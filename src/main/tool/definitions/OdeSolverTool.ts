/**
 * OdeSolverTool — 对话式自适应 ODE 求解工具
 *
 * 当用户用自然语言描述微分方程时，Agent 提取结构化参数后调用此工具。
 * 后端使用 Python (SymPy) 解析方程 + 数值计算 + matplotlib 动态绘图。
 *
 * 职责：
 * - 接收 Agent 提取的结构化参数（方程、方法、初值、区间、步长）
 * - 校验参数合法性
 * - 调用 Python 后端完成数值求解与可视化
 * - 返回数值解表格与图形路径
 * - 支持多轮对话调整步长、切换方法对比
 */

import { buildTool, formatToolResult, formatToolError } from '../types'
import { execSync } from 'child_process'
import { writeFileSync, unlinkSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { WORKSPACE } from '../../config'
import { randomUUID } from 'crypto'

// ════════════════════════════════════════════════════════════════════
// Python 后端脚本（内嵌以规避构建系统对 .py 文件的处理问题）
// ════════════════════════════════════════════════════════════════════

const PYTHON_SCRIPT = `
import json, sys, os, re

# ---------- 可选依赖：SymPy / matplotlib / numpy ----------
HAS_SYMPY = False
HAS_MPL = False
try:
    import sympy as sp
    HAS_SYMPY = True
except ImportError:
    sp = None
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    HAS_MPL = True
except ImportError:
    plt = None
try:
    import numpy as np
except ImportError:
    np = None

def parse_initial_condition(s):
    """解析初始条件 y(x0)=y0 或 y(x0) = y0 / y=x0"""
    s = s.strip()
    # y(x0)=y0
    m = re.match(r'y\\s*\\(\\s*([^)]+)\\s*\\)\\s*=\\s*(.+)', s)
    if m:
        x0_s, y0_s = m.group(1).strip(), m.group(2).strip()
        return float(x0_s), float(y0_s)
    # y = x0 (fallback — 假设 y 就是初始值，x 默认为 0)
    m = re.match(r'y\\s*=\\s*(.+)', s)
    if m:
        return 0.0, float(m.group(1).strip())
    # 纯数字
    try:
        return 0.0, float(s)
    except ValueError:
        pass
    raise ValueError(f"Cannot parse initial condition: {s}")

def parse_equation(eq_str):
    """从完整方程或纯 RHS 中提取右侧表达式"""
    s = eq_str.strip()
    if '=' in s:
        parts = s.split('=', 1)
        rhs = parts[1].strip()
        lhs = parts[0].strip()
        # 验证 LHS 是导数形式（可选）
        lhs_clean = lhs.replace("'", "").replace("d", "").replace("/", "").replace("dx", "").replace(" ", "")
        if not lhs_clean:
            return rhs
        # 如果 LHS 太复杂，可能是完整方程，仍然使用 RHS
        return rhs
    return s

def compute_euler(f, xs, h, y0):
    """前向欧拉法"""
    ys = [y0]
    y = y0
    for i in range(len(xs) - 1):
        y = y + h * f(xs[i], y)
        ys.append(y)
    return ys

def compute_rk4(f, xs, h, y0):
    """经典四阶 Runge-Kutta 法"""
    ys = [y0]
    y = y0
    for i in range(len(xs) - 1):
        k1 = f(xs[i], y)
        k2 = f(xs[i] + h / 2, y + h / 2 * k1)
        k3 = f(xs[i] + h / 2, y + h / 2 * k2)
        k4 = f(xs[i] + h, y + h * k3)
        y = y + h / 6 * (k1 + 2 * k2 + 2 * k3 + k4)
        ys.append(y)
    return ys

def solve():
    """主入口：读取 stdin JSON → 求解 → stdout JSON"""
    raw = sys.stdin.read()
    if not raw.strip():
        print(json.dumps({'error': 'Empty input'}))
        return

    try:
        params = json.loads(raw)
    except json.JSONDecodeError as e:
        print(json.dumps({'error': f'Invalid JSON: {e}'}))
        return

    eq_str = params.get('equation', '').strip()
    method = params.get('method', 'rk4').strip().lower()
    init_str = params.get('initialCondition', '').strip()
    interval = params.get('interval', [0, 1])
    h = float(params.get('stepSize', 0.1))
    output_dir = params.get('outputDir', '')

    # ---- 校验 ----
    if not eq_str:
        print(json.dumps({'error': 'equation is required'}))
        return
    if not init_str:
        print(json.dumps({'error': 'initialCondition is required'}))
        return
    if method not in ('euler', 'rk4'):
        print(json.dumps({'error': f'Unsupported method "{method}". Use "euler" or "rk4".'}))
        return

    # ---- 解析初始条件 ----
    try:
        x0, y0 = parse_initial_condition(init_str)
    except (ValueError, Exception) as e:
        print(json.dumps({'error': f'Cannot parse initial condition "{init_str}": {e}'}))
        return

    # ---- 解析区间 ----
    if not isinstance(interval, (list, tuple)) or len(interval) < 2:
        print(json.dumps({'error': f'Invalid interval: {interval}'}))
        return
    a, b = float(interval[0]), float(interval[1])
    if b <= a:
        print(json.dumps({'error': f'Invalid interval: end ({b}) must be greater than start ({a})'}))
        return
    if h <= 0:
        print(json.dumps({'error': f'Invalid stepSize: {h}. Must be positive.'}))
        return

    n = max(1, int(round((b - a) / h)))
    actual_h = (b - a) / n

    # ---- 解析方程 ----
    rhs = parse_equation(eq_str)

    f = None
    analytical_note = ''

    if HAS_SYMPY and sp is not None:
        try:
            x_sym = sp.Symbol('x')
            y_sym = sp.Symbol('y')
            f_expr = sp.sympify(rhs)
            f = sp.lambdify((x_sym, y_sym), f_expr, 'numpy' if np else 'math')

            # 尝试求解析解（仅用于绘图对比，非关键路径）
            try:
                x_f = sp.Symbol('x')
                y_f = sp.Function('y')
                ode = sp.Eq(sp.Derivative(y_f(x_f), x_f), f_expr.subs(y_sym, y_f(x_f)))
                sol = sp.dsolve(ode, ics={y_f(x0): y0})
                if sol and sol.rhs != y_f(x_f):
                    analytical_note = f'Analytical solution: {str(sol.rhs)}'
            except Exception:
                pass
        except Exception as e:
            print(json.dumps({'error': f'SymPy parse error: {e}'}))
            return
    else:
        # ---- 无 SymPy 回退：使用 eval（仅支持基本数值表达式） ----
        try:
            allowed_names = {
                'x': 0.0, 'y': 0.0,
                'sin': __import__('math', fromlist=['sin']).sin,
                'cos': __import__('math', fromlist=['cos']).cos,
                'tan': __import__('math', fromlist=['tan']).tan,
                'exp': __import__('math', fromlist=['exp']).exp,
                'log': __import__('math', fromlist=['log']).log,
                'sqrt': __import__('math', fromlist=['sqrt']).sqrt,
                'pi': __import__('math', fromlist=['pi']).pi,
                'e': __import__('math', fromlist=['e']).e,
            }
            # 验证表达式安全性
            code = compile(rhs, '<ode>', 'eval')
            for name in code.co_names:
                if name not in allowed_names and name not in ('x', 'y'):
                    print(json.dumps({'error': f'Unknown symbol "{name}" in equation (SymPy not available)'}))
                    return
            def f_py(x, y):
                allowed_names['x'] = x
                allowed_names['y'] = y
                return eval(code, {'__builtins__': {}}, allowed_names)
            f = f_py
            analytical_note = '(numerical only, SymPy not available)'
        except Exception as e:
            print(json.dumps({'error': f'Equation parse (fallback) error: {e}'}))
            return

    # ---- 数值求解 ----
    xs = [a + i * actual_h for i in range(n + 1)]
    try:
        if method == 'euler':
            ys = compute_euler(f, xs, actual_h, y0)
        else:
            ys = compute_rk4(f, xs, actual_h, y0)
    except Exception as e:
        print(json.dumps({'error': f'Numerical computation error: {e}'}))
        return

    # ---- 生成数值表 ----
    header = f"{'x':>12}  {'y':>16}"
    sep = "-" * 30
    rows = [header, sep]

    # 采样显示：最多显示 50 行
    display_step = max(1, (n + 1) // 50) if n > 50 else 1
    for i in range(0, n + 1, display_step):
        rows.append(f"{xs[i]:>12.6f}  {ys[i]:>16.8f}")
    if display_step > 1 and (n % display_step) != 0:
        rows.append(f"{xs[n]:>12.6f}  {ys[n]:>16.8f}")

    if n > 50:
        rows.append(f"... ({n + 1} total points, showing every {display_step}th)")

    table = '\\n'.join(rows)

    # ---- 生成可视化 ----
    plot_path = ''
    if HAS_MPL and plt is not None:
        try:
            if not os.path.exists(output_dir):
                os.makedirs(output_dir, exist_ok=True)

            plt.figure(figsize=(10, 6))
            plt.plot(xs, ys, 'b-', linewidth=2, label=f'{method.upper()} (h={actual_h:.6f})')

            # 如果有解析解且可用，绘制对比
            if HAS_SYMPY and sp is not None and analytical_note and not analytical_note.startswith('(numerical'):
                try:
                    x_f = sp.Symbol('x')
                    y_f = sp.Function('y')
                    ode = sp.Eq(sp.Derivative(y_f(x_f), x_f), f_expr.subs(y_sym, y_f(x_f)))
                    sol = sp.dsolve(ode, ics={y_f(x0): y0})
                    if sol and sol.rhs != y_f(x_f):
                        sol_f = sp.lambdify(x_f, sol.rhs, 'numpy' if np else 'math')
                        xs_dense = np.linspace(a, b, max(100, n * 2)) if np else xs
                        ys_exact = [float(sol_f(xv)) for xv in xs_dense]
                        plt.plot(xs_dense, ys_exact, 'r--', linewidth=1.5, alpha=0.7, label='Analytical')
                except Exception:
                    pass

            plt.xlabel('x')
            plt.ylabel('y')
            eq_display = rhs if len(rhs) <= 40 else rhs[:37] + '...'
            plt.title(f"ODE: {eq_display}  |  {method.upper()} (h={actual_h})")
            plt.grid(True, alpha=0.3)
            plt.legend()
            if np:
                plt.tight_layout()

            safe_name = re.sub(r'[^a-zA-Z0-9_-]', '_', f'ode_{method}_{x0}_{b}')[:60]
            save_path = os.path.join(output_dir, f'{safe_name}.png')
            plt.savefig(save_path, dpi=150, bbox_inches='tight')
            plt.close()
            plot_path = save_path
        except Exception as e:
            plot_path = f'[Plot error: {e}]'

    # ---- 结果 ----
    result = {
        'table': table,
        'plotPath': plot_path,
        'method': method,
        'stepSize': actual_h,
        'steps': n,
        'x0': x0,
        'y0': y0,
        'xFinal': xs[-1],
        'yFinal': ys[-1],
        'analyticalNote': analytical_note if analytical_note else None,
        'hasSympy': HAS_SYMPY,
        'hasMpl': HAS_MPL,
    }
    print(json.dumps(result))

if __name__ == '__main__':
    solve()
`

// ════════════════════════════════════════════════════════════════════
// 工具定义
// ════════════════════════════════════════════════════════════════════

export const solveOdeTool = buildTool({
  name: 'solve_ode',
  description: `求解常微分方程（ODE）数值解，返回数值解表格 + 可视化图形。

支持一阶常微分方程 dy/dx = f(x, y) 的数值求解，方法包括：
- euler — 前向欧拉法（一阶精度）
- rk4   — 经典四阶龙格-库塔法（高精度，默认推荐）

用法：
- 第一步：从用户自然语言描述中提取结构化参数调用此工具
- 多轮：用户可调整步长重新求解，或切换方法对比精度

参数提取指南（供 Agent 参考）：
1. equation — 微分方程右侧表达式或 "dy/dx = expr" 格式
   例: "dy/dx = x*y" → 提取 "x*y"
        "y' = sin(x) + y" → 提取 "sin(x) + y"
        "x^2 + y^2" → 直接使用
2. method — euler 或 rk4，用户未指定时推荐 rk4
3. initialCondition — 格式 "y(x0)=y0"
   例: "y(0)=1", "y(0.5)=2.5"
4. interval — 求解区间 [a, b]
   例: [0, 2] 表示从 x=0 到 x=2
5. stepSize — 步长（可选，默认 0.1），精度要求高可设 0.01

支持的数学函数：sin, cos, tan, exp, log, sqrt, pi, e, 以及基本算术运算
支持的方法切换：同一方程可分别用 euler 和 rk4 求解对比

使用示例（供 Agent 参考）：
- 用户说 "用欧拉法求 dy/dx = y, y(0)=1 从 0 到 2，步长 0.1"
    → equation="y", method="euler", initialCondition="y(0)=1", interval=[0,2], stepSize=0.1
- 用户说 "求解 y' = x + y, y(0)=0 从 0 到 1"
    → equation="x + y", method="rk4", initialCondition="y(0)=0", interval=[0,1]
- 用户说 "步长改为 0.05 重新算"
    → 调整 stepSize 后再次调用`,
  inputJSONSchema: {
    type: 'object',
    properties: {
      equation: {
        type: 'string',
        description: '微分方程右侧表达式 f(x,y)，或完整方程 "dy/dx = f(x,y)" 格式。示例："x*y"、"sin(x) + y"、"y"、"x^2 + y^2"',
      },
      method: {
        type: 'string',
        enum: ['euler', 'rk4'],
        description: '数值方法：euler（欧拉法，一阶精度）或 rk4（龙格-库塔法，四阶精度，推荐）',
      },
      initialCondition: {
        type: 'string',
        description: '初始条件，固定格式 "y(x0)=y0"，例如 "y(0)=1"、"y(0.5)=2.5"',
      },
      interval: {
        type: 'array',
        items: { type: 'number' },
        minItems: 2,
        maxItems: 2,
        description: '求解区间 [a, b]，例如 [0, 2] 表示 x 从 0 到 2',
      },
      stepSize: {
        type: 'number',
        description: '步长 h，默认 0.1。值越小精度越高但计算量越大。推荐范围: [0.001, 0.5]',
      },
    },
    required: ['equation', 'method', 'initialCondition', 'interval'],
  },
  handler: async (args: {
    equation: string
    method: string
    initialCondition: string
    interval: [number, number]
    stepSize?: number
  }): Promise<ReturnType<typeof formatToolResult>> => {
    try {
      // ── 校验 ──
      if (!args.equation || !args.equation.trim()) {
        return formatToolError('equation 不能为空。请提供微分方程，如 "dy/dx = x*y"')
      }
      if (!['euler', 'rk4'].includes(args.method)) {
        return formatToolError(`不支持的方法 "${args.method}"，请使用 "euler" 或 "rk4"`)
      }
      if (!args.initialCondition || !args.initialCondition.trim()) {
        return formatToolError('initialCondition 不能为空。请提供初始条件，如 "y(0)=1"')
      }
      if (!args.interval || args.interval.length < 2) {
        return formatToolError('interval 必须为包含两个数字的数组，如 [0, 2]')
      }
      const [a, b] = args.interval
      if (!Number.isFinite(a) || !Number.isFinite(b)) {
        return formatToolError('interval 的端点必须是有效数字')
      }
      if (b <= a) {
        return formatToolError(`无效的求解区间: [${a}, ${b}]，终点必须大于起点`)
      }
      const stepSize = args.stepSize ?? 0.1
      if (!Number.isFinite(stepSize) || stepSize <= 0) {
        return formatToolError(`无效的步长: ${stepSize}，步长必须是正数`)
      }
      if (stepSize < 0.0001) {
        return formatToolError(`步长 ${stepSize} 过小，可能导致计算量过大。请使用 ≥ 0.0001 的步长`)
      }
      if (stepSize > (b - a)) {
        return formatToolError(`步长 ${stepSize} 超过了求解区间长度 ${b - a}，请缩小步长`)
      }

      // ── 准备输出目录 ──
      const plotsDir = join(WORKSPACE.cache, 'ode_plots')
      if (!existsSync(plotsDir)) {
        mkdirSync(plotsDir, { recursive: true })
      }

      // ── 写入临时 Python 脚本 ──
      const scriptPath = join(WORKSPACE.cache, `ode_solver_${randomUUID().slice(0, 8)}.py`)
      writeFileSync(scriptPath, PYTHON_SCRIPT, 'utf-8')

      // ── 构造调用参数 ──
      const inputJson = JSON.stringify({
        equation: args.equation,
        method: args.method,
        initialCondition: args.initialCondition,
        interval: args.interval,
        stepSize: stepSize,
        outputDir: plotsDir,
      })

      // ── 执行 Python ──
      const pythonCmd = process.platform === 'win32' ? 'python' : 'python3'
      let stdout: string
      try {
        stdout = execSync(
          `${pythonCmd} "${scriptPath}"`,
          {
            input: inputJson,
            timeout: 60_000,
            maxBuffer: 5 * 1024 * 1024,
            encoding: 'utf-8',
            windowsHide: true,
          },
        ).trim()
      } catch (execErr: any) {
        const msg = execErr.stderr?.toString() || execErr.message || String(execErr)
        if (msg.includes('python') && (msg.includes('not recognized') || msg.includes('not found') || msg.includes('ENOENT'))) {
          return formatToolError(
            'Python 未找到。请安装 Python 3.8+ 并确保 "python" 命令可用。\n' +
            '下载地址: https://www.python.org/downloads/\n' +
            '安装后需安装依赖: pip install sympy matplotlib numpy'
          )
        }
        if (msg.includes('No module named') || msg.includes('ModuleNotFoundError')) {
          const mod = msg.match(/No module named ['"]?(\S+)['"]?/)?.[1] || msg.match(/ModuleNotFoundError.*named\s+'?(\S+)'?/)?.[1] || '未知模块'
          return formatToolError(
            `Python 模块 "${mod}" 未安装。请运行: pip install ${mod}`
          )
        }
        return formatToolError(`Python 执行错误: ${msg.slice(0, 500)}`)
      } finally {
        // 清理临时脚本
        try { unlinkSync(scriptPath) } catch { /* ignore */ }
      }

      // ── 解析结果 ──
      if (!stdout) {
        return formatToolError('Python 后端未返回任何输出')
      }

      let result: any
      try {
        result = JSON.parse(stdout)
      } catch {
        return formatToolError(`Python 输出解析失败: ${stdout.slice(0, 300)}`)
      }

      if (result.error) {
        return formatToolError(`求解失败: ${result.error}`)
      }

      // ── 格式化输出 ──
      const lines: string[] = []

      // 头部
      lines.push(`【ODE 数值求解结果】`)
      lines.push(`  方程: ${args.equation}`)
      lines.push(`  方法: ${result.method.toUpperCase()}  (h = ${result.stepSize})`)
      lines.push(`  步数: ${result.steps}`)
      lines.push(`  初始条件: y(${result.x0}) = ${result.y0}`)
      lines.push(`  最终值: y(${result.xFinal}) = ${result.yFinal}`)
      if (result.analyticalNote) {
        lines.push(`  解析解: ${result.analyticalNote}`)
      }
      lines.push('')

      // 数值表
      lines.push(`【数值解表】`)
      lines.push(result.table)
      lines.push('')

      // 图形
      if (result.plotPath && typeof result.plotPath === 'string' && !result.plotPath.startsWith('[Plot')) {
        lines.push(`【可视化图形】`)
        lines.push(`  文件: ${result.plotPath}`)
        lines.push('')
      } else if (result.plotPath && result.plotPath.startsWith('[Plot')) {
        lines.push(`【可视化】${result.plotPath}`)
        lines.push('')
      }

      // 方法提示
      if (result.method === 'euler') {
        lines.push(`💡 提示：欧拉法为一阶精度。如需更高精度，可使用 RK4 法求解对比。`)
      } else {
        lines.push(`💡 提示：可使用 euler 法同参数求解，对比两种方法的精度差异。`)
      }
      lines.push(`💡 可调整步长（stepSize）重新计算以获得更高精度。`)

      return formatToolResult(lines.join('\n'))
    } catch (err: any) {
      return formatToolError(`ODE 求解工具异常: ${err.message || String(err)}`)
    }
  },
  isReadOnly: false,
})
