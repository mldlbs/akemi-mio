const fs = require('fs');
const path = require('path');

const files = fs.readdirSync(path.join(__dirname, 'packages', 'asr', 'src'))
    .filter(f => f.endsWith('.ts'));

const dir = path.join(__dirname, 'packages', 'asr', 'src');

files.forEach(file => {
    const filePath = path.join(dir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    content = content.replace(/from '\.\/types'/g, "from '@akemi-mio/audio-types'");
    content = content.replace(/from '\.\/AsrService'/g, "from '@akemi-mio/audio/AsrService'");
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed: ${file}`);
});
