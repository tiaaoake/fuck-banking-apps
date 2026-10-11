# Notes for AI agents (Codex and others)

Read `CLAUDE.md` first: the project's rules (privacy, read-only script, how tabs are read) apply to every agent, not just Claude.

The workflows live as skills in `.claude/skills/`. Claude Code loads them by itself; other agents should open the matching file and follow it:

| When the user says | Follow |
| --- | --- |
| "get me started", "help me set this up", "where am I up to?", or asks how to customise or update | `.claude/skills/getting-started/SKILL.md` |
| "set up my dashboard", or the banks are syncing but nothing is categorised and there are no goals | `.claude/skills/finance-setup/SKILL.md` |
| "what should I cut?", "run my monthly review", "how am I doing?", anything about goals and spending | `.claude/skills/personal-finance-review/SKILL.md` |

`python3 scripts/doctor.py` shows which setup steps are done. Without a Google Sheets connector, give sheet changes as tab-separated rows for the user to paste.

Claude Code also runs `scripts/agent-guard.py` before shell commands. Other agents don't, so be careful: never bypass the git commit check (`.githooks/pre-commit`), and never commit `my-*` files, `.clasp.json`, `.cache/` or exports.
