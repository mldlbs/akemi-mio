// Ambient shims for sibling workspace packages that core sources reference
// but that are intentionally NOT dependencies of the publishable npm package
// (root tsconfig resolves them via `paths`; the standalone build does not).
// Shorthand wildcards type value imports as `any`; modules whose names are
// used in TYPE positions need an explicit `export type X = any` (a shorthand
// module's named import behaves like a namespace → TS2709). All of these sit
// outside the exports whitelist, so npm consumers never load them.
declare module '@akemi-mio/intelligence/*'
declare module '@akemi-mio/evolution/*'
declare module '@akemi-mio/intelligence-mcp/*'
declare module '@akemi-mio/intelligence-memory/*'
declare module '@akemi-mio/intelligence-observer/*'

declare module '@akemi-mio/intelligence/agent/AgentService' {
  export type AgentService = any
}

declare module '@akemi-mio/evolution/SelfEvolutionService' {
  export type SelfEvolutionService = any
}

declare module '@akemi-mio/intelligence-mcp/ServerManager' {
  export type ServerManager = any
}

declare module '@akemi-mio/intelligence-memory/MemoryService' {
  export type MemoryService = any
}

declare module '@akemi-mio/intelligence/agent/context' {
  export type Message = any
  export function estimateMessageTokens(message: any): number
}
