import { buildTool, formatToolResult, formatToolError } from '../types';
const WRITING_API = 'https://www.crlkcloud.cyou/writing/api';
async function writingFetch(method, path, body) {
    const url = `${WRITING_API}${path}`;
    const res = await fetch(url, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    return res.json();
}
export const writingSystemTool = buildTool({
    name: 'writing_system',
    description: '远程写作系统 v2.0 — 创建/查询/更新/删除故事、角色、章节、关系、剧情线，全文搜索。秋山澪通过此工具在服务器上直接创作小说。支持：list_stories, get_story, create_story, update_story, delete_story, list_characters, create_character, update_character, delete_character, list_scenes, get_scene, create_scene, update_scene, delete_scene, list_relationships, create_relationship, update_relationship, delete_relationship, list_plotlines, search, ai_write',
    inputJSONSchema: {
        type: 'object',
        properties: {
            action: {
                type: 'string',
                description: '操作类型: list_stories | get_story | create_story | update_story | delete_story | list_characters | create_character | update_character | delete_character | list_scenes | get_scene | create_scene | update_scene | delete_scene | list_relationships | create_relationship | update_relationship | delete_relationship | list_plotlines | search | ai_write',
            },
            data: {
                type: 'string',
                description: '操作数据，JSON 字符串。各操作所需字段：\n- create_story: { "title": "故事名", "genre": "类型", "description": "简介" }\n- update_story: { "storyId": "ID", "title?": "新标题", "genre?": "新类型", "description?": "新简介" }\n- delete_story: { "storyId": "ID" }\n- create_character: { "name": "角色名", "storyId": "故事ID", "role": "主角/配角", "attributes": { "personality": "性格" } }\n- update_character: { "characterId": "ID", "name?": "新名", "role?": "新定位", "attributes?": { "personality": "..." } }\n- delete_character: { "characterId": "ID" }\n- create_scene: { "title": "章节标题", "content": "正文内容...", "storyId": "故事ID", "order": 序号 }\n- update_scene: { "sceneId": "ID", "title?": "新标题", "content?": "新内容", "order?": 新序号 }\n- delete_scene: { "sceneId": "ID" }\n- create_relationship: { "sourceId": "角色ID1", "targetId": "角色ID2", "type": "关系类型" }\n- update_relationship: { "relationshipId": "ID", "type": "新类型" }\n- delete_relationship: { "relationshipId": "ID" }\n- search: { "query": "搜索关键词" }\n- ai_write: { "prompt": "写作提示", "storyId": "故事ID(可选)", "temperature": 0.8 }',
            },
            storyId: {
                type: 'string',
                description: '故事ID（get_story / list_characters / list_scenes / list_relationships / list_plotlines 时需要）',
            },
            characterId: {
                type: 'string',
                description: '角色ID（get_character 时需要）',
            },
            sceneId: {
                type: 'string',
                description: '章节ID（get_scene 时需要）',
            },
        },
        required: ['action'],
    },
    handler: async (args) => {
        const { action, data, storyId, characterId, sceneId } = args;
        try {
            switch (action) {
                case 'list_stories': {
                    const stories = await writingFetch('GET', '/stories');
                    return formatToolResult(JSON.stringify(stories, null, 2));
                }
                case 'get_story': {
                    if (!storyId)
                        return formatToolError('需要 storyId');
                    const story = await writingFetch('GET', `/stories/${storyId}`);
                    return formatToolResult(JSON.stringify(story, null, 2));
                }
                case 'create_story': {
                    const body = data ? JSON.parse(data) : {};
                    const result = await writingFetch('POST', '/stories', body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'update_story': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.storyId)
                        return formatToolError('需要 storyId');
                    const result = await writingFetch('PUT', `/stories/${body.storyId}`, body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'delete_story': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.storyId)
                        return formatToolError('需要 storyId');
                    const result = await writingFetch('DELETE', `/stories/${body.storyId}`);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'list_characters': {
                    const query = storyId ? `?storyId=${storyId}` : '';
                    const chars = await writingFetch('GET', `/characters${query}`);
                    return formatToolResult(JSON.stringify(chars, null, 2));
                }
                case 'create_character': {
                    const body = data ? JSON.parse(data) : {};
                    const result = await writingFetch('POST', '/characters', body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'update_character': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.characterId)
                        return formatToolError('需要 characterId');
                    const result = await writingFetch('PUT', `/characters/${body.characterId}`, body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'delete_character': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.characterId)
                        return formatToolError('需要 characterId');
                    const result = await writingFetch('DELETE', `/characters/${body.characterId}`);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'list_scenes': {
                    if (!storyId)
                        return formatToolError('需要 storyId');
                    const scenes = await writingFetch('GET', `/scenes?storyId=${storyId}`);
                    return formatToolResult(JSON.stringify(scenes, null, 2));
                }
                case 'get_scene': {
                    const body = data ? JSON.parse(data) : {};
                    const sid = body?.sceneId || sceneId;
                    if (!sid)
                        return formatToolError('需要 sceneId');
                    const scene = await writingFetch('GET', `/scenes/${sid}`);
                    return formatToolResult(JSON.stringify(scene, null, 2));
                }
                case 'create_scene': {
                    const body = data ? JSON.parse(data) : {};
                    const result = await writingFetch('POST', '/scenes', body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'update_scene': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.sceneId)
                        return formatToolError('需要 sceneId');
                    const result = await writingFetch('PUT', `/scenes/${body.sceneId}`, body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'delete_scene': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.sceneId)
                        return formatToolError('需要 sceneId');
                    const result = await writingFetch('DELETE', `/scenes/${body.sceneId}`);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'list_relationships': {
                    const query = storyId ? `?storyId=${storyId}` : '';
                    const rels = await writingFetch('GET', `/relationships${query}`);
                    return formatToolResult(JSON.stringify(rels, null, 2));
                }
                case 'create_relationship': {
                    const body = data ? JSON.parse(data) : {};
                    const result = await writingFetch('POST', '/relationships', body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'update_relationship': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.relationshipId)
                        return formatToolError('需要 relationshipId');
                    const result = await writingFetch('PUT', `/relationships/${body.relationshipId}`, body);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'delete_relationship': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.relationshipId)
                        return formatToolError('需要 relationshipId');
                    const result = await writingFetch('DELETE', `/relationships/${body.relationshipId}`);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'list_plotlines': {
                    const query = storyId ? `?storyId=${storyId}` : '';
                    const plots = await writingFetch('GET', `/plotlines${query}`);
                    return formatToolResult(JSON.stringify(plots, null, 2));
                }
                case 'search': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.query)
                        return formatToolError('需要 query');
                    const result = await writingFetch('GET', `/search?q=${encodeURIComponent(body.query)}`);
                    return formatToolResult(JSON.stringify(result, null, 2));
                }
                case 'ai_write': {
                    const body = data ? JSON.parse(data) : {};
                    if (!body.prompt)
                        return formatToolError('需要 prompt');
                    const result = await writingFetch('POST', '/ai/write', body);
                    return formatToolResult(result.content || JSON.stringify(result));
                }
                default:
                    return formatToolError(`未知操作: ${action}`);
            }
        }
        catch (e) {
            return formatToolError(e.message);
        }
    },
});
