# Homebrew fixtures

These JSON files were downloaded unchanged from the official public API on 2026-10-05 for cask/formula field-mapping tests:

- `visual-studio-code.json`: `https://formulae.brew.sh/api/cask/visual-studio-code.json`
- `wechat.json`: `https://formulae.brew.sh/api/cask/wechat.json`
- `ripgrep.json`: `https://formulae.brew.sh/api/formula/ripgrep.json`

Normalization tests also use inline edge cases for disabled packages, replacements, renames, architecture constraints, complex licenses and all dependency types. Tests never execute Homebrew commands.
