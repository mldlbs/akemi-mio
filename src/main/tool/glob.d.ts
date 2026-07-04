// Minimal type declarations for 'glob' v7 — used by FileOpsTools.searchFilesGlobTool
declare module 'glob' {
  interface GlobOptions {
    cwd?: string
    root?: string
    dot?: boolean
    nomount?: boolean
    mark?: boolean
    nosort?: boolean
    stat?: boolean
    silent?: boolean
    strict?: boolean
    sync?: boolean
    nounique?: boolean
    nonull?: boolean
    debug?: boolean
    nobrace?: boolean
    noglobstar?: boolean
    noext?: boolean
    nocase?: boolean
    matchBase?: boolean
    nodir?: boolean
    ignore?: string | ReadonlyArray<string>
    follow?: boolean
    realpath?: boolean
    absolute?: boolean
  }

  export function sync(pattern: string, options?: GlobOptions): string[]
  export function globSync(pattern: string, options?: GlobOptions): string[]

  export class Glob {
    constructor(pattern: string, options?: GlobOptions)
    found: string[]
  }

  export class GlobSync {
    constructor(pattern: string, options?: GlobOptions)
    found: string[]
  }
}
