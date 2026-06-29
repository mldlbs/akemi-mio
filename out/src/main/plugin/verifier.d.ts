/**
 * Verify a plugin file — accept if:
 *  1. Built-in plugin (outside userData), OR
 *  2. Has a valid Ed25519 signature, OR
 *  3. SHA-256 matches an allowlist entry (legacy fallback)
 *
 * Returns true if the plugin is trusted.
 */
export declare function verifyPlugin(filePath: string, pluginName: string): boolean;
