# Mio MCP Compatibility Entry

The maintained MCP implementation and full documentation live in
`packages/mio-cli/server/mio-intelligence-mcp`.

This directory is retained for repository consumers that still launch:

```text
node server/mio-intelligence-mcp/index.js
```

The entry delegates to the canonical `mio-agent-runtime` implementation.
Do not add MCP behavior here.
