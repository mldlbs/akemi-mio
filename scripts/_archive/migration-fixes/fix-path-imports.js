const fs = require('fs');
const path = require('path');

function fixPathImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixPathImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports like './insight/types' -> './types'
      content = content.replace(
        /from '\.\/insight\/([^']+)'/g,
        (match, importPath) => {
          return `from './${importPath}'`;
        }
      );
      
      // Fix imports like './insight/InsightScorer' -> './InsightScorer'
      content = content.replace(
        /from '\.\/insight\/([^']+)'/g,
        (match, importPath) => {
          return `from './${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for intelligence-insight package
fixPathImports(path.join(__dirname, 'packages', 'intelligence-insight', 'src'));
