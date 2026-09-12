const fs = require('fs');
const path = require('path');

function fixIntelligenceImports(dir, oldPrefix, newPackage) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixIntelligenceImports(filePath, oldPrefix, newPackage);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/...
      content = content.replace(
        new RegExp(`from '@akemi-mio/intelligence/${oldPrefix}/([^']+)'`, 'g'),
        (match, importPath) => {
          return `from '@akemi-mio/${newPackage}/${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for insight module
fixIntelligenceImports(
  path.join(__dirname, 'packages', 'intelligence', 'src', 'insight'),
  'insight',
  'insight'
);

// Fix imports for observer module
fixIntelligenceImports(
  path.join(__dirname, 'packages', 'intelligence', 'src', 'observer'),
  'observer',
  'intelligence-observer'
);

// Fix imports for plugin module
fixIntelligenceImports(
  path.join(__dirname, 'packages', 'intelligence', 'src', 'plugin'),
  'plugin',
  'intelligence-plugin'
);
