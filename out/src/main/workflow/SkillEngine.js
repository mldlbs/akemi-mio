/**
 * 为 skill 生成带元数据的增强 prompt。
 * 兼容旧有 promptModule，在此基础上附加 ironLaw / redFlags / rationalizations / checklist。
 */
export function renderSkillPrompt(skill) {
    const parts = [skill.promptModule];
    // 铁律
    if (skill.ironLaw) {
        parts.push(`\n### ⚡ 铁律\n${skill.ironLaw}`);
    }
    // 红线标志
    if (skill.redFlags && skill.redFlags.length > 0) {
        parts.push(`\n### 🚩 红线 — 看到这些信号立即 STOP\n${skill.redFlags.map((f) => `- 🛑 ${f}`).join('\n')}`);
    }
    // 借口对照表
    if (skill.rationalizations && skill.rationalizations.length > 0) {
        parts.push(`\n### 🧠 常见借口 vs 现实\n${skill.rationalizations.map((r) => `| "${r.excuse}" | → ${r.reality} |`).join('\n')}`);
    }
    // Checklist
    if (skill.checklist && skill.checklist.length > 0) {
        const required = skill.checklist.filter((c) => c.required).map((c) => `- [ ] ${c.label} — ${c.description}`);
        if (required.length > 0) {
            parts.push(`\n### ✅ 必需检查项\n${required.join('\n')}`);
        }
    }
    // 禁止行为
    if (skill.antiPatterns && skill.antiPatterns.length > 0) {
        parts.push(`\n### ⛔ 禁止行为\n${skill.antiPatterns.map((a) => `- ❌ ${a}`).join('\n')}`);
    }
    return parts.join('\n\n');
}
/**
 * 渲染依赖/推荐链。
 */
export function renderSkillReferences(skill) {
    const all = [...(skill.requires || []), ...(skill.recommends || [])];
    if (all.length === 0)
        return '';
    return all
        .map((ref) => {
        const tag = ref.type === 'required' ? '🔴' : ref.type === 'recommended' ? '🟢' : '🟡';
        return `- ${tag} [${ref.type}] ${ref.name}: ${ref.description}`;
    })
        .join('\n');
}
/**
 * 完整 prompt 注入：核心指令 + 元数据 + 依赖链
 */
export function renderFullSkillPrompt(skill) {
    const sections = [renderSkillPrompt(skill)];
    const refs = renderSkillReferences(skill);
    if (refs) {
        sections.push(`### 🔗 关联技能\n${refs}`);
    }
    return sections.join('\n\n');
}
/**
 * 列出技能所有关联依赖（包括嵌套）。
 */
export function getAllDependencies(skill, allSkills) {
    const required = [];
    const recommended = [];
    const visit = (s, visited) => {
        for (const ref of s.requires || []) {
            const dep = allSkills.get(ref.name);
            if (dep && !visited.has(dep.name)) {
                visited.add(dep.name);
                required.push(dep);
                visit(dep, visited);
            }
        }
        for (const ref of s.recommends || []) {
            const dep = allSkills.get(ref.name);
            if (dep && !visited.has(dep.name)) {
                visited.add(dep.name);
                recommended.push(dep);
                visit(dep, visited);
            }
        }
    };
    visit(skill, new Set([skill.name]));
    return { required, recommended };
}
/**
 * 将一组 skill 按依赖拓扑排序。
 * 简单的 BFS：required skill 排在被引用者前面。
 */
export function sortByDependencies(skills, allSkills) {
    const sorted = [];
    const visited = new Set();
    const visit = (s) => {
        if (visited.has(s.name))
            return;
        visited.add(s.name);
        for (const ref of s.requires || []) {
            const dep = allSkills.get(ref.name);
            if (dep)
                visit(dep);
        }
        sorted.push(s);
    };
    for (const s of skills)
        visit(s);
    return sorted;
}
