/**
 * afterPack hook: embed custom icon into the packaged exe.
 *
 * electron-builder skips rcedit when signAndEditExecutable is false
 * (needed to avoid winCodeSign download behind the Great Firewall).
 * This hook re-applies the icon via the cached rcedit binary.
 */
const { execSync } = require('child_process')
const { join } = require('path')
const { existsSync } = require('fs')

const RCEDIT_PATH = join(
  process.env.LOCALAPPDATA || 'C:\\Users\\gf191\\AppData\\Local',
  'electron-builder',
  'Cache',
  'winCodeSign',
  'rcedit-x64.exe',
)

exports.default = async function (context) {
  const { appOutDir, packager } = context
  const productName = packager.appInfo.productName
  const exePath = join(appOutDir, `${productName}.exe`)
  const iconPath = join(packager.buildResourcesDir, 'icon.ico')

  if (!existsSync(RCEDIT_PATH)) {
    console.warn('[afterPack-icon] rcedit not found, skipping icon embed')
    return
  }
  if (!existsSync(exePath)) {
    console.warn('[afterPack-icon] exe not found:', exePath)
    return
  }
  if (!existsSync(iconPath)) {
    console.warn('[afterPack-icon] icon not found:', iconPath)
    return
  }

  try {
    execSync(`"${RCEDIT_PATH}" "${exePath}" --set-icon "${iconPath}"`, { stdio: 'pipe' })
    console.log('[afterPack-icon] Icon embedded successfully:', iconPath)
  } catch (err) {
    console.error('[afterPack-icon] Failed to embed icon:', err.message)
  }
}
