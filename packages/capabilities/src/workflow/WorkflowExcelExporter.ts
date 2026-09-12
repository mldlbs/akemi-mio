import * as ExcelJS from 'exceljs'
import * as path from 'path'
import * as fs from 'fs'
import { log } from '@akemi-mio/core/logger/Logger'
import type { WorkflowRun } from './types'

/**
 * 从工作流运行记录中解析结构化的成果数据，生成 Excel 台账。
 *
 * 工作流步骤的 agentResult 中包含 Markdown 表格，本函数从中提取：
 * - 合格人员清单（s10/s11 的输出）
 * - 不合格企业清单
 * - 检查明细（s4-s8）
 *
 * @param run       工作流运行记录
 * @param outputDir 输出目录，最终文件写到此目录
 * @returns         生成的 .xlsx 文件路径，失败返回 null
 */
export async function writeWorkflowExcel(run: WorkflowRun, outputDir: string): Promise<string | null> {
  try {
    const wb = new ExcelJS.Workbook()
    wb.creator = 'Akemi-Mio Workflow'
    wb.created = new Date(run.startedAt)

    // ── Sheet 1: 双业绩确认台账 ──
    const qualifiedSheet = wb.addWorksheet('合格人员台账')
    const failSheet = wb.addWorksheet('不合格清单')
    const detailSheet = wb.addWorksheet('检查明细')

    // 表头样式
    const headerStyle: Partial<ExcelJS.Style> = {
      font: { bold: true, color: { argb: 'FFFFFFFF' } },
      fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } },
      border: {
        top: { style: 'thin' },
        bottom: { style: 'thin' },
        left: { style: 'thin' },
        right: { style: 'thin' },
      },
    }

    // ── 合格人员台账 ──
    const qualifiedHeaders = [
      '企业名称',
      '技术负责人',
      '身份证号',
      '业绩项目',
      '项目等级',
      '五方',
      '七项',
      '含身份证',
      '有效业绩数',
      '判定',
    ]
    qualifiedSheet.addRow(qualifiedHeaders)
    qualifiedSheet.getRow(1).eachCell((cell) => {
      cell.style = headerStyle
    })
    qualifiedSheet.columns = qualifiedHeaders.map((h) => ({ header: h, width: Math.max(h.length * 2, 18) }))

    // ── 不合格清单 ──
    const failHeaders = ['企业名称', '技术负责人', '不合格原因', '状态']
    failSheet.addRow(failHeaders)
    failSheet.getRow(1).eachCell((cell) => {
      cell.style = headerStyle
    })
    failSheet.columns = failHeaders.map((h) => ({ header: h, width: Math.max(h.length * 2, 20) }))

    // ── 检查明细 ──
    const detailHeaders = ['步骤', '企业', '项目', '检查项', '结果', '详情']
    detailSheet.addRow(detailHeaders)
    detailSheet.getRow(1).eachCell((cell) => {
      cell.style = headerStyle
    })
    detailSheet.columns = detailHeaders.map((h) => ({ header: h, width: Math.max(h.length * 2, 22) }))

    // 解析步骤结果中的表格数据
    for (const step of run.steps) {
      if (!step.agentResult) continue

      // s_browser JSON 输出（新格式）
      if (step.stepId === 's_browser') {
        const parsed = tryParseBrowserJson(step.agentResult)
        if (parsed) {
          for (const ent of parsed.enterprises || []) {
            for (const p of ent.personnel || []) {
              const count = p.有效业绩数 || 0
              if (p.双业绩合格) {
                qualifiedSheet.addRow([
                  ent.name,
                  p.姓名,
                  p.身份证号 || '',
                  (p.关联项目 || []).join(';'),
                  '',
                  '',
                  '',
                  '',
                  String(count),
                  '✅ 合格',
                ])
              } else {
                const reason = `有效业绩 ${count} 条，不足 2 条`
                failSheet.addRow([ent.name, p.姓名, reason, '不合格'])
              }
            }
            if (!ent.personnel || ent.personnel.length === 0) {
              failSheet.addRow([ent.name, '无', ent.enterprise_verdict || '无技术负责人', '不合格'])
            }
          }
        }
        if (parsed) {
          for (const ent of parsed.enterprises || []) {
            for (const proj of ent.projects || []) {
              detailSheet.addRow(['s_browser', ent.name, proj.name, '技术指标', proj.grade, proj.verdict || ''])
              detailSheet.addRow([
                's_browser',
                ent.name,
                proj.name,
                '五方',
                proj.五方齐全 ? '齐全' : '不齐',
                proj.五方含施工企业 ? '含施工' : '不含施工',
              ])
              detailSheet.addRow([
                's_browser',
                ent.name,
                proj.name,
                '七项',
                proj.七项完整 ? '完整' : '不完整',
                proj.竣工含身份证 ? '含身份证' : '无身份证',
              ])
            }
          }
        }
      }

      // s8 双业绩确认（旧格式，兼容）
      if (step.stepId === 's8') {
        const qualified: Record<string, any[]> = {}
        const failed: Record<string, any[]> = {}

        const lines = step.agentResult.split('\n')
        let currentName = ''
        let currentEnterprise = ''
        let tableLines: string[] = []

        for (const line of lines) {
          const titleMatch = line.match(/\*\*技术负责人：(\S+)\*\*.*\*\*企业：(\S+)\*\*/)
          if (titleMatch) {
            if (currentName && tableLines.length > 1) {
              parseTableRows(tableLines, currentEnterprise, currentName, qualified, failed)
            }
            currentName = titleMatch[1]
            currentEnterprise = titleMatch[2]
            tableLines = []
            continue
          }
          if (line.includes('| ---') || (line.trim().startsWith('|') && line.trim().endsWith('|'))) {
            tableLines.push(line)
          }
        }
        if (currentName && tableLines.length > 1) {
          parseTableRows(tableLines, currentEnterprise, currentName, qualified, failed)
        }

        for (const [name, rows] of Object.entries(qualified)) {
          for (const r of rows) {
            qualifiedSheet.addRow([
              r.enterprise,
              name,
              r.idCard || '',
              r.project,
              r.grade,
              r.wufang,
              r.qixiang,
              r.idCardFlag,
              r.count,
              r.verdict,
            ])
          }
        }
        for (const [name, rows] of Object.entries(failed)) {
          for (const r of rows) {
            failSheet.addRow([r.enterprise, name, r.reason, '不合格'])
          }
        }
      }

      // 提取通用数据到检查明细
      if (['s4', 's5', 's6', 's7'].includes(step.stepId)) {
        const lines = step.agentResult.split('\n')
        for (const line of lines) {
          if (line.trim().startsWith('|') && line.includes('|')) {
            const cols = line
              .split('|')
              .map((c) => c.trim())
              .filter(Boolean)
            if (cols.length >= 3) {
              detailSheet.addRow([step.stepId, ...cols.slice(0, 5)])
            }
          }
        }
      }
    }

    // 边框 + 自动换行
    ;[qualifiedSheet, failSheet, detailSheet].forEach((sheet) => {
      sheet.eachRow((row) => {
        row.eachCell((cell) => {
          cell.border = {
            top: { style: 'thin' },
            bottom: { style: 'thin' },
            left: { style: 'thin' },
            right: { style: 'thin' },
          }
          cell.alignment = { vertical: 'middle', wrapText: true }
        })
      })
    })

    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true })
    }
    const filePath = path.join(outputDir, '技术负责人业绩台账.xlsx')
    await wb.xlsx.writeFile(filePath)
    log('INFO', 'workflow_excel_written', { path: filePath })
    return filePath
  } catch (err: any) {
    log('ERROR', 'workflow_excel_write_failed', { error: err.message })
    return null
  }
}

/**
 * 解析 Markdown 表格行为结构化的台账数据（s8 双业绩确认表）
 */
function parseTableRows(
  lines: string[],
  enterprise: string,
  name: string,
  qualified: Record<string, any[]>,
  failed: Record<string, any[]>,
): void {
  const dataLines = lines.filter((l) => !l.includes('---') && !l.includes('序号 |'))
  for (const line of dataLines) {
    const cols = line
      .split('|')
      .map((c) => c.trim())
      .filter(Boolean)
    if (cols.length < 6) continue
    const project = cols[1] || ''
    const grade = cols[2] || ''
    const wufang = cols[3] === '✓' ? '齐全' : cols[3]
    const qixiang = cols[4] === '✓' ? '齐全' : cols[4]
    const idCard = cols[5] === '✓' ? '有' : cols[5]
    const valid = cols[cols.length - 1] || ''

    const row = { enterprise, project, grade, wufang, qixiang, idCardFlag: idCard, count: '1', verdict: valid, idCard: '', reason: '' }

    if (valid.includes('✅')) {
      if (!qualified[name]) qualified[name] = []
      qualified[name].push(row)
    } else {
      row.reason = `等级:${grade} 五方:${wufang} 七项:${qixiang} 身份证:${idCard}`
      if (!failed[name]) failed[name] = []
      failed[name].push(row)
    }
  }
}

/** 尝试解析 s_browser 输出的 JSON（支持直接 JSON 和代码块中提取） */
function tryParseBrowserJson(result: string): { enterprises: any[]; summary?: any } | null {
  // 直接解析
  try {
    const parsed = JSON.parse(result)
    if (parsed.enterprises) return parsed
  } catch {
    /* 继续尝试代码块提取 */
  }
  // 从 ```json ... ``` 代码块提取
  const match = result.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (match) {
    try {
      const parsed = JSON.parse(match[1].trim())
      if (parsed.enterprises) return parsed
    } catch {
      /* 继续尝试其他模式 */
    }
  }
  // 尝试从大括号开始提取
  const braceIdx = result.indexOf('{')
  if (braceIdx >= 0) {
    try {
      const parsed = JSON.parse(result.slice(braceIdx))
      if (parsed.enterprises) return parsed
    } catch {}
  }
  return null
}
