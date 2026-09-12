const fs = require('fs');
const path = require('path');

function fixMcpMemoryObservationImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixMcpMemoryObservationImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/mcp/...
      content = content.replace(
        /from '@akemi-mio\/intelligence\/mcp\/([^']+)'/g,
        (match, importPath) => {
          return `from './${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for mcp-memory-observation package
fixMcpMemoryObservationImports(path.join(__dirname, 'packages', 'mcp-memory-observation', 'src'));
