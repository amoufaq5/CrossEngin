#!/bin/sh
#
# Point this clone's git hooks at `.githooks/`, unless that would take something away.
#
# ADR-0382, corrected in its own review. The root `prepare` script used to be the whole
# installer, inline:
#
#     git rev-parse --git-dir >/dev/null 2>&1 && git config core.hooksPath .githooks || true
#
# and it was wrong in two measured ways. Both reproduced in a throwaway repository:
#
#   1. A pre-existing `core.hooksPath` pointing anywhere else — husky, lefthook, a
#      developer's own directory — was **overwritten with no warning**. Taking another
#      tool's hooks away is worse than not installing ours, because the hooks that stop
#      running are ones somebody chose and the failure is silent.
#
#   2. `git config --unset core.hooksPath` was **re-set on the next `pnpm install`**, so
#      the ADR's claim that it "undoes its effect per clone" was false. A remedy that does
#      not work is worse than none (ADR-0334), and this one had been written into the
#      Consequences of the increment citing that rule.
#
# So: the escape is `crossengin.hooks off`, which is git config and therefore per clone and
# persistent, and a foreign hooks path is left exactly as it is with a line saying so. The
# worst case in every branch below is the status quo plus one line of stderr, which is what
# keeps `pnpm install` from being the thing this breaks.
#
# Invoked as `sh .githooks/install-hooks.sh`, so it needs no mode bit. It needs exactly the
# shell the hook it installs needs — if there is no POSIX `sh`, `.githooks/pre-commit`
# could not have run either, so declining to install is the right answer rather than a
# limitation. It is not a git hook name, so git never executes it as one.
set -e

# Not a repository. This is the `deploy/Dockerfile` position: `.dockerignore` excludes
# `.git` and keeps `.githooks`, so `COPY . .` lands this file in a tree with no repository
# and `pnpm install --frozen-lockfile` must not fail there (ADR-0382 Option G measured the
# unguarded form exiting 128). The `prepare` script guards this too; the duplicate is here
# so running the installer by hand behaves the same way.
git rev-parse --git-dir >/dev/null 2>&1 || exit 0

# The opt-out. Read before anything is written, so a clone that has declined stays declined
# however often `pnpm install` runs.
if [ "$(git config --get crossengin.hooks || true)" = "off" ]; then
  exit 0
fi

existing=$(git config --get core.hooksPath || true)

if [ -n "$existing" ] && [ "$existing" != ".githooks" ]; then
  echo "crossengin: core.hooksPath is already '$existing', so .githooks was NOT installed." >&2
  echo "            Overwriting another tool's hooks path would silently stop its hooks." >&2
  echo "            To use this repository's hook instead:" >&2
  echo "              git config core.hooksPath .githooks" >&2
  exit 0
fi

if [ "$existing" = ".githooks" ]; then
  # Already ours. Silent, because the ordinary case must not print on every install.
  exit 0
fi

git config core.hooksPath .githooks
# Printed only when something changed, which is the line whose absence made the clobbering
# above invisible.
echo "crossengin: core.hooksPath -> .githooks (pre-commit runs the workspace rules)." >&2
echo "            To decline, for this clone and for good:" >&2
echo "              git config crossengin.hooks off && git config --unset core.hooksPath" >&2
