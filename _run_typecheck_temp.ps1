npx tsc --noEmit -p tsconfig.node.json --pretty
if ($LASTEXITCODE -eq 0) { Write-Host "TYPECHECK PASSED" } else { Write-Host "TYPECHECK FAILED with exit code $LASTEXITCODE" }
