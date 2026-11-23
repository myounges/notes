#!/usr/bin/env bash
# End-to-end API verification for the notes backend.
# Requires: server running on PORT, DATA_DIR configured, password set.
set -uo pipefail

BASE="${BASE:-http://127.0.0.1:8082}"
PASS="${PASS:-testpass123}"
DATA_DIR="${DATA_DIR:-./data/notes}"
COOKIE_JAR="$(mktemp)"
TMPA="$(mktemp /tmp/attach-XXXX.txt)"
trap 'rm -f "$COOKIE_JAR" "$TMPA"' EXIT

pass=0
fail=0

check_status() {
  local desc="$1" expected="$2"
  shift 2
  local code
  code=$(curl -s -o /dev/null -w "%{http_code}" "$@")
  if [ "$code" = "$expected" ]; then
    pass=$((pass+1)); echo "ok   - $desc [HTTP $code]"
  else
    fail=$((fail+1)); echo "FAIL - $desc (expected $expected got $code)"
  fi
}

check_contains() {
  local desc="$1" needle="$2"
  shift 2
  local out
  out=$(curl -s "$@")
  if echo "$out" | grep -q -- "$needle"; then
    pass=$((pass+1)); echo "ok   - $desc"
  else
    fail=$((fail+1)); echo "FAIL - $desc; resp: ${out:0:160}"
  fi
}

echo "== auth =="
check_status "GET /api/notes without auth -> 401" 401 "$BASE/api/notes" -b "$COOKIE_JAR"
check_status "login wrong password -> 401" 401 -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d '{"password":"wrongpass"}'
check_contains "login ok" '"ok":true' -c "$COOKIE_JAR" -X POST "$BASE/api/auth/login" -H 'Content-Type: application/json' -d "{\"password\":\"$PASS\"}"

echo "== notes CRUD =="
check_status "GET /api/notes with auth -> 200" 200 -b "$COOKIE_JAR" "$BASE/api/notes"

C=$(curl -s -b "$COOKIE_JAR" -X POST "$BASE/api/notes" -H 'Content-Type: application/json' -d '{"title":"API test note","body":"hello world **markdown**","tags":["test","api"]}')
ID=$(echo "$C" | python3 -c 'import sys,json;print(json.load(sys.stdin)["id"])' 2>/dev/null || echo '')
if [ -n "$ID" ]; then pass=$((pass+1)); echo "ok   - create note: $ID"; else fail=$((fail+1)); echo "FAIL - create note; resp: $C"; fi

check_contains "read note" '"title":"API test note"' -b "$COOKIE_JAR" "$BASE/api/notes/$ID"
check_contains "GET /api/notes lists created note" 'API test note' -b "$COOKIE_JAR" "$BASE/api/notes"
check_contains "update note" '"body":"updated body' -b "$COOKIE_JAR" -X PUT "$BASE/api/notes/$ID" -H 'Content-Type: application/json' -d '{"body":"updated body"}'

NTD="$DATA_DIR/notes/$ID/note.md"
if [ -f "$NTD" ]; then
  pass=$((pass+1)); echo "ok   - note.md exists on disk"
  if grep -q "word_count: [0-9]" "$NTD"; then pass=$((pass+1)); echo "ok   - word_count in frontmatter"; else fail=$((fail+1)); echo "FAIL - word_count in frontmatter"; fi
  if grep -q "device:" "$NTD"; then pass=$((pass+1)); echo "ok   - device in frontmatter"; else fail=$((fail+1)); echo "FAIL - device in frontmatter"; fi
else
  fail=$((fail+1)); echo "FAIL - note.md on disk ($NTD)"
fi

echo "== search =="
check_contains "search finds updated body" '"total":1' -b "$COOKIE_JAR" "$BASE/api/search?q=updated"
check_contains "search finds by tag" 'api' -b "$COOKIE_JAR" "$BASE/api/search?q=api"

echo "== tags =="
check_contains "GET /api/tags" '"name":"api"' -b "$COOKIE_JAR" "$BASE/api/tags"

echo "== attachments =="
printf 'hello attachment content\n' > "$TMPA"
ATTD=$(basename "$TMPA")
check_contains "attachment uploaded" "\"filename\":\"$ATTD\"" -b "$COOKIE_JAR" -X POST "$BASE/api/notes/$ID/attachments" -F "file=@$TMPA"
check_contains "attachment served" "hello attachment content" -b "$COOKIE_JAR" "$BASE/api/notes/$ID/attachments/$ATTD"
check_status "attachment 404 for bad name" 404 -b "$COOKIE_JAR" "$BASE/api/notes/$ID/attachments/does_not_exist.bin"
check_status "DELETE attachment -> 200" 200 -b "$COOKIE_JAR" -X DELETE "$BASE/api/notes/$ID/attachments/$ATTD"
check_status "GET deleted attachment -> 404" 404 -b "$COOKIE_JAR" "$BASE/api/notes/$ID/attachments/$ATTD"

echo "== reindex =="
check_contains "reindex" '"indexed":' -b "$COOKIE_JAR" -X POST "$BASE/api/reindex"

echo "== delete note =="
check_status "DELETE note -> 200" 200 -b "$COOKIE_JAR" -X DELETE "$BASE/api/notes/$ID"
check_status "GET deleted note -> 404" 404 -b "$COOKIE_JAR" "$BASE/api/notes/$ID"

echo "== logout =="
check_status "POST logout -> 200" 200 -b "$COOKIE_JAR" -c "$COOKIE_JAR" -X POST "$BASE/api/auth/logout"
check_status "GET /api/notes after logout -> 401" 401 -b "$COOKIE_JAR" "$BASE/api/notes"

echo
echo "PASSED: $pass   FAILED: $fail"
[ "$fail" -eq 0 ]