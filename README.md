# 秋山澪 Ai Voice Assistant Wallpaper

基于 Electron 的 AI 语音助手桌面壁纸应用，支持语音唤醒、语音识别（Whisper/Baidu ASR）、AI 对话、语音合成（TTS）。

## 功能

- 🎤 语音输入：Whisper 本地语音识别 / 百度语音识别（可选）
- 🤖 AI 对话：与 LLM 进行自然对话
- 🔊 语音合成：Edge TTS 朗读回复
- 🎯 按键唤醒：F2 快捷键唤醒语音输入
- ⚡ 轻量高性能：基于 Electron + Vite + React

## 开始使用

```bash
# 安装依赖
npm install

# 下载 ASR 模型
npm run download:model

# 启动开发环境
npm run dev

# 构建生产版本
npm run build:win
```

## 技术栈

- **框架**: Electron + electron-vite
- **前端**: React 19 + TypeScript
- **语音识别**: Whisper (Xenova Transformers) / 百度语音识别 API
- **语音合成**: Edge TTS
- **桌面打包**: electron-builder

## License

MIT
