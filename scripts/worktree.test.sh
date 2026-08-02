#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
source_script="$script_dir/worktree.sh"
fixture=$(mktemp -d "${TMPDIR:-/tmp}/agora-worktree-test.XXXXXX")
trap 'rm -rf "$fixture"' EXIT

git -C "$fixture" init -b main >/dev/null
git -C "$fixture" config user.name "Worktree Test"
git -C "$fixture" config user.email "worktree-test@example.invalid"
mkdir -p "$fixture/scripts" "$fixture/.claude/skills/verify" "$fixture/mobile/.claude/skills/mobile-verify"
cp "$source_script" "$fixture/scripts/worktree.sh"
printf 'fixture\n' > "$fixture/README.md"
printf 'SECRET=test\n' > "$fixture/.env"
printf '/.worktrees/\n.worktree-env\n.cargo-target/\n.env\n.claude/\n.codex/\n' > "$fixture/.gitignore"
git -C "$fixture" add .gitignore README.md scripts/worktree.sh
git -C "$fixture" commit -m "test fixture" >/dev/null

(cd "$fixture" && scripts/worktree.sh new feat/one --copy-env >/dev/null)
worktree="$fixture/.worktrees/feat-one"
[[ -d "$worktree" ]]
[[ "$(git -C "$worktree" branch --show-current)" == "feat/one" ]]
grep -q '^export AGORA_PORT=4480$' "$worktree/.worktree-env"
grep -q '^export AGORA_BASE=' "$worktree/.worktree-env"
[[ "$(stat -f '%Lp' "$worktree/.env" 2>/dev/null || stat -c '%a' "$worktree/.env")" == "600" ]]
[[ -L "$worktree/.claude/skills" ]]
[[ -L "$worktree/mobile/.claude/skills" ]]

# Generated build output must not make an otherwise clean worktree unremovable.
mkdir -p "$worktree/.cargo-target/debug"
printf 'artifact\n' > "$worktree/.cargo-target/debug/agora-server"
[[ -z "$(git -C "$worktree" status --porcelain)" ]]

touch "$worktree/dirty.txt"
if (cd "$fixture" && scripts/worktree.sh rm feat/one >/dev/null 2>&1); then
  echo "dirty worktree removal unexpectedly succeeded" >&2
  exit 1
fi
rm "$worktree/dirty.txt"
(cd "$fixture" && scripts/worktree.sh rm feat/one --delete-branch >/dev/null)
[[ ! -e "$worktree" ]]
if git -C "$fixture" show-ref --verify --quiet refs/heads/feat/one; then
  echo "merged branch was not deleted" >&2
  exit 1
fi

echo "worktree tests passed"
