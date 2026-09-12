'use strict'

const { JsonlStore } = require('./jsonl-store.js')
const { EventBus } = require('./event-bus.js')
const { createId } = require('./ids.js')

function createLogger(name = 'mio') {
  return {
    info: (message, metadata) => console.info(`[${name}] ${message}`, metadata || ''),
    warn: (message, metadata) => console.warn(`[${name}] ${message}`, metadata || ''),
    error: (message, metadata) => console.error(`[${name}] ${message}`, metadata || ''),
  }
}

module.exports = { JsonlStore, EventBus, createId, createLogger }
