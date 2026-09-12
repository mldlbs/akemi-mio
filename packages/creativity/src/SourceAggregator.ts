import { log } from '@akemi-mio/core/logger/Logger'
import type { CreativitySource } from './types'

export type SourceDomain = 'module' | 'behavior' | 'observation' | 'external' | 'failure' | 'feedback'

export interface SourceProvider {
  domain: SourceDomain
  name: string
  collect: () => CreativitySource[]
}

/**
 * SourceAggregator — 来源总线
 *
 * 统一收集多域来源，做去重、每域限流与失败降级，
 * 供创意产生与发酵两端共用同一份信号。
 */
export class SourceAggregator {
  private providers: SourceProvider[] = []
  private maxPerDomain: number
  private minDomains: number

  constructor(maxPerDomain = 4, minDomains = 3) {
    this.maxPerDomain = maxPerDomain
    this.minDomains = minDomains
  }

  addProvider(provider: SourceProvider): void {
    this.providers.push(provider)
  }

  build(): CreativitySource[] {
    const byDomain = new Map<SourceDomain, CreativitySource[]>()
    const seen = new Set<string>()

    for (const provider of this.providers) {
      let collected: CreativitySource[] = []
      try {
        collected = provider.collect() ?? []
      } catch (err: any) {
        log('WARN', 'source_provider_failed', { provider: provider.name, error: String(err?.message ?? err) })
        continue
      }
      const unique = collected.filter((s) => {
        const key = `${provider.domain}:${s.name}`
        if (seen.has(key)) return false
        seen.add(key)
        return true
      })
      const list = byDomain.get(provider.domain) ?? []
      byDomain.set(provider.domain, [...list, ...unique])
    }

    const output: CreativitySource[] = []
    let domainsWithData = 0
    for (const [domain, sources] of byDomain) {
      if (sources.length > 0) domainsWithData++
      const sorted = [...sources].sort((a, b) => b.weight - a.weight)
      output.push(...sorted.slice(0, this.maxPerDomain))
    }

    if (domainsWithData < this.minDomains) {
      log('WARN', 'source_aggregator_low_diversity', { domains: domainsWithData, min: this.minDomains })
    }
    log('INFO', 'source_aggregator_build', { total: output.length, domains: domainsWithData })
    return output
  }
}

