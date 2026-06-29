import { log } from '../logger/Logger';
import { getRawDb } from '../db/connection';
import { estimateTokens } from '../agent/context';
// token_account: key TEXT PRIMARY KEY, value TEXT
// token_transactions: id, type(income/expense), amount, category, note, created_at
const SEED_BALANCE = 100000;
/** 余额低于此值时触发自动补充，确保一次完整 Evolution 分析（~60k）不会因余额而中断 */
const MAINTENANCE_FLOOR = 30000;
/** 单次补充最大金额 */
const MAINTENANCE_REFILL = 100000;
/** 每小时自动收入（仅在线时） */
const HOURLY_ALLOWANCE = 8000;
const TASK_COST_ESTIMATES = {
    analysis: 2000,
    plan_execution: 5000,
    code_generation: 3000,
    memory_query: 500,
    content_generation: 2000,
    image_generation: 4000,
    video_generation: 8000,
    reflexion: 1000,
    /** 一次带工具调用的 LLM 调用 */
    llm_call_tool: 500,
    /** 一次纯文本回复的 LLM 调用 */
    llm_call_reply: 100,
};
export class TokenAccount {
    constructor() {
        this.initialized = false;
        this.cachedBalance = 0;
    }
    async initialize() {
        if (this.initialized)
            return;
        const db = getRawDb();
        db.run("INSERT OR IGNORE INTO token_account (key, value) VALUES ('balance', '0')");
        db.run("INSERT OR IGNORE INTO token_account (key, value) VALUES ('lifetime_earned', '0')");
        db.run("INSERT OR IGNORE INTO token_account (key, value) VALUES ('lifetime_spent', '0')");
        db.run("INSERT OR IGNORE INTO token_account (key, value) VALUES ('last_allowance_ts', '0')");
        this.cachedBalance = this.getBalance();
        // 首次启动 seed 余额
        if (this.cachedBalance === 0) {
            this.earn(SEED_BALANCE, 'system', '初始种子余额');
        }
        // 日常自动收入：检查上次自动注资时间，按小时补充
        this.applyAutoAllowance();
        this.initialized = true;
        log('INFO', 'token_account_initialized', { balance: this.cachedBalance });
    }
    /** 公开的自动补充入口 — 可在运行时周期性调用 */
    refreshAllowance() {
        this.applyAutoAllowance();
    }
    applyAutoAllowance() {
        const db = getRawDb();
        const row = db.exec("SELECT value FROM token_account WHERE key = 'last_allowance_ts'");
        const lastTs = Number(row[0]?.values?.[0]?.[0] || 0);
        const now = Date.now();
        const hoursElapsed = Math.max(0, (now - lastTs) / 3600000);
        const cycles = Math.floor(hoursElapsed);
        if (cycles > 0) {
            const amount = cycles * HOURLY_ALLOWANCE;
            const effectiveAmount = Math.min(amount, MAINTENANCE_REFILL);
            if (effectiveAmount > 0) {
                this.earn(effectiveAmount, 'auto_allowance', `自动收入 ${cycles}h (${hoursElapsed.toFixed(1)}h 累计)`);
            }
            db.run("UPDATE token_account SET value = ? WHERE key = 'last_allowance_ts'", [String(now)]);
        }
        // 余额低于维护地板时从 MAINTENANCE_REFILL 补充
        if (this.cachedBalance < MAINTENANCE_FLOOR) {
            const refill = MAINTENANCE_REFILL - this.cachedBalance;
            if (refill > 0) {
                this.earn(refill, 'maintenance_refill', `余额过低 (${this.cachedBalance}) 触发补充`);
            }
        }
    }
    getBalance() {
        const db = getRawDb();
        const row = db.exec("SELECT value FROM token_account WHERE key = 'balance'");
        return Number(row[0]?.values?.[0]?.[0] || 0);
    }
    earn(amount, category, note) {
        if (amount <= 0)
            return;
        const db = getRawDb();
        const now = Date.now();
        const id = `txn_${now}_${Math.random().toString(36).slice(2, 6)}`;
        db.run("INSERT INTO token_transactions (id, type, amount, category, note, created_at) VALUES (?, 'income', ?, ?, ?, ?)", [
            id,
            amount,
            category,
            note || '',
            now,
        ]);
        db.run("UPDATE token_account SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'balance'", [amount]);
        db.run("UPDATE token_account SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'lifetime_earned'", [amount]);
        this.cachedBalance = this.getBalance();
        log('INFO', 'token_earned', { amount, category, balance: this.cachedBalance });
    }
    spend(amount, category, note) {
        if (amount <= 0)
            return;
        const db = getRawDb();
        const now = Date.now();
        const id = `txn_${now}_${Math.random().toString(36).slice(2, 6)}`;
        db.run("INSERT INTO token_transactions (id, type, amount, category, note, created_at) VALUES (?, 'expense', ?, ?, ?, ?)", [
            id,
            amount,
            category,
            note || '',
            now,
        ]);
        db.run("UPDATE token_account SET value = CAST(CAST(value AS INTEGER) - ? AS TEXT) WHERE key = 'balance'", [amount]);
        db.run("UPDATE token_account SET value = CAST(CAST(value AS INTEGER) + ? AS TEXT) WHERE key = 'lifetime_spent'", [amount]);
        this.cachedBalance = this.getBalance();
        log('INFO', 'token_spent', { amount, category, balance: this.cachedBalance });
    }
    canAfford(estimatedCost) {
        return this.cachedBalance >= estimatedCost;
    }
    getWealthLevel() {
        if (this.cachedBalance < 3000)
            return 'poor';
        if (this.cachedBalance < 30000)
            return 'moderate';
        return 'rich';
    }
    getRecentSummary(count = 5) {
        const db = getRawDb();
        const rows = db.exec(`SELECT * FROM token_transactions ORDER BY created_at DESC LIMIT ${count}`);
        if (!rows[0]?.values?.length)
            return '';
        const parts = ['【近期 Token 交易】'];
        for (const v of rows[0].values) {
            const type = v[1] === 'income' ? '+' : '-';
            parts.push(`  ${type}${v[2]} (${v[3]})`);
        }
        parts.push(`当前余额: ${this.cachedBalance}`);
        return parts.join('\n');
    }
    getFormattedContext() {
        const wealth = this.getWealthLevel();
        const advice = wealth === 'poor'
            ? 'Token 不足，优先执行低成本任务和收入任务。'
            : wealth === 'moderate'
                ? 'Token 适中，可执行中等成本任务。'
                : 'Token 充足，可执行高成本/高收益任务。';
        return ['---', `【Token 经济】余额: ${this.cachedBalance} | 状态: ${wealth}`, advice, this.getRecentSummary(), '---'].join('\n');
    }
    getLifetimeStats() {
        const db = getRawDb();
        const earned = Number(db.exec("SELECT value FROM token_account WHERE key = 'lifetime_earned'")[0]?.values?.[0]?.[0] || 0);
        const spent = Number(db.exec("SELECT value FROM token_account WHERE key = 'lifetime_spent'")[0]?.values?.[0]?.[0] || 0);
        return { earned, spent };
    }
}
export class CostEstimator {
    estimateLLMCall(prompt, systemPrompt) {
        return estimateTokens(prompt) + estimateTokens(systemPrompt) + 200;
    }
    estimateTask(taskType, complexity = 'medium') {
        const base = TASK_COST_ESTIMATES[taskType] || 2000;
        const multiplier = complexity === 'low' ? 0.5 : complexity === 'high' ? 2 : 1;
        return Math.round(base * multiplier);
    }
    estimateContentRevenue(contentLength) {
        return Math.max(100, Math.round(contentLength / 2));
    }
    isWorthwhile(earnings, cost, threshold = 1.5) {
        return earnings >= cost * threshold;
    }
}
