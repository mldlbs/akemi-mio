const ts = require('typescript');
const fs = require('fs');
const path = require('path');

const configPath = path.resolve(__dirname, 'tsconfig.node.json');
const configText = fs.readFileSync(configPath, 'utf8');
const config = JSON.parse(configText);

const program = ts.createProgram({
  rootNames: config.include
    ? undefined
    : undefined,
  options: { ...config.compilerOptions, noEmit: true },
  configFileParsingDiagnostics: true,
});

const program2 = ts.createProgram({
  options: {},
  configFileParsingDiagnostics: true,
});

// Actually, let's just use the simpler API
const parsedConfig = ts.parseJsonConfigFileContent(
  config,
  ts.sys,
  __dirname
);

const prog = ts.createProgram({
  rootNames: parsedConfig.fileNames,
  options: { ...parsedConfig.options, noEmit: true },
});

const diagnostics = [
  ...ts.getPreEmitDiagnostics(prog),
];

const host = ts.createCompilerHost({ ...parsedConfig.options, noEmit: true }, true);
