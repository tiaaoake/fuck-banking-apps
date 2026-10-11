# Finance tracker

A Google Sheet that fills itself from your NZ bank accounts (via [Akahu](https://www.akahu.nz)) and, optionally, [Wise](https://wise.com). It gives you a Dashboard, a month-over-month report, net worth across currencies, goals with a forecast of when you'll reach each one, a payday transfer plan, and a Friday money email. A Claude skill reads it and gives you a ranked list of the changes that would cut your spending most, then tracks whether they worked.

- `apps-script/finance-sync.gs` is the engine. It runs in Google Apps Script, attached to your sheet. It pulls accounts and transactions in, converts everything to NZD, and rebuilds every tab.
- `.claude/skills/personal-finance-review/` is the Claude skill: savings actions, spending analysis, goals and a monthly review. [Claude Code](https://claude.com/claude-code) picks it up when you open this folder.

The script only reads from your bank. It can't make payments or transfers. Your tokens live in Apps Script's Script properties, never in this repo.

## What you need

- A Google account (the sheet and script live in your Drive).
- An [Akahu](https://my.akahu.nz) account with your banks connected. Akahu is NZ only and free for personal use.
- Optional: a Wise account, for multi-currency balances and Jars.
- A Mac or Linux terminal with `git`, Python 3 and [Node.js](https://nodejs.org) 18 or later.
- Optional but recommended: [Claude Code](https://claude.com/claude-code), for the savings review and for managing goals from chat.

## Setup

About 30 minutes, once.

### 1. Get the code

Copy the clone URL from the green Code button on this repo's GitHub page, then:

```bash
git clone <clone URL> finance-tracker
cd finance-tracker
scripts/setup-local.sh
```

`setup-local.sh` creates your own `my-*` files from the examples and turns on a commit check that stops personal data reaching git. Open `.private-words` and add your surname, your employer and the names of people you pay, one per line. The check blocks any commit that contains them.

If you want your copy on GitHub, make it a **private** repo.

### 2. Install clasp and sign in to Google

[clasp](https://github.com/google/clasp) uploads the script to Google.

1. Turn on the Apps Script API at [script.google.com/home/usersettings](https://script.google.com/home/usersettings). clasp can't push without it.
2. Install clasp and sign in with the Google account that will own the sheet:

```bash
npm install -g @google/clasp
```

```bash
clasp login
```

### 3. Create the sheet and push the script

```bash
cd apps-script
clasp create --type sheets --title "Personal Finance" --rootDir .
git checkout appsscript.json
clasp push -f
cd ..
```

This creates a Google Sheet named **Personal Finance** in your Drive with the script attached. It also writes `apps-script/.clasp.json` (your script ID and sheet ID; it's gitignored). `clasp create` replaces `appsscript.json` with a blank one, so `git checkout` puts this repo's version back before you push.

Keep the name "Personal Finance": the Claude skill looks for it.

If you'd rather make the sheet by hand: create the sheet, open Extensions > Apps Script, then copy `apps-script/.clasp.json.example` to `apps-script/.clasp.json`. Fill in the script ID (Apps Script > Project Settings) and the sheet ID (the long part of the sheet's URL), then run `clasp push -f` from `apps-script`. clasp's login can only read sheets it created, though, so `scripts/read-sheet.py` won't work with a hand-made sheet. Use a Google Drive or Sheets connector in Claude instead.

### 4. Get your Akahu tokens

1. Sign in at [my.akahu.nz](https://my.akahu.nz) and connect your bank accounts (and KiwiSaver, if your provider is supported).
2. Go to Developers and create a personal app. Copy the **App token** and the **User token**.

Connect personal accounts only. If you have a business, leave its accounts out of Akahu, or the review will count business spending as yours.

Optional, for Wise: in Wise, go to Settings > API tokens and create a **read only** token for your personal profile. Connect Wise here or inside Akahu, not both, or it's counted twice.

### 5. Add the tokens to the script

1. Open the sheet, then Extensions > Apps Script.
2. Go to Project Settings (the cog) > Script properties and add:

   | Property | Value |
   | --- | --- |
   | `AKAHU_APP_TOKEN` | Akahu App token |
   | `AKAHU_USER_TOKEN` | Akahu User token |
   | `WISE_API_TOKEN` | Wise read-only token (optional) |

3. While you're there, check the time zone. The script uses `Pacific/Auckland` (set in `appsscript.json`). In the sheet, File > Settings > Time zone should match, or months shift by a day.

### 6. Run it for the first time

1. In the Apps Script editor, open `finance-sync.gs`, choose `setup` from the function menu and click Run.
2. Google asks for permissions. It warns that the app isn't verified, because it's your own script: click Advanced > Go to project, then Allow. It needs to edit this sheet, call Akahu and Wise, set up the daily refresh and send you the Friday email.
3. Run `sync`. The first sync pulls about a year of transactions and can take a minute or two.
4. Reload the sheet. A **Finance** menu appears; from now on use Finance > Sync banking feeds.

`setup` creates every tab, with example rows marked "Example" or "e.g." that are ignored. Run it again after pulling updates to this repo. It adds new tabs and columns and leaves your data alone.

### 7. Turn on the daily refresh (optional)

In the editor, run `installAutoRefresh` once. Every morning around 7am the sheet syncs and rebuilds itself. On Fridays it emails you (the script's owner) a short money note: the week so far, this month's budgets, callouts, goals and a plan for the weekend.

- `sendDailyEmail` sends one now.
- `installWeeklyTrigger` syncs on Mondays only, if you'd rather not have the daily refresh.
- `removeTriggers` stops both.

### 8. Make it yours

1. Open **Uncategorised**, pick a My category for the top rows, then Finance > Recategorise and refresh. Each pick becomes a rule.
2. Edit `apps-script/my-rules.gs`. It ships with the category layout this was built around (Bills, Everyday, Subscriptions, Lifestyle, One-off, Other) and common merchants. Swap the placeholders (your name for transfers to yourself, your employer, your landlord) for your own, then `cd apps-script && clasp push`.
3. Add your goals on **Targets** (or ask Claude to; see below), and anything that doesn't sync (an overseas bank, shares, crypto, money you're owed) on **Holdings**.

### 9. Connect Claude (optional)

Open Claude Code in this folder. The skill reads the sheet with `python3 scripts/read-sheet.py`, which uses your clasp login, so there's nothing more to connect.

To have Claude edit Targets, Holdings, Notes and Transfers To Do for you, also connect the Google Sheets (or Google Drive) connector in Claude with the same Google account.

## Your settings: where they live

The repo is the engine. Everything about you lives in two places, and neither is in git.

In the sheet (most of it; yellow cells are yours to edit):

| Tab | What you set |
| --- | --- |
| Categories | Your categorisation rules and groups |
| Targets | Goals, spending limits, planned purchases |
| Notes | Questions to take to your accountant, adviser or bank, or to decide yourself. Claude adds to it; mark rows Done. |
| Holdings | Accounts that don't sync |
| Savings actions | Status of each action |
| Home scenarios | Two homes to compare, if you're saving for one |

In your own files, next to the code. Each `my-*` file is gitignored and has a `.example` that is committed instead. clasp still pushes the `.gs` ones, and `clasp pull` brings them back on a new machine.

| File | What's in it |
| --- | --- |
| `apps-script/my-rules.gs` | Categorisation rules (they name people and places), edits to Categories rows, category merges, subscriptions, pay-per-visit services |
| `apps-script/my-actions.gs` | Savings actions Claude works out, with your amounts |
| `.claude/skills/personal-finance-review/my-preferences.md` | Spending you've asked Claude never to cut, and your subscription decisions |
| `apps-script/.clasp.json` | Your script ID and sheet ID |
| `.private-words` | Words the commit check blocks: your surname, people you pay, your employer |

The commit check (`scripts/check-private.py`) blocks any commit that includes those files, an email, a bank account or card number, a Google file ID, a token, or a word from `.private-words`. It runs before every commit and again on GitHub. Commit messages are checked too, and can't hold dollar amounts.

For AI agents: `.claude/settings.json` runs `scripts/agent-guard.py` before every shell command in Claude Code. It runs the same check before any commit or push, and refuses ways around it. `CLAUDE.md` tells agents where personal data goes instead.

## Using it

Open Claude Code in this folder and say "what should I cut?" for a ranked list of savings actions, or "run my monthly review" for the full review. First time, it helps set up targets. Also: "mid-month check-in", "update my targets", "where's my money going?".

### How you use it

Once a week, about 2 minutes: open Uncategorised, pick a My category for the top few rows (edit the Match text if it's too broad), then Finance > Recategorise and refresh. Each pick becomes a Categories rule, so it stays sorted from then on. A sync also saves your picks first, so nothing typed there is lost.

Once a month, about 15 minutes: Finance > Sync banking feeds, update the Holdings balances that don't update themselves, then ask Claude to "run my monthly review". It checks last month's actions, gives up to five new ranked ones, and adds them to Savings actions for you. The Forecast then shows how much sooner each goal lands. Between reviews, glance at the Dashboard.

### Tabs

Twelve tabs you use. Yellow cells are yours to edit; everything else is filled in by the script and gets overwritten.

| Tab | What it's for |
| --- | --- |
| Dashboard | Headline numbers, your goals and planned purchases (each purchase shows how much of it the paying account covers today), top savings actions, subscriptions (software and apps), living costs by type (rent, office, power, internet, phone, insurance), recurring lifestyle (anything in eating out, fitness, personal care, health or entertainment you pay regularly: gym, massage, barber, your regular cafes), month over month, targets, and charts of income and spend and net worth by month. Generated. |
| Transfers To Do | What to move where for the latest invoice, in order (tax, bills, spending, savings, purchase set-asides, buffer), each line ticked off once the money arrives; one-off transfers outside payday (Claude adds them; set Status to Done once made, and they're kept across refreshes); and your routine: invoice day, Mondays, the 1st. Generated, apart from the one-off rows. |
| Forecast | Your goals first: target, saved, what's left, how much each gets per month and per pay, when it's done, and what's not yet allocated; then each goal month by month for a year. Below that: this month's spend projected to month-end, planned purchases, net worth over 12 months. Generated. |
| Home scenarios | Two homes side by side (Scenario A and B): price, deposit %, costs, rates and running costs, then the deposit needed, when you'll have it, the repayments (also at a stress-test rate), the full cost to own against your rent, and whether the loan fits your income. What's saved counts every House deposit goal on Targets; rent and monthly savings come from Targets. Selected scenario sizes the house goal: on each refresh the House deposit goal that takes your monthly savings changes so the goals add up to what that scenario needs. Also shows how much you hold in other currencies and what an exchange-rate move would do to it. Yellow cells are yours; the rest updates as you change them. |
| Net worth | Every account in its own currency column, totals per currency and in NZD, and each account's goal and progress. Generated, but as formulas: click a number to see where it comes from. A line at the bottom confirms the formulas match the script's own working. |
| Uncategorised | Weekly: uncategorised spending from the last 90 days, one row per merchant, with how-to steps at the top. Pick a category, then Finance > Recategorise and refresh, and it becomes a rule. |
| Savings actions | Ranked actions to spend less. Pick the ones you'll do by setting Status to Committed (or Dropped). Each has a Track, Baseline and Target, and the script fills Last month, This month so far and Progress from your transactions, so you can see if it's working. Claude adds and refreshes them from `apps-script/my-actions.gs`; your Status and Actual saving are never overwritten. |
| Targets | Your goals, and purchases you're considering. Filled in with Claude. |
| Categories | Tagging rules and groups. See below. |
| Holdings | Accounts that don't sync. See below. |
| Transactions | Hidden. Every transaction, newest first. Kept by the sync; only My category changes, and Recategorise rewrites it from the rules, so sort on Uncategorised instead. |

Hidden (the script and Claude read them; unhide from the sheet's tab list if you want to look): Transactions, Accounts, Summary, Merchants, Net worth history, Balance history, FX.

### Goals per account

Give each account a job. In Targets, put part of the account's name in "Applies to" ("Savings" for BNZ Savings, "Portfolio", "KiwiSaver", "Visa"):

- Savings goal: a balance to reach (in NZD), optionally by a Target date.
- Share of savings: the % of each month's savings a goal gets (Car 40%, House 60%). When a goal finishes, its share goes to the others. A Monthly transfer, if set, wins over a share. Goals with neither get what's left, by Priority. The Forecast's Month by month shows what goes into each account and how its balance grows.
- A goal can sit on a Holdings account too (Sharesies Save, a Portfolio): its balance counts, at today's rate, and it grows by itself rather than from payday savings. Give every account a job this way, even money you aren't moving. Holdings of Type Cash count toward runway.
- A goal on KiwiSaver grows by itself (contributions and returns): it takes no share of your savings and has no payday transfer. Splitting a house deposit into a KiwiSaver goal and a cash goal shows the cash you still need to save.
- A goal can draw on several accounts: join them with + in Applies to ("#Home + KiwiSaver"). Progress and pace use their combined balance and trend.
- Debt payoff: a debt account to clear.
- Monthly savings: your budget, savings first. Target amount is what you save each month; it's split across your goals by Share of savings, and take-home less savings is your spending budget. Spending limit rows give categories their part of it. The Dashboard's Month over month shows a Target column (last full month green if met, red if not), and the Forecast pays goals from this target instead of your typical surplus.
- Planned purchases and trips get their own set-aside: what the paying account can't cover today (soonest first) is spread over the paydays before the date, and shows in the Payday plan. Trips are planned this way rather than given a monthly spending limit.
- Paid from (last column on Targets): which account a Spending limit is paid from. Blank means the Bills group comes from your Bills account and everything else from a Monthly budget account if you have one, else Everyday. The Forecast's Payday plan uses it to show, month by month, what to transfer where each payday: tax, each goal's share, each spending account, and the buffer that stays.
- Set-aside rate: GST and income tax per invoice. Applies to is the account (Income GST, Income Tax), Target amount the rate: GST is taken as the GST inside a GST-inclusive payment (0.15 means 15/115), income tax as a share of what's left. The Transfers To Do tab uses them to split each payment in order (tax, bills, spending, savings, purchase set-asides, then what's left over to / Savings, so nothing stays where pay lands) and ticks each line off when a transfer of that size reaches the account.
- Planned purchase: something you're considering buying. Applies to is the account it's paid from (the exact name, like "/ Savings"; blank means all your cash), Target amount the cost, Target date when (blank means now). The Forecast shows the balance before and after, the lowest it gets in the next 12 months, how many months it takes to earn back, and a chart of each paying account with and without the purchases. A purchase isn't a goal, so it doesn't take a share of the account's balance; it's flagged if it would dip into goals on the same account.

Progress then comes from the account itself, and the Forecast uses the account's own trend over the last three months (so KiwiSaver contributions and regular transfers count). A goal not tied to an account, or with too little history, is paid from your monthly surplus in Priority order. A Monthly transfer, if you set one, overrides both.

One account can hold several goals, like buckets: an emergency fund and a trip both in BNZ Savings. The balance fills them in Priority order (each takes up to its target, the last takes the rest), and the account's monthly growth goes to the highest-priority one still open. The others show "queued" on the Forecast until it's their turn. Net worth shows the account's combined goal and every goal's name.

### Holdings

Accounts that don't sync (an overseas bank, a share platform, crypto, tax owed). Enter a Balance, or for shares and crypto enter Units and a Price symbol (`VOO`, `CURRENCY:BTCCAD`) priced in the row's Currency. Type is Cash, Investment, Property, Owed to you, Reserved, Debt or Other; debts count against net worth. Owed to you is money you've lent: it counts in net worth but not as cash. Lower its Balance as it's repaid; the lending and the repayments themselves are categorised Loan, which is neither spending nor income (MY_TRANSACTION_CATEGORIES in my-rules.gs re-tags a single transaction by its ID). Reserved is money set aside for a bill you owe, like tax: it shows, but counts as zero in net worth and isn't cash for runway. Synced accounts with GST or tax in the name are Reserved automatically. To change a synced account's type, add a Holdings row with just Type and Account (part of the account's name), leaving Balance, Units and Price symbol blank. Rows with Notes starting "Example" are ignored. Last updated is stamped when you change a Balance or Units by hand. On Net worth, each account's Source says Synced or Manual, with its Last updated date; manual ones turn red after about a month. Use names or the last 4 digits, not full account or card numbers. After editing, use Finance > Recategorise and refresh.

### Categories and groups

Akahu's own categories (50+) are translated into a short set automatically (AKAHU_MAP in the script):

| Group | Categories |
| --- | --- |
| Bills | Rent, Office rent, Utilities (power, internet, phone), Insurance |
| Everyday | Groceries, Transport, Health, Personal care, Household |
| Subscriptions | Software (Akahu's business software), Subscriptions, and any you add with this group (e.g. AI & software, Design & creative) |
| Lifestyle | Eating out, Fitness, Entertainment, Shopping |
| One-off | Trips, Gifts |
| Other | Work, Fees, ATM withdrawals (any cash taken out) |

To merge two categories into one (say Personal care and Health into Health & self-care), list them in MY_CATEGORY_MERGES in `apps-script/my-rules.gs`; Recategorise applies it to past transactions too.

Your own rules always come first: rows on the Categories tab, then rules kept in `apps-script/my-rules.gs` (the ones Claude adds for you).

Each Categories row with match text is a rule. The first rule whose text appears in the merchant, description, payee/reference or Akahu's category sets the category. A rule can be limited to one account ("Only account") or to money in or out ("Only money"). Rules beat everything else, including transfer matching, so a transfer to your landlord can be tagged Rent:

| Match text | My category | Group | Only account | Only money |
| --- | --- | --- | --- | --- |
| landlord name | Rent | Bills | BNZ | out |
| supermarket | Groceries | | | |
| | Eating out | Lifestyle | | |

The Group column puts a category in a group: Bills, Everyday, Subscriptions, Lifestyle, One-off or Other (any other name works too). A row with no match text only sets the group. Match text `*` matches anything, which is useful with Only account: `* | Trips | | usd balance | out` makes all spending from a travel account Trips. Categories with no group show as Other.

`Transfer`, `Credit card payment` and `Ignore` are left out of spending and income.

After changing Categories, use Finance > Recategorise and refresh.

How the numbers are counted:

- Money out of one of your accounts and the same amount into another within 3 days is marked Transfer and left out.
- Refunds come off their category's spend.
- Income is take-home: gross income less your tax set-aside rate over the last year (money moved into Reserved accounts divided by gross income), so it stays steady even though you move tax money in batches. Tax paid from those accounts isn't spending.
- Income is anything in a category starting with "Income" (e.g. `Income: freelance`), plus uncategorised money in. Add Categories rules for your payers.

## Making changes

- Edit code here, then `cd apps-script && clasp push`. If you edited in the browser, `clasp pull` first.
- Run `node tests/finance-sync.test.js` after changing the script.
- To preview the Friday email without sending it: `node scripts/preview-email.js --sample` writes `.cache/email-preview.html` with made-up numbers. Run `python3 scripts/read-sheet.py` first and leave off `--sample` to preview it with yours.

## Getting updates

```bash
git pull
```

```bash
cd apps-script && clasp push
```

Then run `setup` once in the Apps Script editor, so any new tabs or columns are added.

## Troubleshooting

- **"User has not enabled the Apps Script API"** when pushing: turn it on at [script.google.com/home/usersettings](https://script.google.com/home/usersettings), wait a minute, then try again.
- **No Finance menu**: reload the sheet. If it's still missing, run `setup` again from the editor.
- **Sync fails with 401 or 403**: an Akahu token is wrong or expired. Copy both again from my.akahu.nz > Developers into Script properties.
- **Months look off by one**: the sheet's time zone (File > Settings) doesn't match the script's.
- **`read-sheet.py` can't sign in**: run `clasp login` again.

## Rules

- Keep your own copy private.
- No tokens, exports, CSVs or sheet copies in git.
- No personal information in git. Your data lives in the sheet and the `my-*` files; the commit check enforces it.
- The script only reads. No payments or transfers in code. Set up automatic transfers in your bank or Wise app.
- Nothing here is financial advice.
