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

This is for a Mac. You do the first four steps yourself, which takes about 15 minutes. Then the AI takes over and walks you through the rest.

**1. Make a GitHub account.** Sign up at https://github.com/signup. It's free.

**2. Install the tools.** Open Terminal (Cmd+Space, type Terminal). If you don't have Homebrew yet, install it first from https://brew.sh (copy the one line on that page into Terminal). Then:

```bash
brew install git gh node
```

**3. Download the project.** Log in to GitHub (pick GitHub.com, then HTTPS, then "Login with a web browser"), then download:

```bash
gh auth login
```

```bash
mkdir -p ~/Projects && cd ~/Projects && gh repo clone OWNER/REPO finance-tracker && cd finance-tracker
```

**4. Open an AI in the folder.** Use whichever you have:

- Claude Code (what I use): install it from https://claude.com/claude-code, then run `claude` in the folder.
- ChatGPT's Codex: run `npm install -g @openai/codex`, then `codex` in the folder, and sign in with your ChatGPT account.

**5. Say "get me started".** From here the AI drives:

- It checks which steps you've done (`python3 scripts/doctor.py`).
- It runs the terminal commands for you.
- It walks you through the browser bits one at a time: connecting Google, getting your Akahu tokens, the first sync.
- If you stop halfway, say "where am I up to?" next time and it picks up from there.

**6. Say "set up my dashboard".** Once your banks are syncing, this:

- splits your income by source
- sorts your bills, subscriptions and spending
- sets your goals, each with a base and a stretch target
- builds a budget
- turns on the Friday email

It takes 30 to 60 minutes, once.

**7. Then once a month, say "run my monthly review".** You get your ranked list of what to cut, and whether last month's changes worked.

## Making it yours

Just ask. "Make the Friday email meaner." "Send it on Sundays." "Add a tab for my car costs." "Stop suggesting I cut coffee." It's your own copy of the code, so anything can change. Your settings live in files that never get overwritten when you pull updates from me. Ask the AI how to pull updates, or to set up a private backup of your copy on GitHub.

The README has every step written out, if you'd rather do it by hand or want to see what the AI is doing.

A few things to know:

- When you run it the first time, Google will warn that the app is "unverified". That's normal, because it's your own script: click Advanced, then Go to project.
- Once it's running it takes about 2 minutes a week (sorting a few new transactions), plus 15 minutes a month for the review.

Shout if you get stuck. Happy to jump on a call and do it together.

[your name]
