// Change tokens in an isolated copy to catch hardcoded generator regressions without altering repository colors.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('Generator reads color tokens from an isolated copy and uses them in SVG output', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opennavo-logo-'));
  try {
    const source = path.join(root, 'docs/design/logo/source');
    fs.mkdirSync(source, { recursive: true });
    for (const file of ['build.js', 'assets.js', 'geom.js', 'wordmark-outline.json']) {
      fs.copyFileSync(path.join(__dirname, file), path.join(source, file));
    }
    fs.symlinkSync(path.resolve(__dirname, '../../../../apps/web/node_modules'), path.join(source, 'node_modules'));
    const tokens = JSON.parse(fs.readFileSync(path.resolve(__dirname, '../../../../packages/tokens/tokens.json'), 'utf8'));
    let next = 1;
    for (const group of ['brand', 'text', 'surface']) {
      for (const token of Object.values(tokens.color[group])) {
        const value = () => `#${(next++).toString(16).padStart(6, '0')}`;
        token.value = Array.isArray(token.value) ? token.value.map(value) : value();
      }
    }
    const tokenDir = path.join(root, 'packages/tokens');
    fs.mkdirSync(tokenDir, { recursive: true });
    fs.writeFileSync(path.join(tokenDir, 'tokens.json'), JSON.stringify(tokens));
    const output = JSON.parse(execFileSync(process.execPath, ['-e', `
      const B = require('./build');
      const A = require('./assets');
      process.stdout.write(JSON.stringify({ colors: B.C, dark: A.markSquare(24, 'dark'), light: A.markSquare(24, 'light'), icon: A.appIconSvg(false) }));
    `], { cwd: source, encoding: 'utf8' }));
    const c = tokens.color;
    assert.deepEqual(output.colors, {
      logo: c.brand.logoGradient.value, core: c.brand.logoCoreGradient.value,
      starOnLight: c.brand.logoCoreGradientOnLight.value, coral: c.brand.coral.value,
      textOnDark: c.text.primary.value, textOnLight: c.text.inverse.value,
      iconBody: c.surface.sidebar.value, page: c.surface.page.value, violet: c.brand.violet.value,
    });
    for (const value of [...c.brand.logoGradient.value, ...c.brand.logoCoreGradient.value]) assert.ok(output.dark.includes(value));
    for (const value of c.brand.logoCoreGradientOnLight.value) assert.ok(output.light.includes(value));
    assert.ok(output.icon.includes(c.surface.sidebar.value));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
