// 网易云音乐SDK初始化模块
// 请替换YOUR_APP_ID为实际申请的APPID
window.NeteaseMusicSDK = {
  /**
   * 初始化SDK
   * @param {string} appid - 开放平台申请的APPID
   * @returns {Promise<void>}
   */
  init(appid) {
    return new Promise((resolve, reject) => {
      // 动态加载SDK脚本
      const script = document.createElement('script')
      script.src = `https://music.163.com/sdk/v2/?appid=${appid}&callback=neteaseReady`
      
      // 设置超时处理（10秒）
      const timeout = setTimeout(() => {
        reject(new Error('SDK加载超时'))
        document.body.removeChild(script)
      }, 10000)
      
      // 全局回调函数
      window.neteaseReady = () => {
        clearTimeout(timeout)
        resolve()
      }
      
      script.onerror = () => {
        clearTimeout(timeout)
        reject(new Error('SDK加载失败'))
      }
      
      document.body.appendChild(script)
    })
  },
  
  // 示例API方法
  recognizeAudio(audioData) {
    return window.NetEaseMusicAPI?.recognize(audioData) || 
      Promise.reject('SDK未初始化')
  }
}