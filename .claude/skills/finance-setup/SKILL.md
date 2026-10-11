---
name: finance-setup
description: First-time setup of the Personal Finance sheet, once the bank feeds are connected and the first sync has run. Walks the user through giving each account a job, splitting income by source, sorting bills, subscriptions and uncategorised spending into rules, then setting savings goals with a base and a stretch version, a monthly budget, and the daily refresh and Friday email, so the Dashboard is complete. Use when the user says "set up my dashboard", "I've connected my banks, what now?", "help me set this up", or when the review skill finds most money uncategorised or Targets empty.
---

# Finance setup

The bank feeds are connected and the first sync has run. Now turn a sheet of raw transactions into a Dashboard the user trusts. Work through the steps in order, one at a time. Show what you found, propose changes, and write them once the user agrees. Expect it to take 30 to 60 minutes; if they need to stop, say which step you got to so you can pick up there next time.

Be plain and friendly. This is budgeting help, not financial advice: no investment, KiwiSaver fund or tax recommendations. When one of those comes up, add a row to the Notes tab for the user to take to a professional.

## How changes get made

- Read the sheet with `python3 scripts/read-sheet.py` (every tab to `.cache/sheet.json`) or `python3 scripts/read-sheet.py <Tab>`. Read again after the user refreshes.
- Categorisation rules, subscriptions and services go in `apps-script/my-rules.gs` (gitignored). Specific rules go above the `*` catch-alls. Run `node tests/finance-sync.test.js`, then `cd apps-script && clasp push`.
- Targets, Holdings and Notes rows go in the sheet with the Google Sheets connector, in yellow cells only. Read the range first so nothing the user typed gets overwritten. With no connector (Codex, for example), give the rows as tab-separated lines for the user to paste.
- After a push or a sheet edit, ask the user to run Finance > Recategorise and refresh, then read again to check the result.
- Never ask for, print or store tokens.

## 1. Check the data

Read Accounts, Summary and Uncategorised.

- If Accounts is empty, the sync hasn't worked. Send the user back to the README, steps 5 and 6, and stop here.
- Check every account is personal. Any business account should be disconnected in Akahu.
- Look for doubles: Wise connected both directly and through Akahu, or an account showing twice.
- Say how much history arrived (the oldest transaction) and what share of spending is uncategorised. This step is done when the data looks complete.

## 2. Give every account a job

List the synced accounts with their balances. For each one, ask what it's for: everyday spending, bills, savings (for what?), tax set-aside, travel money, a credit card, KiwiSaver.

- Suggest giving accounts nicknames in the bank's app that say their job ("Bills", "Savings Japan"). The names sync through, and Targets match on them.
- Accounts named with GST or Tax are treated as Reserved: shown, but not counted as cash. If a tax account is named something else, add a Holdings row with just Type Reserved and part of the account's name.
- Ask about money the sync can't see: overseas banks, share platforms, crypto, a house, money lent to someone, tax owed. Add each one as a Holdings row (Type, Provider, Account, Currency, then Balance, or Units and Price symbol). Use a name or the last 4 digits, never a full account number.

## 3. Split income by source

The Dashboard's Month over month lists income per source, one row each, once each payer has an `Income: <Source>` category; a source shows as soon as it has a rule, even before money arrives. Uncategorised money in counts as income too, but it all lands under "Other".

1. From Transactions, list money in over the last 6 months, grouped by payer (description and reference), biggest first. Leave out rows already marked Transfer.
2. Ask what each one is:
   - Pay from a job: `['employer text', 'Income: <Employer>', '', '', 'in']`
   - Side income, freelance clients, rent from a flatmate: their own `Income: <Source>` category each, or one shared category like `Income: Freelance`
   - A refund: the category it refunds (Shopping, Trips), so it comes off that spending
   - Money from your own account that wasn't paired as a transfer: `Transfer`
   - Someone repaying a loan: `Loan`, with what's still owed on Holdings as Owed to you
   - Friends paying back for a shared dinner or trip: that spending category, so the user's real share is what's left
3. Use match text that is specific and stable (the payer's name, not a reference number that changes), and set Only money to `in`.
4. Ask if they're self-employed or paid by invoice. If so:
   - They'll want Set-aside rate rows on Targets for GST and income tax, with Applies to set to the tax accounts. The rates come from their accountant or IRD: add a Notes row to confirm them, and don't suggest a rate.
   - Explain the payday flow: Finance > Payday: what to move, and the Transfers To Do tab.

Done when the income rows in the Dashboard's Month over month match how the user thinks about their income, and Other is small.

## 4. Bills, subscriptions and regulars

1. Bills: find rent, power, internet, phone and insurance in Merchants. Rent is often a bank transfer that Akahu can't label, so add a rule on the landlord's name with Only money `out`. Check the Bills group adds up to what the user expects to pay each month.
2. Subscriptions: list Merchants rows flagged Likely recurring and anything in the Subscriptions group. Confirm each one with the user, then add its match text to `MY_SUBSCRIPTIONS` so the Dashboard lists it as soon as it charges, including yearly ones. Group them the way the user thinks about them (AI & software, Streaming, Design & creative) with rules that set a category in the Subscriptions group.
3. Regulars paid per visit (gym casuals, massage, a barber): add them to `MY_SERVICES` so they show under Recurring services.

## 5. Clear Uncategorised

1. Take the top 20 or so rows on Uncategorised by amount. Propose a category for each in one table (merchant, amount, suggested category) and let the user correct it in one reply rather than asking twenty questions.
2. Stick to the short category set (see the review skill). Only add a category if the user asks for one, and put every new category in a group.
3. Write the rules, push, and ask for Recategorise and refresh. Repeat once if a lot is still left.
4. Tell the user about the weekly habit: open Uncategorised, pick a category for the top few rows, then Recategorise. It takes about 2 minutes.

Done when uncategorised spending is under about 5% of the month's spend.

## 6. Show the baseline

From Summary, the last 3 full months: take-home income, spending per group, and the surplus (income less spending). Also give the runway: cash divided by a typical month's spending.

Ask what surprises them. Anything that looks wrong usually means a missing rule; fix it before going on. Goals set from wrong numbers won't hold up.

## 7. Goals: base and stretch

Ask what they want their money to do over the next year or two. Let them talk first; don't hand them a list. Then, for each goal:

1. Agree the kind, amount, account and date as in the review skill's "First run: set up targets" (Savings goal, Debt payoff, Planned purchase, Income target), tying each goal to the account that holds the money.
2. Set two levels:
   - **Base**: what the current surplus can pay for. Work out the monthly amount each goal needs, and check that the base goals together fit in the surplus from step 6. If they don't, say so and help the user choose what comes first, or push dates out.
   - **Stretch**: what becomes possible if spending comes down. Ask how far they'd like to push it: a bigger goal, an earlier date, or an extra goal.
3. Write the base goals as normal Targets rows, with Priority and Share of savings. Write each stretch as its own Savings goal row named "Stretch: …", with the lowest Priority and no Share of savings, so it only gets money once the base goals are covered. For a stretch that only brings a date forward, put "Stretch: by <date>" in the base goal's Notes instead.
4. Suggest a buffer goal if they don't have one: say it's common to keep a few months of spending in cash. Leave the amount to them.
5. The gap between base and stretch, per month, is what savings actions need to find. Say the number. After the first review, the Forecast's "With actions" column shows how far actions close it.

## 8. Monthly budget

1. Add one Monthly savings row: the base monthly savings from step 7. Put the stretch figure in its Notes.
2. Take-home less savings is the spending budget. Add Spending limit rows for the big flexible categories (Groceries, Eating out, Shopping, Transport), starting from the last 3 months' average, and for the ones the user wants to bring down, a little below it. Ask before setting any limit lower than that.
3. Set Paid from on each limit if the user has separate bills and spending accounts. The Forecast's Payday plan then shows what to move where each payday.
4. Check that the limits plus bills fit inside the spending budget. The Dashboard shows any part of the budget not yet given to a category.

## 9. Refresh, email and reminders

1. Daily refresh: ask the user to run `installAutoRefresh` once in the Apps Script editor. The sheet then syncs every morning around 7am, and emails them on Fridays.
2. Friday email: show them a preview with `node scripts/preview-email.js` (after reading the sheet), and ask whether they want a different day, tone or content. The email's wording lives in `EMAIL_LINES` and `dailyEmailData_` in `apps-script/finance-sync.gs`. Run the tests and preview again after any change.
3. Reminders: offer to put two repeating events in their calendar if a calendar connector is available. Otherwise suggest they add them: weekly, "2 minutes: sort Uncategorised"; monthly, "15 minutes: sync, update Holdings, run my monthly review".

## 10. Walk the Dashboard

Ask the user to run Recategorise and refresh one last time, then read the Dashboard and go through it top to bottom with them: headline numbers, goals, subscriptions, living costs, month over month, budget. Check that every section has data and that it all looks right to them. List anything still missing and what fills it.

Finish by offering the first monthly review (the personal-finance-review skill). That's where the ranked savings actions come from, and where the stretch goals start to get funded.
