/**
 * Strip markdown code fences from an LLM reply.
 * Handles:
 *   ```json ... ```
 *   ``` ... ```
 *   `...` (single backtick)
 *   No fences at all (returns original)
 */
export declare function stripCodeFences(text: string): string;
/**
 * Extract a JSON string from an LLM reply, handling markdown code fences
 * and surrounding explanatory text.
 *
 * Strategy:
 *  1. Strip markdown code fences via stripCodeFences()
 *  2. Find the first { or [ character
 *  3. Walk character by character tracking bracket depth, string escaping
 *  4. When depth returns to 0, return that substring
 *  5. If no balanced brackets found, return null
 */
export declare function extractJsonFromLLMReply(reply: string): string | null;
/**
 * Attempt to parse an LLM reply as JSON, with automatic handling of
 * markdown code fences and surrounding explanatory text.
 * Returns the parsed value on success, or null on failure.
 */
export declare function tryParseLLMJson<T = unknown>(reply: string): T | null;
