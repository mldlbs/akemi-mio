npx tsc --noEmit -p tsconfig.node.json
if ($LASTEXITCODE -eq 0) {
    Write-Host "TypeScript check passed."
    exit 0
} else {
    Write-Host "TypeScript check failed with exit code $LASTEXITCODE"
    exit $LASTEXITCODE
}
