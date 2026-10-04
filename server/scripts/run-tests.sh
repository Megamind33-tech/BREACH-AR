#!/usr/bin/env bash
# Runs each server test file on its own with a hard time limit, so one hung file cannot stall (or hide) the rest.
# Usage: scripts/run-tests.sh [file ...]   (default: every test/*.test.ts)   Exit code 1 if any file fails or times out.
cd "$(dirname "$0")/.." || exit 2
files=("$@"); [ ${#files[@]} -eq 0 ] && files=(test/*.test.ts)
fail=0; total=0; passed=0
for f in "${files[@]}"; do
  out=$(mktemp)
  timeout "${TEST_TIMEOUT:-600}" npx tsx --test --test-force-exit "$f" > "$out" 2>&1; code=$?
  t=$(grep -a -E '^ℹ tests' "$out" | awk '{print $3}'); p=$(grep -a -E '^ℹ pass' "$out" | awk '{print $3}')
  if [ $code -eq 124 ]; then echo "TIMEOUT $f"; fail=1
  elif [ "${t:-0}" = "${p:-0}" ] && [ "${t:-0}" != "0" ]; then echo "ok      $f ($p tests)"
  else echo "FAIL    $f (${p:-0}/${t:-0})"; grep -a -E '^✖' "$out" | head -5; fail=1; fi
  total=$((total + ${t:-0})); passed=$((passed + ${p:-0})); rm -f "$out"
done
echo "TOTAL $passed/$total passed"
exit $fail
