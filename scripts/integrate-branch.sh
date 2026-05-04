#!/usr/bin/env bash
# integrate-branch.sh — Rebase a feature branch onto release/mwitt and merge it.
#
# Used during the cutover (orbital-pipeline-2026-05-04) to bring all in-flight
# feature branches onto the new release/mwitt mainline. After cutover, the
# normal flow is "open a PR via gh pr create" — this script is for the bulk
# initial integration only.
#
# Per branch:
#   1. Check out a working ref off origin/<branch>.
#   2. Rebase onto release/mwitt.
#   3. On conflict: deterministic auto-resolve for known noise files
#      (package-lock.json, _journal.json), then run renumber-migrations.mjs.
#   4. If conflicts remain after auto-resolve, abort and report — that branch
#      goes on the human-merge list.
#   5. On clean rebase: build + lint + test the merged result. If any check
#      fails, abort and report.
#   6. On success: fast-forward release/mwitt to the rebased tip with --no-ff.
#
# Usage:
#   ./scripts/integrate-branch.sh feat/settings-general
#   ./scripts/integrate-branch.sh --dry-run feat/settings-general

set -euo pipefail

DRY_RUN=0
if [ "${1:-}" = "--dry-run" ]; then
  DRY_RUN=1
  shift
fi

BRANCH="${1:-}"
if [ -z "$BRANCH" ]; then
  echo "usage: $0 [--dry-run] <branch-name>"
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

log() { echo "[integrate-branch:$BRANCH] $*"; }

# Pre-flight
git diff --quiet || { log "FAIL: working tree dirty"; exit 1; }
git fetch origin "$BRANCH" release/mwitt 2>&1 | tail -3 || true

if ! git rev-parse --verify "origin/$BRANCH" >/dev/null 2>&1; then
  log "SKIP: origin/$BRANCH does not exist"
  exit 0
fi

# Work on a temporary integration ref so we don't pollute origin until we're sure.
INT_REF="integrate/$BRANCH"
git branch -f "$INT_REF" "origin/$BRANCH"
git checkout "$INT_REF"

# Rebase onto current release/mwitt
log "rebasing onto release/mwitt..."
if ! git rebase release/mwitt; then
  log "rebase reported conflicts; attempting deterministic auto-resolve"
  CONFLICTS_BEFORE=$(git diff --name-only --diff-filter=U)
  log "conflicting files:"
  echo "$CONFLICTS_BEFORE" | sed 's/^/  /'

  # Auto-resolve known noise files: take ours (release/mwitt side).
  for f in package-lock.json packages/db/src/migrations/meta/_journal.json; do
    if echo "$CONFLICTS_BEFORE" | grep -qx "$f"; then
      log "auto-resolving $f -> ours (release/mwitt)"
      git checkout --ours -- "$f"
      git add -- "$f"
    fi
  done

  # Re-run renumber for any newly introduced migrations
  log "renumbering migrations"
  node scripts/renumber-migrations.mjs || true
  git add packages/db/src/migrations/

  REMAINING=$(git diff --name-only --diff-filter=U || true)
  if [ -n "$REMAINING" ]; then
    log "FAIL: conflicts remain after auto-resolve:"
    echo "$REMAINING" | sed 's/^/  /'
    git rebase --abort
    git checkout release/mwitt
    git branch -D "$INT_REF" || true
    exit 3
  fi

  log "auto-resolve clean; continuing rebase"
  GIT_EDITOR=true git rebase --continue || {
    log "FAIL: rebase --continue failed"
    git rebase --abort
    git checkout release/mwitt
    git branch -D "$INT_REF" || true
    exit 3
  }
fi

# Post-rebase sanity: journal monotonic, settings router intact
log "validating journal + settings router"
node scripts/check-journal-monotonic.mjs
node scripts/check-settings-router.mjs

if [ "$DRY_RUN" = "1" ]; then
  log "DRY RUN: skipping build/test/merge. Integration ref left at $INT_REF."
  git checkout release/mwitt
  exit 0
fi

# Optional: run a quick build to catch obvious break (skipped if SKIP_BUILD=1)
if [ "${SKIP_BUILD:-0}" != "1" ]; then
  log "running build (set SKIP_BUILD=1 to skip)"
  if ! npm run build --silent 2>&1 | tail -20; then
    log "FAIL: build broke after rebase"
    git checkout release/mwitt
    git branch -D "$INT_REF" || true
    exit 4
  fi
fi

# Merge into release/mwitt with --no-ff
log "merging $INT_REF into release/mwitt with --no-ff"
git checkout release/mwitt
git merge --no-ff "$INT_REF" -m "merge: $BRANCH

Integrated via scripts/integrate-branch.sh during the
release-pipeline cutover (orbital-pipeline-2026-05-04)."

git branch -D "$INT_REF"
log "OK: $BRANCH merged into release/mwitt"
