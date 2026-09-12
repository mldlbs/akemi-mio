'use strict'

const fs = require('node:fs')
const path = require('node:path')

class JsonlStore {
  constructor(filePath) {
    if (typeof filePath !== 'string' || filePath === '') throw new TypeError('filePath must be a non-empty string')
    this.filePath = filePath
  }

  append(record) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    fs.appendFileSync(this.filePath, `${JSON.stringify(record)}\n`, 'utf8')
    return record
  }

  readAll() {
    if (!fs.existsSync(this.filePath)) return []
    return fs.readFileSync(this.filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  }

  replace(records) {
    if (!Array.isArray(records)) throw new TypeError('records must be an array')
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`
    const contents = records.map((record) => JSON.stringify(record)).join('\n')
    fs.writeFileSync(temporaryPath, contents ? `${contents}\n` : '', 'utf8')
    fs.renameSync(temporaryPath, this.filePath)
  }
}

module.exports = { JsonlStore }
