/**
 * Strip markdown code fences from an LLM reply.
 * Handles:
 *   ```json ... ```
 *   ``` ... ```
 *   `...` (single backtick)
 *   No fences at all (returns original)
 */
export function stripCodeFences(text: string): string {
  let s = text.trim()

  // Triple backtick fences: optional "json" or other language tag after opening ```
  const tripleMatch = s.match(/^```(?:\w+)?\s*\n?([\s\S]*?)```\s*$/)
  if (tripleMatch) {
    return tripleMatch[1].trim()
  }

  // Single backtick wrapping: `...`
  if (s.startsWith('`') && s.endsWith('`') && s.length >= 2) {
    const inner = s.slice(1, -1).trim()
    // Only unwrap if there's no triple-fence inside (shouldn't happen, but be safe)
    if (!inner.includes('```')) {
      return inner
    }
  }

  return s
}

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
export function extractJsonFromLLMReply(reply: string): string | null {
  const cleaned = stripCodeFences(reply)
  if (!cleaned) return null

  // Find first structural character
  const firstBrace = cleaned.indexOf('{')
  const firstBracket = cleaned.indexOf('[')
  let start = -1
  let openChar = ''
  let closeChar = ''

  if (firstBrace === -1 && firstBracket === -1) return null

  if (firstBrace >= 0 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace
    openChar = '{'
    closeChar = '}'
  } else {
    start = firstBracket
    openChar = '['
    closeChar = ']'
  }

  // Walk through the string from start, tracking bracket depth
  let depth = 0
  let inString = false
  let escaped = false

  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i]

    if (escaped) {
      escaped = false
      continue
    }

    if (inString) {
      if (ch === '\\') {
        escaped = true
      } else if (ch === '"') {
        inString = false
      }
      continue
    }

    // Not in a string
    if (ch === '"') {
      inString = true
      continue
    }

    if (ch === openChar) {
      depth++
    } else if (ch === closeChar) {
      depth--
      if (depth === 0) {
        // Found the balanced JSON — return it
        return cleaned.slice(start, i + 1)
      }
    }
  }

  // Unbalanced brackets — return null rather than invalid JSON
  return null
}

/**
 * Attempt to parse an LLM reply as JSON, with automatic handling of
 * markdown code fences and surrounding explanatory text.
 * Returns the parsed value on success, or null on failure.
 */
export function tryParseLLMJson<T = unknown>(reply: string): T | null {
  // Fast path: try direct parse first
  try {
    return JSON.parse(reply) as T
  } catch {
    // Fall through to extraction
  }

  const extracted = extractJsonFromLLMReply(reply)
  if (extracted) {
    try {
      return JSON.parse(extracted) as T
    } catch {
      // Extraction found something but it's still not valid JSON
    }
  }

  return null
}
