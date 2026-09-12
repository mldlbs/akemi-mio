const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { JsonlStore, EventBus, createId } = require('../index.js')

test('persists JSONL records and reads them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mio-foundation-'))
  const store = new JsonlStore(path.join(dir, 'records.jsonl'))
  store.append({ id: 1, value: 'a' })
  store.append({ id: 2, value: 'b' })
  assert.deepEqual(store.readAll(), [{ id: 1, value: 'a' }, { id: 2, value: 'b' }])
})

test('event bus delivers events and supports unsubscribe', () => {
  const bus = new EventBus()
  const received = []
  const unsubscribe = bus.on('task.completed', (event) => received.push(event))
  bus.emit('task.completed', { id: 'one' })
  unsubscribe()
  bus.emit('task.completed', { id: 'two' })
  assert.deepEqual(received, [{ id: 'one' }])
  assert.match(createId('exp'), /^exp_[a-z0-9-]+$/)
})
