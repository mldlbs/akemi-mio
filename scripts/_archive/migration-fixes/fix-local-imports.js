const fs = require('fs');
const path = require('path');

function fixLocalImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixLocalImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/...
      content = content.replace(
        /from '@akemi-mio\/intelligence\/([^']+)'/g,
        (match, importPath) => {
          // Convert to local import
          return `from './${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for intelligence-insight package
fixLocalImports(path.join(__dirname, 'packages', 'intelligence-insight', 'src'));

// Fix imports for intelligence-observer package
fixLocalImports(path.join(__dirname, 'packages', 'intelligence-observer', 'src'));

// Fix imports for intelligence-plugin package
fixLocalImports(path.join(__dirname, 'packages', 'intelligence-plugin', 'src'));
