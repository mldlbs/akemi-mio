const fs = require('fs');
const path = require('path');

function fixIdentityImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixIdentityImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/identity/...
      content = content.replace(
        /from '@akemi-mio\/intelligence\/identity\/([^']+)'/g,
        (match, importPath) => {
          return `from './${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for identity package
fixIdentityImports(path.join(__dirname, 'packages', 'identity', 'src'));
