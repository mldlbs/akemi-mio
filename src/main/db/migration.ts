import type { Database as SqlJsDatabase } from 'sql.js'
import { log } from '../logger/Logger'

interface Migration {
  version: number
  sql: string
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'completed', 'abandoned')),
        reflection TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT PRIMARY KEY,
        plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
        step_index INTEGER NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'in_progress', 'done', 'failed')),
        result TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_plan_steps_plan_id ON plan_steps(plan_id);
      CREATE INDEX IF NOT EXISTS idx_plans_status ON plans(status);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        detector TEXT NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        evidence TEXT NOT NULL,
        score REAL NOT NULL,
        confidence REAL NOT NULL,
        reported INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS concept_combos (
        id TEXT PRIMARY KEY,
        sources TEXT NOT NULL,
        description TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS hypotheses (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        idea TEXT NOT NULL,
        expected_benefit TEXT NOT NULL,
        risk TEXT NOT NULL,
        source_labels TEXT NOT NULL,
        novelty REAL NOT NULL,
        feasibility REAL NOT NULL,
        impact REAL NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','active','experimenting','validated','rejected')),
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS experiments (
        hypothesis_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        steps TEXT NOT NULL,
        success_criteria TEXT NOT NULL,
        estimated_duration TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dream_cycles (
        timestamp INTEGER PRIMARY KEY,
        sources_examined INTEGER NOT NULL,
        combos_generated INTEGER NOT NULL,
        hypotheses_generated INTEGER NOT NULL,
        top_idea TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_insights_reported ON insights(reported);
      CREATE INDEX IF NOT EXISTS idx_hypotheses_status ON hypotheses(status);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('user_fact', 'interaction')),
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_summaries (
        id TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        turn_start INTEGER NOT NULL,
        turn_end INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memory_vectors (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        embedding TEXT NOT NULL,
        confidence REAL NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('user_fact', 'summary')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_content ON memories(content);
    `,
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS credentials (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
  },
  {
    version: 5,
    sql: `
      ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'ephemeral';
      ALTER TABLE memories ADD COLUMN reinforce_count INTEGER NOT NULL DEFAULT 0;
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS memory_archive (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        confidence REAL NOT NULL,
        tier TEXT NOT NULL,
        reason TEXT NOT NULL DEFAULT 'pruned',
        archived_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS knowledge_graph (
        id TEXT PRIMARY KEY,
        entity TEXT NOT NULL,
        attribute TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_kg_entity ON knowledge_graph(entity);
    `,
  },
  {
    version: 7,
    sql: `
      CREATE TABLE IF NOT EXISTS goals (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','paused','completed','abandoned')),
        category TEXT NOT NULL CHECK(category IN ('mission','long_term','short_term','initiative')),
        parent_goal_id TEXT,
        progress INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS strategies (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE,
        description TEXT NOT NULL,
        prompt_template TEXT NOT NULL,
        applicable_context TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        version INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS prompt_templates (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('identity','core','tools','evolution','custom')),
        content TEXT NOT NULL,
        version INTEGER NOT NULL DEFAULT 1,
        active INTEGER NOT NULL DEFAULT 1,
        variables TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 8,
    sql: `
      CREATE TABLE IF NOT EXISTS engineering_memory (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('architecture_pattern','coding_convention','design_decision','test_pattern','failure_pattern')),
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        related_files TEXT NOT NULL DEFAULT '[]',
        tags TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_engmem_type ON engineering_memory(type);
    `,
  },
  {
    version: 9,
    sql: `
      CREATE TABLE IF NOT EXISTS audit_trail (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        source TEXT NOT NULL CHECK(source IN ('agent','plugin','user','evolution','system')),
        action TEXT NOT NULL CHECK(action IN ('tool_call','file_write','file_read','command','permission_change','plugin_load','plugin_unload')),
        target TEXT NOT NULL,
        plugin_name TEXT,
        tool_name TEXT,
        details TEXT NOT NULL DEFAULT '{}',
        allowed INTEGER NOT NULL DEFAULT 1,
        duration INTEGER,
        reason TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audit_ts ON audit_trail(timestamp);
      CREATE INDEX IF NOT EXISTS idx_audit_source ON audit_trail(source);
      CREATE TABLE IF NOT EXISTS permission_grants (
        plugin_name TEXT NOT NULL,
        tool_name TEXT NOT NULL,
        permission TEXT NOT NULL,
        granted INTEGER NOT NULL DEFAULT 1,
        persistent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (plugin_name, tool_name, permission)
      );
    `,
  },
  {
    version: 10,
    sql: `
      CREATE TABLE IF NOT EXISTS token_account (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      INSERT OR IGNORE INTO token_account (key, value) VALUES ('balance', '0');
      INSERT OR IGNORE INTO token_account (key, value) VALUES ('lifetime_earned', '0');
      INSERT OR IGNORE INTO token_account (key, value) VALUES ('lifetime_spent', '0');

      CREATE TABLE IF NOT EXISTS token_transactions (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
        amount INTEGER NOT NULL,
        category TEXT NOT NULL DEFAULT 'general',
        note TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_token_txn_created ON token_transactions(created_at);
    `,
  },
  {
    version: 11,
    sql: `
      CREATE TABLE IF NOT EXISTS procedures (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        steps TEXT NOT NULL DEFAULT '[]',
        trigger_keywords TEXT NOT NULL DEFAULT '[]',
        success_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_procedures_name ON procedures(name);
    `,
  },
  {
    version: 12,
    sql: `
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL CHECK(source IN ('electron', 'telegram')),
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
        content TEXT NOT NULL,
        telegram_chat_id INTEGER,
        telegram_user_id INTEGER,
        telegram_from TEXT,
        telegram_message_id INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_created_at ON messages(created_at);
    `,
  },
  {
    version: 13,
    sql: `
      CREATE TABLE IF NOT EXISTS telegram_outbox (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        msg_type TEXT NOT NULL CHECK(msg_type IN ('send', 'edit', 'reply', 'action')),
        message TEXT NOT NULL,
        target_message_id INTEGER,
        hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON telegram_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_hash ON telegram_outbox(hash);
    `,
  },
  {
    version: 14,
    sql: `
      ALTER TABLE telegram_outbox ADD COLUMN category TEXT NOT NULL DEFAULT 'dialogue';
      CREATE INDEX IF NOT EXISTS idx_outbox_category ON telegram_outbox(category);
    `,
  },
  {
    version: 15,
    sql: `
      CREATE TABLE IF NOT EXISTS identity_core (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        constitution_hash TEXT NOT NULL,
        name TEXT NOT NULL,
        role TEXT NOT NULL,
        personality TEXT NOT NULL DEFAULT '[]',
        capabilities TEXT NOT NULL DEFAULT '[]',
        constraints TEXT NOT NULL DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS identity_traits (
        name TEXT PRIMARY KEY,
        value REAL NOT NULL DEFAULT 0.5,
        trend TEXT NOT NULL DEFAULT 'stable' CHECK(trend IN ('growing','stable','declining')),
        sample_count INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );

      INSERT OR IGNORE INTO identity_traits (name, value, trend, sample_count, updated_at)
      VALUES ('goal_alignment', 0.7, 'stable', 0, strftime('%s','now') * 1000);

      INSERT OR IGNORE INTO identity_traits (name, value, trend, sample_count, updated_at)
      VALUES ('tool_efficiency', 0.6, 'stable', 0, strftime('%s','now') * 1000);

      INSERT OR IGNORE INTO identity_traits (name, value, trend, sample_count, updated_at)
      VALUES ('response_quality', 0.7, 'stable', 0, strftime('%s','now') * 1000);

      CREATE TABLE IF NOT EXISTS identity_metrics (
        id TEXT PRIMARY KEY DEFAULT 'singleton',
        sessions_completed INTEGER NOT NULL DEFAULT 0,
        tools_used INTEGER NOT NULL DEFAULT 0,
        goals_completed INTEGER NOT NULL DEFAULT 0,
        goals_drifted INTEGER NOT NULL DEFAULT 0,
        avg_score REAL NOT NULL DEFAULT 1.0,
        constitution_checksum TEXT NOT NULL DEFAULT '',
        last_updated INTEGER NOT NULL
      );
    `,
  },
  {
    version: 16,
    sql: `
      ALTER TABLE procedures ADD COLUMN embedding TEXT;
      CREATE INDEX IF NOT EXISTS idx_procedures_updated_at ON procedures(updated_at);
    `,
  },
  {
    version: 17,
    sql: `
      CREATE TABLE IF NOT EXISTS meta_reviews (
        id TEXT PRIMARY KEY,
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        summary TEXT NOT NULL,
        patterns TEXT NOT NULL DEFAULT '[]',
        improvements TEXT NOT NULL DEFAULT '[]',
        trait_deltas TEXT NOT NULL DEFAULT '{}',
        created_at INTEGER NOT NULL
      );
    `,
  },
  {
    version: 18,
    sql: `
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        channel TEXT NOT NULL,
        payload TEXT NOT NULL,
        source TEXT,
        trace_id TEXT,
        timestamp INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_channel_ts ON events(channel, timestamp);
    `,
  },
]

export function runMigrations(sqlite: SqlJsDatabase): void {
  sqlite.run('CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)')

  const applied = new Set((sqlite.exec('SELECT version FROM _migrations') as any[]).flatMap((r) => r.values).map((v: any) => Number(v)))

  for (const m of MIGRATIONS) {
    if (!applied.has(m.version)) {
      log('INFO', 'db_migration_applying', { version: m.version })
      sqlite.run(m.sql)
      sqlite.run('INSERT INTO _migrations (version, applied_at) VALUES (?, ?)', [m.version, Date.now()])
      log('INFO', 'db_migration_applied', { version: m.version })
    }
  }
}
