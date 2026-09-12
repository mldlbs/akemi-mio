const fs = require('fs');
const path = require('path');

const ttsCoreDir = path.join(__dirname, 'packages', 'tts-core', 'src');
const files = fs.readdirSync(ttsCoreDir).filter(f => f.endsWith('.ts'));

files.forEach(file => {
    const filePath = path.join(ttsCoreDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    // 修复 ./types 导入
    content = content.replace(/from '\.\/types'/g, "from '@akemi-mio/audio'");
    // 修复跨模块导入
    content = content.replace(/from '\.\/PiperOrchestrator'/g, "from '@akemi-mio/piper-tts/PiperOrchestrator'");
    content = content.replace(/from '\.\/SentimentAnalyzer'/g, "from '@akemi-mio/audio/SentimentAnalyzer'");
    content = content.replace(/from '\.\/PhrasePregenService'/g, "from '@akemi-mio/audio/PhrasePregenService'");
    content = content.replace(/from '\.\/VoicePreferenceModel'/g, "from '@akemi-mio/audio/VoicePreferenceModel'");
    content = content.replace(/from '\.\/NetworkMonitor'/g, "from '@akemi-mio/audio/NetworkMonitor'");
    content = content.replace(/from '\.\/TtsRouter'/g, "from './TtsRouter'");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed: ${file}`);
});
