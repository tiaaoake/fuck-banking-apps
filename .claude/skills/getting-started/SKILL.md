---
name: getting-started
description: Takes a new user from a fresh clone to a working, synced Personal Finance sheet, then hands over to dashboard setup. Runs scripts/doctor.py to see which step they're up to, does the terminal steps for them, and talks them through the browser steps (Google, Akahu, Apps Script). Also explains how to customise the tracker and keep getting updates. Use when the user says "get me started", "help me set this up", "where am I up to?", "something's not working with setup", or asks how to customise it or pull updates.
---

# Getting started

The user has cloned this repo and opened an AI assistant in it. Get them to a sheet that syncs their banks, then hand over to the finance-setup skill. Assume they're comfortable with apps but new to terminals and code.

## How to run it

1. Run `python3 scripts/doctor.py`. It lists every setup step as done `[x]` or not `[ ]`, and ends with the next thing to do. Run it again after every step: it's how you both know where you're up to, even across sessions.
2. Tell the user in one or two lines where they are ("Tools are in. Next is connecting to Google.") and do the next step.
3. Terminal steps: run them yourself, explaining each in a sentence first. Browser steps: give the user the exact link and what to click, then wait for them to say it's done.
4. One step at a time. Never ask the user to paste a token, password or key into the chat, and never print one. Tokens go straight into Apps Script's Script properties.

## The steps

**Tools.** `brew install git node`, then `npm install -g @google/clasp`. If `brew` is missing, the user installs Homebrew from brew.sh themselves (it asks for their Mac password).

**Local files.** Run `scripts/setup-local.sh`. Then ask for the words that identify them (surname, employer, the names of people they pay or who pay them), and write them into `.private-words`, one per line. Explain that the commit check blocks these from ever reaching git.

**Google.**
1. The user turns on the Apps Script API at https://script.google.com/home/usersettings.
2. Run `clasp login`. It opens a browser window; the user signs in with the Google account that should own the sheet.
3. Create the sheet: in `apps-script`, run `clasp create --type sheets --title "Personal Finance" --rootDir .`. Then restore the repo's manifest with `git checkout appsscript.json` (clasp create overwrites it), and push with clasp's force flag (`clasp push`, plus `-f`). If the push says the Apps Script API isn't enabled, it can take a few minutes to switch on: wait, then try again.

**Bank feeds.** All in the browser; talk them through it.
1. Akahu: sign up at https://my.akahu.nz, connect their personal bank accounts (and KiwiSaver if listed), then Developers > create a personal app, and keep the App token and User token handy.
2. Optional, Wise: Settings > API tokens > a read-only token for the personal profile. Connect Wise either here or inside Akahu, not both.
3. Open the sheet (`clasp open-container` opens it, or find "Personal Finance" in Google Drive), then Extensions > Apps Script > Project Settings > Script properties. Add `AKAHU_APP_TOKEN`, `AKAHU_USER_TOKEN` and, if using Wise, `WISE_API_TOKEN`.
4. While they're there, have them check that the sheet's time zone (File > Settings) is Pacific/Auckland.
5. In the editor, choose `setup` and click Run. Google warns the app is unverified: Advanced > Go to project > Allow. That's expected for your own script. Then run `sync`; the first one can take a minute or two.
6. Have them reload the sheet. The Finance menu appears.

**Daily refresh.** In the editor, run `installAutoRefresh` once: a sync every morning around 7am, and the Friday email.

When the Tools, Local files, Google and Sheet sections of the doctor all pass, say so, then start the finance-setup skill ("set up my dashboard"). The doctor's last section tracks that skill's progress.

## When something fails

- `clasp push` says the API is disabled: turn it on at script.google.com/home/usersettings, wait a few minutes, retry.
- `clasp login` or `read-sheet.py` fails to sign in: run `clasp login` again.
- Sync errors 401 or 403: an Akahu token is wrong or was regenerated. Re-copy both into Script properties.
- No Finance menu: reload the sheet, or run `setup` again.
- An account shows twice: Wise is connected both directly and through Akahu.
- Months are off by a day: the sheet's time zone doesn't match the script's.
- The doctor says it can't read the sheet, and they made the sheet by hand: clasp's login can only read sheets it created. Use a Sheets connector for the AI, or recreate the sheet with clasp create.

## Customising it

It's the user's own copy, so any of it can change. Explain where each kind of change goes, so updates don't fight with it:

- **About them** (rules, subscriptions, savings actions, things never to cut): the `my-*` files and the sheet. These never conflict with updates.
- **Look and wording** (the Friday email's tone and day, which tabs show, Dashboard sections): `apps-script/finance-sync.gs`. Change it, run `node tests/finance-sync.test.js`, preview the email with `node scripts/preview-email.js`, then `clasp push`. Commit the change so it isn't lost.
- **New features** (another tab, another email, a new kind of goal): describe it to the AI. Keep number logic in plain functions with a test, as `CLAUDE.md` says.
- **How the AI coaches** (what it asks, what it focuses on): the skill files in `.claude/skills/`. Personal preferences go in `my-preferences.md`; changes to the process go in the SKILL.md files.

## Keeping it updated

If they cloned the original repo, `git pull` gets updates. If they made their own private copy (git remote renamed to `upstream`), it's `git pull upstream main`. After pulling: `node tests/finance-sync.test.js`, `cd apps-script && clasp push`, then run `setup` once in the editor to add any new tabs or columns. If their own changes clash with an update, resolve it with them, keeping their customisations.

Suggest a private copy of their own on GitHub for backup once they've customised anything: `git remote rename origin upstream`, then `gh repo create my-finance-tracker --private --source . --push`. It must be private.
