import type { CapabilityProviderAdapter } from '@akemi-mio/capabilities/capability/types'

/**
 * file.management adapter — canonical → tool-specific params
 *
 * Canonical input:
 *   { operation: "read"|"write"|"edit"|"delete"|"move"|"copy"|"create_directory"|"list",
 *     path: string,
 *     content?: string }
 *
 * Provider tools:
 *   read_file      → { path }
 *   write_file     → { path, content }
 *   edit_file      → { path, content }
 *   delete_file    → { path }
 *   move_file      → { source: path, destination: content }
 *   copy_file      → { source: path, destination: content }
 *   create_directory → { path }
 *   list_files     → { path }
 */
export const fileSystemAdapter: CapabilityProviderAdapter = (input: unknown, tool: string): unknown => {
  const raw = input as Record<string, unknown>

  switch (tool) {
    case 'read_file':
    case 'delete_file':
    case 'create_directory':
    case 'list_files':
      return { path: raw.path ?? '' }

    case 'write_file':
    case 'edit_file':
      return { path: raw.path ?? '', content: raw.content ?? '' }

    case 'move_file':
    case 'copy_file':
      return { source: raw.path ?? '', destination: raw.content ?? '' }

    default:
      return input
  }
}


