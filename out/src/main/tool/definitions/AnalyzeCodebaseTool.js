import { execSync } from 'child_process';
import { buildTool, formatToolResult, formatToolError } from '../types';
import { PROJECT_ROOT } from '../utils/workspace';
export const analyzeCodebaseTool = buildTool({
    name: 'analyze_codebase',
    description: '分析项目状态：测试结果、lint 错误、TODO 数量',
    inputJSONSchema: {
        type: 'object',
        properties: {
            quick: { type: 'boolean', description: '快速检查（不执行完整测试）' },
        },
        required: [],
    },
    handler: async (args) => {
        try {
            let report = '';
            const isQuick = args.quick !== false;
            report += '【项目状态分析】\n';
            try {
                const todos = execSync('git grep -n "TODO\\|FIXME\\|HACK" -- "*.ts" "*.tsx" "*.js" "*.jsx" 2>nul || echo 0', {
                    cwd: PROJECT_ROOT,
                    encoding: 'utf-8',
                    timeout: 10000,
                }).trim();
                const todoCount = todos === '0' ? 0 : todos.split('\n').length;
                report += `- TODO/FIXME: ${todoCount} 处\n`;
            }
            catch {
                report += '- TODO: 检测失败\n';
            }
            if (!isQuick) {
                try {
                    const testOut = execSync('npx vitest run --reporter=verbose 2>&1', {
                        cwd: PROJECT_ROOT,
                        encoding: 'utf-8',
                        timeout: 60000,
                    }).trim();
                    const lines = testOut.split('\n');
                    const passLine = lines.find((l) => l.includes('Tests') && l.includes('passed'));
                    report += `- 测试结果: ${passLine || testOut.slice(-200)}\n`;
                }
                catch (err) {
                    const out = String(err.stdout || err.message || '').trim();
                    const lines = out.split('\n');
                    const failLine = lines.find((l) => l.includes('Tests') || l.includes('failed'));
                    report += `- 测试结果: ${failLine || out.slice(-200)}\n`;
                }
            }
            try {
                const gitStatus = execSync('git status --short 2>&1', {
                    cwd: PROJECT_ROOT,
                    encoding: 'utf-8',
                    timeout: 5000,
                }).trim();
                const modifiedCount = gitStatus ? gitStatus.split('\n').length : 0;
                report += `- 未提交修改: ${modifiedCount} 个文件\n`;
            }
            catch {
                report += '- Git 状态: 检测失败\n';
            }
            return formatToolResult(report.trim());
        }
        catch (err) {
            return formatToolError(err.message);
        }
    },
    isReadOnly: true,
});
