#!/usr/bin/env bash
# PreToolUse hook: reminds Claude to branch off before editing.
# - On main: always emit a strong reminder.
# - On any other branch: emit a lighter "is this the right branch?" nudge
#   once per session, so unrelated work gets its own branch even when the
#   session started on a pre-existing feature branch.
# Always exits 0 (non-blocking).

set -eu

stdin=$(cat)
session_id=$(printf '%s' "$stdin" | jq -r '.session_id // "unknown"' 2>/dev/null || echo "unknown")
b=$(git -C "${CLAUDE_PROJECT_DIR:-$PWD}" branch --show-current 2>/dev/null || true)

if [ -z "$b" ]; then
  exit 0
fi

# Skip when the target file is outside this project — auto-memory writes
# (~/.claude/projects/.../memory/), other repos, and any /tmp scratch files
# don't belong to this repo's git workflow and shouldn't trigger the
# protected-branch reminder. Edit/Write/MultiEdit use file_path;
# NotebookEdit uses notebook_path.
project_dir="${CLAUDE_PROJECT_DIR:-$PWD}"
target_path=$(printf '%s' "$stdin" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null || echo "")
if [ -n "$target_path" ] && [ -n "$project_dir" ]; then
  # Claude Code sometimes passes file_path as a project-relative string
  # (e.g. "lib/common.js") rather than an absolute path. Anchor any
  # non-absolute value under project_dir before the prefix check or the
  # case-glob silently fails and we skip the branch reminder.
  case "$target_path" in
    /*) ;;
    *) target_path="${project_dir}/${target_path}" ;;
  esac
  # Collapse `..` segments before the prefix check: a relative outside-project
  # edit like `../scratch/note.md` anchors to `$project_dir/../scratch/…`,
  # which the glob below would wrongly accept as inside. The file may not
  # exist yet, so normalize lexically instead of resolving on disk.
  target_path=$(python3 -c 'import os, sys; print(os.path.normpath(sys.argv[1]))' "$target_path" 2>/dev/null || printf '%s' "$target_path")
  project_dir=$(python3 -c 'import os, sys; print(os.path.normpath(sys.argv[1]))' "$project_dir" 2>/dev/null || printf '%s' "$project_dir")
  case "$target_path" in
    "$project_dir"/*) ;;  # inside the repo — fall through to the branch check
    *) exit 0 ;;          # outside the repo — silently skip
  esac
fi

emit() {
  # $1 = additionalContext string (already-escaped JSON fragment safe)
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","additionalContext":%s}}\n' "$1"
}

json_escape() {
  printf '%s' "$1" | jq -Rs . 2>/dev/null || printf '"%s"' "$1"
}

if [ "$b" = "main" ]; then
  msg="You are on protected branch $b. Per CLAUDE.md, all changes must go through pull requests — create a feature branch (git checkout -b <name>) before editing files. Do not commit or push on this branch."
  emit "$(json_escape "$msg")"
  exit 0
fi

# session_id can contain slashes or other path-unsafe chars depending on
# harness version; strip everything that isn't alphanumeric so touch always
# succeeds and per-session deduplication is reliable. Fall back to a safe
# constant when the sanitized result is empty (e.g., null session id).
safe_session_id="$(printf '%s' "$session_id" | tr -cd '[:alnum:]')"
[ -z "$safe_session_id" ] && safe_session_id="default"
sentinel="/tmp/claude-branch-check-${safe_session_id}"
if [ ! -f "$sentinel" ]; then
  touch "$sentinel" 2>/dev/null || true
  msg="Editing on branch '$b'. If this work is unrelated to that branch's purpose, create a new feature branch first (git checkout -b <name>) — don't pile unrelated changes onto whatever branch the session happened to start on. This reminder shows once per session."
  emit "$(json_escape "$msg")"
fi

exit 0
