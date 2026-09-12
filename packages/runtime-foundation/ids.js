'use strict'

const crypto = require('node:crypto')

function createId(prefix = 'id') {
  if (typeof prefix !== 'string' || prefix.trim() === '') throw new TypeError('prefix must be a non-empty string')
  return `${prefix}_${crypto.randomUUID()}`
}

module.exports = { createId }
