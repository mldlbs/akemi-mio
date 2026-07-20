import { log } from '../logger/Logger'

// sql.js 兼容接口（better-sqlite3 CompatDatabase 也实现此接口）
type MigrationDatabase = {
  run: (sql: string, params?: any[]) => void
  exec: (sql: string) => Array<{ columns: string[]; values: any[][] }>
  prepare: (sql: string) => {
    bind: (params: any[]) => void
    step: () => boolean
    getAsObject: () => Record<string, any>
    reset: () => void
    free: () => void
  }
}

interface Migration {
  version: number
  sql: string
  /** Revert SQL。对于 ADD COLUMN 等无操作场景设为空字符串。
   *  注意：revert 不修改 _migrations 表（R5-C: append-only）。
   *  回滚通过前向修正迁移实现。 */
  revert?: string
  /** Migration 分类标签 */
  category?: 'schema' | 'data' | 'index' | 'backfill'
  /** 标记该迁移不可逆转（如 DROP 列后的重建迁移） */
  irreversible?: boolean
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
  },
  {
    version: 4,
    sql: `
      CREATE TABLE IF NOT EXISTS credentials (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 5,
    sql: `
      ALTER TABLE memories ADD COLUMN tier TEXT NOT NULL DEFAULT 'ephemeral';
      ALTER TABLE memories ADD COLUMN reinforce_count INTEGER NOT NULL DEFAULT 0;
    `,
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
  },
  {
    version: 14,
    sql: `
      ALTER TABLE telegram_outbox ADD COLUMN category TEXT NOT NULL DEFAULT 'dialogue';
      CREATE INDEX IF NOT EXISTS idx_outbox_category ON telegram_outbox(category);
    `,
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
  },
  {
    version: 16,
    sql: `
      ALTER TABLE procedures ADD COLUMN embedding TEXT;
      CREATE INDEX IF NOT EXISTS idx_procedures_updated_at ON procedures(updated_at);
    `,
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
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
    revert: '',
    category: 'schema',
  },
  {
    version: 19,
    sql: `
      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        agent_id TEXT NOT NULL,
        category TEXT NOT NULL CHECK(category IN ('tool_select','strategy','plan_route','goal_adjust','recovery')),
        context TEXT NOT NULL,
        choice TEXT NOT NULL,
        alternatives TEXT NOT NULL DEFAULT '[]',
        outcome TEXT NOT NULL DEFAULT 'pending' CHECK(outcome IN ('pending','success','failure')),
        confidence REAL NOT NULL DEFAULT 0.5,
        related_plan_id TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_decisions_category ON decisions(category);
      CREATE INDEX IF NOT EXISTS idx_decisions_timestamp ON decisions(timestamp);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 20,
    sql: `
      CREATE TABLE IF NOT EXISTS agent_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        agent_id TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT 'system',
        detail TEXT NOT NULL DEFAULT '',
        duration_ms INTEGER,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_events_ts ON agent_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_agent_events_type ON agent_events(event_type);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 21,
    sql: `
      CREATE TABLE IF NOT EXISTS explored_pairs (
        pair_key TEXT PRIMARY KEY,
        created_at INTEGER NOT NULL
      );
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 22,
    sql: `
      ALTER TABLE plans ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 23,
    sql: `
      DROP TABLE IF EXISTS telegram_outbox_new;
      CREATE TABLE telegram_outbox_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        bot TEXT NOT NULL DEFAULT 'chat',
        msg_type TEXT NOT NULL CHECK(msg_type IN ('send', 'edit', 'reply', 'action', 'photo', 'media_group')),
        category TEXT NOT NULL DEFAULT 'dialogue',
        message TEXT NOT NULL,
        target_message_id INTEGER,
        hash TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'sent', 'failed')),
        retry_count INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER
      );
      INSERT INTO telegram_outbox_new SELECT id, chat_id, 'chat', msg_type, IFNULL(category,'dialogue'), message, target_message_id, hash, status, retry_count, last_error, created_at, updated_at FROM telegram_outbox;
      DROP TABLE telegram_outbox;
      ALTER TABLE telegram_outbox_new RENAME TO telegram_outbox;
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON telegram_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_hash ON telegram_outbox(hash);
      CREATE INDEX IF NOT EXISTS idx_outbox_category ON telegram_outbox(category);
    `,
    revert: `
      -- Reverse v23: recreate original schema, migrate data back, drop new table
      DROP TABLE IF EXISTS telegram_outbox_old;
      CREATE TABLE telegram_outbox_old (
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
      INSERT INTO telegram_outbox_old SELECT id, chat_id, msg_type, message, target_message_id, hash, status, retry_count, last_error, created_at, updated_at FROM telegram_outbox;
      DROP TABLE telegram_outbox;
      ALTER TABLE telegram_outbox_old RENAME TO telegram_outbox;
      CREATE INDEX IF NOT EXISTS idx_outbox_status ON telegram_outbox(status);
      CREATE INDEX IF NOT EXISTS idx_outbox_hash ON telegram_outbox(hash);
    `,
    category: 'schema',
    irreversible: true,
  },
  {
    version: 24,
    sql: `
      ALTER TABLE messages ADD COLUMN session_id TEXT;
      CREATE INDEX IF NOT EXISTS idx_messages_session_id ON messages(session_id);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 25,
    sql: `
      ALTER TABLE messages ADD COLUMN category TEXT NOT NULL DEFAULT 'chat';
      CREATE INDEX IF NOT EXISTS idx_messages_category ON messages(category);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 26,
    sql: `
      CREATE TABLE IF NOT EXISTS workflow_defs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL,
        definition TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS workflow_runs (
        run_id TEXT PRIMARY KEY,
        workflow_def_id TEXT NOT NULL,
        workflow_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','paused','done','failed')),
        trigger TEXT,
        context TEXT,
        pending_gate TEXT,
        user_input TEXT,
        started_at INTEGER NOT NULL,
        completed_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS workflow_step_runs (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL REFERENCES workflow_runs(run_id) ON DELETE CASCADE,
        step_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','running','done','failed','skipped')),
        input TEXT,
        output TEXT,
        error TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_wf_runs_def_id ON workflow_runs(workflow_def_id);
      CREATE INDEX IF NOT EXISTS idx_wf_runs_status ON workflow_runs(status);
      CREATE INDEX IF NOT EXISTS idx_wf_step_runs_run_id ON workflow_step_runs(run_id);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 27,
    sql: `
      CREATE TABLE IF NOT EXISTS evaluation_events (
        id TEXT PRIMARY KEY,
        timestamp INTEGER NOT NULL,
        trace_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        source TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        parent_event_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_ev_ts ON evaluation_events(timestamp);
      CREATE INDEX IF NOT EXISTS idx_ev_type ON evaluation_events(type);
      CREATE INDEX IF NOT EXISTS idx_ev_trace ON evaluation_events(trace_id);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 28,
    sql: `
      ALTER TABLE memories ADD COLUMN behavior_score REAL NOT NULL DEFAULT 0.5;
      ALTER TABLE memories ADD COLUMN last_accessed_at INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN manual_score_override REAL;

      CREATE TABLE IF NOT EXISTS interaction_log (
        id TEXT PRIMARY KEY,
        user_text TEXT NOT NULL,
        response_time_ms INTEGER,
        topics TEXT NOT NULL DEFAULT '[]',
        is_explicit_remember INTEGER NOT NULL DEFAULT 0,
        rementioned_memory_ids TEXT NOT NULL DEFAULT '[]',
        timestamp INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_interaction_log_ts ON interaction_log(timestamp);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 29,
    sql: `
      ALTER TABLE memories ADD COLUMN topics TEXT NOT NULL DEFAULT '[]';
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 30,
    sql: `
      ALTER TABLE memories ADD COLUMN utility_score REAL NOT NULL DEFAULT 0.5;
      ALTER TABLE memories ADD COLUMN agent_reference_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN user_confirmed_useful_count INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE memories ADD COLUMN last_utility_update_at INTEGER NOT NULL DEFAULT 0;
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 31,
    sql: `
      -- Composite index for trace replay queries (WHERE trace_id = ? ORDER BY timestamp ASC)
      CREATE INDEX IF NOT EXISTS idx_ev_trace_ts ON evaluation_events(trace_id, timestamp);

      -- Guardrail decision persistence for historical reproducibility
      CREATE TABLE IF NOT EXISTS guardrail_decisions (
        decision_id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        action TEXT NOT NULL,
        runtime_action TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        signals TEXT NOT NULL,
        decided_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gd_trace ON guardrail_decisions(trace_id);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 32,
    sql: `
      -- Metrics projection for guardrail analytics (hourly windows)
      CREATE TABLE IF NOT EXISTS guardrail_metrics (
        id TEXT PRIMARY KEY,
        window_since INTEGER NOT NULL,
        window_until INTEGER NOT NULL,
        checked_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        terminated_count INTEGER NOT NULL DEFAULT 0,
        continue_count INTEGER NOT NULL DEFAULT 0,
        total_signals_healthy INTEGER NOT NULL DEFAULT 0,
        total_signals_degrading INTEGER NOT NULL DEFAULT 0,
        total_signals_stalled INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_gm_window ON guardrail_metrics(window_since, window_until);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 33,
    sql: `
      -- R2-A: Replay sequence number for cursor-based iteration
      ALTER TABLE evaluation_events ADD COLUMN seq INTEGER;
      CREATE INDEX IF NOT EXISTS idx_ev_seq ON evaluation_events(seq);
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 34,
    sql: `
      -- R2-B: Projection checkpoint table for resumable rebuild
      CREATE TABLE IF NOT EXISTS projection_checkpoints (
        projection_name TEXT PRIMARY KEY,
        last_seq INTEGER NOT NULL,
        last_updated_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle'
          CHECK(status IN ('idle', 'running', 'failed')),
        error TEXT
      );
    `,
    revert: 'DROP TABLE IF EXISTS projection_checkpoints;',
    category: 'schema',
  },
  {
    version: 35,
    sql: `
      -- R1-A: Retention DELETE indexes for guardrail_decisions and guardrail_metrics
      CREATE INDEX IF NOT EXISTS idx_gd_decided_at ON guardrail_decisions(decided_at);
      CREATE INDEX IF NOT EXISTS idx_gm_updated_at ON guardrail_metrics(updated_at);
    `,
    revert: `
      DROP INDEX IF EXISTS idx_gd_decided_at;
      DROP INDEX IF EXISTS idx_gm_updated_at;
    `,
    category: 'index',
  },
  {
    version: 36,
    sql: `
      ALTER TABLE memories ADD COLUMN structured_data TEXT;
    `,
    revert: '',
    category: 'schema',
  },
  {
    version: 37,
    sql: `
      CREATE TABLE IF NOT EXISTS memories_new (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('user_fact', 'interaction', 'task_state', 'user_profile', 'fictional')),
        content TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        tier TEXT NOT NULL DEFAULT 'ephemeral',
        reinforce_count INTEGER NOT NULL DEFAULT 0,
        behavior_score REAL NOT NULL DEFAULT 0.5,
        last_accessed_at INTEGER NOT NULL DEFAULT 0,
        access_count INTEGER NOT NULL DEFAULT 0,
        is_pinned INTEGER NOT NULL DEFAULT 0,
        manual_score_override REAL,
        topics TEXT NOT NULL DEFAULT '[]',
        utility_score REAL NOT NULL DEFAULT 0.5,
        agent_reference_count INTEGER NOT NULL DEFAULT 0,
        user_confirmed_useful_count INTEGER NOT NULL DEFAULT 0,
        last_utility_update_at INTEGER NOT NULL DEFAULT 0,
        structured_data TEXT
      );
      INSERT INTO memories_new SELECT * FROM memories;
      DROP TABLE memories;
      ALTER TABLE memories_new RENAME TO memories;
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_content ON memories(content);
    `,
    revert: '',
    category: 'schema',
    irreversible: true,
  },
  {
    version: 38,
    sql: `
      CREATE TABLE IF NOT EXISTS evolution_checkpoints (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        phase TEXT NOT NULL CHECK(phase IN ('pre_cycle','pre_pipeline','in_collect','pre_execute','post_execute','pre_commit')),
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','in_progress','completed','failed','rolled_back','interrupted')),
        git_snapshot_branch TEXT,
        stash_message TEXT,
        target_files TEXT,
        git_head_hash TEXT,
        step_data TEXT,
        created_at INTEGER NOT NULL,
        completed_at INTEGER,
        error TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_evo_ckpt_cycle ON evolution_checkpoints(cycle_id);
      CREATE INDEX IF NOT EXISTS idx_evo_ckpt_status ON evolution_checkpoints(status);
    `,
    revert: 'DROP TABLE IF EXISTS evolution_checkpoints;',
    category: 'schema',
  },
  {
    version: 39,
    sql: `
      CREATE TABLE IF NOT EXISTS checkpoint_store (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
    revert: 'DROP TABLE IF EXISTS checkpoint_store;',
    category: 'schema',
  },
]

// 导出迁移数组供测试验证
export { MIGRATIONS }

export function runMigrations(sqlite: MigrationDatabase): void {
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

/**
 * 应用单条迁移的 revert SQL（R5-C）。
 *
 * 注意：不修改 _migrations 表。回滚通过前向修正迁移实现。
 * revert 是手动操作，只在需要撤销某条迁移时由运维触发。
 */
export function revertMigration(sqlite: SqlJsDatabase, version: number): void {
  const m = MIGRATIONS.find((x) => x.version === version)
  if (!m) {
    log('WARN', 'db_migration_revert_not_found', { version })
    return
  }
  if (m.irreversible) {
    log('ERROR', 'db_migration_revert_irreversible', { version, detail: 'This migration cannot be reversed without data loss.' })
    return
  }
  if (!m.revert || m.revert.length === 0) {
    log('WARN', 'db_migration_revert_noop', { version, detail: 'Migration has no revert SQL (e.g. ADD COLUMN); schema change stays.' })
    return
  }
  log('INFO', 'db_migration_revert_applying', { version })
  sqlite.run(m.revert)
  log('INFO', 'db_migration_revert_applied', { version })
}
