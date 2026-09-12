const fs = require('fs');
const path = require('path');

const piperTtsDir = path.join(__dirname, 'packages', 'piper-tts', 'src');
const files = fs.readdirSync(piperTtsDir).filter(f => f.endsWith('.ts'));

files.forEach(file => {
    const filePath = path.join(piperTtsDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    // 修复 ./types 导入
    content = content.replace(/from '\.\/types'/g, "from '@akemi-mio/audio'");
    // 修复跨模块导入
    content = content.replace(/from '\.\/TtsService'/g, "from '@akemi-mio/audio/TtsService'");
    content = content.replace(/from '\.\/UserContextClassifier'/g, "from '@akemi-mio/audio/UserContextClassifier'");
    content = content.replace(/from '\.\/BehaviorEmotionDetector'/g, "from '@akemi-mio/audio/BehaviorEmotionDetector'");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed: ${file}`);
});
