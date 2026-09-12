'use strict'

const fs = require('fs')
const path = require('path')

const RUNTIME_NAME = 'mio-agent-runtime'

const evolutionModules = [
  {
    name: '@akemi-mio/runtime-contracts',
    packageDir: 'runtime-contracts',
    health: (module) => typeof module.createRuntimeEvent === 'function',
  },
  {
    name: '@akemi-mio/runtime-foundation',
    packageDir: 'runtime-foundation',
    health: (module) => typeof module.JsonlStore === 'function' && typeof module.EventBus === 'function',
  },
  {
    name: '@akemi-mio/experience-memory',
    packageDir: 'experience-memory',
    health: (module) => typeof module.ExperienceMemory === 'function',
  },
  {
    name: '@akemi-mio/evolution-learning',
    packageDir: 'evolution-learning',
    health: (module) => typeof module.createLearningModule === 'function' && typeof module.evaluateAnalysis === 'function',
  },
  {
    name: '@akemi-mio/evolution-strategy',
    packageDir: 'evolution-strategy',
    health: (module) => typeof module.createStrategyModule === 'function' && typeof module.buildProposal === 'function',
  },
  {
    name: '@akemi-mio/evolution-safety',
    packageDir: 'evolution-safety',
    health: (module) => typeof module.createSafetyModule === 'function' && typeof module.validateProposal === 'function',
  },
  {
    name: '@akemi-mio/evolution-scheduler',
    packageDir: 'evolution-scheduler',
    health: (module) => typeof module.createSchedulerModule === 'function' && typeof module.createSchedulePlan === 'function',
  },
]

function fallbackPackagePath(entry) {
  return path.resolve(__dirname, '..', '..', entry.packageDir)
}

function loadEvolutionModule(entry) {
  try {
    return require(entry.name)
  } catch (_) {
    return require(fallbackPackagePath(entry))
  }
}

function readPackageVersion(entry) {
  try {
    const packagePath = require.resolve(`${entry.name}/package.json`)
    return JSON.parse(fs.readFileSync(packagePath, 'utf8')).version
  } catch (_) {
    try {
      return JSON.parse(fs.readFileSync(path.join(fallbackPackagePath(entry), 'package.json'), 'utf8')).version
    } catch (_) {
      return null
    }
  }
}

function runtimeVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8')).version
  } catch (_) {
    return null
  }
}

function getEvolutionStatus() {
  const modules = evolutionModules.map((entry) => {
    let loaded = false
    let healthy = false
    try {
      const module = loadEvolutionModule(entry)
      loaded = true
      healthy = Boolean(entry.health(module))
    } catch (_) {}
    return {
      name: entry.name,
      version: readPackageVersion(entry),
      loaded,
      healthy,
    }
  })
  return { runtime: RUNTIME_NAME, version: runtimeVersion(), modules }
}

function formatEvolutionStatusText(status) {
  const lines = [`${status.runtime} ${status.version || 'unknown'}`]
  for (const module of status.modules) {
    lines.push(`${module.name}@${module.version || 'unknown'}: ${module.healthy ? 'healthy' : 'unavailable'}`)
  }
  return lines.join('\n')
}

module.exports = {
  RUNTIME_NAME,
  evolutionModules,
  getEvolutionStatus,
  formatEvolutionStatusText,
}
