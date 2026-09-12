export interface ToolCallIdentity {
  capability?: string
  operation?: string
  provider?: string
}

export function inferCapabilityOperation(capabilityId: string, args: Record<string, any>, toolName?: string): string | undefined {
  if (capabilityId === 'file.management') {
    if (typeof args.operation === 'string' && args.operation.length > 0) {
      return args.operation
    }

    const byToolName: Record<string, string> = {
      read_file: 'read',
      list_files: 'read',
      write_file: 'write',
      edit_file: 'edit',
      delete_file: 'delete',
      move_file: 'move',
      copy_file: 'copy',
      create_directory: 'create_directory',
    }
    if (toolName && byToolName[toolName]) {
      return byToolName[toolName]
    }

    return undefined
  }
  if (capabilityId === 'search.retrieval') return 'query'
  if (capabilityId === 'system.execution') return args.command ? 'run' : undefined
  if (capabilityId === 'browser.automation') {
    return typeof args.action === 'string' && args.action.length > 0 ? args.action : 'navigate'
  }
  if (capabilityId === 'content.drafting' || capabilityId === 'publishing') return 'generate'
  return undefined
}
