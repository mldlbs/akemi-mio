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
// timestamp of the newest event already delivered. Running it again therefore
// returns only what is new -- which is the point, but also why a digest is not
// idempotent and the cursor must be written even when nothing matched (otherwise
// a subscription created just now would replay the whole trace history).

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
      const cursor = state[subscription.id] || null
      const cursorTime = cursor ? Date.parse(cursor) : null
      const subscriptionEventTypes = subscription.eventTypes || []
      let lastEventTime = null
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
        if (cursorTime !== null && eventTime !== null && eventTime <= cursorTime) continue
        if (eventTime !== null && (lastEventTime === null || eventTime > lastEventTime)) {
          lastEventTime = eventTime
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
        state[subscription.id] = new Date(lastEventTime).toISOString()
      } else if (cursor === null) {
        state[subscription.id] = digestTime
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
