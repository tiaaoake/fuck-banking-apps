#!/usr/bin/env python3
"""Claude Code hook (PreToolUse, Bash): keeps agents from committing personal data, even if the git hooks are off.

Refuses ways around the check (--no-verify, git add -f, changing core.hooksPath). Before a commit, checks every file
git could pick up and the command itself (which holds the message); before a push, checks every tracked file.
Exit 2 blocks the command and tells the agent why.
"""
import json, os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
cmd = (json.load(sys.stdin).get('tool_input') or {}).get('command', '')
if not re.search(r'\bgit\b', cmd):
    sys.exit(0)


def block(why):
    print(why + ' Personal data stays in the sheet or a gitignored my-* file; see README, "Your settings".', file=sys.stderr)
    sys.exit(2)


if re.search(r'--no-verify|\bcommit\b[^|;&]*\s-[a-zA-Z]*n\b', cmd):
    block('Skipping the git hooks is not allowed here.')
if re.search(r'\badd\b[^|;&]*\s(-f|--force)\b', cmd):
    block('Force-adding ignored files is not allowed here.')
if 'hooksPath' in cmd and '.githooks' not in cmd:
    block('Changing core.hooksPath is not allowed here.')


def check(*args):
    r = subprocess.run([sys.executable, os.path.join(ROOT, 'scripts/check-private.py'), *args], cwd=ROOT,
                       capture_output=True, text=True)
    if r.returncode:
        block(r.stdout.strip())


if re.search(r'\bgit\b[^|;&]*\bcommit\b', cmd):
    check('--candidates')
    path = os.path.join(ROOT, '.git', 'agent-guard-msg')
    with open(path, 'w') as f:
        f.write(cmd)
    check('--message', path)
if re.search(r'\bgit\b[^|;&]*\bpush\b', cmd):
    check()
