const fs = require('fs');
const path = require('path');

function fixImports(dir, packageName) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixImports(filePath, packageName);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/...
      content = content.replace(
        /from '@akemi-mio\/intelligence\/([^']+)'/g,
        (match, importPath) => {
          // Check if the imported file exists in the current package
          const localPath = path.join(dir, importPath + '.ts');
          const localIndexPath = path.join(dir, importPath, 'index.ts');
          
          if (fs.existsSync(localPath) || fs.existsSync(localIndexPath)) {
            // Local import
            return `from './${importPath}'`;
          } else {
            // External import - keep as intelligence package import
            return match;
          }
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for each package
const packagesDir = path.join(__dirname, 'packages');

fixImports(path.join(packagesDir, 'superpowers', 'src'), 'superpowers');
fixImports(path.join(packagesDir, 'analysis', 'src'), 'analysis');
fixImports(path.join(packagesDir, 'intelligence-insight', 'src'), 'insight');
fixImports(path.join(packagesDir, 'intelligence-observer', 'src'), 'observer');
fixImports(path.join(packagesDir, 'intelligence-plugin', 'src'), 'plugin');
