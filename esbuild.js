/**
 * esbuild build script for the TabAI extension.
 *
 * Two entry points are produced:
 *  - dist/extension.js : the VS Code extension host bundle (CommonJS, node target)
 *
 * The extension is bundled as a single CommonJS file because VS Code's extension
 * host loads `main` directly with `require`. `vscode` is always external.
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

/** Shared build options for the extension bundle. */
const baseOptions = {
  entryPoints: ['src/extension.ts'],
  bundle: true,
  outfile: 'dist/extension.js',
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: production ? false : 'inline',
  minify: production,
  logLevel: 'info',
};

/** Copies static assets that must ship inside the package. */
function copyStaticAssets() {
  fs.mkdirSync(path.join(__dirname, 'dist'), { recursive: true });
}

async function main() {
  copyStaticAssets();
  if (watch) {
    const ctx = await esbuild.context(baseOptions);
    await ctx.watch();
    console.log('[tabai] watching...');
    return;
  }
  await esbuild.build(baseOptions);
  console.log('[tabai] build finished, production=' + production);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
