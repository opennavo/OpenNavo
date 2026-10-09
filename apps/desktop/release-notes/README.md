# Desktop release notes

Before pushing a `desktop-vX.Y.Z` tag, add two UTF-8 Markdown files for that exact version:

- `apps/desktop/release-notes/X.Y.Z/zh-CN.md`
- `apps/desktop/release-notes/X.Y.Z/en-US.md`

Describe actual user-facing changes in the tagged code. Keep the two languages consistent. Do not copy preview data or list unreleased features. Prereleases use the complete version directory, such as `0.3.0-beta.1`.

Validate locally from the repository root:

```sh
node apps/desktop/scripts/release-notes.mjs --version X.Y.Z
```

Tag CI validates both files before starting macOS builds and passes them to draft registration with `--notes-dir apps/desktop/release-notes`. Missing, empty or version-only notes fail publication; there is no placeholder fallback. Manual build-only runs do not require notes. Files are read directly, preserving Markdown and avoiding shell interpolation of their contents.

The server stores these notes with the draft release. Publishing that release makes them available to the website and clients. Other languages follow the server's translation and fallback policy. Existing published notes are not changed by editing these files; update those through the admin release editor.

Direct registration also supports explicit `--notes-zh` and `--notes-en` text arguments, but both must contain real content and cannot be combined with `--notes-dir`.
