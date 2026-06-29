import { log } from '../logger/Logger';
import { getRawDb } from '../db/connection';
let idCounter = 0;
export class GoalEngine {
    getActiveGoals(category) {
        const db = getRawDb();
        const where = category ? "WHERE status = 'active' AND category = ?" : "WHERE status = 'active'";
        const params = category ? [category] : [];
        const rows = db.exec(`SELECT * FROM goals ${where} ORDER BY priority DESC, created_at DESC`)[0];
        return rows ? rows.values.map((v) => this.rowToGoal(rows.columns, v)) : [];
    }
    getGoal(id) {
        const db = getRawDb();
        const rows = db.exec('SELECT * FROM goals WHERE id = ?', [id])[0];
        if (!rows)
            return null;
        return this.rowToGoal(rows.columns, rows.values[0]);
    }
    create(input) {
        const db = getRawDb();
        const id = `goal_${Date.now()}_${++idCounter}`;
        const now = Date.now();
        db.run(`INSERT INTO goals (id, title, description, priority, status, category, parent_goal_id, progress, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`, [id, input.title, input.description, input.priority, input.status, input.category, input.parentGoalId || null, now, now]);
        log('INFO', 'goal_created', { id, title: input.title, category: input.category });
        return { ...input, id, parentGoalId: input.parentGoalId || null, progress: 0, createdAt: now, updatedAt: now };
    }
    updateProgress(id, delta) {
        const db = getRawDb();
        const goal = this.getGoal(id);
        if (!goal)
            return;
        const newProgress = Math.min(100, Math.max(0, goal.progress + delta));
        db.run('UPDATE goals SET progress = ?, updated_at = ? WHERE id = ?', [newProgress, Date.now(), id]);
        if (newProgress >= 100) {
            db.run("UPDATE goals SET status = 'completed', updated_at = ? WHERE id = ?", [Date.now(), id]);
            log('INFO', 'goal_completed', { id, title: goal.title });
        }
    }
    setStatus(id, status) {
        const db = getRawDb();
        db.run('UPDATE goals SET status = ?, updated_at = ? WHERE id = ?', [status, Date.now(), id]);
        log('INFO', 'goal_status_changed', { id, status });
    }
    getFormattedContext() {
        const active = this.getActiveGoals();
        if (active.length === 0)
            return '';
        const parts = ['---', '【当前目标】'];
        for (const g of active) {
            const bar = '█'.repeat(Math.floor(g.progress / 10)) + '░'.repeat(10 - Math.floor(g.progress / 10));
            parts.push(`[${g.category}] ${g.title} (${g.progress}%) ${bar}`);
            if (g.description)
                parts.push(`   ${g.description}`);
        }
        parts.push('---');
        return parts.join('\n');
    }
    adjustPrioritiesByToken(tokenBalance) {
        const goals = this.getActiveGoals();
        const lowCost = goals.filter((g) => this.estimateTokenCost(g) < 1000);
        const highCost = goals.filter((g) => this.estimateTokenCost(g) >= 1000);
        if (tokenBalance < 5000) {
            for (const g of lowCost)
                dbUpdatePriority(g.id, Math.max(g.priority, 5));
            for (const g of highCost)
                dbUpdatePriority(g.id, Math.min(g.priority, 3));
        }
        else {
            for (const g of [...lowCost, ...highCost])
                dbUpdatePriority(g.id, g.priority);
        }
    }
    estimateTokenCost(goal) {
        const costMap = {
            mission: 5000,
            long_term: 3000,
            short_term: 800,
            initiative: 2000,
        };
        return costMap[goal.category] || 1000;
    }
    rowToGoal(columns, values) {
        const obj = {};
        for (let i = 0; i < columns.length; i++)
            obj[columns[i]] = values[i];
        return {
            id: obj.id,
            title: obj.title,
            description: obj.description,
            priority: obj.priority,
            status: obj.status,
            category: obj.category,
            parentGoalId: obj.parent_goal_id || null,
            progress: obj.progress,
            createdAt: obj.created_at,
            updatedAt: obj.updated_at,
        };
    }
}
function dbUpdatePriority(id, priority) {
    const db = getRawDb();
    db.run('UPDATE goals SET priority = ?, updated_at = ? WHERE id = ?', [priority, Date.now(), id]);
}
