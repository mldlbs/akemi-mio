import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { validateSandboxHtml, validateAllSandboxes } from '../SandboxValidator';
import { tmpdir } from 'os';
import { join } from 'path';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
vi.mock('../../logger/Logger', () => ({ log: vi.fn() }));
const VALID_HTML = '<!DOCTYPE html>\n<html>\n<head><meta charset="utf-8"><title>Test</title></head>\n<body><h1>Hello</h1></body>\n</html>';
const INVALID_HTML = '<h1>Missing doctype and tags</h1>';
function makeTestDir() {
    const d = join(tmpdir(), `sandbox-test-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
}
describe('SandboxValidator', () => {
    let testDir;
    beforeEach(() => {
        testDir = makeTestDir();
    });
    afterEach(() => {
        try {
            rmSync(testDir, { recursive: true });
        }
        catch {
            /* ignore */
        }
    });
    it('有效 HTML 通过验证', () => {
        const file = join(testDir, 'test.html');
        writeFileSync(file, VALID_HTML, 'utf-8');
        const result = validateSandboxHtml(file);
        expect(result.passed).toBe(true);
        expect(result.html.valid).toBe(true);
    });
    it('缺少 DOCTYPE 报错', () => {
        const file = join(testDir, 'invalid.html');
        writeFileSync(file, INVALID_HTML, 'utf-8');
        const result = validateSandboxHtml(file);
        expect(result.passed).toBe(false);
        expect(result.html.errors.some((e) => e.includes('DOCTYPE'))).toBe(true);
    });
    it('文件不存在返回失败', () => {
        const result = validateSandboxHtml('/nonexistent/file.html');
        expect(result.passed).toBe(false);
        expect(result.html.errors.some((e) => e.includes('读取'))).toBe(true);
    });
    it('缺失 error boundary 触发 warning', () => {
        const file = join(testDir, 'no-error-boundary.html');
        writeFileSync(file, VALID_HTML, 'utf-8');
        const result = validateSandboxHtml(file);
        expect(result.rendering.some((r) => r.rule === 'missing-error-boundary')).toBe(true);
    });
    it('validateAllSandboxes 扫描目录', () => {
        const sandboxDir = join(testDir, 'sandbox');
        mkdirSync(sandboxDir, { recursive: true });
        const projDir = join(sandboxDir, 'my-project');
        mkdirSync(projDir, { recursive: true });
        writeFileSync(join(projDir, 'my-project.html'), VALID_HTML, 'utf-8');
        const result = validateAllSandboxes(sandboxDir);
        expect(result.total).toBe(1);
        expect(result.passed).toBe(1);
    });
    it('validateAllSandboxes 空目录返回 0', () => {
        const emptyDir = join(testDir, 'empty');
        mkdirSync(emptyDir, { recursive: true });
        const result = validateAllSandboxes(emptyDir);
        expect(result.total).toBe(0);
    });
    it('不存在的目录返回 0', () => {
        const result = validateAllSandboxes(join(testDir, 'noexist'));
        expect(result.total).toBe(0);
    });
});
