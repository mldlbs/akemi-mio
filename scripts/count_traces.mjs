import { createRequire } from "module";
const req = createRequire(import.meta.url);

// Try better-sqlite3 first, fallback to sql.js
let db;
try {
  const Database = req("better-sqlite3");
  db = new Database("_ev_check.db", { readonly: true });
} catch {
  const initSqlJs = req("sql.js");
  const fs = req("fs");
  const SQL = await initSqlJs();
  db = new SQL.Database(fs.readFileSync("_ev_check.db"));
}

function q(sql) {
  try {
    if (db.prepare) {
      // better-sqlite3 mode
      const stmt = db.prepare(sql);
      if (sql.trim().toUpperCase().startsWith("SELECT")) {
        return stmt.all();
      }
      return [];
    }
  } catch {}
  // sql.js mode
  const r = db.exec(sql);
  return r[0] ? r[0].values.map(v => {
    const obj = {};
    // Try to get column names
    return v;
  }) : [];
}

// Count traces in v1.1 session
const traceCount = db.prepare
  ? db.prepare("SELECT COUNT(DISTINCT trace_id) as c FROM evaluation_events WHERE session_id != '' AND session_id IS NOT NULL AND trace_id != '' AND trace_id IS NOT NULL").get()
  : null;

const v1events = db.prepare
  ? db.prepare("SELECT COUNT(*) as c FROM evaluation_events WHERE session_id != '' AND session_id IS NOT NULL").get()
  : null;

const oldEvents = db.prepare
  ? db.prepare("SELECT COUNT(*) as c FROM evaluation_events WHERE session_id = '' OR session_id IS NULL").get()
  : null;

console.log("v1.1 events:", v1events?.c ?? "?");
console.log("v1.0 events:", oldEvents?.c ?? "?");
console.log("Total traces:", traceCount?.c ?? "?");

// Traces with both model + tool
const mixedTraces = db.prepare
  ? db.prepare(`SELECT COUNT(*) as c FROM (SELECT trace_id FROM evaluation_events WHERE session_id != '' AND session_id IS NOT NULL AND trace_id != '' AND trace_id IS NOT NULL GROUP BY trace_id HAVING SUM(CASE WHEN type LIKE 'model.%' THEN 1 ELSE 0 END) > 0 AND SUM(CASE WHEN type LIKE 'tool.%' THEN 1 ELSE 0 END) > 0)`).get()
  : null;

console.log("Mixed model+tool traces:", mixedTraces?.c ?? "?");

// Per-trace event count distribution
const sizes = db.prepare
  ? db.prepare("SELECT COUNT(*) as cnt FROM evaluation_events WHERE session_id != '' AND session_id IS NOT NULL AND trace_id != '' AND trace_id IS NOT NULL GROUP BY trace_id ORDER BY cnt").all()
  : [];

const cnts = sizes.map(r => r.cnt);
if (cnts.length > 0) {
  const p50 = cnts[Math.floor(cnts.length * 0.5)];
  const p90 = cnts[Math.floor(cnts.length * 0.9)];
  const p95 = cnts[Math.floor(cnts.length * 0.95)];
  const mx = cnts[cnts.length - 1];
  const mn = cnts[0];
  console.log(`Trace event distribution: P50=${p50} P90=${p90} P95=${p95} Max=${mx} Min=${mn} Count=${cnts.length}`);
} else {
  console.log("No trace size data available");
}

// Latest event timestamp
const latest = db.prepare
  ? db.prepare("SELECT MAX(timestamp) as ts FROM evaluation_events WHERE session_id != '' AND session_id IS NOT NULL").get()
  : null;

if (latest) {
  const dt = new Date(Number(latest.ts));
  const hoursAgo = ((Date.now() - Number(latest.ts)) / 3600000).toFixed(1);
  console.log(`Last v1.1 event: ${dt.toISOString()} (${hoursAgo}h ago)`);
}

db.close?.();
