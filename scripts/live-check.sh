#!/bin/bash
# StopCode live integration check: runs REAL Claude Code sessions (non-interactive `claude -p`)
# with the plugin loaded from this repository and verifies, end to end, that
#   1. the skills work (/stopcode:status, /stopcode:resume),
#   2. an opted-in quiet-hours boundary denies a new tool action (PreToolUse) without a retry loop
#      and without touching the target file,
#   3. a new prompt during quiet hours is blocked (UserPromptSubmit),
#   4. /stopcode:resume reports the boundary and only lifts it with an explicit override.
# It uses a throwaway project directory (with a space in its name) and a throwaway data dir,
# so your real StopCode data is never touched. It costs a few model calls on your account.
#
# Usage: bash scripts/live-check.sh            (requires: node, git, claude >= 2.1.3xx, signed in)
set -u
# Git Bash (MSYS) rewrites arguments that look like POSIX paths; turn that off so regexes,
# prompts starting with "/stopcode:" and Windows paths reach the programs unchanged.
export MSYS_NO_PATHCONV=1
export MSYS2_ARG_CONV_EXCL="*"
cd "$(dirname "$0")/.." || exit 1
REPO_W="$(node -p "process.cwd().split(String.fromCharCode(92)).join('/')")"
TMP_BASE="$(node -p "require('os').tmpdir().split(String.fromCharCode(92)).join('/')")/stopcode-live-$$"
PROJ="$TMP_BASE/demo project"
export STOPCODE_DATA_DIR="$TMP_BASE/data"
MODEL="${STOPCODE_LIVE_MODEL:-claude-sonnet-5-5}"
mkdir -p "$PROJ" || exit 1
cd "$PROJ" || exit 1
git init -q . 2>/dev/null
echo "sample" > note.txt
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "PASS  $1"; }
bad()  { FAIL=$((FAIL+1)); echo "FAIL  $1"; }
run_claude() { env -u CLAUDECODE claude -p "$1" --plugin-dir "$REPO_W" --max-turns 6 --permission-mode acceptEdits --allowedTools "Bash(node *) Write" --model "$MODEL" < /dev/null 2>&1; }

echo "Project: $PROJ"
echo "Data:    $STOPCODE_DATA_DIR"
echo "--- 1. start a mission through the CLI"
node "$REPO_W/bin/stopcode.js" start "Fix login validation so empty passwords are rejected" --criteria "auth tests pass" --criteria "empty password returns 400" >/dev/null && ok "mission started" || bad "mission start"

echo "--- 2. /stopcode:status skill in a real session"
OUT="$(run_claude "/stopcode:status")"
echo "$OUT" | grep -qi "empty passwords are rejected" && ok "status skill reported the mission" || { bad "status skill"; echo "$OUT" | tail -5; }
if [ -f "$STOPCODE_DATA_DIR/health.json" ] && grep -q '"lastHookEvent"' "$STOPCODE_DATA_DIR/health.json"; then ok "real hook events recorded in health.json"; else bad "no hook events recorded"; fi

echo "--- 3. quiet hours (protected) then a new tool action in the same turn"
OUT="$(run_claude "First run exactly this Bash command: node \"$REPO_W/bin/stopcode.js\" quiet start 10m --protect . After it succeeds, use the Write tool to create blocked.txt containing hello in the current directory. If the Write is denied by a hook, do not retry; reply with the single word DENIED followed by the hook's reason in one sentence.")"
echo "$OUT" | grep -q "DENIED" && ok "model reported the denial" || { bad "no denial reported"; echo "$OUT" | tail -5; }
[ ! -e blocked.txt ] && ok "target file was not created" || bad "blocked.txt exists"
node "$REPO_W/bin/stopcode.js" quiet status | grep -q "active" && ok "quiet hours active" || bad "quiet hours not active"

echo "--- 4. a new prompt during quiet hours is blocked"
OUT="$(run_claude "Say the word hello and nothing else.")"
echo "$OUT" | grep -qi "blocked by hook\|quiet hours are active" && ok "UserPromptSubmit blocked the prompt" || { bad "prompt not blocked"; echo "$OUT" | tail -3; }

echo "--- 5. /stopcode:resume without override keeps the boundary"
OUT="$(run_claude "/stopcode:resume")"
echo "$OUT" | grep -qi "quiet hours are active\|lift" && ok "resume skill reported the boundary" || { bad "resume skill"; echo "$OUT" | tail -5; }
node "$REPO_W/bin/stopcode.js" quiet status | grep -q "active" && ok "quiet hours still active after resume without override" || bad "boundary lifted without override"

echo "--- 6. /stopcode:resume --override lifts it explicitly"
OUT="$(run_claude "/stopcode:resume --override")"
node "$REPO_W/bin/stopcode.js" quiet status | grep -q "not active" && ok "override lifted quiet hours" || bad "override failed"
echo "$OUT" | grep -qi "haven't started\|not started\|have not started\|when you want" && ok "resume did not launch work" || echo "note: could not confirm the 'no work launched' wording; read the output above"

echo
echo "Summary: $PASS passed, $FAIL failed. Timeline:"
node "$REPO_W/bin/stopcode.js" status --json | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const v=JSON.parse(d);console.log(v.timeline.slice(-14).map(e=>"  "+e.type+" @ "+e.atLocal+(e.tool?" ("+e.tool+")":"")).join("\n"))})'
echo "Scratch data left in $TMP_BASE (delete it when done)."
[ "$FAIL" -eq 0 ]
