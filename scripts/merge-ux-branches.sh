#!/usr/bin/env bash
# Merge the 6 UX branches into consolidated/main-2026-05-04, build, deploy, walk.
# Run from /Users/matthewwitt/AI SDLC/orbital after each agent reports done.
set -euo pipefail

cd "/Users/matthewwitt/AI SDLC/orbital"

BRANCHES=(
  "feat/ux-1-create-project"
  "feat/ux-2-settings"
  "feat/ux-3-consistency"
  "feat/ux-4-nav"
  "feat/ux-5-forms"
  "feat/ux-6-states"
)

git fetch origin
git checkout consolidated/main-2026-05-04
git pull origin consolidated/main-2026-05-04 --ff-only || true

for branch in "${BRANCHES[@]}"; do
  echo "## Merging $branch"
  if git merge --no-ff "origin/$branch" -m "merge: $branch" 2>&1 | tee /tmp/merge.log; then
    echo "  ok"
  else
    echo "  CONFLICT on $branch"
    if git diff --name-only --diff-filter=U | grep -qE 'package-lock.json|_journal.json'; then
      # Trivial conflicts: resolve in favor of theirs (newer dep additions win)
      git checkout --theirs package-lock.json packages/db/src/migrations/meta/_journal.json 2>/dev/null || true
      git add -A
      git commit --no-edit
      echo "  resolved trivial conflicts; continuing"
    else
      echo "  non-trivial conflicts in:"
      git diff --name-only --diff-filter=U
      echo "  ABORTING this branch — needs manual review"
      git merge --abort
    fi
  fi
done

echo "## Building"
rm -rf packages/orchestrator/dist packages/orchestrator/.tsbuildinfo packages/api-lambda/dist packages/domain/dist packages/domain/.tsbuildinfo
npm run build -w @orbital/types
npm run build -w @orbital/db
npm run build -w @orbital/domain
npm run build -w @orbital/orchestrator
cd packages/api-lambda && npm run build
cd ../ui && npx vite build
cd ../..

echo "## Deploying api-lambda"
cd packages/api-lambda/dist
rm -f /tmp/api-lambda-update.zip
zip -q /tmp/api-lambda-update.zip handler.mjs
V=$(aws lambda update-function-code --function-name orbital-mwitt-api --zip-file fileb:///tmp/api-lambda-update.zip --publish --query Version --output text)
echo "  v=$V"
until [ "$(aws lambda get-provisioned-concurrency-config --function-name orbital-mwitt-api --qualifier live --query Status --output text 2>/dev/null)" = "READY" ]; do sleep 5; done
aws lambda update-alias --function-name orbital-mwitt-api --name live --function-version "$V" --routing-config '{}' --query FunctionVersion --output text

echo "## Deploying UI"
cd ../../ui
aws s3 sync dist/ s3://orbital-ui-mwitt-403001214246/ --delete
INV=$(aws cloudfront create-invalidation --distribution-id E28L1XYTKZTJQG --paths '/*' --query 'Invalidation.Id' --output text)
echo "  INV=$INV"
aws cloudfront wait invalidation-completed --distribution-id E28L1XYTKZTJQG --id "$INV"

echo "## Final walk"
node walk-deep.mjs | tail -5

echo "## Pushing consolidated"
cd ../..
git push origin consolidated/main-2026-05-04
