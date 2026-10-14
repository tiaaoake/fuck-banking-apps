---
name: pay-plan
description: Works out what to do with each pay: which accounts to have, what moves where on payday, how much and in what order, so bills are covered, spending has a limit and every savings goal gets its share. Sets up Targets so the Forecast's Payday plan and the Transfers To Do tab show the transfers, then helps the user set up automatic payments in their bank. Use when the user says "sort my pay", "what do I do when I get paid?", "where should my pay go?", "set up my accounts", "payday plan", or when finance-setup reaches the budget step.
---

# Pay plan

The user wants a simple answer to "my pay just landed, now what?". By the end they have:

- accounts that each do one job
- a short list of transfers to make each payday, with amounts and an order
- those transfers set up as automatic payments in their bank (where that makes sense)
- the sheet set up so Transfers To Do shows each payday's moves and ticks them off.

Work one step at a time, with their real numbers. This is budgeting help, not financial advice: don't recommend banks, savings products, KiwiSaver funds or tax rates. Put those questions on the Notes tab.

The script never moves money. The user makes every transfer, or sets up the automatic payment, in their own banking app.

## 1. Read where they are

Run `python3 scripts/read-sheet.py`, then read:

- Forecast: the line under Your goals that says how often they're paid ("You're paid monthly, around the 18th", or "about twice a month"), typical take-home, spend and surplus, and the Payday plan.
- Accounts and Net worth: every account, and where pay lands (the account the Payday plan says pay lands in).
- Summary: the last 3 full months of spending by group and category, especially the Bills group.
- Targets: goals, Monthly savings, Spending limits, Paid from, Share of savings.

If income isn't split by source yet or most spending is uncategorised, do the finance-setup skill's steps 3 to 5 first: the plan is only as good as the numbers.

Confirm with the user: how often they're paid, which day, which account it lands in, and whether it's salary (tax already taken out) or invoices (they need to set tax aside themselves).

## 2. Agree the accounts

Suggest a setup, then fit it to what they already have. Fewer accounts is fine: three (bills, spending, savings) covers most people.

| Job | Name it (the sheet finds accounts by these words) | What goes there |
| --- | --- | --- |
| Pay lands | anything; often their main account | Pay arrives, then everything moves out, so it ends near $0 |
| Bills | contains "Bills" | Rent, power, internet, phone, insurance, subscriptions: everything on a direct debit |
| Monthly budget (optional) | contains "Monthly" or "Budget" | This month's spending money, which feeds Everyday a set amount each week |
| Everyday | contains "Everyday" | The card they spend from day to day |
| Savings | contains "Savings", one per goal if they like ("Savings Japan", "Savings House") | Goals; whatever's left over each payday goes to the plain "Savings" one |
| Tax (self-employed only) | contains "Tax" or "GST" | Their tax set-aside; shown but not counted as spendable cash |

- Names come from the nickname they give each account in their banking app. Akahu syncs it through on the next sync.
- Opening new accounts is their job, in their banking app. Most NZ banks let you open extra accounts in a few taps; don't recommend a particular bank or product.
- The weekly Everyday amount is the most useful habit: spend only from Everyday, and when it runs low, that's the week's signal. Suggest it, but don't push.
- One savings account can hold several goals, filled in Priority order. Separate accounts are easier to see, but not required.

## 3. Size each bucket

Work it out per month first, from Summary's last 3 full months:

1. **Tax** (invoices only): their set-aside rate. The rate comes from their accountant or IRD. If they don't know it, add a Notes row and use their best guess for now.
2. **Bills**: the Bills group's monthly average, plus yearly bills (insurance, registration, memberships) divided by 12. Add a little headroom.
3. **Spending**: their flexible categories (groceries, eating out, transport, shopping and so on), at the 3-month average or a target they choose.
4. **Savings**: the Monthly savings target from finance-setup (the base level). If there isn't one, take-home less bills less spending is the most they can save; agree a number a bit below that.
5. **Left over**: anything not planned goes to Savings on payday, so nothing sits idle in the pay account.

Check that tax plus bills plus spending plus savings fits inside take-home. If it doesn't, say so with the numbers, and help them choose: spend less where, save less for now, or push a goal's date out.

Then split savings between goals with Share of savings (percentages that add up to 100%), in the order they care about.

Then turn the monthly amounts into **per pay** amounts: divide by pays per month (about 2.17 if paid fortnightly, 4.33 if weekly). The Forecast's Your goals table shows each goal per pay too.

## 4. Write it into the sheet

With the Google Sheets connector (or as tab-separated rows to paste), on Targets, yellow cells only. Read the tab first so nothing gets overwritten:

- One **Monthly savings** row: Target amount is the monthly savings.
- **Spending limit** rows for each category, with **Paid from** set to the account it comes out of: bills to the Bills account, flexible spending to Monthly or Everyday. Leaving Paid from blank sends Bills-group categories to the Bills account, and everything else to Monthly if there is one, else Everyday.
- **Savings goal** rows, each tied to its account in Applies to, with Share of savings.
- Self-employed only: **Set-aside rate** rows for GST and income tax, with Applies to set to the tax account.

Ask them to run Finance > Recategorise and refresh, then read the Forecast's Payday plan back to them and check it matches what you agreed.

## 5. Payday, step by step

Write the plan out as a short numbered list they can follow, in this order. For example, for pay landing in "Main":

1. Tax: $X to Tax (invoices only)
2. Bills: $X to Bills
3. Spending: $X to Monthly (or $X a week to Everyday)
4. Savings: $X to Savings Japan, $X to Savings House
5. Whatever's left in Main: to Savings

Then set it up:

- **Monthly pay, salary:** the amounts are steady. Set each line up as an automatic payment for the day after payday (a day's gap allows for pay arriving late). After that, payday takes no effort.
- **Fortnightly or weekly pay:** use the per-pay amounts for the automatic payments. The Transfers To Do tab works in monthly amounts, so treat it as a check that the month adds up, not a list to follow each pay.
- **Invoices or irregular pay:** amounts change, so don't automate the split. When money arrives, they open the sheet and use Finance > Payday: what to move. Transfers To Do lists each move from what's actually in the account, and ticks each one off as the money lands.
- **Weekly spending money:** an automatic payment from Monthly to Everyday every Monday.

Walk them through setting up the automatic payments in their banking app, one at a time. They do it; you tell them the from, to, amount, how often and the start date.

## 6. Record it and check the first payday

1. Add the plan to `.claude/skills/personal-finance-review/my-preferences.md` under a "# Pay plan" heading: how often they're paid, where pay lands, and each transfer with its amount and frequency. It's gitignored, and the monthly review checks it.
2. After their next payday, ask them to run Finance > Payday: what to move (or just wait for the morning refresh). Read Transfers To Do with them: each line should say Done. If one says To do or Short by, work out why: a missed transfer, a different amount, or a budget that needs adjusting.
3. If the amounts change later (a pay rise, a new goal, a goal finished), update the Targets rows and the automatic payments together, and update the Pay plan in my-preferences.md.
