const fs = require('fs');
const path = require('path');

function fixLearningImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixLearningImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/learning/...
      content = content.replace(
        /from '@akemi-mio\/intelligence\/learning\/([^']+)'/g,
        (match, importPath) => {
          return `from './${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for learning package
fixLearningImports(path.join(__dirname, 'packages', 'learning', 'src'));
