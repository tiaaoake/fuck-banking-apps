# Invite email

A ready-to-send email for sharing this with a friend. Fill in the [brackets] and OWNER/REPO (from this repo's URL).

---

Subject: That self-updating spreadsheet I built (want it?)

Hey [name],

You know how banking apps are useless for actually understanding your money? Every bank has its own app, none of them talk to each other, the "insights" are a pie chart that files half your spending under Other, and working out whether you're on track for anything means exporting CSVs and wrestling Excel. I got fed up and built my own.

It pulls all your NZ bank accounts (and Wise, if you use it) into one Google Sheet that updates itself every morning: a dashboard, budgets, goals with a "when will I get there" forecast, net worth, and a payday plan of what to move where.

The big idea: it's designed to be run with AI. Instead of clicking around an app, you talk to it. "What should I cut?" "Add a goal for Japan next March." "Why was October so expensive?" "Never tell me to cut climbing." The AI reads your sheet, gives you a ranked list of changes backed by your real numbers, and tracks whether they're working.

You can make it completely yours:

- Your own categories. Sort a few transactions a week and it learns the rules.
- Goals, budgets and planned purchases, each with a forecast date.
- A 7am refresh every morning, and a cheeky money email to your inbox on Fridays. Ask the AI to change the tone, the day or what's in it.
- Anything else you want. It's your own copy of the code, so ask the AI to add the tab, reminder or email you're after.

What it runs on (all FREE):

- **Google Sheets and Apps Script**: the sheet and the engine, in your own Google account.
- **Akahu**: NZ's open-banking service, which connects to your banks. Free for personal use.
- **Wise API** (optional): for multi-currency balances.
- **GitHub**: where the code lives.
- **clasp**: Google's tool for uploading the code to your sheet.
- **An AI assistant**: ChatGPT's Codex or Claude Code. Use whichever you already have; they come with a ChatGPT or Claude plan.

No app, no subscription, and nobody selling your data. The only thing you might pay for is an AI plan you probably already have.

## Your data, upfront

- Your transactions and balances live in your own Google Sheet, in your Google Drive. Nobody else sees them unless you share it. Don't give anyone edit access to the sheet or its script: anyone who can edit the script can see your bank tokens.
- Akahu connects to your banks and holds your data so it can provide the service, under its own privacy policy (akahu.nz). It's read only: it can't move money, and you can disconnect any bank at any time at my.akahu.nz. Wise, if you add it, uses a read-only token.
- The code on GitHub holds no data, and a check blocks personal info from being committed. Nothing comes to me.
- Your bank tokens go in the script's settings in Google. Never put them in the code or paste them into an AI chat.
- When an AI reviews your money, it reads your sheet (transactions, balances, goals), so that data is sent to OpenAI or Anthropic. Check whether your chats are used for training and turn it off if you'd rather (ChatGPT: Settings > Data controls; Claude: Settings > Privacy).
- When the AI reads the sheet, it saves a copy in the project's `.cache` folder on your computer. That never goes to GitHub.
- The Friday email goes from your own Gmail to you.
- It's not financial advice. The AI sticks to spending and budgeting; tax and investment questions go on a Notes tab for you to take to an actual adviser.

## Setting it up

This is for a Mac. Allow about an hour all up.

**1. Make a GitHub account.** Sign up at https://github.com/signup. It's free.

**2. Install the tools.** Open Terminal (Cmd+Space, type Terminal). If you don't have Homebrew yet, install it first from https://brew.sh (copy the one line on that page into Terminal). Then:

```bash
brew install git gh node
```

**3. Log in to GitHub from the terminal.**

```bash
gh auth login
```

Pick GitHub.com, then HTTPS, then "Login with a web browser", and follow the prompts.

**4. Download the project.**

```bash
mkdir -p ~/Projects
cd ~/Projects
gh repo clone OWNER/REPO finance-tracker
cd finance-tracker
scripts/setup-local.sh
```

The last line creates your own private settings files and switches on the check that stops personal info getting into git.

Optional: if you'd like your own copy on GitHub (handy for backups), make it **private**:

```bash
git remote rename origin upstream
gh repo create my-finance-tracker --private --source . --push
```

Later, `git pull upstream main` gets any updates I make.

**5. Follow the README.** README.md in the folder walks through the rest, step by step: making the Google Sheet, getting your Akahu tokens and the first sync. You'll need a free Akahu account (https://my.akahu.nz) with your banks connected.

**6. Hand the boring bits to an AI.** Open an assistant in the folder and ask it things: help with setup, sorting transactions, setting goals, or a monthly "what should I cut" review.

ChatGPT / Codex:

```bash
npm install -g @openai/codex
cd ~/Projects/finance-tracker
codex
```

Sign in with your ChatGPT account. Then start with: "Read README.md, CLAUDE.md and .claude/skills/personal-finance-review/SKILL.md, then walk me through setup one step at a time." Those files were written for Claude, but Codex follows them fine. Run `ln -s CLAUDE.md AGENTS.md` in the folder and Codex picks them up by itself.

Claude Code (what I use): install it from https://claude.com/claude-code and open the folder. It picks up the instructions and the review skill on its own, so you can say "help me set this up", or once it's running, "run my monthly review".

A few things to know:

- When you run it the first time, Google will warn that the app is "unverified". That's normal, because it's your own script: click Advanced, then Go to project.
- Once it's running it takes about 2 minutes a week (sorting a few new transactions), plus 15 minutes a month for the review.

Shout if you get stuck. Happy to jump on a call and do it together.

[your name]
