# Mio Runtime Compatibility Entry

The published Mio Agent Runtime lives in `packages/mio-cli`.
This directory remains only for repository scripts that still invoke
`node cli/mio.js`.

Use the canonical package during development:

```powershell
node packages/mio-cli/bin/mio.js --help
npm run check --workspace mio-agent-runtime
npm pack --dry-run --workspace mio-agent-runtime
```

The compatibility invocation is still supported:

```powershell
node cli/mio.js --help
```

Do not add runtime behavior to this directory. Changes belong under
`packages/mio-cli`.
