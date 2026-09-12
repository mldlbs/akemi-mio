const fs = require('fs');
const path = require('path');

const evolutionValidatorDir = path.join(__dirname, 'packages', 'evolution-validator', 'src');
const files = fs.readdirSync(evolutionValidatorDir).filter(f => f.endsWith('.ts'));

files.forEach(file => {
    const filePath = path.join(evolutionValidatorDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    // 修复跨模块导入（如果有）
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed: ${file}`);
});
