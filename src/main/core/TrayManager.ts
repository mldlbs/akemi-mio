import { app, Menu, Tray, nativeImage, BrowserWindow } from 'electron'
import { log } from '../logger/Logger'

// 32×32 PNG 托盘图标（与 build/icon.ico 一致，裁剪空白边距后居中绘制）
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAJ10lEQVR4nMVXaYxcxRHu493vzbkzs8fs7IH38C5rfMYHxhFgO4BsEymIEBJziSAgQAIoEYmDgoJyiPxAQkJCShACiyMIQw4OBUiwA8TCB9jGBi8GH+u9vLtz7sybd/XrjvrNjtfxFSt/UqOdVfd0d1V9Vf1VNQQXIBBCIMm6KohKBCFBAwCKCGMNIQwduzxUreRz59gIAGPnPxv8F9GMhoSihvoZYy7Egi4gsR1hsQNi3CZgMSJgqadqTb/CfG+YQYBd29xjW6WDjlWuAHB+5ecxoDYdiTVlBEm9iFEmqVrsRlE2buCe818Z/3DvGKMIYRR4O7OXUR+4bmXLdGH8l+Xi2IFgXXAmuwADYA02I5yIhiKp6yBWLlfV6Ea+mVIfAEDdmYVoZrvA5xgFFMyoQAhJECIEEQZ2tfjc1PjgXa5j2mcLCTwXNOm2BY/IWngTAEhilLgAIlRTdsFCKKVEEETFJ97REyP7F9pWqXQ6EvBs3qdaem8LRVqeoZSQWS//N6GU2hgLCqVkeGxoT0+AxClGoNOVx5Kda8KxzDOEeHyhUFfOb8K55HyJjhBSOIIYi5lUS/8WHpb/+B3UtAenyEpIizW0v01c2+ZxrCvmf65HzqGcAUnEFEF49gXBIUjiDilqeF2soe3KwPsZh1BdP5dYov0+njx147hij/jAcT0wb26mqsgSpXTWXYwQMKsOWLawK7tqaX+xVK4CAeOzosUd8n1CwrGWZ7EgoTpsqI6hICqCokc3UUooREhCEFLXJSDdGNnbmU6M3nvLOuK4HkKodnigAwJg2Q64ft1K7VcPbdQiIdWt2g51PQ9gjM6wgVGfYEHOGOHUJXV0Ud1aVYs0IyhIADDKp1yPoJChkCcevaN57eXzJxdfMqc00ONS154lhAhwJCzbrd7Wq5dPXLqoz9YMDTzyQN8qrFk05/P5czL5XKF8Eol6GLk+xhjVQw231cMHayHCIJHYsNwwnl9kCHXyEOmaBBb0Z4oLBtod1/GQrqqgZFaHqyZJ/fGv22OyLGkb1iz5VJEB6uxo7XKrtuIDf2h4ZMpscSe0f3BMfe2tjwpK1CKBHwEhYYksSqU0ARD1yfjIsV2tPnFpkOHhkUgiiKUfB2uZIskYI8XpqHqutj2effXP7+4o5vPHWtLt62NRPb1i7YrlK1cvKx8+OprLjo21hMLG5Ic79vxp34HBrGnb29vSyemxyWmzr6vdak83kCPHJ4WWRnRJIpYyY6NZS5EFIohSsywbDVWSn0KyesgQCToW1fVBWiFPGACmraqEACCLO/9lcy5mY9u27ZRdV2z+8tuHy869e+jft+9ELenmPWePHXls0+ZHjxwZJVP5qnD/d+/b2pxuOTKZryJ3rwUMBLBh3VLz97+7uzmZinFNVYXh8QlBVUQaIyDpMhB0x3Olquu68jOtQctWBcYrYlQko4fj8cT6L9etcY8ePUVvuuqy4tHh0YGSbf/2uo0fLnzs/s+Ll146/3Rb8qqJnlTvpXsfvPfSjaO7hhYPDu5pa1Ij9mQ+X9Q1FV62ekVc1eMVN2AiFlUQFBRClBWMGFmgY9/3oaryNFMpD2vRtOu5BQoJGsk2Y3YcGjj2ylOnC/mJY21dyx5tamq7/boNvdPpjq+4H/rJ2JX33PNIa2Nj069f/NVPRdH8/ennflKx7Yku03VObXr69Z/PjEZLcDxPAF6AcKIBP0AQAYxBPGRk8/k8lBW5iCgR/+Vvm3+cyWT2B/OE82PZ4h9/u2nLww/c3ZcpX37sqad/uP7uX3y2+6X/e2jd6kWZAyckSKCqKjFN00qlyp/+8pe/DyI8UBT5R0eOHGGqqs4qApK0nfi+x44dH+Ojh3N7Bpbt/eaj5wAAzF+1YqHyo+/cDJYt7oPxuJ4GAHiexz3HYSIIRInHISQYRAEEDBESOAcQc55/zsQK5wByhpgj1HNbKEIgGjNZPBpbms+LJQQhiSBIOJf+9Wqv6xChHhOE5Hf/+9N2O5au7I6nOl5cu+XmSSMSA4Qwx3U9s1YrFjMTh4sjB/5uFybf1A1t3MpPjmamRv8UjkR7sLlmzF+savGYQRCGRBhRqT9OFcZ/rWlqNW7ELsnPfP7GkSnn+N7su2+/E47bYrF6r/OqjOGgcX7v28/5vrtQj3YMBn6KEEZSUyf3Z8cO/VHRosvSXVf+e3rsvbyVGwW6HpuKiG27ZYMjGMQo1edP8c8QQkXTtN5QJPIjwnk8P/bp52Y5/xpBaH4sqjeGopk6BBAIY5wQQaEIgyCDAo85Y4wgECxgh0IGCkt6//zBhl0b7rjpi//+8kvhGy+8uLzh/S3Lej/edyLRNfDCLTd/sad34EtvakdHd7ah9QFEKAkhAkr9Q4RQ1w3zEVmO5BixyHnEo44e2YN4/pa33njYZ9wTRTGFEQaxGBRQCKEIQkxYNJp+yHMrVSEI5kH8MwYhhnxx+LPv2tT/sFTO/dS2ikTQQo5+5spM+zU/I4FzGBAihIxIY0/imdd+2XNZ7Lbb7382aLJET/zw0Z9ve+L1nQ3NTZ/bc+iguN8IhRsGNj198+dXDOwopTrf/tsLzw4Xxo6Iquz17bx86tNda2q+QxFgBTBYELoXAQClBXT6n1BMS6mPm/MtP+2Yjq7g2BCGAMgCND3ARSEAIUEgqAAQqGXTutXW/o5Y2LopU3bvh/8Jhoefaa/f+n+Bdt6TdPe/ejDN6+5dPHuR+55/LKlyzfZ+Rx5Y/OLwzs+2hSJRMLxaPSBVMfALmIs/HHPgU1Pbdr6ycmjk1PkR8s3XN8TjcefM0L6Y55Ne2Utsndw2e7a3I9/nT7+2J09l16feOilbdP5o4OqqgNBQJBSBgIBQAAQABQQAgQBaO3qKz3b8lxLCRnTvtC18KntpkPvDH4l13ULRyJ6T8gI3ZuKp6hEKeNcT8QTA4IgeuPjYw+OT4790Ar53f2Dy7+57+g/b0qlUqSxqSPd0NiyJ51IAgiB67qwrSP9q9a21INvuO3/tNqNh0+cvqyrvbXQFE87x7MZHyGs1cMBFESBcE5dBBk3Qppv2Raz7aI5kR1PKVMB9n92AQMsAEII0CJxeKRl6YnlKxeMdLc3lkqlmtQ3sNhsbYlFmhI2Mk2BlcsXyoVCrkfl3CBQrwqQQSApYOhK2KyYOSLLCi8VC1Y+m01UK9kVB/bv78jlCqQ51XrWMEJcFISDgDsY4KvM/OShTL7k7fzbl5KjQ3t4fUPHOw1NLbshYiAQEAAAAUQEEVCw9+jRY+Vdb7+BjVDj2b6BJe9dd91HtVQm03fZsuOGGYl9gTHCAnQjQdR46tSpN9auXXMof5b8P5a/AAc0A1mn0J8CAAAAAElFTkSuQmCC'

let tray: Tray | null = null

export function initTray(mainWindow: () => BrowserWindow | null): void {
  if (tray) return

  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'))
  tray = new Tray(icon)

  tray.setToolTip('秋山澪 AI Voice Assistant')

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          const win = mainWindow()
          if (win && !win.isDestroyed()) {
            win.show()
            win.focus()
          }
        },
      },
      {
        label: '隐藏主窗口',
        click: () => {
          const win = mainWindow()
          if (win && !win.isDestroyed()) win.hide()
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          tray?.destroy()
          tray = null
          app.exit(0)
        },
      },
    ]),
  )

  tray.on('double-click', () => {
    const win = mainWindow()
    if (win && !win.isDestroyed()) {
      win.isVisible() ? win.hide() : win.show()
    }
  })

  log('INFO', 'tray_init_done')
}

export function destroyTray(): void {
  if (tray) {
    tray.destroy()
    tray = null
  }
}
