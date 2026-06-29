export interface ChatResult {
    reply?: string;
    error?: string;
}
export type ChunkCallback = (text: string) => void;
