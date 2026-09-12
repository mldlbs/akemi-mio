const test = require('node:test')
const assert = require('node:assert/strict')

const { buildProposal, createStrategyModule, rankProposals } = require('../index.js')

test('builds deterministic proposals without host mutation capabilities', () => {
  const proposal = buildProposal({
    task: 'extract safety checks',
    project: 'akemi-mio',
    agent: 'codex',
    constraints: ['no electron dependency', 'host mutations stay injected'],
    evidenceIds: ['ev-1'],
  })

  assert.equal(proposal.schemaVersion, 1)
  assert.equal(proposal.project, 'akemi-mio')
  assert.equal(proposal.agent, 'codex')
  assert.equal(proposal.riskLevel, 'medium')
  assert.deepEqual(proposal.evidenceIds, ['ev-1'])
  assert.ok(proposal.steps.every((step) => typeof step === 'string' && step.length > 0))
})

test('ranks proposals by expected impact and lower risk deterministically', () => {
  const lowRisk = { id: 'a', expectedImpact: 60, riskLevel: 'low' }
  const highImpact = { id: 'b', expectedImpact: 90, riskLevel: 'high' }
  const medium = { id: 'c', expectedImpact: 70, riskLevel: 'medium' }

  assert.deepEqual(rankProposals([lowRisk, highImpact, medium]).map((p) => p.id), ['b', 'c', 'a'])
  assert.deepEqual(rankProposals([medium, lowRisk]).map((p) => p.id), ['c', 'a'])
})

test('strategy module uses injected llm when requested and emits proposal events', async () => {
  const events = []
  const module = createStrategyModule({
    idFactory: () => 'prop-fixed',
    eventBus: { emit: (type, payload) => events.push({ type, payload }) },
    llm: {
      complete(prompt) {
        assert.match(prompt, /improve runtime learning/)
        return Promise.resolve('Prefer a narrow module API with injected dependencies.')
      },
    },
  })

  const proposal = await module.generateProposal({
    task: 'improve runtime learning',
    useLlm: true,
    context: 'stage 5',
  })

  assert.equal(proposal.id, 'prop-fixed')
  assert.match(proposal.summary, /narrow module API/)
  assert.equal(events[0].type, 'strategy.proposal_created')
})
