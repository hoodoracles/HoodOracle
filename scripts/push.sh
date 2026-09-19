#!/usr/bin/env bash
#
# Push to both repositories, each with the authorship it needs.
#
#   npm run push
#
# Two remotes, two identities, same tree:
#
#   origin   hoodoracles/HoodOracle   authored hoodoracles <hoodoracles@gmail.com>
#   godhblk  godhblk/hoodoracle       authored godhblk <isaacfortune4@gmail.com>
#
# The split is not cosmetic. Vercel deploys from godhblk/hoodoracle and refuses
# to build a commit whose author it does not recognise as belonging to the
# project, so pushing hoodoracles-authored commits there silently stops
# deployments. Meanwhile the public repo should not carry a personal address in
# every commit. One tree, two authorships, is the only arrangement that
# satisfies both.
#
# `main` is the source of truth and is hoodoracles-authored. The godhblk copy
# is derived from it on every push, never edited directly -- commit to `main`
# and run this.

set -euo pipefail

BRANCH=main
MIRROR=godhblk-mirror

cd "$(dirname "$0")/.."

if [[ -n "$(git status --porcelain --untracked-files=no)" ]]; then
  echo "refusing to push with uncommitted changes:"
  git status --short --untracked-files=no
  exit 1
fi

current=$(git rev-parse --abbrev-ref HEAD)
if [[ "$current" != "$BRANCH" ]]; then
  echo "on '$current', expected '$BRANCH'"
  exit 1
fi

echo "==> origin  (hoodoracles/HoodOracle)"
git push origin "$BRANCH"

echo
echo "==> rebuilding $MIRROR from $BRANCH, re-authored as godhblk"
git branch -f "$MIRROR" "$BRANCH"
FILTER_BRANCH_SQUELCH_WARNING=1 git filter-branch -f --env-filter '
export GIT_AUTHOR_NAME="godhblk"
export GIT_AUTHOR_EMAIL="isaacfortune4@gmail.com"
export GIT_COMMITTER_NAME="godhblk"
export GIT_COMMITTER_EMAIL="isaacfortune4@gmail.com"
' -- "$MIRROR" >/dev/null 2>&1

# The rewrite must change authorship and nothing else. A tree mismatch means
# something other than the author was altered, and force-pushing that to the
# repository Vercel builds from is not a mistake worth discovering later.
if [[ "$(git rev-parse "${BRANCH}^{tree}")" != "$(git rev-parse "${MIRROR}^{tree}")" ]]; then
  echo "tree mismatch between $BRANCH and $MIRROR -- refusing to push"
  exit 1
fi

echo "==> godhblk (godhblk/hoodoracle, the one Vercel builds)"
git push godhblk "${MIRROR}:${BRANCH}" --force

echo
echo "origin   $(git rev-parse --short "$BRANCH")  $(git log -1 --format='%an' "$BRANCH")"
echo "godhblk  $(git rev-parse --short "$MIRROR")  $(git log -1 --format='%an' "$MIRROR")"
