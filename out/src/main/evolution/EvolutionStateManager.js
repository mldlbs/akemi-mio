import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { log } from '../logger/Logger';
/**
 * 状态持久化管理器 — save/restore cooling state across restarts。
 * 从 SelfEvolutionService 提取。
 */
export class EvolutionStateManager {
    constructor(stateFilePath) {
        this.tryRunFailures = 0;
        this.recoveryCooldownUntil = 0;
        this.lastSuccessTime = 0;
        this.recentAnalysisFingerprints = [];
        this.currentAnalysisTimeoutMs = 120000;
        this.promptTrimMode = true;
        this.historyMaxEntries = 5;
        this.analysisStuckTimeoutMs = 60000;
        this.stateFilePath = stateFilePath;
    }
    load() {
        try {
            if (!existsSync(this.stateFilePath))
                return;
            const raw = readFileSync(this.stateFilePath, 'utf-8');
            const state = JSON.parse(raw);
            if (typeof state.tryRunFailures === 'number')
                this.tryRunFailures = state.tryRunFailures;
            if (typeof state.recoveryCooldownUntil === 'number')
                this.recoveryCooldownUntil = state.recoveryCooldownUntil;
            if (typeof state.lastSuccessTime === 'number')
                this.lastSuccessTime = state.lastSuccessTime;
            if (Array.isArray(state.recentAnalysisFingerprints))
                this.recentAnalysisFingerprints = state.recentAnalysisFingerprints;
            if (typeof state.currentAnalysisTimeoutMs === 'number')
                this.currentAnalysisTimeoutMs = state.currentAnalysisTimeoutMs;
            if (typeof state.promptTrimMode === 'boolean')
                this.promptTrimMode = state.promptTrimMode;
            if (typeof state.analysisStuckTimeoutMs === 'number')
                this.analysisStuckTimeoutMs = state.analysisStuckTimeoutMs;
            if (typeof state.historyMaxEntries === 'number')
                this.historyMaxEntries = state.historyMaxEntries;
            log('INFO', 'evolution_state_loaded', {
                tryRunFailures: this.tryRunFailures,
                cooldownActive: this.recoveryCooldownUntil > 0 && Date.now() < this.recoveryCooldownUntil,
                currentAnalysisTimeoutMs: this.currentAnalysisTimeoutMs,
                promptTrimMode: this.promptTrimMode,
            });
        }
        catch (err) {
            log('WARN', 'evolution_state_load_failed', { error: String(err) });
        }
    }
    save() {
        try {
            const state = {
                tryRunFailures: this.tryRunFailures,
                recoveryCooldownUntil: this.recoveryCooldownUntil,
                lastSuccessTime: this.lastSuccessTime,
                recentAnalysisFingerprints: this.recentAnalysisFingerprints,
                currentAnalysisTimeoutMs: this.currentAnalysisTimeoutMs,
                promptTrimMode: this.promptTrimMode,
                historyMaxEntries: this.historyMaxEntries,
                analysisStuckTimeoutMs: this.analysisStuckTimeoutMs,
                savedAt: Date.now(),
            };
            const dir = dirname(this.stateFilePath);
            if (!existsSync(dir))
                mkdirSync(dir, { recursive: true });
            writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), 'utf-8');
        }
        catch (err) {
            log('WARN', 'evolution_state_save_failed', { error: String(err) });
        }
    }
    computeFingerprint(summary) {
        return summary.replace(/\s+/g, ' ').slice(0, 100).trim();
    }
    isDegenerate(threshold) {
        if (this.recentAnalysisFingerprints.length < threshold)
            return { degenerate: false };
        const recent = this.recentAnalysisFingerprints.slice(-threshold);
        if (recent.every((fp) => fp === recent[0])) {
            return { degenerate: true, reason: `Degenerate: ${threshold} consecutive identical conclusions` };
        }
        return { degenerate: false };
    }
    recordAnalysisFingerprint(summary) {
        const fp = this.computeFingerprint(summary);
        this.recentAnalysisFingerprints.push(fp);
        if (this.recentAnalysisFingerprints.length > 10) {
            this.recentAnalysisFingerprints = this.recentAnalysisFingerprints.slice(-10);
        }
    }
}
