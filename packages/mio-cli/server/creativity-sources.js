'use strict'

// Source auto-aggregation for the creativity engine (spec Capability 2).
//
// Default providers read ONLY local MIO_HOME data — zero network. Insight and
// observer sources arrive as plain arrays from the caller, because only the
// entry point knows which store is authoritative (MIO_HOME for the CLI, the
// MCP server's MIO_DATA_DIR) and whether its optional package resolves.
// SourceAggregator already tolerates a throwing provider (per-provider
// try/catch with a WARN log), so providers here do not need extra guards.

const fs = require('fs')
const path = require('path')
const { SourceAggregator } = require('@akemi-mio/creativity/SourceAggregator')
const { sourcesFromInsights, isoOf } = require('./creativity-engine.js')

function readJsonl(file) {
  try {
    return fs
      .readFileSync(file, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try { return JSON.parse(line) } catch { return null }
      })
      .filter(Boolean)
  } catch (_) {
    return []
  }
}

// Every weight is > 0.7 on purpose: IdeaGenerator.applyTemperature keeps any
// source with weight > 0.7 unconditionally (temperature 0.5 middle branch), so
// the assembled set reaches the prompt intact — deterministic, no RNG survival.
const WEIGHTS = {
  memory: 0.75,
  traceOk: 0.74,
  traceFail: 0.73,
  hypothesisActive: 0.72,
  hypothesisRejected: 0.72,
  trend: 0.76,
}

function memoryProvider(dataDir) {
  return {
    domain: 'feedback',
    name: 'memory',
    collect() {
      return readJsonl(path.join(dataDir, 'memory.jsonl'))
        .filter((r) => r && r.archived !== true && (r.kind === 'decision' || r.kind === 'note'))
        .slice(-6)
        .map((r) => ({
          name: `${r.kind}: ${String(r.content || '').slice(0, 40)}`,
          content: String(r.content || ''),
          type: 'feedback',
          weight: WEIGHTS.memory,
          origin: `memory:${r.id}`,
          originId: r.id,
          timestamp: isoOf(r.timestamp),
        }))
    },
  }
}

function traceProviders(dataDir) {
  const events = () => readJsonl(path.join(dataDir, 'traces.jsonl')).slice(-40)
  const fmt = (r) => `${r.event_type}${r.outcome ? `/${r.outcome}` : ''}: ${JSON.stringify(r.payload || {}).slice(0, 300)}`
  const stamp = (r) => isoOf(r.timestamp ?? r.ts)
  return [
    {
      domain: 'behavior',
      name: 'traces-success',
      collect() {
        return events()
          .filter((r) => r.event_type === 'task_outcome' && r.outcome === 'success')
          .slice(-3)
          .map((r) => ({
            name: `success: ${String((r.payload && (r.payload.task || r.payload.summary)) || r.trace_id || 'task').slice(0, 40)}`,
            content: fmt(r),
            type: 'behavior',
            weight: WEIGHTS.traceOk,
            origin: `trace:${r.trace_id}`,
            originId: r.trace_id,
            timestamp: stamp(r),
          }))
      },
    },
    {
      domain: 'failure',
      name: 'traces-failure',
      collect() {
        return events()
          .filter(
            (r) =>
              (r.event_type === 'error' || r.event_type === 'retry') ||
              (r.event_type === 'task_outcome' && (r.outcome === 'failure' || r.outcome === 'error' || r.outcome === 'aborted')),
          )
          .slice(-3)
          .map((r) => ({
            name: `failure: ${String(r.event_type)}${r.trace_id ? ` ${String(r.trace_id).slice(0, 12)}` : ''}`,
            content: fmt(r),
            type: 'failure',
            weight: WEIGHTS.traceFail,
            origin: `trace:${r.trace_id || 'unknown'}`,
            originId: r.trace_id,
            timestamp: stamp(r),
          }))
      },
    },
  ]
}

function hypothesesProvider(dataDir) {
  return {
    domain: 'module',
    name: 'hypotheses',
    collect() {
      return readJsonl(path.join(dataDir, 'creativity', 'creativity-hypotheses.jsonl'))
        .filter((h) => h && (h.status === 'active' || h.status === 'rejected'))
        .slice(-6)
        .map((h) => ({
          name: String(h.title || h.id).slice(0, 60),
          content: `idea: ${h.idea}\nrisk: ${h.risk || '-'}`,
          type: h.status === 'rejected' ? 'failure' : 'knowledge',
          weight: h.status === 'rejected' ? WEIGHTS.hypothesisRejected : WEIGHTS.hypothesisActive,
          origin: `hypothesis:${h.id}`,
          originId: h.id,
          timestamp: isoOf(h.createdAt),
        }))
    },
  }
}

// Observer trend reports → provocation sources. The report schema has drifted
// across observer versions, so fields are read defensively with fallbacks.
function trendSources(trends) {
  return (Array.isArray(trends) ? trends : []).slice(0, 4).map((t, i) => {
    const title = (t && (t.title || t.name || t.date)) || `trend-${i}`
    const body =
      (t && t.summary) ||
      (Array.isArray(t && t.themes) ? t.themes.join('; ') : '') ||
      JSON.stringify(t || {}).slice(0, 400)
    const key = (t && (t.date || t.id)) || String(i)
    const stamp = isoOf(t && (t.generatedAt || t.date))
    return {
      name: String(title).slice(0, 60),
      content: String(body),
      type: 'provocation',
      weight: WEIGHTS.trend,
      origin: `observer-trends:${key}`,
      ...(t && t.id ? { originId: t.id } : {}),
      ...(stamp ? { timestamp: stamp } : {}),
    }
  })
}

// Assemble every local (+ optionally insight/observer) domain through the
// package SourceAggregator so dedup, per-domain caps and failure tolerance
// behave identically for idea.generate and the generate top-up.
function buildAutoSources({ dataDir, insights = [], trends = [] }) {
  const aggregator = new SourceAggregator(4, 1)
  aggregator.addProvider(memoryProvider(dataDir))
  for (const provider of traceProviders(dataDir)) aggregator.addProvider(provider)
  aggregator.addProvider(hypothesesProvider(dataDir))
  if (Array.isArray(insights) && insights.length > 0) {
    aggregator.addProvider({ domain: 'observation', name: 'insight', collect: () => sourcesFromInsights(insights) })
  }
  const trendList = Array.isArray(trends) ? trends : []
  if (trendList.length > 0) {
    aggregator.addProvider({ domain: 'external', name: 'observer-trends', collect: () => trendSources(trendList) })
  }
  return aggregator.build()
}

// Explicit --source entries always win: auto sources only top a set up to the
// two entries the concept mixer needs; they never replace or reorder explicit
// ones (spec Capability 2, injection point 2).
function topUpSources(explicit, auto) {
  const list = Array.isArray(explicit) ? explicit.filter(Boolean) : []
  if (list.length >= 2) return list
  const seen = new Set(list.map((s) => s.name))
  const extra = (Array.isArray(auto) ? auto : []).filter((s) => s && !seen.has(s.name))
  return [...list, ...extra]
}

module.exports = { buildAutoSources, topUpSources, trendSources, memoryProvider, traceProviders, hypothesesProvider }
