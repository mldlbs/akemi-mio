import { ipcMain } from 'electron'
import { log } from '../../logger/Logger'
import { credentialsManager } from '../../credentials/CredentialsManager'
import { planManager as planManagerImport } from '../../evolution'
import type { HandlerContext } from './context'

export function registerEvolutionHandlers({ agentService, evolutionRef, pipelineRef, dashboardRef }: HandlerContext): void {
  if (evolutionRef) {
    ipcMain.handle('evolution:trigger', async () => {
      const svc = evolutionRef.current
      if (!svc) return { success: false, error: 'evolution not ready' }
      try { await svc.triggerNow(); return { success: true } }
      catch (err: any) { log('ERROR', 'evolution_trigger_failed', { error: String(err) }); return { success: false, error: String(err) } }
    })

    ipcMain.handle('evolution:status', async () => {
      const svc = evolutionRef.current
      if (!svc) return { lastRun: null, consecutiveFailures: 0, isBusy: false }
      return { lastRun: svc.getLastRun(), consecutiveFailures: svc.getConsecutiveFailures(), isBusy: agentService.isBusy() }
    })
  }

  // ── 合成证据注入（受控故障验证） ──
  if (pipelineRef) {
    ipcMain.handle('evolution:pipeline:inject', async (_event, def: import('../../evolution/automation').SyntheticProblemDef) => {
      const pipeline = pipelineRef.current
      if (!pipeline) return { success: false, error: 'pipeline not ready' }
      try {
        const id = pipeline.injectSynthetic(def)
        return { success: true, problemId: id }
      } catch (err: any) {
        log('ERROR', 'pipeline_inject_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })

    ipcMain.handle('evolution:pipeline:runOnce', async () => {
      const pipeline = pipelineRef.current
      if (!pipeline) return { success: false, error: 'pipeline not ready' }
      try {
        const metrics = await pipeline.runOnce()
        return { success: true, metrics }
      } catch (err: any) {
        log('ERROR', 'pipeline_run_once_failed', { error: String(err) })
        return { success: false, error: String(err) }
      }
    })
  }

  if (dashboardRef) {
    ipcMain.handle('evolution:dashboard:toggle', async () => {
      const svc = dashboardRef.current
      if (!svc) return { success: false, visible: false }
      return { success: true, visible: svc.toggleVisibility() }
    })
  }

  ipcMain.handle('evolution:dashboard:live:getConfig', async () => ({
    enabled: credentialsManager.get('evo_dashboard_live_enabled') !== 'false',
    opacity: credentialsManager.get('evo_dashboard_live_opacity') ? parseFloat(credentialsManager.get('evo_dashboard_live_opacity')!) : 0.85,
  }))

  ipcMain.handle('evolution:dashboard:live:setConfig', async (_event, config: { enabled?: boolean; opacity?: number }) => {
    try {
      if (config.enabled !== undefined) credentialsManager.set('evo_dashboard_live_enabled', String(config.enabled))
      if (config.opacity !== undefined) credentialsManager.set('evo_dashboard_live_opacity', String(config.opacity))
      return { success: true }
    } catch { return { success: false } }
  })

  // Evolution plan status
  ipcMain.handle('evolution:planStatus', async () => {
    try {
      const plan = planManagerImport.getActivePlan()
      if (!plan) return { hasActivePlan: false, planTitle: '', totalSteps: 0, completedSteps: 0, percentComplete: 0, currentStep: '' }
      const completedSteps = plan.steps.filter((s: any) => s.status === 'done' || s.status === 'completed').length
      const totalSteps = plan.steps.length
      const currentStep = plan.steps.find((s: any) => s.status === 'in_progress')
      return { hasActivePlan: true, planTitle: plan.title, totalSteps, completedSteps, percentComplete: totalSteps > 0 ? Math.round((completedSteps / totalSteps) * 100) : 0, currentStep: currentStep?.description || '' }
    } catch { return { hasActivePlan: false, planTitle: '', totalSteps: 0, completedSteps: 0, percentComplete: 0, currentStep: '' } }
  })
}
