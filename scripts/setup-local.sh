#!/bin/sh
# One-time setup after cloning: create your own files from the examples, and turn on the commit check.
# Safe to run again; it never overwrites a file you already have.
# apps-script/.clasp.json is left to `clasp create` (see README), which makes the sheet and writes it for you.
cd "$(dirname "$0")/.." || exit 1
for f in apps-script/my-rules.gs apps-script/my-actions.gs \
         .claude/skills/personal-finance-review/my-preferences.md .private-words; do
  if [ ! -e "$f" ] && [ -e "$f.example" ]; then cp "$f.example" "$f" && echo "Created $f"; fi
done
git config core.hooksPath .githooks && echo "Commit check on: commits with personal data are blocked."
