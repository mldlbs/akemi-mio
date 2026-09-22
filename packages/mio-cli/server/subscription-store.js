'use strict'

// Shared subscription + digest store: the single implementation behind
// mio.observer.subscribe and mio.observer.digest.
//
// Kept separate from observer-store.js on purpose: that one is the research
// pipeline and is project-local (<cwd>/.local/observer), while subscriptions,
// traces and the digest cursor all live under the MIO_HOME data dir. Mixing them
// would mean one store with two different notions of "where the data lives".
//
// The digest is cursor-based: digest_state.json records, per subscription, the
// position of the newest event already delivered. Running it again therefore
// returns only what is new -- which is the point, but also why a digest is not
// idempotent and the cursor must be written even when nothing matched (otherwise
// a subscription created just now would replay the whole trace history).
//
// A cursor is `{ time, id }` and is an *exclusive* bound: an event is delivered
// iff it sorts strictly after it, with `id` breaking ties inside a millisecond.
// The tie-break is not cosmetic. Both timestamps in play come from the same wall
// clock -- task-store.js stamps the event, digest() stamps the cursor -- and the
// gap between them is one small writeFileSync, so comparing time alone silently
// swallowed every event that shared a millisecond with the cursor, permanently,
// because the cursor only moves forward. Measured 2026-09-22: that gap is ~2ms
// on a Defender-scanned Windows box but sub-millisecond on a CI runner, which is
// why `digest respects topic filter` passed 30/30 locally and flaked about half
// the time on CI. See __tests__/observer-digest-cursor.test.js.
//
// The `id` field has three states, and the difference matters:
//   ''     a wall-clock cursor: digest() found nothing to deliver, so nothing at
//          that instant has been consumed. The empty string sorts below every
//          real id, so same-millisecond events are still delivered.
//   null   a legacy cursor, written before the tie-break existed as a bare ISO
//          string. `null` sorts above every real id, reproducing the old
//          inclusive time comparison exactly -- so an upgrade never re-delivers.
//   '<id>' an event cursor: the event with that id has been delivered.
const WALL_CURSOR_ID = ''

function readCursor(raw) {
  if (typeof raw === 'string') {
    const time = Date.parse(raw)
    return Number.isFinite(time) ? { time, id: null } : null
  }
  if (raw && typeof raw === 'object' && typeof raw.time === 'string') {
    const time = Date.parse(raw.time)
    if (!Number.isFinite(time)) return null
    return { time, id: typeof raw.id === 'string' ? raw.id : null }
  }
  return null
}

// Exclusive: true when `event` sorts strictly after `cursor`.
function isNewEvent(eventTime, eventId, cursor) {
  if (!cursor || cursor.time === null || eventTime === null) return true
  if (eventTime !== cursor.time) return eventTime > cursor.time
  // Same millisecond -- fall back to the id. Ids are `trace_<ms>_<hex>`, so the
  // order inside a millisecond is by the random suffix: arbitrary, but stable,
  // which is all "do not deliver twice" needs.
  if (cursor.id === null) return false
  if (typeof eventId !== 'string' || eventId === '') return true
  return eventId > cursor.id
}

const fs = require('fs')
const path = require('path')
const { createId, readJsonl, writeJsonl } = require('./memory-store.js')

const SUBSCRIPTION_DEFAULT_TTL_DAYS = 30
const MAX_SUBSCRIPTIONS_PER_AGENT = 20
const MAX_DIGEST_EVENTS = 100

function subscribeKey(agent, project, eventTypes, topic) {
  return `${agent}|${project}|${eventTypes.join(',')}|${topic || ''}`
}

function createSubscriptionStore(options = {}) {
  const dataDir = options.dataDir
  const projectName = options.projectName || (() => null)
  // Named resolveAgentId so subscribe() can still use `agent` as a local.
  const resolveAgentId = options.agentId || (() => 'mcp')

  const subscriptionPath = path.join(dataDir, 'subscriptions.jsonl')
  const tracePath = path.join(dataDir, 'traces.jsonl')
  const digestStatePath = path.join(dataDir, 'digest_state.json')

  function readDigestState() {
    if (!fs.existsSync(digestStatePath)) return {}
    try {
      const parsed = JSON.parse(fs.readFileSync(digestStatePath, 'utf8'))
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
    } catch (_) {
      return {}
    }
  }

  function writeDigestState(state) {
    fs.mkdirSync(dataDir, { recursive: true })
    fs.writeFileSync(digestStatePath, JSON.stringify(state), 'utf8')
  }

  function loadActiveSubscriptions(agent) {
    const now = Date.now()
    return readJsonl(subscriptionPath)
      .filter((subscription) => subscription && subscription.agent === agent)
      .filter((subscription) => {
        if (subscription.expiresAt) {
          const expires = new Date(subscription.expiresAt).getTime()
          if (Number.isFinite(expires) && expires <= now) return false
        }
        return true
      })
  }

  function subscribe(args = {}) {
    const agent = resolveAgentId() || 'mcp'
    const project = args.project || projectName()
    const eventTypes = Array.isArray(args.eventTypes)
      ? args.eventTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
      : []
    const topic = args.topic ? String(args.topic).trim().slice(0, 120) : ''
    const ttlDays = Number(args.ttlDays) || SUBSCRIPTION_DEFAULT_TTL_DAYS
    const ttlMs = Math.max(1, ttlDays) * 24 * 60 * 60 * 1000

    const subscriptions = readJsonl(subscriptionPath)
    const key = subscribeKey(agent, project, eventTypes, topic)
    let existing = subscriptions.find((subscription) => {
      return (
        subscription &&
        subscribeKey(
          subscription.agent,
          subscription.project,
          subscription.eventTypes || [],
          subscription.topic || '',
        ) === key
      )
    })
    const now = new Date()
    const expiresAt = new Date(now.getTime() + ttlMs).toISOString()
    if (existing) {
      existing.updatedAt = now.toISOString()
      existing.expiresAt = expiresAt
    } else {
      existing = {
        id: createId('sub'),
        agent,
        project,
        eventTypes,
        topic: topic || null,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
        expiresAt,
      }
      subscriptions.push(existing)
    }
    const agentSubscriptions = subscriptions.filter(
      (subscription) => subscription.agent === agent,
    )
    if (agentSubscriptions.length > MAX_SUBSCRIPTIONS_PER_AGENT) {
      throw new Error(`Too many subscriptions for agent ${agent} (max ${MAX_SUBSCRIPTIONS_PER_AGENT})`)
    }
    writeJsonl(subscriptionPath, subscriptions)
    return { subscribed: true, subscription: existing, project }
  }

  function digest(args = {}) {
    const agent = resolveAgentId() || 'mcp'
    const project = args.project || projectName()
    const limit = Math.min(Math.max(Number(args.limit) || 20, 1), MAX_DIGEST_EVENTS)
    // An empty array means "no filter", not "match nothing" -- otherwise a
    // caller that omits event types (or passes []) would silently exclude every
    // subscription that declares any types at all.
    const filterEventTypes =
      Array.isArray(args.eventTypes) && args.eventTypes.length > 0
        ? args.eventTypes.map((value) => String(value).trim().toLowerCase()).filter(Boolean)
        : null

    let subscriptions = loadActiveSubscriptions(agent)
    if (args.project) {
      subscriptions = subscriptions.filter((subscription) => subscription.project === project)
    }
    if (filterEventTypes) {
      subscriptions = subscriptions.filter((subscription) => {
        if ((subscription.eventTypes || []).length === 0) return true
        return filterEventTypes.some((eventType) =>
          (subscription.eventTypes || []).includes(eventType),
        )
      })
    }

    const state = readDigestState()
    const traces = readJsonl(tracePath)
    const digestTime = new Date().toISOString()
    const events = []
    const seenIds = new Set()
    const matchedSubscriptionIds = new Set()

    for (const subscription of subscriptions) {
      const cursor = readCursor(state[subscription.id])
      const subscriptionEventTypes = subscription.eventTypes || []
      let lastEventTime = null
      let lastEventId = WALL_CURSOR_ID
      for (const event of traces) {
        if (subscription.project && event.project && event.project !== subscription.project) {
          continue
        }
        if (
          subscriptionEventTypes.length > 0 &&
          !subscriptionEventTypes.includes(String(event.event_type || '').toLowerCase())
        ) {
          continue
        }
        if (subscription.topic) {
          const haystack = `${event.event_type || ''} ${JSON.stringify(event.payload || {})}`
            .toLowerCase()
          if (!haystack.includes(subscription.topic.toLowerCase())) continue
        }
        const eventTime = event.timestamp ? Date.parse(event.timestamp) : null
        if (!isNewEvent(eventTime, event.id, cursor)) continue
        if (eventTime !== null) {
          if (lastEventTime === null || eventTime > lastEventTime) {
            lastEventTime = eventTime
            lastEventId = typeof event.id === 'string' ? event.id : WALL_CURSOR_ID
          } else if (eventTime === lastEventTime && typeof event.id === 'string' && event.id > lastEventId) {
            // Several delivered events share the newest millisecond. The cursor
            // has to sit on the highest id among them, otherwise the next digest
            // would hand the lower ones out again.
            lastEventId = event.id
          }
        }
        if (seenIds.has(event.id)) continue
        seenIds.add(event.id)
        events.push({
          id: event.id,
          trace_id: event.trace_id || null,
          event_type: event.event_type,
          outcome: event.outcome || null,
          timestamp: event.timestamp,
          agent: event.agent || null,
          payload: event.payload || null,
        })
        matchedSubscriptionIds.add(subscription.id)
        if (events.length >= limit) break
      }
      // Advance the cursor even when nothing matched: a brand-new subscription
      // has no cursor, and without this it would replay the entire history.
      if (lastEventTime !== null) {
        state[subscription.id] = { time: new Date(lastEventTime).toISOString(), id: lastEventId }
      } else if (cursor === null) {
        state[subscription.id] = { time: digestTime, id: WALL_CURSOR_ID }
      }
      if (events.length >= limit) break
    }

    writeDigestState(state)
    return {
      project,
      agent,
      subscriptionCount: subscriptions.length,
      matchedSubscriptions: Array.from(matchedSubscriptionIds),
      count: events.length,
      events,
    }
  }

  return { subscribe, digest, subscriptionPath, digestStatePath }
}

module.exports = { createSubscriptionStore, subscribeKey }
