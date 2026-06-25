const fs = require('fs')
const c = fs.readFileSync('src/main/agent/context.ts', 'utf-8')

// PROMPT_CORE template literal starts at: const PROMPT_CORE = `...
// The closing backtick is the one right before '\n\nconst PROMPT_TOOLS'
const openTick = c.indexOf('const PROMPT_CORE')
const tplStart = c.indexOf('`', openTick) + 1

// Find closing backtick: last backtick before 'const PROMPT_TOOLS'
const toolsStart = c.indexOf('\nconst PROMPT_TOOLS')
let tplEnd = -1
for (let i = toolsStart - 1; i >= tplStart; i--) {
  if (c[i] === '`' && c[i] !== '\\') {
    tplEnd = i
    break
  }
}

const before = c.slice(0, tplStart)
const content = c.slice(tplStart, tplEnd)
const after = c.slice(tplEnd)

// Escape all backticks inside the template content
const escaped = content.replace(/`/g, '\\`')
fs.writeFileSync('src/main/agent/context.ts', before + escaped + after, 'utf-8')
console.log('done')
