# Sources of brew output

These are short log excerpts from official documentation/issues. The simulator combines them by scenario and replays progress with carriage returns; it never installs, upgrades, or uninstalls packages on the development machine. Historical issues cover legacy output compatibility; scan tests separately verify Homebrew 7 read-only JSON.

| File / error | Public source |
|---|---|
| install.txt (installation, moving, linking) | https://github.com/Homebrew/homebrew-cask/issues/69939 |
| upgrade.txt (upgrades and versions) | https://github.com/Homebrew/brew/issues/9125 |
| latest.txt | https://github.com/Homebrew/homebrew-cask/issues/251226 |
| download.txt URLs and E_CHECKSUM | https://github.com/Homebrew/homebrew-cask/issues/110856 |
| download.txt progress bar | https://github.com/Homebrew/homebrew-cask/blob/main/USAGE.md |
| E_DOWNLOAD | https://github.com/Homebrew/brew/issues/21426 |
| E_APP_EXISTS (original placeholder paths preserved) | https://github.com/Homebrew/homebrew-cask/issues/60284 |
| E_DISABLED | https://github.com/Homebrew/homebrew-core/issues/77932 |
| E_LOCKED | https://github.com/Homebrew/homebrew-core/issues/5159 |
| E_SUDO | https://github.com/Homebrew/install/issues/612 |
| E_REQUIRED_BY (two log lines; must not match only one) | https://github.com/Homebrew/brew/issues/3730 |

The simulator does not inherit arbitrary test-process environment variables; tests explicitly inject scenario variables. Read-only commands still force HOMEBREW_NO_AUTO_UPDATE=1. Signal tests target only the simulator's isolated PTY process group. The slow scenario installs its signal handlers before announcing `FAKE_BREW_READY`; cancellation tests wait for that marker rather than a startup delay.

Additional samples: fetching/pouring from https://github.com/Homebrew/brew/issues/21067; uninstall/purge from https://github.com/Homebrew/homebrew-cask/issues/196281; cleanup/caveats from https://github.com/Homebrew/brew/issues/5675; missing packages from https://github.com/Homebrew/brew/issues/15235; permission errors from https://github.com/Homebrew/homebrew-cask/issues/250469; OS requirements from https://github.com/Homebrew/homebrew-cask/issues/287458; conflicts from https://github.com/Homebrew/homebrew-cask/issues/62301.

The specification's `requires macOS >=` differs from actual Homebrew 7 Cask output. The parser retains that compatibility rule and also accepts `This cask does not run on macOS versions older than`. No Homebrew 7 write logs were fabricated.

`installed_subset.json` comes from read-only `info --json=v2 --installed` under Homebrew 7.0.7 on 2026-10-05, explicitly setting HOMEBREW_NO_AUTO_UPDATE=1 and HOMEBREW_NO_ANALYTICS=1. It retains scan fields for four official formulae and three official casks. Tests redirect app targets to temporary directories and construct their own plist/icns files, avoiding real Applications writes. Neither the full machine inventory nor user environment is committed.

`outdated_subset.json` was extracted the same day from read-only `outdated --json=v2 --greedy` with HOMEBREW_NO_AUTO_UPDATE=1 / HOMEBREW_NO_ANALYTICS=1, retaining the same installed candidates. `examples/read_only_updates.rs` runs a complete read-only comparison against a temporary database, without invoking update/upgrade.

Maintenance fixtures reproduce only official source output formats with test paths/versions/sizes; no real cleanup or bundle was run. `cleanup_dry_run.txt` follows Homebrew 7.0.7 [cleanup.rb](https://github.com/Homebrew/brew/blob/7.0.7/Library/Homebrew/cleanup.rb) and [cmd/cleanup.rb](https://github.com/Homebrew/brew/blob/7.0.7/Library/Homebrew/cmd/cleanup.rb) Would remove/total formats. `doctor.txt` contains two [diagnostic.rb](https://github.com/Homebrew/brew/blob/7.0.7/Library/Homebrew/diagnostic.rb) warning forms. `Brewfile` uses simple [Homebrew Bundle](https://docs.brew.sh/Brew-Bundle-and-Brewfile) declarations. Test exports let only the simulator write temporary files, never real bundle.
