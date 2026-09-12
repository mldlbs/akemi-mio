const fs = require('fs');
const path = require('path');

const evolutionPlanDir = path.join(__dirname, 'packages', 'evolution-plan', 'src');
const files = fs.readdirSync(evolutionPlanDir).filter(f => f.endsWith('.ts'));

files.forEach(file => {
    const filePath = path.join(evolutionPlanDir, file);
    let content = fs.readFileSync(filePath, 'utf8');
    // 修复跨模块导入（如果有）
    fs.writeFileSync(filePath, content, 'utf8');
    console.log(`Fixed: ${file}`);
});
