const fs = require('fs');
const path = require('path');

// 修复 audio-tools
const audioToolsDir = path.join(__dirname, 'packages', 'audio-tools', 'src');
const audioToolsFiles = fs.readdirSync(audioToolsDir).filter(f => f.endsWith('.ts'));
audioToolsFiles.forEach(file => {
    const filePath = path.join(audioToolsDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/from '@akemi-mio\/audio-types'/g, "from '@akemi-mio/audio'");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed audio-tools: ${file}`);
});

// 修复 voice-analytics
const voiceAnalyticsDir = path.join(__dirname, 'packages', 'voice-analytics', 'src');
const voiceAnalyticsFiles = fs.readdirSync(voiceAnalyticsDir).filter(f => f.endsWith('.ts'));
voiceAnalyticsFiles.forEach(file => {
    const filePath = path.join(voiceAnalyticsDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/from '@akemi-mio\/audio-types'/g, "from '@akemi-mio/audio'");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed voice-analytics: ${file}`);
});

// 修复 asr
const asrDir = path.join(__dirname, 'packages', 'asr', 'src');
const asrFiles = fs.readdirSync(asrDir).filter(f => f.endsWith('.ts'));
asrFiles.forEach(file => {
    const filePath = path.join(asrDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/from '@akemi-mio\/audio-types'/g, "from '@akemi-mio/audio'");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed asr: ${file}`);
});
