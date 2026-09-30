#!/usr/bin/env bash
# investment_model/ 의 데이터·결과만 커밋하고 기본 브랜치에 push (rebase 후 최대 5회 재시도).
# 다른 경로(data/kospi_signal.json 등)는 절대 stage 하지 않습니다.
set -euo pipefail
BRANCH="${1:?branch}"
MSG="${2:?message}"
git config user.name "github-actions[bot]"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
paths=()
for p in investment_model/data investment_model/history investment_model/output; do [ -e "$p" ] && paths+=("$p"); done
git add -A -- "${paths[@]}"
if git diff --cached --quiet; then
  echo "변경 없음 — 커밋하지 않습니다."
  exit 0
fi
git commit -q -m "$MSG"
for i in 1 2 3 4 5; do
  if git pull -q --rebase --autostash origin "$BRANCH" && git push -q origin "HEAD:$BRANCH"; then
    echo "push 완료 ($i회차)"; exit 0
  fi
  echo "push 실패 — $((i*5))초 후 재시도"; sleep $((i*5))
done
echo "::error::push 5회 실패"; exit 1
