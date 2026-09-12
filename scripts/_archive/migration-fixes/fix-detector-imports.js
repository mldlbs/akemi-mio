const fs = require('fs');
const path = require('path');

function fixDetectorImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixDetectorImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports in Detectors directory - need to go up one level
      if (filePath.includes('Detectors')) {
        content = content.replace(
          /from '\.\/types'/g,
          "from '../types'"
        );
      }
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for intelligence-insight package
fixDetectorImports(path.join(__dirname, 'packages', 'intelligence-insight', 'src'));
