const fs = require('fs');
const fp = 'D:/work/code/akemi-mio/src/main/db/messages.ts';
let src = fs.readFileSync(fp, 'utf8');

const pairs = [
  [
    "FROM messages ORDER BY created_at ASC LIMIT ?",
    "FROM messages WHERE category != 'evolution' AND COALESCE(session_id,'') != 'session_evolution' ORDER BY created_at ASC LIMIT ?"
  ],
  [
    "WHERE session_id IS NOT NULL",
    "WHERE session_id IS NOT NULL AND session_id != 'session_evolution' AND category != 'evolution'"
  ],
  [
    "FROM messages WHERE session_id = ? ORDER BY created_at ASC",
    "FROM messages WHERE session_id = ? AND category != 'evolution' ORDER BY created_at ASC"
  ],
  [
    "SELECT session_id FROM messages ORDER BY created_at DESC LIMIT 1",
    "SELECT session_id FROM messages WHERE category != 'evolution' AND session_id != 'session_evolution' ORDER BY created_at DESC LIMIT 1"
  ],
  [
    "SELECT created_at FROM messages ORDER BY created_at DESC LIMIT 1",
    "SELECT created_at FROM messages WHERE category != 'evolution' AND session_id != 'session_evolution' ORDER BY created_at DESC LIMIT 1"
  ]
];

let changed = 0;
for (const [oldStr, newStr] of pairs) {
  if (src.includes(oldStr) && !src.includes(newStr)) {
    src = src.replace(oldStr, newStr);
    changed++;
    console.log('OK:', oldStr.substring(0, 60));
  } else if (src.includes(newStr)) {
    console.log('SKIP (already):', oldStr.substring(0, 60));
  } else {
    console.log('NOT FOUND:', oldStr.substring(0, 60));
  }
}

fs.writeFileSync(fp, src, 'utf8');
console.log('---');
console.log('total changes:', changed);

// verify
const final = fs.readFileSync(fp, 'utf8');
const hitCount = (final.match(/session_evolution/g) || []).length;
const catCount = (final.match(/category != 'evolution'/g) || []).length;
console.log('session_evolution refs:', hitCount);
console.log("category != 'evolution' refs:", catCount);
