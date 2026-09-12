const fs = require('fs');
const path = require('path');

function fixAgentPersonaImports(dir) {
  const files = fs.readdirSync(dir, { withFileTypes: true });
  
  for (const file of files) {
    const filePath = path.join(dir, file.name);
    
    if (file.isDirectory()) {
      fixAgentPersonaImports(filePath);
    } else if (file.name.endsWith('.ts')) {
      let content = fs.readFileSync(filePath, 'utf8');
      
      // Fix imports from @akemi-mio/intelligence/agent/...
      content = content.replace(
        /from '@akemi-mio\/intelligence\/agent\/([^']+)'/g,
        (match, importPath) => {
          return `from './${importPath}'`;
        }
      );
      
      fs.writeFileSync(filePath, content, 'utf8');
      console.log(`Fixed: ${filePath}`);
    }
  }
}

// Fix imports for agent-persona package
fixAgentPersonaImports(path.join(__dirname, 'packages', 'agent-persona', 'src'));
