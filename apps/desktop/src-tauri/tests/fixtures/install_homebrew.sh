#!/bin/bash
# The local installer copies only fake brew into the supplied temporary test directory.
set -eu
test "$NONINTERACTIVE" = "1"
test "$HOMEBREW_NO_AUTO_UPDATE" = "1"
test -n "$SUDO_ASKPASS"
test -n "$OPENNAVO_LOCALE"
test "$HOMEBREW_API_DOMAIN" = "https://api.example.test"
test "$HOMEBREW_BREW_GIT_REMOTE" = "https://git.example.test/brew"
printf '==> Installing Homebrew (local simulator)\n'
/bin/mkdir -p "$(/usr/bin/dirname "$FAKE_INSTALL_DEST")"
/bin/cp "$FAKE_INSTALL_SOURCE" "$FAKE_INSTALL_DEST"
/bin/chmod 755 "$FAKE_INSTALL_DEST"
printf '==> Installation successful!\n'
