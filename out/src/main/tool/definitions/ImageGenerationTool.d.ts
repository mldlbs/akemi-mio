import type { MCPToolResult } from '../../mcp/types';
import type { ComfyUIManager } from '../../image/ComfyUIManager';
export declare function setComfyUIManager(mgr: ComfyUIManager | null): void;
export declare const generateImageTool: import("..").Tool<{
    prompt: string;
    negativePrompt?: string;
    size?: string;
    imageCount?: number;
    useComfyUI?: boolean;
    refImage?: string;
}, MCPToolResult>;
