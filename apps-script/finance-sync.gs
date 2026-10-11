/**
 * Personal finance sheet: bank data -> Google Sheets
 * Sources: Akahu (NZ banks, e.g. BNZ) and Wise (direct, every currency balance and Jar).
 * Connect either or both.
 *
 * One-time setup:
 *  1. Project Settings > Script properties. Add whichever you use:
 *       AKAHU_APP_TOKEN, AKAHU_USER_TOKEN   (my.akahu.nz > Developers)
 *       WISE_API_TOKEN                      (Wise > Settings > API tokens, READ ONLY)
 *     If Wise is connected here, don't also connect it inside Akahu, or it will be counted twice.
 *  2. Run setup()               creates the tabs
 *  3. Run sync()                first pull (up to a year)
 *  4. Sync on demand from the Finance menu in the sheet (reload the sheet to see it),
 *     or run installWeeklyTrigger() to sync every Monday around 6am. removeTriggers() stops it.
 *  Name the spreadsheet "Personal Finance" so the Claude skill can find it.
 *
 * Foreign-currency amounts are converted to NZD at the rate on the day they're synced.
 * The first big pull uses today's rate for older transactions, so treat those as close, not exact.
 *
 * Tokens live only in Script properties. Never paste them into the sheet or a chat.
 */

const TODO_TAB = 'Transfers To Do';   // was 'To do'

// Tabs in order. The first eleven are the ones you use; the rest are hidden (the script and Claude read them).
const HEADERS = {
  'Dashboard': [],
  [TODO_TAB]: [],
  'Forecast': [],
  'Net worth': [],
  'Home scenarios': [],
  'Uncategorised': [],
  'Savings actions': ['Rank', 'Action', 'Merchant or category', 'Est. monthly saving', 'Effort', 'Evidence', 'Added', 'Due',
              'Status', 'Actual saving', 'Notes', 'Track', 'Baseline / mo', 'Target / mo', 'Last month', 'This month so far',
              'Progress'],
  'Targets': ['Name', 'Kind', 'Applies to (category or account)', 'Target amount', 'Target date',
              'Current amount', 'Monthly transfer', 'Priority', 'Notes', 'Share of savings', 'Paid from'],
  'Notes': ['Topic', 'Question or concern', 'Ask', 'Status', 'Notes', 'Added'],
  'Categories': ['Match text (merchant, description, reference or Akahu category contains)', 'My category', 'Group',
                 'Only account (contains)', 'Only money (in / out)'],
  'Holdings': ['Type', 'Provider', 'Account', 'Currency', 'Balance', 'Units', 'Price symbol', 'Notes', 'Last updated'],
  'Transactions': ['Date', 'Account', 'Description', 'Merchant', 'Amount', 'Type', 'Akahu category', 'My category',
                   'Transaction ID', 'Currency', 'Amount (NZD)', 'Reference'],
  'Accounts': ['Account', 'Type', 'Currency', 'Balance', 'Available', 'Balance (NZD)', 'Last updated', 'Account ID', 'Provider'],
  'Summary': [],
  'Merchants': [],
  'Net worth history': ['Month', 'Updated', 'Cash', 'Investments', 'Property', 'Debt', 'Other', 'Net worth (NZD)'],
  'Balance history': ['Month', 'Account', 'Provider', 'Type', 'Currency', 'Balance', 'Balance (NZD)'],
  'FX': ['Currency', 'Rate to NZD']
};
const HIDDEN_TABS = ['Transactions', 'Accounts', 'Summary', 'Merchants', 'Net worth history', 'Balance history', 'FX'];
// One rule across the sheet: yellow cells are yours to edit (or Claude's, from chat); everything else is generated and
// gets overwritten. Tab -> [first column, how many], 1-based. Uncategorised colours its own rows as it rebuilds.
const EDITABLE = '#fef9c3';
const EDITABLE_COLS = { 'Targets': [1, 11], 'Categories': [1, 5], 'Holdings': [1, 9], 'Savings actions': [9, 2], 'Notes': [1, 6] };
function markEditable_(ss) {
  Object.keys(EDITABLE_COLS).forEach(name => {
    const sh = ss.getSheetByName(name);
    if (!sh || sh.getMaxRows() < 2) return;
    const [col, n] = EDITABLE_COLS[name];
    sh.getRange(2, col, sh.getMaxRows() - 1, n).setBackground(EDITABLE);
    sh.getRange(1, 1).setNote('Yellow cells are yours to edit. Everything else is filled in by the script.');
  });
}
// A target belongs to an account when its "Applies to" text appears in the account's name ("Savings" -> "BNZ Savings").
// Exact name first, then the first name containing the text. names: account names in the order to try.
const findAccount_ = (appliesTo, names) => names.find(n => String(n).trim().toLowerCase() === String(appliesTo || '').trim().toLowerCase()) ||
  names.find(n => appliesToAccount_(appliesTo, n)) || '';
const appliesToAccount_ = (appliesTo, account) => {
  const a = String(appliesTo || '').trim().toLowerCase();
  return !!a && String(account || '').toLowerCase().includes(a);
};
// "Applies to" for a goal: one account, or several joined with + ("#Home + KiwiSaver").
const goalAccounts_ = appliesTo => String(appliesTo || '').split('+').map(s => s.trim()).filter(Boolean);
// Share of savings on Targets (col 10): typed as 40%, 0.4 or 40.
const shareOf_ = v => { const n = Number(String(v).replace('%', '')); return !(n > 0) ? 0 : n > 1 ? Math.min(n / 100, 1) : n; };
const isGoalKind_ = kind => /^(savings goal|debt payoff)$/i.test(String(kind).trim());
// A one-off purchase you're considering: Applies to is the account it's paid from, Target amount the cost, Target date
// when (blank means now). Shown on the Forecast; it isn't a goal, so it doesn't take a share of the account's balance.
const isPlanKind_ = kind => /^planned purchase$/i.test(String(kind).trim());

/**
 * One account can hold several goals (buckets). Its balance fills them in Priority order: each savings goal takes up
 * to its target amount, and the last one takes whatever is left. A debt goal takes the balance owed. A goal with a
 * Current amount typed in keeps that and uses none of the balance.
 * A goal can draw on several accounts: "Applies to" joined with + ("#Home + KiwiSaver") adds their balances.
 * accountOf(appliesTo) -> account name or ''; balanceOf(name) -> NZD balance or null.
 * Returns one {account, accounts, now} per Targets row (now is null when it doesn't come from an account); account is
 * the names joined with " + ", accounts the list.
 */
function goalBalances_(targets, accountOf, balanceOf) {
  const out = targets.map(() => ({ account: '', accounts: [], now: null }));
  const byAccount = {}, members = {};
  targets.forEach((t, i) => {
    if (!t[0] || /^example/i.test(String(t[8])) || !isGoalKind_(t[1])) return;
    const names = goalAccounts_(t[2]).map(accountOf);
    if (!names.length || names.some(n => !n)) return;
    const acct = names.join(' + ');
    out[i].account = acct; out[i].accounts = names; members[acct] = names;
    if (t[5] === '' || t[5] == null) (byAccount[acct] = byAccount[acct] || []).push(i);
  });
  const combined = acct => {
    const vals = members[acct].map(balanceOf);
    return vals.some(v => v == null) ? null : vals.reduce((a, b) => a + b, 0);
  };
  Object.keys(byAccount).forEach(acct => {
    let left = combined(acct);
    if (left == null) return;
    const list = byAccount[acct].sort((a, b) => (Number(targets[a][7]) || 99) - (Number(targets[b][7]) || 99) || a - b);
    const savings = list.filter(i => !/debt/i.test(targets[i][1]));
    let debtTaken = false;
    list.forEach(i => {
      if (/debt/i.test(targets[i][1])) { out[i].now = debtTaken ? 0 : combined(acct); debtTaken = true; return; }
      const aim = Number(targets[i][3]) || 0;
      const take = i === savings[savings.length - 1] || !aim ? left : Math.min(left, aim);
      out[i].now = take;
      left -= take;
    });
  });
  return out;
}

// Left out of spending and income. Use Ignore for anything else that shouldn't count (e.g. reimbursed work costs).
// Loan: money you lend, and the repayments, are neither spending nor income (what's owed sits on Holdings).
const EXCLUDE_FROM_SPEND = ['Transfer', 'Credit card payment', 'Ignore', 'Loan'];
// Six full months plus the current one, so far.
const SUMMARY_MONTHS = 7;
// Money out of one of your accounts and the same amount into another within this many days is a transfer.
const PAIR_WINDOW_DAYS = 3;
// Merchants tab: average over this many full months; "Likely recurring" needs a charge in this many of the last 6.
const MERCHANT_AVG_MONTHS = 3;
const RECURRING_MIN_MONTHS = 3;
// Account types counted as cash for runway (Akahu types, plus the Wise ones set in fromWise_()).
// HOLDING CASH: a Holdings row of Type Cash (Sharesies Save and the like), as the Dashboard sees it.
const CASH_TYPES = ['CHECKING', 'SAVINGS', 'FOREIGN', 'WALLET', 'WISE BALANCE', 'WISE JAR', 'HOLDING CASH'];
// Categories counted as income: "Income", "Income: freelance", and so on.
const isIncomeCategory_ = cat => /^income\b/i.test(String(cat));
// Groups separate fixed bills from everyday and discretionary spending. Set a category's group in Categories.
// Any other group name you use there works too; it's listed after these.
const GROUPS = ['Bills', 'Everyday', 'Subscriptions', 'Lifestyle', 'One-off', 'Other'];
// Default categories and their groups: the user's own set, with Rent split out of Bills, plus Fees and Gifts.
const DEFAULT_GROUPS = [['Rent', 'Bills'], ['Office rent', 'Bills'], ['Utilities', 'Bills'], ['Insurance', 'Bills'],
  ['Bills', 'Bills'], ['Subscriptions', 'Subscriptions'], ['Software', 'Subscriptions'],
  ['Groceries', 'Everyday'], ['Transport', 'Everyday'], ['Health', 'Everyday'], ['Personal care', 'Everyday'],
  ['Household', 'Everyday'],
  ['Eating out', 'Lifestyle'], ['Fitness', 'Lifestyle'], ['Entertainment', 'Lifestyle'], ['Shopping', 'Lifestyle'],
  ['Trips', 'One-off'], ['Gifts', 'One-off'], ['Work', 'Other'], ['Fees', 'Other'], ['ATM withdrawals', 'Other']];

// Akahu's categories are fine-grained (50+). Transactions with no rule of yours get one of the short categories
// above instead, matched on Akahu's category name, first match wins. Your Categories rules always come first.
const AKAHU_MAP = [
  [/physiotherapy|doctor|dental|medical|pharmac|optom|hospital|health (care|services)/, 'Health'],
  [/haircut|cosmetic|beauty|spas|massage|nail/, 'Personal care'],
  [/accommodation|air transport|travel agenc|duty free|car rental|cruise/, 'Trips'],
  [/restaurant|cafe|fast food|takeaway|bars, pubs|bakeries|liquor|catering/, 'Eating out'],
  [/supermarket|grocer|convenience|specialty food|meat|butcher|fruit|seafood/, 'Groceries'],
  [/fuel|parking|taxi|rideshare|bus and shuttle|public transport|transport services|toll|vehicle|automotive|car wash/, 'Transport'],
  [/gym|fitness|sports and athletic|sports equipment|yoga|pilates|swimming/, 'Fitness'],
  [/cinema|theatre|concert|events and tickets|attraction|entertainment|streaming|music|gaming|recreation/, 'Entertainment'],
  [/electricity|gas |gas$|water|internet|telecommunication/, 'Utilities'],
  [/insurance/, 'Insurance'],
  [/home furnishing|building supplies|hardware|cleaning|furniture|garden|homeware/, 'Household'],
  [/clothing|retail|variety|electronic|appliance|book|department|antique|jewel|shoe|gift shop|toy|stationery store/, 'Shopping'],
  [/business software|cloud services|software/, 'Software'],
  [/advertising|office supplies|stationery|professional services|coworking|co-working/, 'Work'],
  [/charity|welfare|donation|florist/, 'Gifts'],
  [/government|bank fees|fees and charges/, 'Fees'],
  [/financial asset brokers|exchanges, and managed funds|investment/, 'Transfer']
];
const mapAkahu_ = category => {
  const c = String(category || '').toLowerCase();
  const hit = c && AKAHU_MAP.find(([re]) => re.test(c));
  return hit ? hit[1] : '';
};
// Net worth: row order, and how synced account types map to them. Holdings rows set their own Type.
// Reserved is money set aside for a bill you owe, like tax: shown, but counted as zero in net worth (the cash and the
// bill cancel out) and not counted as cash for runway. Synced accounts with GST or tax in the name are Reserved.
// Owed to you: money you've lent (a Holdings row), counted in net worth but not as cash.
const WORTH_TYPES = ['Cash', 'Investment', 'Property', 'Owed to you', 'Reserved', 'Debt', 'Other'];
const RESERVED_NAME = /\b(gst|tax)\b/i;
const worthType_ = (type, name) => {
  if (RESERVED_NAME.test(String(name || ''))) return 'Reserved';
  const t = String(type).toUpperCase();
  if (/KIWISAVER|INVESTMENT/.test(t)) return 'Investment';
  if (/CREDITCARD|LOAN|MORTGAGE/.test(t)) return 'Debt';
  if (/TAX/.test(t)) return 'Other';
  return 'Cash';
};

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  renameActionsTab_(ss);
  renameTodoTab_(ss);
  Object.keys(HEADERS).forEach(name => {
    const sh = ss.getSheetByName(name) || ss.insertSheet(name);
    const h = HEADERS[name];
    if (!h.length) return;
    if (sh.getLastRow() === 0) sh.appendRow(h);
    else if (sh.getLastColumn() < h.length) sh.getRange(1, 1, 1, h.length).setValues([h]);   // columns added since
    sh.setFrozenRows(1);
    sh.getRange(1, 1, 1, h.length).setFontWeight('bold');
  });
  const targets = ss.getSheetByName('Targets');
  if (targets.getLastRow() === 1) {
    // Kind is one of: Savings goal | Spending limit | Income target | Debt payoff | Planned purchase
    // These are examples only. Replace them, or let the first review set them up with you.
    targets.appendRow(['Emergency fund', 'Savings goal', 'Savings account', 5000, '', '', '', 1, 'Example']);
    targets.appendRow(['Eating out', 'Spending limit', 'Eating out', 400, '', '', '', 2, 'Example: per month']);
  }
  const cats = ss.getSheetByName('Categories');
  if (cats.getLastRow() === 1) {
    // Top-ups between your own accounts (BNZ -> Wise) are paired automatically; see markOwnTransfers_().
    cats.appendRow(['credit card', 'Credit card payment', '', '', '']);
    cats.appendRow(['converted', 'Transfer', '', '', '']);
    // Rows starting "e.g." are ignored. Replace with your landlord's name or the rent payment reference.
    cats.appendRow(['e.g. landlord name or rent reference', 'Rent', 'Bills', '', 'out']);
    // Turn Akahu's categories into yours. These also match merchant names.
    [['supermarket', 'Groceries'], ['grocer', 'Groceries'], ['restaurant', 'Eating out'], ['cafe', 'Eating out'],
     ['takeaway', 'Eating out'], ['fuel', 'Transport'], ['parking', 'Transport'], ['public transport', 'Transport'],
     ['pharmac', 'Personal care'], ['bank fee', 'Fees'], ['interest charge', 'Fees']]
      .forEach(([m, c]) => cats.appendRow([m, c, '', '', 'out']));
  }
  // Rows with no match text just put a category in a group. Adds any default category that has no group yet,
  // so running setup again on an older sheet brings it up to date without touching your rows.
  const grouped = parseRules_(cats.getLastRow() > 1 ? cats.getRange(2, 1, cats.getLastRow() - 1, 5).getValues() : []).groups;
  DEFAULT_GROUPS.filter(([c]) => !grouped[c.toLowerCase()]).forEach(([c, g]) => cats.appendRow(['', c, g, '', '']));
  const holdings = ss.getSheetByName('Holdings');
  if (holdings.getLastRow() === 1) {
    // Accounts that don't sync. Notes starting "Example" are ignored. For shares or crypto, fill Units and
    // Price symbol (GOOGLEFINANCE style, priced in the row's Currency) instead of Balance.
    holdings.appendRow(['Investment', 'Sharesies', 'Portfolio', 'NZD', 0, '', '', 'Example: replace with your balance']);
    holdings.appendRow(['Investment', 'Coinbase', 'Bitcoin', 'USD', '', 0.05, 'CURRENCY:BTCUSD', 'Example: units x live price']);
    holdings.appendRow(['Investment', 'Sharesies', 'Vanguard S&P 500 ETF', 'USD', '', 10, 'VOO', 'Example']);
    holdings.appendRow(['Debt', 'IRD', 'Tax owed', 'NZD', 0, '', '', 'Example: debts count against net worth']);
  }
  const blank = ss.getSheetByName('Sheet1');
  if (blank && blank.getLastRow() === 0) ss.deleteSheet(blank);
  // Put tabs in order and hide the ones only the script and Claude need. Unhide any from the sheet's tab list.
  Object.keys(HEADERS).forEach((name, i) => { ss.setActiveSheet(ss.getSheetByName(name)); ss.moveActiveSheet(i + 1); });
  HIDDEN_TABS.forEach(name => ss.getSheetByName(name).hideSheet());
  markEditable_(ss);
  ss.setActiveSheet(ss.getSheetByName('Dashboard'));
}

function sync() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const props = PropertiesService.getScriptProperties();

  // 1. Gather raw data from each connected source.
  //    Each account: {name, type, currency, current, available, id}
  //    Each transaction: {date, account, description, merchant, amount, type, category, id, currency, reference}
  const txSh = ss.getSheetByName('Transactions');
  const firstRun = txSh.getLastRow() < 2;
  // Normally 21 days back. If the sync hasn't run for a while, reach back past the newest row so the gap fills. Max a year.
  const newest = firstRun ? 0 : new Date(txSh.getRange(2, 1).getValue()).getTime() || 0;
  const days = firstRun ? 365 : Math.min(365, Math.max(21, (Date.now() - newest) / 864e5 + 7));
  const start = new Date(Date.now() - days * 864e5);

  let accounts = [], txns = [];
  if (props.getProperty('AKAHU_USER_TOKEN')) {
    const a = fromAkahu_(start);
    accounts = accounts.concat(a.accounts); txns = txns.concat(a.txns);
  }
  if (props.getProperty('WISE_API_TOKEN')) {
    const w = fromWise_(start);
    accounts = accounts.concat(w.accounts); txns = txns.concat(w.txns);
  }
  if (!accounts.length) throw new Error('No sources connected. Add Akahu and/or Wise tokens in Script properties.');

  // 2. Rates for every currency seen, then convert to NZD.
  const rates = getRates_(ss, accounts.map(a => a.currency).concat(txns.map(t => t.currency), holdingCurrencies_(ss)));
  const toNzd = (amt, cur) => (amt === '' || amt == null || rates[cur] == null) ? '' : Math.round(amt * rates[cur] * 100) / 100;

  // 3. Accounts tab (replaced each run).
  const accRows = accounts.map(a => [a.name, a.type, a.currency, a.current, a.available, toNzd(a.current, a.currency), new Date(),
                                     a.id, a.provider || '']);
  const accSh = ss.getSheetByName('Accounts');
  if (accSh.getRange(1, 9).getValue() === '') accSh.getRange(1, 9).setValue('Provider').setFontWeight('bold');
  if (accSh.getLastRow() > 1) accSh.getRange(2, 1, accSh.getLastRow() - 1, 9).clearContent();
  accSh.getRange(2, 1, accRows.length, 9).setValues(accRows);

  // 4. Transactions tab (append only new ones).
  const existing = new Set();
  if (!firstRun) txSh.getRange(2, 9, txSh.getLastRow() - 1, 1).getValues().forEach(r => existing.add(String(r[0])));
  saveSorted_(ss);   // categories picked on the Uncategorised tab become rules first, so new rows use them
  applyRuleEdits_(ss);
  const { rules } = loadRules_(ss);
  const rows = txns
    .filter(t => !existing.has(String(t.id)))
    .map(t => [t.date, t.account, t.description, t.merchant, t.amount, t.type, t.category,
               myCategory_(rules, t), t.id, t.currency, toNzd(t.amount, t.currency), t.reference || '']);
  if (txSh.getRange(1, 12).getValue() === '') txSh.getRange(1, 12).setValue('Reference').setFontWeight('bold');
  if (rows.length) {
    txSh.getRange(txSh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
    txSh.getRange(2, 1, txSh.getLastRow() - 1, 12).sort({ column: 1, ascending: false });
  }

  // 5. Fill NZD amounts left blank by a missing rate on an earlier run.
  if (txSh.getLastRow() > 1) {
    const conv = txSh.getRange(2, 5, txSh.getLastRow() - 1, 7).getValues();   // Amount .. Amount (NZD)
    const nzd = conv.map(r => [r[6] === '' ? toNzd(r[0], r[5]) : r[6]]);
    if (conv.some((r, i) => r[6] !== nzd[i][0])) txSh.getRange(2, 11, nzd.length, 1).setValues(nzd);
  }

  markOwnTransfers_(ss);
  buildNetWorth_(ss, rates);
  buildReports_(ss);
}

// ---------- sources ----------

function fromAkahu_(start) {
  const accs = akahu_('/accounts').items || [];
  const names = {}, currencyOf = {};
  const accounts = accs.map(a => {
    const bal = a.balance || {};
    names[a._id] = a.name;
    currencyOf[a._id] = bal.currency || 'NZD';
    return { name: a.name, type: a.type, currency: currencyOf[a._id], provider: a.connection ? a.connection.name : '',
             current: bal.current != null ? bal.current : '', available: bal.available != null ? bal.available : '', id: a._id };
  });
  const txns = [];
  let cursor = null;
  do {
    let path = '/transactions?start=' + encodeURIComponent(start.toISOString());
    if (cursor) path += '&cursor=' + encodeURIComponent(cursor);
    const data = akahu_(path);
    (data.items || []).forEach(t => txns.push({
      date: new Date(t.date), account: names[t._account] || t._account, description: t.description,
      merchant: t.merchant ? t.merchant.name : '', amount: t.amount, type: t.type,
      category: t.category ? t.category.name : '', id: t._id, currency: currencyOf[t._account] || 'NZD',
      // Payee and reference fields on bank transfers: what a rule needs to tag rent, bills and the like.
      reference: t.meta ? [t.meta.other_account, t.meta.particulars, t.meta.code, t.meta.reference].filter(Boolean).join(' ') : ''
    }));
    cursor = data.cursor && data.cursor.next;
  } while (cursor);
  return { accounts, txns };
}

/**
 * Wise, direct with a READ-ONLY personal token. Pulls every currency balance and Jar
 * on the personal profile. Business profiles are ignored.
 */
function fromWise_(start) {
  const profiles = wise_('/v2/profiles').filter(p => String(p.type).toLowerCase() === 'personal');
  if (!profiles.length) throw new Error('No Wise personal profile found for this token.');

  const accounts = [], txns = [];
  const end = new Date();
  profiles.forEach(p => {
    const balances = wise_('/v4/profiles/' + p.id + '/balances?types=STANDARD,SAVINGS');
    balances.forEach(b => {
      const cur = b.currency || (b.amount && b.amount.currency);
      const name = 'Wise ' + cur + (b.type === 'SAVINGS' ? ' Jar' + (b.name ? ' (' + b.name + ')' : '') : '');
      const value = b.amount ? b.amount.value : '';
      accounts.push({ name: name, type: b.type === 'SAVINGS' ? 'Wise Jar' : 'Wise balance', currency: cur,
                      current: value, available: value, id: 'wise:' + b.id, provider: 'Wise' });

      const st = wise_('/v1/profiles/' + p.id + '/balance-statements/' + b.id + '/statement.json' +
        '?currency=' + cur + '&intervalStart=' + start.toISOString() + '&intervalEnd=' + end.toISOString() + '&type=COMPACT');
      (st.transactions || []).forEach(t => {
        const d = t.details || {};
        const raw = Math.abs(Number(t.amount && t.amount.value) || 0);
        const kind = String(d.type || '').toUpperCase();
        txns.push({
          date: new Date(t.date), account: name, description: d.description || kind,
          merchant: d.merchant && d.merchant.name ? d.merchant.name : '',
          amount: t.type === 'DEBIT' ? -raw : raw,
          type: kind === 'CONVERSION' ? 'TRANSFER' : kind,   // currency swaps between your own balances
          category: '', id: 'wise:' + b.id + ':' + t.referenceNumber, currency: cur,
          reference: [d.senderName, d.recipient && d.recipient.name, d.paymentReference].filter(Boolean).join(' ')
        });
      });
    });
  });
  return { accounts, txns };
}

function wise_(path) {
  const token = PropertiesService.getScriptProperties().getProperty('WISE_API_TOKEN');
  const res = UrlFetchApp.fetch('https://api.wise.com' + path, {
    headers: { 'Authorization': 'Bearer ' + token },
    muteHttpExceptions: true
  });
  const code = res.getResponseCode();
  if (code === 403 && res.getHeaders()['x-2fa-approval']) {
    throw new Error('Wise is asking for an extra security check on statements. Paste this error into Claude and ask for the fix.');
  }
  if (code !== 200) throw new Error('Wise ' + code + ' on ' + path.split('?')[0] + ': ' + res.getContentText().slice(0, 300));
  return JSON.parse(res.getContentText());
}

/** Save categories picked on the Uncategorised tab as rules, then re-apply Categories to every transaction. */
function recategorise() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const sh = ss.getSheetByName('Transactions');
  if (sh.getLastRow() < 2) return;
  saveSorted_(ss);
  applyRuleEdits_(ss);
  const { rules } = loadRules_(ss);
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 12).getValues();
  const out = vals.map(r => [myCategory_(rules, { account: r[1], description: r[2], merchant: r[3], amount: r[4],
                                                    type: r[5], category: r[6], reference: r[11], id: r[8] })]);
  sh.getRange(2, 8, out.length, 1).setValues(out);
  markOwnTransfers_(ss);
  refreshNetWorth_(ss);   // Holdings and goals may have changed too, so Net worth is never left behind
  buildReports_(ss);
}

/**
 * Notes: questions and concerns to take to an accountant, adviser or bank, kept by you and Claude. Created if missing;
 * the script only formats it and never changes what's written there.
 */
function setupNotes_(ss) {
  let sh = ss.getSheetByName('Notes');
  if (!sh) {
    const after = ss.getSheetByName('Targets');
    sh = ss.insertSheet('Notes', after ? after.getIndex() : ss.getNumSheets());
  }
  if (sh.getRange('A1').getValue() === '') sh.getRange(1, 1, 1, 6).setValues([HEADERS['Notes']]);
  sh.getRange(1, 1, 1, 6).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.setColumnWidth(1, 110); sh.setColumnWidth(2, 460); sh.setColumnWidth(3, 170); sh.setColumnWidth(4, 80);
  sh.setColumnWidth(5, 320); sh.setColumnWidth(6, 100);
  sh.getRange(2, 1, sh.getMaxRows() - 1, 6).setWrap(true).setVerticalAlignment('top');
  sh.getRange(2, 6, sh.getMaxRows() - 1, 1).setNumberFormat('d mmm yyyy');
  sh.getRange(2, 4, sh.getMaxRows() - 1, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(['Open', 'Done'], true).setAllowInvalid(true).build());
}

/** Stamps Holdings' Last updated when you change a row's Balance or Units by hand. */
function onEdit(e) {
  const r = e && e.range;
  if (!r || r.getSheet().getName() !== 'Holdings' || r.getRow() < 2) return;
  if (r.getColumn() > 6 || r.getLastColumn() < 5) return;   // only Balance (E) and Units (F)
  r.getSheet().getRange(r.getRow(), 9, r.getNumRows(), 1).setValue(new Date()).setNumberFormat('d mmm yyyy');
}

/** Finance > Payday: sync, then open the Transfers To Do tab with the latest invoice's moves. It only reads; you move the money. */
function payday() {
  sync();
  const ss = SpreadsheetApp.getActiveSpreadsheet(), sh = ss.getSheetByName(TODO_TAB);
  if (sh) ss.setActiveSheet(sh);
}

/** Adds a Finance menu to the sheet, for syncing on demand. */
function onOpen() {
  SpreadsheetApp.getUi().createMenu('Finance')
    .addItem('Payday: what to move', 'payday')               // sync, then open Transfers To Do with the latest invoice's moves
    .addItem('Sync banking feeds', 'sync')                    // new bank data, then rebuild everything
    .addItem('Recategorise and refresh', 'recategorise')      // reapply rules and rebuild every tab, no bank calls
    .addToUi();
}

/** Rebuild Net worth from the last synced balances plus Holdings, without calling the banks. */
function refreshNetWorth() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  refreshNetWorth_(ss);
  buildReports_(ss);
}
function refreshNetWorth_(ss) {
  const acc = ss.getSheetByName('Accounts');
  const accCurrencies = acc.getLastRow() > 1 ? acc.getRange(2, 3, acc.getLastRow() - 1, 1).getValues().map(r => r[0]) : [];
  buildNetWorth_(ss, getRates_(ss, accCurrencies.concat(holdingCurrencies_(ss))));
}

/** Optional. Syncs every Monday around 6am. Replaces any earlier sync trigger. */
function installWeeklyTrigger() {
  removeTriggers();
  ScriptApp.newTrigger('sync').timeBased().onWeekDay(ScriptApp.WeekDay.MONDAY).atHour(6).create();
}

/** Stops scheduled syncs. The Finance menu still works. */
/**
 * Run once from the Apps Script editor: every morning around 7am the sheet syncs new bank data and rebuilds every tab,
 * without anyone pressing a menu. Changes made to Targets, Holdings or the rules show up then (or straight away with
 * Finance > Recategorise and refresh). removeTriggers() stops it.
 */
function installAutoRefresh() {
  removeTriggers();
  ScriptApp.newTrigger('dailyRefresh').timeBased().everyDays(1).atHour(7).create();
}

/** The 7am run: sync every day; on Fridays, also the money email (the week so far, before the weekend). */
function dailyRefresh() {
  sync();
  if (new Date().getDay() === 5) sendDailyEmail();
}

/**
 * The daily money email, to the Google account that owns this script: a short note in a cheeky coach voice, built
 * from your real numbers. This week's money, the one category to watch, yesterday, a shout check, goals, a Friday
 * plan on Thursdays and Fridays, and a question for the day. Run it from the editor any time to try it.
 */
function sendDailyEmail() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const read = name => {
    const t = ss.getSheetByName(name);
    return t && t.getLastRow() > 1 ? t.getRange(2, 1, t.getLastRow() - 1, t.getLastColumn()).getValues() : [];
  };
  const groups = loadRules_(ss).groups;
  const m = dailyEmailData_(read('Transactions'), accountsWithHoldings_(read('Accounts'), read('Balance history')), read('Targets'), new Date(),
                           c => groupOf_(groups, c));
  const e = dailyEmailHtml_(m, ss.getUrl());
  MailApp.sendEmail({ to: Session.getEffectiveUser().getEmail(), subject: m.subject, htmlBody: e.html, body: e.text });
}

/**
 * The daily email as plain text with bold, nothing else: no colours, boxes or fonts, so it reads like a note from a
 * person. Returns {html, text}. Plain data, so it can be previewed outside the sheet.
 */
function dailyEmailHtml_(m, url) {
  const r0 = n => (n < 0 ? '-$' : '$') + Math.abs(Math.round(n)).toLocaleString('en-NZ');
  const cell = 'padding:4px 12px 4px 0;border-bottom:1px solid #ddd;text-align:left', num = 'padding:4px 0 4px 12px;border-bottom:1px solid #ddd;text-align:right';
  const table = (head, rows) => '<table style="border-collapse:collapse;margin:4px 0 0">' +
    '<tr>' + head.map((h, i) => '<th style="' + (i ? num : cell) + '">' + h + '</th>').join('') + '</tr>' +
    rows.map(r => '<tr>' + r.map((v, i) => '<td style="' + (i ? num : cell) + '">' + v + '</td>').join('') + '</tr>').join('') + '</table>';
  const sec = (title, inner) => '<p style="margin:18px 0 0"><b>' + title + '</b></p>' + inner;
  const w = m.weekTable;
  const html = '<div style="font-family:Arial,sans-serif;font-size:15px;line-height:1.5"><p>' + m.greeting + '</p>' +
    // Fridays: the week day by day, before the weekend. Other days: one line.
    sec(w.review ? 'Your week so far' : 'This week', (w.review
      ? table(['Day', 'Spent'], (w.days || []).map(d => [d.label, d.spent == null ? '–' : r0(d.spent)])
          .concat([['<b>Week so far</b>', '<b>' + r0(w.spent) + ' of ' + r0(w.budget) + '</b>'], ['<b>Left for the weekend</b>', '<b>' + r0(w.left) + '</b>']]))
      : table(['', 'Spent', 'Budget', 'Left'], [['Everyday (since Monday)', r0(w.spent), r0(w.budget), '<b>' + r0(w.left) + '</b>']])) +
      '<p style="margin:6px 0 0">' + w.daysLeft + ' day' + (w.daysLeft === 1 ? '' : 's') + ' left this week' +
      (w.left > 0 && w.daysLeft ? ', about ' + r0(w.left / w.daysLeft) + ' a day' : '') + '. Everyday has ' + r0(w.everyday) +
      (w.monthlyName ? '; ' + w.monthlyName + ' has ' + r0(w.monthly) + ' for the next ' + w.monthDaysLeft + ' days' : '') + '.</p>') +
    (m.budgets.length ? sec('This month', table(['Budget', 'Spent', 'Limit', ''], m.budgets.map(b =>
      [b.name, r0(b.spent), r0(b.limit), b.note ? '<b>' + b.note + '</b>' : '']).concat([(() => {
        // Total: how much of the whole month's budget is gone.
        const sp = m.budgets.reduce((s, b) => s + b.spent, 0), lim = m.budgets.reduce((s, b) => s + b.limit, 0);
        return ['<b>Total</b>', '<b>' + r0(sp) + '</b>', '<b>' + r0(lim) + '</b>', '<b>' + (lim ? Math.round(sp / lim * 100) : 0) + '% used</b>'];
      })()]))) : '') +
    sec('Callouts', '<ul style="margin:4px 0 0;padding-left:20px">' + m.callouts.map(c => '<li>' + c + '</li>').join('') + '</ul>') +
    (m.goalRows.length ? sec('Goals', table(['Goal', 'Saved', 'Target', 'To go'], m.goalRows.map(g =>
      [g.name, r0(g.saved), r0(g.target), '<b>' + r0(g.left) + '</b> (' + Math.round(g.pct * 100) + '%)']))) : '') +
    (m.plan ? sec(m.plan.title, '<ol style="margin:4px 0 0;padding-left:20px">' + m.plan.items.map(x => '<li>' + x + '</li>').join('') + '</ol>') : '') +
    sec('Today\'s question', '<p style="margin:4px 0 0">' + m.question + '</p>') +
    '<p style="margin:22px 0 0">Talk tomorrow,<br>Your coach</p>' +
    '<p style="margin:12px 0 0;font-size:12px">From your own plan in the <a href="' + url + '">Personal Finance sheet</a>. A nudge, not financial advice.</p></div>';
  const text = html.replace(/<\/(tr|p|li|table)>/g, '\n').replace(/<\/t[dh]>/g, '  ').replace(/<br>/g, '\n').replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&').replace(/\n{3,}/g, '\n\n').trim();
  return { html, text };
}

// Lines the email rotates through, a different one each day. Original, not quotes.
const EMAIL_LINES = {
  greeting: ['Morning, house-buyer.', 'Rise and budget.', 'Good morning, future homeowner.', 'Morning, money boss.',
             'Hello, you financially responsible legend.', 'Kia ora, savings machine.', 'Morning. Coffee first, then this.'],
  perfectWeek: ['A perfect week so far. Frame it.', 'Spotless. Nobody tell the cafes.', 'Not a cent. Monk mode.'],
  overWeek: ['That\'s over the week\'s money. Next week\'s top-up just got smaller. Them\'s the rules.',
             'The week ran out before the week did. Rein it in till Monday.'],
  noWatch: ['Nothing to watch. Every category is on pace. Suspicious, but we\'ll allow it.',
            'All categories behaving. Who are you and what have you done with the real you?',
            'Quiet on every front. Keep this energy.'],
  early: ['Early days: plenty of time to turn this ship around, Captain.', 'Still early. A couple of quiet nights fixes it.'],
  mid: ['Halfway-ish. Time for a few home-cooked nights.', 'The month\'s middle is where budgets go to die. Not this one.'],
  late: ['Final stretch. Hold the line.', 'Home stretch: fridge first, menu second.'],
  noSpend: ['No spending at all. A no-spend day. Gold star.', 'Zero dollars. Your wallet had a nap.'],
  smallDay: ['A suspiciously virtuous day. Who are you?', 'Barely a dent. Love that for you.'],
  bigDay: ['Big day. Was it worth it? Honest answer only.', 'A big one. If it was one of your things, no regrets.'],
  noShout: ['No bills over $100 yesterday. Your friends survived without your wallet. Growth, for everyone.',
            'No big tabs. Splitting suits you.', 'No shouts spotted. Generosity with a budget is still generosity.'],
  questions: [
    'Before you tap, ask: "Is this one of my things?" Coffee: yes, always, sacred.',
    'What are you actually after right now: food, rest, company, or a reward? Buy the right one.',
    'If this purchase cost hours instead of dollars, would you still buy it?',
    'What\'s one free thing that would make today great?',
    'Is this a want that can wait 48 hours?',
    'What would future you, standing in your own kitchen, want you to skip today?',
    'Who could you invite over instead of out this week?',
    'What\'s your best money decision this week so far?',
    'What\'s one subscription you\'d cancel if it renewed today?',
    'Could you raise your rate, or find one more client? That\'s the biggest lever of all.'
  ]
};

/**
 * Synced accounts plus Holdings ones (Sharesies and the like) at their latest NZD value from Balance history, in the
 * Accounts layout: [name, type, currency, balance, '', NZD, '', '', provider, worth type]. Holdings get type
 * HOLDING CASH (counts as cash) or HOLDING. Plain data, testable.
 */
function accountsWithHoldings_(synced, balanceHistory) {
  const seen = new Set(synced.map(a => a[0])), latest = {};
  (balanceHistory || []).forEach(b => { if (b[1] && !seen.has(b[1]) && (!latest[b[1]] || monthKey_(b[0]) >= latest[b[1]][0])) latest[b[1]] = [monthKey_(b[0]), b]; });
  return synced.concat(Object.keys(latest).map(n => { const b = latest[n][1];
    return [n, b[3] === 'Cash' ? 'HOLDING CASH' : 'HOLDING', b[4], b[5], '', Number(b[6]) || 0, '', '', b[2], b[3]]; }));
}

/**
 * The numbers and words behind the daily email. Rows are Transactions and Accounts values; targets drive the
 * budget. groupOf(category) -> its group. Plain data, testable.
 */
function dailyEmailData_(tx, accounts, targets, today, groupOf) {
  const r0 = n => '$' + Math.round(n).toLocaleString('en-NZ');
  const day = d => { const x = new Date(d); return new Date(x.getFullYear(), x.getMonth(), x.getDate()); };
  const t0 = day(today), names = accounts.map(a => a[0]);
  const doy = Math.floor((t0 - new Date(t0.getFullYear(), 0, 0)) / 864e5);
  const pick = (k, salt) => EMAIL_LINES[k][(doy + (salt || 0)) % EMAIL_LINES[k].length];
  const MON = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const find = w => names.find(n => String(n).toLowerCase().includes(w)) || '';
  const bal = n => Number((accounts.find(a => a[0] === n) || [])[5]) || 0;
  const lower = s => String(s || '').trim().toLowerCase();
  const spendRow = r => { const v = nzdAmount_(r), c = String(r[7]).trim(); return v !== null && v < 0 && !EXCLUDE_FROM_SPEND.includes(c) && !isIncomeCategory_(c); };
  const bud = budget_(targets, 0);
  const everyday = find('everyday'), monthly = find('monthly') || find('budget');
  const monday = new Date(t0); monday.setDate(t0.getDate() - ((t0.getDay() + 6) % 7));
  const monthStart = new Date(t0.getFullYear(), t0.getMonth(), 1), lastStart = new Date(t0.getFullYear(), t0.getMonth() - 1, 1);
  const daysIn = new Date(t0.getFullYear(), t0.getMonth() + 1, 0).getDate(), dayNo = t0.getDate();
  const monthlyCats = bud ? Object.keys(bud.byCat).filter(c => !bud.from[c] && groupOf(bud.names[c] || c) !== 'Bills') : [];
  const weekly = bud ? monthlyCats.reduce((s, c) => s + bud.byCat[c], 0) * 12 / 52 : 0;
  // Take-home per working hour, for "that's N hours of work".
  const typical = tx.filter(r => isIncomeRow_(String(r[7]).trim(), nzdAmount_(r) || 0) && day(r[0]) >= new Date(t0.getFullYear(), t0.getMonth() - 3, 1) && day(r[0]) < monthStart)
    .reduce((s, r) => s + (nzdAmount_(r) || 0), 0) / 3;
  const rates = targets.filter(t => /^set-aside rate$/i.test(String(t[1]).trim()));
  const gst = rates.filter(t => /gst/i.test(t[0] + t[2])).reduce((s, t) => s + shareOf_(t[3]) / (1 + shareOf_(t[3])), 0);
  const tax = rates.filter(t => !/gst/i.test(t[0] + t[2])).reduce((s, t) => s + shareOf_(t[3]), 0);
  const hourly = typical * (1 - gst) * (1 - tax) * 12 / 2080;

  // This week.
  const weekSpent = tx.filter(r => r[1] === everyday && day(r[0]) >= monday && day(r[0]) < t0 && spendRow(r)).reduce((s, r) => s - nzdAmount_(r), 0);
  const daysLeft = 7 - ((t0.getDay() + 6) % 7);
  // Each day of this week, Monday first: what came out of Everyday that day (days not over yet are null).
  const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const weekDays = Array.from({ length: 7 }, (_, k) => {
    const d = new Date(monday); d.setDate(monday.getDate() + k);
    const spent = d < t0 ? tx.filter(r => r[1] === everyday && day(r[0]).getTime() === d.getTime() && spendRow(r)).reduce((s, r) => s - nzdAmount_(r), 0) : null;
    return { label: DAY[d.getDay()] + ' ' + d.getDate(), spent };
  });
  const week = [];
  if (everyday) {
    let tail = '';
    if (weekly && weekSpent > weekly) tail = ' ' + pick('overWeek');
    else if (weekSpent < 1) tail = t0.getDay() === 1 ? ' A fresh week. Don\'t blow it before lunch.' : ' ' + pick('perfectWeek');
    else if (weekly) tail = ' ' + r0(weekly - weekSpent) + ' left for ' + daysLeft + ' day' + (daysLeft === 1 ? '' : 's') + ', about ' + r0((weekly - weekSpent) / daysLeft) + ' a day.';
    week.push('Everyday: <b>' + r0(bal(everyday)) + '</b>. Weekly money is <b>' + r0(weekly) + '</b>, and you\'ve spent ' + r0(weekSpent) + ' since Monday.' + tail);
  }
  if (monthly) week.push(monthly.replace(/^[\/#]\s*/, '') + ': <b>' + r0(bal(monthly)) + '</b> for the next ' + (daysIn - dayNo + 1) + ' days. Not extra money: every week from now till the end of ' + MON[t0.getMonth()] + '.');

  // The one to watch: the category furthest over its limit, or furthest ahead of pace (day-to-day ones, from the 3rd).
  let watch = { title: 'The one to watch', lines: [pick('noWatch')], alert: false };
  let budgets = [];   // [{name, spent, limit, note}] this month, day-to-day categories first
  if (bud) {
    const spent = {}, last = {};
    tx.filter(spendRow).forEach(r => {
      const c = lower(r[7]), d = day(r[0]);
      if (d >= monthStart && d < t0) spent[c] = (spent[c] || 0) - nzdAmount_(r);
      else if (d >= lastStart && d < monthStart) last[c] = (last[c] || 0) - nzdAmount_(r);
    });
    const elapsed = Math.max(dayNo - 1, 1) / daysIn, dayToDay = new Set(monthlyCats);
    budgets = Object.keys(bud.byCat).filter(c => bud.byCat[c] > 0)
      .sort((a, b) => (dayToDay.has(b) - dayToDay.has(a)) || bud.byCat[b] - bud.byCat[a])
      .map(c => ({ name: bud.names[c] || c, spent: spent[c] || 0, limit: bud.byCat[c],
                   note: (spent[c] || 0) > bud.byCat[c] ? 'Over' : dayToDay.has(c) && dayNo >= 3 && (spent[c] || 0) / elapsed > bud.byCat[c] * 1.1 ? 'Watch' : '' }));
    const scored = Object.keys(bud.byCat).filter(c => bud.byCat[c] > 0 && spent[c])
      .map(c => ({ c, over: spent[c] > bud.byCat[c], ratio: (spent[c] / elapsed) / bud.byCat[c], gap: spent[c] / elapsed - bud.byCat[c] }))
      .filter(x => x.over || (dayToDay.has(x.c) && dayNo >= 3 && x.ratio > 1.1))
      .sort((a, b) => (b.over - a.over) || b.gap - a.gap);   // the biggest problem in dollars first
    if (scored.length) {
      const c = scored[0].c, nm = bud.names[c] || c, lim = bud.byCat[c];
      const lines = [scored[0].over
        ? '<b>' + nm + ': ' + r0(spent[c]) + ' so far, already over the ' + r0(lim) + ' limit.</b> Everything from here comes out of savings. Ouch.'
        : '<b>' + nm + ': ' + r0(spent[c]) + ' in ' + (dayNo - 1) + ' day' + (dayNo === 2 ? '' : 's') + '.</b> At this pace ' + MON[t0.getMonth()] +
          ' lands at about ' + r0(spent[c] / elapsed) + ', against your ' + r0(lim) + '. ' + pick(dayNo <= 10 ? 'early' : dayNo <= 20 ? 'mid' : 'late')];
      if (last[c] > 100 && hourly > 0) lines.push('Last month it was <b>' + r0(last[c]) + '</b>: about ' + Math.round(last[c] / hourly) + ' hours of work at your ~' + r0(hourly) + '/hour take-home.');
      watch = { title: 'The one to watch', lines: lines.concat(scored.length > 1 ? ['Also creeping: ' + scored.slice(1, 3).map(x => bud.names[x.c] || x.c).join(', ') + '.'] : []), alert: true };
    }
  }

  // Yesterday, and the shout check.
  const yday = new Date(t0); yday.setDate(t0.getDate() - 1);
  const ylist = tx.filter(r => day(r[0]).getTime() === yday.getTime() && spendRow(r)).sort((a, b) => nzdAmount_(a) - nzdAmount_(b));
  const ytotal = ylist.reduce((s, r) => s - nzdAmount_(r), 0);
  const yesterday = ylist.slice(0, 6).map(r => (r[3] || r[2]) + ', ' + r0(-nzdAmount_(r)));
  yesterday.push(!ylist.length ? pick('noSpend') : ytotal < 25 ? (ylist.length > 1 ? 'Total ' + r0(ytotal) + '. ' : '') + pick('smallDay')
    : 'Total ' + r0(ytotal) + '.' + (ytotal > 200 ? ' ' + pick('bigDay') : ''));
  const shoutRow = ylist.find(r => lower(r[7]) === 'eating out' && -nzdAmount_(r) >= 100);
  const shout = shoutRow ? (shoutRow[3] || shoutRow[2]) + ', ' + r0(-nzdAmount_(shoutRow)) + '. Was that a shout? If so, it came out of your eating out money. Generous, but the house is watching.'
    : pick('noShout');

  // Goals you pay into.
  // Every savings goal, as on the Dashboard: an account shared by goals is split between them by priority, and goals
  // named "Base (part)" are added up into one row. Then planned purchases as one row.
  const shared = goalBalances_(targets, a => findAccount_(a, names), n => bal(n));
  const base = n => (String(n).match(/^(.*\S)\s*\(([^)]+)\)\s*$/) || [])[1] || String(n);
  const byGoal = {}, order = [];
  targets.forEach((t, i) => {
    if (!t[0] || /^example/i.test(String(t[8])) || !/^savings goal$/i.test(String(t[1]).trim())) return;
    const k = base(t[0]), now = Number(t[5]) || (shared[i].now != null ? shared[i].now : 0);
    if (!byGoal[k]) { byGoal[k] = { name: k, saved: 0, target: 0 }; order.push(k); }
    byGoal[k].saved += now; byGoal[k].target += Number(t[3]) || 0;
  });
  const goalRows = order.map(k => byGoal[k]).sort((a, b) => b.target - a.target);
  const planned = targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && isPlanKind_(t[1]));
  if (planned.length) {
    const cost = planned.reduce((s, t) => s + (Number(t[3]) || 0), 0);
    const held = Array.from(new Set(planned.map(t => findAccount_(t[2], names)).filter(Boolean))).reduce((s, a) => s + bal(a), 0);
    goalRows.push({ name: 'Planned purchases', saved: Math.min(held, cost), target: cost });
  }
  goalRows.forEach(g => { g.left = Math.max(g.target - g.saved, 0); g.pct = g.target ? Math.min(g.saved / g.target, 1) : 0; });
  const goals = targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && /^savings goal$/i.test(String(t[1]).trim()) && shareOf_(t[9]))
    .map(t => {
      const left = Math.max((Number(t[3]) || 0) - bal(findAccount_(goalAccounts_(t[2])[0], names)), 0);
      const orders = Math.round(left / 45);
      return '<b>' + t[0] + '</b>: ' + (left < 1 ? 'done! Go celebrate (cheaply).' : r0(left) + ' to go' +
        (left <= 1000 ? '. So close.' : orders <= 80 ? ', about ' + orders + ' takeaway orders you don\'t make.' : '. Every quiet Friday night moves this bar.'));
    });

  // Thursdays and Fridays: plan Friday night while you're feeling wise.
  const plan = [4, 5].includes(t0.getDay()) ? { title: 'Friday plan, set now while you\'re feeling wise:',
    items: ['Friends over, you cook, they bring the drinks.', 'One dinner out you\'ll actually remember, split down the middle.', 'Couch, a homemade takeaway, zero regrets.'] } : null;
  // A personal-sounding subject with no money words, so mail sorters file it as a note, not a receipt or statement.
  // Callouts: the short list of things worth noticing today.
  const pay = find('invoice'), callouts = [];
  if (watch.alert) watch.lines.forEach(l => callouts.push(l));
  if (pay && bal(pay) > 1) callouts.push('<b>' + r0(bal(pay)) + ' is waiting in ' + pay + '.</b> Run Finance > Payday: what to move, then make the transfers.');
  if (shoutRow) callouts.push(shout);
  if (ytotal > 200) callouts.push('<b>Yesterday: ' + r0(ytotal) + '.</b> ' + pick('bigDay'));
  if (!callouts.length) callouts.push(pick('noWatch'));
  const weekTable = { days: weekDays, review: t0.getDay() === 5, spent: weekSpent, budget: weekly, left: weekly - weekSpent, daysLeft, everyday: bal(everyday), monthly: bal(monthly),
                      monthlyName: monthly ? monthly.replace(/^[\/#]\s*/, '') : '', monthDaysLeft: daysIn - dayNo + 1 };
  return { weekTable, budgets, goalRows, callouts, yesterdayTotal: ytotal, yesterdayCount: ylist.length,
           subject: watch.alert ? 'Your morning nudge: a word about ' + watch.lines[0].replace(/<[^>]+>/g, '').split(':')[0].toLowerCase()
                                : 'Your morning nudge: all calm today',
           greeting: pick('greeting'), week, watch, yesterday, shout, goals, plan, question: pick('questions', 3) };
}
function removeTriggers() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['sync', 'recategorise', 'dailyRefresh'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
}

// ---------- helpers ----------

function akahu_(path) {
  const p = PropertiesService.getScriptProperties();
  const app = p.getProperty('AKAHU_APP_TOKEN');
  const user = p.getProperty('AKAHU_USER_TOKEN');
  if (!app || !user) throw new Error('Add AKAHU_APP_TOKEN and AKAHU_USER_TOKEN in Project Settings > Script properties.');
  const res = UrlFetchApp.fetch('https://api.akahu.io/v1' + path, {
    headers: { 'Authorization': 'Bearer ' + user, 'X-Akahu-Id': app },
    muteHttpExceptions: true
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('Akahu ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300));
  }
  return JSON.parse(res.getContentText());
}

/** Live rate to NZD for each currency, via GOOGLEFINANCE in the FX tab. NZD is always 1. */
function getRates_(ss, currencies) {
  const sh = ss.getSheetByName('FX');
  const unique = Array.from(new Set(currencies.concat(['NZD'])));
  sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), 2).clearContent();
  const rows = unique.map((c, i) => [c, c === 'NZD' ? 1 : '=GOOGLEFINANCE("CURRENCY:' + c + 'NZD")']);
  sh.getRange(2, 1, rows.length, 2).setValues(rows);
  SpreadsheetApp.flush();
  const rates = {};
  sh.getRange(2, 1, rows.length, 2).getValues().forEach(([c, r]) => {
    if (typeof r === 'number' && r > 0) rates[c] = r;
  });
  return rates;
}

/**
 * Categories tab. Each row with match text is a rule: the first rule whose text appears in the merchant, description
 * or reference sets the category, optionally only for one account or one direction of money. Rules beat everything
 * else, including Akahu's own category, its TRANSFER type, and transfer pairing. A row's Group puts that category in
 * a group; rows with no match text only do that.
 */
function loadRules_(ss) {
  const sh = ss.getSheetByName('Categories');
  const vals = sh && sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, 5).getValues() : [];
  // The sheet's rules first, then the ones kept in my-rules.gs, so anything set on the Categories tab wins.
  return parseRules_(vals.concat(typeof MY_RULES === 'undefined' ? [] : MY_RULES),
                     typeof MY_CATEGORY_MERGES === 'undefined' ? [] : MY_CATEGORY_MERGES,
                     typeof MY_TRANSACTION_CATEGORIES === 'undefined' ? [] : MY_TRANSACTION_CATEGORIES);
}

// merges: [[from, to]] pairs (MY_CATEGORY_MERGES): any transaction that would get "from" gets "to" instead.
// byId: [[transaction ID, category]] (MY_TRANSACTION_CATEGORIES): one transaction, whatever the rules say.
function parseRules_(vals, merges, byId) {
  const lower = s => String(s || '').trim().toLowerCase();
  const rules = [], groups = {}, ruled = new Set();
  vals.forEach(r => {
    const match = lower(r[0]), cat = String(r[1] || '').trim(), group = String(r[2] || '').trim();
    if (!cat) return;
    if (group && !groups[lower(cat)]) groups[lower(cat)] = group;
    if (!match || match.startsWith('e.g.')) return;
    const dir = lower(r[4]);
    rules.push({ match, cat, account: lower(r[3]), dir: dir === 'in' || dir === 'out' ? dir : '' });
    if (!EXCLUDE_FROM_SPEND.includes(cat)) ruled.add(lower(cat));
  });
  rules.merge = {}; rules.byId = {};
  (byId || []).forEach(([id, cat]) => { if (String(id || '').trim() && String(cat || '').trim()) rules.byId[String(id).trim()] = String(cat).trim(); });
  (merges || []).forEach(([from, to]) => { if (lower(from) && String(to || '').trim()) rules.merge[lower(from)] = String(to).trim(); });
  return { rules, groups, ruled };
}

/** t: {merchant, description, reference, account, amount, type, category (Akahu's)} */
function myCategory_(rules, t) {
  if (rules.byId && t.id && rules.byId[String(t.id)]) return rules.byId[String(t.id)];
  const cat = categoryOf_(rules, t);
  return (rules.merge && rules.merge[String(cat).toLowerCase()]) || cat;
}
function categoryOf_(rules, t) {
  const text = [t.merchant, t.description, t.reference, t.category].join(' ').toLowerCase();
  const account = String(t.account || '').toLowerCase();
  const amt = Number(t.amount) || 0;
  for (const r of rules) {
    if (r.account && !account.includes(r.account)) continue;
    if ((r.dir === 'in' && amt <= 0) || (r.dir === 'out' && amt >= 0)) continue;
    if (r.match === '*' || text.includes(r.match)) return r.cat;   // "*" matches anything (use with Only account)
  }
  if (t.type === 'TRANSFER') return 'Transfer';
  if (t.type === 'ATM' && Number(t.amount) < 0) return 'ATM withdrawals';   // cash out, whatever it's spent on
  return mapAkahu_(t.category) || t.category || 'Uncategorised';
}

/** Group for a category: Income and Transfer are fixed; the rest come from Categories, else Other. */
function groupOf_(groups, cat) {
  if (EXCLUDE_FROM_SPEND.includes(cat)) return 'Transfer';
  if (isIncomeCategory_(cat)) return 'Income';
  const key = String(cat).trim().toLowerCase();
  const fallback = DEFAULT_GROUPS.find(([c]) => c.toLowerCase() === key);
  return groups[key] || (fallback ? fallback[1] : 'Other');
}

/** Groups in display order: the standard ones, then any custom ones. */
function groupOrder_(names) {
  return GROUPS.filter(g => names.includes(g)).concat(names.filter(g => !GROUPS.includes(g)).sort());
}

/** NZD amount for a Transactions row, or null if it's foreign and has no rate yet. Never falls back to a foreign amount. */
function nzdAmount_(r) {
  if (r[10] !== '') return Number(r[10]) || 0;
  return (r[9] || 'NZD') === 'NZD' ? Number(r[4]) || 0 : null;
}

/** Where income came from: "Income: Acme" -> Acme. Plain Income, Income: Other and uncategorised money in -> Other. */
function incomeSource_(cat) {
  const m = String(cat).match(/^income\s*:\s*(.+)$/i);
  return m && !/^other$/i.test(m[1].trim()) ? m[1].trim() : 'Other';
}

/** Income sources in display order: named ones by size, Other last. */
function incomeSources_(incomeBy) {
  const total = s => Object.values(incomeBy[s] || {}).reduce((a, b) => a + b, 0);
  return Object.keys(incomeBy).filter(s => s !== 'Other').sort((a, b) => total(b) - total(a))
    .concat(incomeBy.Other ? ['Other'] : []);
}

/** True if a row counts as income rather than spend (or a refund against spend). */
function isIncomeRow_(cat, amt) {
  return isIncomeCategory_(cat) || (amt > 0 && cat === 'Uncategorised');
}

/** Rent, office, utilities, phone and insurance: fixed costs of living, by category name or the Bills group. */
function isLivingCost_(category, group) {
  if (EXCLUDE_FROM_SPEND.includes(category) || /^subscriptions$/i.test(String(category).trim())) return false;
  return group === 'Bills' ||
    /^office$|co-?working|\b(rent|electricity|power|gas|water|internet|broadband|telecommunication|phone|mobile|insurance|rates|utilit)/i.test(String(category).trim());
}

/** The Actions tab was renamed Savings actions; keep an older sheet's rows by renaming its tab. */
function renameActionsTab_(ss) {
  const old = ss.getSheetByName('Actions');
  if (old && !ss.getSheetByName('Savings actions')) old.setName('Savings actions');
}

// Savings actions columns (0-based): 0 Rank, 1 Action, 2 Merchant or category, 3 Est. monthly saving, 4 Effort,
// 5 Evidence, 6 Added, 7 Due, 8 Status, 9 Actual saving, 10 Notes, 11 Track, 12 Baseline / mo, 13 Target / mo,
// then generated: 14 Last month, 15 This month so far, 16 Progress.
const ACTION_COLS = 17, ACTION_INPUT_COLS = 14;
const ACTION_STATUSES = ['Suggested', 'Committed', 'Done', 'Dropped'];
// Columns Claude refreshes from my-actions.gs on rows already on the tab. Status (8) and Actual saving (9) are yours.
const ACTION_CLAUDE_COLS = [0, 2, 3, 4, 5, 7, 10, 11, 12, 13];
const isCommitted_ = status => /^(committed|open)$/i.test(String(status).trim());

/**
 * Bring the Savings actions tab in line with my-actions.gs: rename rows listed in MY_ACTION_RENAMES, refresh
 * Claude's columns on rows already there, add new ones. Never touches your Status (except Suggested -> what
 * my-actions.gs says, and Open -> Committed) or Actual saving.
 */
function syncMyActions_(ss) {
  const mine = typeof MY_ACTIONS === 'undefined' ? [] : MY_ACTIONS;
  const renames = typeof MY_ACTION_RENAMES === 'undefined' ? [] : MY_ACTION_RENAMES;
  const sh = ss.getSheetByName('Savings actions');
  if (!sh) return;
  const header = HEADERS['Savings actions'];
  if (sh.getLastColumn() < header.length) sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  const current = sh.getLastRow() > 1 ? sh.getRange(2, 1, sh.getLastRow() - 1, ACTION_COLS).getValues() : [];
  const rows = syncActions_(current, mine, renames);
  if (!rows.length) return;
  sh.getRange(2, 1, rows.length, ACTION_COLS).setValues(rows);
  sh.getRange(2, 7, rows.length, 2).setNumberFormat('d mmm yyyy');
  sh.getRange(2, 4, rows.length, 1).setNumberFormat('$#,##0');
  sh.getRange(2, 10, rows.length, 1).setNumberFormat('$#,##0');
  sh.getRange(2, 13, rows.length, 4).setNumberFormat('$#,##0');
  sh.getRange(2, 9, rows.length, 1).setDataValidation(SpreadsheetApp.newDataValidation()
    .requireValueInList(ACTION_STATUSES, true).setAllowInvalid(true).build());
}

/** Plain data version of syncMyActions_: returns every row, existing ones updated and new ones appended. */
function syncActions_(current, mine, renames) {
  const key = t => String(t || '').trim().toLowerCase();
  const pad = r => r.concat(Array(ACTION_COLS).fill('')).slice(0, ACTION_COLS);
  const rows = current.filter(r => String(r[1]).trim()).map(pad);
  (renames || []).forEach(([from, to]) => rows.forEach(r => { if (key(r[1]) === key(from)) r[1] = to; }));
  rows.forEach(r => { if (/^open$/i.test(String(r[8]).trim())) r[8] = 'Committed'; });
  mine.forEach(a => {
    const src = pad(a);
    const row = rows.find(r => key(r[1]) === key(src[1]));
    if (!row) { rows.push(src.slice(0, ACTION_INPUT_COLS).concat(['', '', ''])); return; }
    ACTION_CLAUDE_COLS.forEach(c => { row[c] = src[c]; });
    if (/^suggested$/i.test(String(row[8]).trim()) && src[8]) row[8] = src[8];
  });
  return rows;
}

/**
 * Fill Last month, This month so far and Progress for each action with a Track, from Transactions.
 * Track is text found in the merchant, description or reference (| for alternatives, ! to exclude), or category:Name.
 */
function trackMyActions_(ss) {
  const sh = ss.getSheetByName('Savings actions'), tx = ss.getSheetByName('Transactions');
  if (!sh || sh.getLastRow() < 2 || tx.getLastRow() < 2) return;
  const tz = ss.getSpreadsheetTimeZone(), now = new Date();
  const thisMonth = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 1), tz, 'yyyy-MM');
  const lastMonth = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - 1, 1), tz, 'yyyy-MM');
  const vals = tx.getRange(2, 1, tx.getLastRow() - 1, 12).getValues()
    .map(r => Object.assign(r.slice(), { month: Utilities.formatDate(new Date(r[0]), tz, 'yyyy-MM') }));
  const actions = sh.getRange(2, 1, sh.getLastRow() - 1, ACTION_COLS).getValues();
  const out = actions.map(a => trackAction_(vals, a, lastMonth, thisMonth));
  sh.getRange(2, 15, out.length, 3).setValues(out);
}

/** [last month, this month so far, progress] for one action. Transactions rows carry a .month key. */
function trackAction_(vals, a, lastMonth, thisMonth) {
  const track = String(a[11] || '').trim().toLowerCase();
  if (!track) return ['', '', ''];
  const byCategory = track.startsWith('category:') ? track.slice(9).trim() : '';
  const parts = byCategory ? [] : track.split('|').map(w => w.trim()).filter(Boolean);
  const words = parts.filter(w => !w.startsWith('!')), without = parts.filter(w => w.startsWith('!')).map(w => w.slice(1).trim());
  const spent = month => -vals.filter(r => r.month === month).filter(r => {
    const cat = String(r[7] || '').trim();
    if (EXCLUDE_FROM_SPEND.includes(cat) || isIncomeCategory_(cat)) return false;
    if (byCategory) return cat.toLowerCase() === byCategory;
    const text = [r[3], r[2], r[11]].join(' ').toLowerCase();
    return words.some(w => text.includes(w)) && !without.some(w => text.includes(w));
  }).reduce((s, r) => s + (nzdAmount_(r) || 0), 0);
  const last = Math.round(spent(lastMonth)), now = Math.round(spent(thisMonth));
  const base = Number(a[12]), target = Number(a[13]);
  const status = String(a[8] || '').trim();
  // Judge last month only once the action has been running for all of it; before that, show this month so far.
  const added = a[6] ? (Object.prototype.toString.call(a[6]) === '[object Date]' ? monthKey_(a[6]) : String(a[6]).slice(0, 7)) : '';
  let progress = '';
  if (/^dropped$/i.test(status)) progress = '';
  else if (added && lastMonth < added) progress = 'Started ' + added + ': $' + now + ' so far this month' + (a[13] !== '' && !isNaN(target) ? ', target $' + target : '');
  else if (a[13] === '' || isNaN(target)) progress = base ? 'Last month $' + last + ' vs $' + base + ' before' : '';
  else if (last <= target) progress = 'On target last month' + (base > last ? ', saved $' + Math.round(base - last) : '');
  else progress = 'Over target by $' + Math.round(last - target) + ' last month';
  if (!/^(committed|open|done)$/i.test(status) && progress) progress = 'Not committed. ' + progress;
  return [last, now, progress];
}

/** Rebuild the generated tabs: Summary and Merchants for Claude, Dashboard for you. */
function buildReports_(ss) {
  renameActionsTab_(ss);
  setupNotes_(ss);
  syncMyActions_(ss);
  markEditable_(ss);
  // Months are worked out in the script's time zone (Pacific/Auckland); the sheet must match or they shift by one.
  const tz = Session.getScriptTimeZone();
  if (ss.getSpreadsheetTimeZone() !== tz) ss.setSpreadsheetTimeZone(tz);
  trackMyActions_(ss);
  syncHouseGoal_(ss);
  const { groups } = loadRules_(ss);
  const reserved = reservedAccounts_(ss);
  const summary = buildSummary_(ss, groups, reserved);
  const merchants = buildMerchants_(ss, groups, reserved);
  const toSort = buildUncategorised_(ss, reserved);
  buildDashboard_(ss, summary, merchants, toSort);
  const forecast = buildForecast_(ss, summary);
  buildHomeScenarios_(ss, summary, forecast ? forecast.goals : []);
}

/** Lower-case names of Reserved accounts (tax set-asides): synced ones by name or override, and Reserved Holdings. */
function reservedAccounts_(ss) {
  const read = name => {
    const t = ss.getSheetByName(name);
    return t && t.getLastRow() > 1 ? t.getRange(2, 1, t.getLastRow() - 1, t.getLastColumn()).getValues() : [];
  };
  const holdings = read('Holdings'), overrides = typeOverrides_(holdings);
  const names = read('Accounts').filter(a => a[0] && syncedType_(a[0], a[1], overrides) === 'Reserved').map(a => a[0])
    .concat(holdings.filter(h => /^reserved$/i.test(String(h[0]).trim()) && h[2]).map(h => h[2]));
  return new Set(names.map(n => String(n).trim().toLowerCase()));
}

/**
 * Summary tab: income, spend per group and per category for the last few months. Small enough for Claude to read quickly.
 * Reserved accounts (tax set-asides) are handled apart: money moved into them is set aside for tax and comes off
 * income, so income is take-home; tax paid out of them isn't spending.
 */
function buildSummary_(ss, groups, reserved) {
  groups = groups || {};
  reserved = reserved || new Set();
  const tx = ss.getSheetByName('Transactions');
  const sh = ss.getSheetByName('Summary');
  sh.clear();
  if (tx.getLastRow() < 2) return null;

  const tz = ss.getSpreadsheetTimeZone();
  const months = [];
  const now = new Date();
  for (let i = SUMMARY_MONTHS - 1; i >= 0; i--) {
    months.push(Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - i, 1), tz, 'yyyy-MM'));
  }

  const spend = {}, income = {}, totals = {}, setAside = {}, incomeBy = {};
  months.forEach(m => { income[m] = 0; totals[m] = 0; setAside[m] = 0; });

  // Tax set-asides happen in batches, so take-home uses your set-aside rate over the last year (money moved into
  // Reserved accounts / gross income) rather than each month's lumpy transfers.
  const yearAgo = new Date(now.getFullYear() - 1, now.getMonth(), now.getDate());
  let grossYear = 0, setAsideYear = 0, unconverted = 0;
  tx.getRange(2, 1, tx.getLastRow() - 1, 11).getValues().forEach(r => {
    const date = new Date(r[0]);
    const m = Utilities.formatDate(date, tz, 'yyyy-MM');
    const inMonths = m in income, inYear = date >= yearAgo;
    if (!inMonths && !inYear) return;
    const cat = r[7] || 'Uncategorised';
    const amt = nzdAmount_(r);
    if (amt === null) { if (inMonths) unconverted++; return; }
    if (reserved.has(String(r[1]).trim().toLowerCase())) {
      // Into a tax account: set aside. Moved back out to your own accounts: released. Paid to IRD: neither.
      // Interest earned there stays there, so it isn't counted either way.
      if (inYear && cat !== 'Uncategorised' && (amt > 0 || cat === 'Transfer')) setAsideYear += amt;
      return;
    }
    if (EXCLUDE_FROM_SPEND.includes(cat)) return;
    // Income is anything in an Income category, plus uncategorised money in.
    // Other money in (refunds, cashback) comes off its category's spend.
    if (isIncomeRow_(cat, amt)) {
      if (inYear) grossYear += amt;
      if (inMonths) {
        income[m] += amt;
        const src = incomeSource_(cat);
        incomeBy[src] = incomeBy[src] || {};
        incomeBy[src][m] = (incomeBy[src][m] || 0) + amt;
      }
      return;
    }
    if (!inMonths) return;
    spend[cat] = spend[cat] || {};
    spend[cat][m] = (spend[cat][m] || 0) - amt;
    totals[m] -= amt;
  });

  const groupOfCat = {}, groupTotals = {};
  Object.keys(spend).forEach(cat => {
    const g = groupOfCat[cat] = groupOf_(groups, cat);
    groupTotals[g] = groupTotals[g] || {};
    months.forEach(m => { groupTotals[g][m] = (groupTotals[g][m] || 0) + (spend[cat][m] || 0); });
  });
  const order = groupOrder_(Object.keys(groupTotals));

  const rate = grossYear > 0 ? Math.min(Math.max(setAsideYear / grossYear, 0), 0.6) : 0;
  const gross = {};
  months.forEach(m => { gross[m] = income[m]; setAside[m] = income[m] * rate; income[m] -= setAside[m]; });

  const round = n => Math.round((n || 0) * 100) / 100;
  const blank = ['', ''].concat(months.map(() => ''));
  const out = [['Category', 'Group'].concat(months)];
  out.push(['INCOME (take-home)', 'Income'].concat(months.map(m => round(income[m]))));
  if (months.some(m => setAside[m])) {
    out.push(['  gross income', 'Income'].concat(months.map(m => round(gross[m]))));
    incomeSources_(incomeBy).forEach(src =>
      out.push(['    from ' + src, 'Income'].concat(months.map(m => round((incomeBy[src] || {})[m])))));
    out.push(['  set aside for tax (' + Math.round(rate * 100) + '%)', 'Income'].concat(months.map(m => round(-setAside[m]))));
  }
  out.push(['TOTAL SPEND', ''].concat(months.map(m => round(totals[m]))));
  order.forEach(g => out.push([g.toUpperCase() + ' (group total)', g].concat(months.map(m => round(groupTotals[g][m])))));
  const bold = out.length;
  const last3 = cat => months.slice(-4, -1).reduce((s, m) => s + (spend[cat][m] || 0), 0);
  order.forEach(g => {
    out.push(blank);
    Object.keys(spend).filter(c => groupOfCat[c] === g).sort((a, b) => last3(b) - last3(a))
      .forEach(cat => out.push([cat, g].concat(months.map(m => round(spend[cat][m])))));
  });

  sh.getRange(1, 1, 1, out[0].length).setNumberFormat('@');   // month headers stay text, not dates
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, bold, out[0].length).setFontWeight('bold');
  sh.getRange(1, 1).setNote('All amounts NZD. Income is take-home: gross income less your tax set-aside rate over the last ' +
    'year (' + Math.round(rate * 100) + '%, money moved into Reserved accounts / gross income). Tax paid from them is not spending. Groups come from the Categories tab; categories with no group are Other. ' +
    'Transfers and credit card payments excluded. Refunds come off their category. ' +
    'Income is Income categories plus uncategorised money in. Current month is partial.' +
    (unconverted ? ' ' + unconverted + ' foreign-currency rows left out: no NZD rate yet.' : '') + ' Updated ' + new Date());
  return { months, income, totals, spend, groupTotals, groupOfCat, order, gross, setAside, setAsideRate: rate, incomeBy };
}

/**
 * Merchants tab: where spending goes, merchant by merchant, so the review can name specific savings.
 * Averages cover the last MERCHANT_AVG_MONTHS full months (the current month is left out). "Likely recurring"
 * means charged in at least RECURRING_MIN_MONTHS of the last 6 full months, usually once or twice a month:
 * subscriptions, memberships, bills. Refunds come off the merchant.
 */
function buildMerchants_(ss, groups, reserved) {
  reserved = reserved || new Set();
  const tx = ss.getSheetByName('Transactions');
  const sh = ss.getSheetByName('Merchants');
  sh.clear();
  if (tx.getLastRow() < 2) return [];

  const tz = ss.getSpreadsheetTimeZone();
  const now = new Date();
  const full = [];   // last 6 full months, newest first
  for (let i = 1; i <= 6; i++) full.push(Utilities.formatDate(new Date(now.getFullYear(), now.getMonth() - i, 1), tz, 'yyyy-MM'));
  const recent = full.slice(0, MERCHANT_AVG_MONTHS);
  const current = Utilities.formatDate(new Date(now.getFullYear(), now.getMonth(), 1), tz, 'yyyy-MM');

  const by = {};
  tx.getRange(2, 1, tx.getLastRow() - 1, 11).getValues().forEach(r => {
    const m = Utilities.formatDate(new Date(r[0]), tz, 'yyyy-MM');
    if ((m !== current && !full.includes(m)) || reserved.has(String(r[1]).trim().toLowerCase())) return;
    const cat = r[7] || 'Uncategorised';
    const amt = nzdAmount_(r);
    if (amt === null || EXCLUDE_FROM_SPEND.includes(cat) || isIncomeRow_(cat, amt)) return;
    const name = merchantName_(r[3], r[2]);
    const x = by[name] = by[name] || { cats: {}, months: {}, charges: 0, recentSpend: 0, last: null, lastAmt: 0 };
    if (m === current) {
      // This month only counts toward "Last charged"; averages use full months.
      const d = new Date(r[0]);
      if (amt < 0 && (!x.last || d > x.last)) { x.last = d; x.lastAmt = -amt; }
      return;
    }
    x.months[m] = (x.months[m] || 0) - amt;
    if (recent.includes(m)) x.recentSpend -= amt;
    if (amt < 0) {
      x.cats[cat] = (x.cats[cat] || 0) - amt;
      if (recent.includes(m)) x.charges++;
      const d = new Date(r[0]);
      if (!x.last || d > x.last) { x.last = d; x.lastAmt = -amt; }
    }
  });

  const round = n => Math.round(n * 100) / 100;
  const rows = Object.keys(by).map(name => {
    const x = by[name];
    const seen = full.filter(m => x.months[m] > 0).length;
    const perMonth = x.charges / MERCHANT_AVG_MONTHS;
    const cat = Object.keys(x.cats).sort((a, b) => x.cats[b] - x.cats[a])[0] || '';
    const avg = round(x.recentSpend / MERCHANT_AVG_MONTHS);
    return [name, cat, groupOf_(groups || {}, cat), avg, round(avg * 12), Math.round(perMonth * 10) / 10, seen,
            seen >= RECURRING_MIN_MONTHS && perMonth <= 2.5 ? 'Yes' : '', x.last || '', x.lastAmt ? round(x.lastAmt) : ''];
  }).filter(r => r[3] > 0 || r[7]).sort((a, b) => b[3] - a[3]).slice(0, 150);

  const out = [['Merchant', 'Category', 'Group', 'Avg / month', 'Per year', 'Charges / month', 'Months seen (of 6)',
                'Likely recurring', 'Last charged', 'Last amount']].concat(rows);
  sh.getRange(1, 1, out.length, out[0].length).setValues(out);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, out[0].length).setFontWeight('bold');
  sh.getRange(1, 1).setNote('All amounts NZD. Averages over ' + recent[recent.length - 1] + ' to ' + recent[0] +
    ' (full months only). Refunds come off the merchant. Updated ' + new Date());
  return rows;
}

// ---------- recurring charges ----------

/**
 * Charges that recur on a steady pattern: at least two at a similar amount (within 20% of the typical charge) at
 * roughly weekly, fortnightly, monthly, quarterly or yearly intervals, and charged recently enough to still be
 * running. Anything matching MY_SUBSCRIPTIONS that charged in the last 45 days is included even after one charge.
 * vals: Transactions rows (12 columns). Returns [{name, category, kind, typical, perMonth, last, count}].
 */
function recurringCharges_(vals, today, known, reserved) {
  reserved = reserved || new Set();
  const day = 864e5, median = xs => { const s = xs.slice().sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : 0; };
  const kinds = [['weekly', 5, 9, 52 / 12, 14], ['fortnightly', 12, 16, 26 / 12, 20], ['monthly', 25, 35, 1, 40],
                 ['quarterly', 80, 100, 1 / 3, 100], ['yearly', 330, 400, 1 / 12, 380]];
  const groups = {};
  vals.forEach(r => {
    const amt = nzdAmount_(r), cat = String(r[7] || '').trim();
    if (!(amt < 0) || EXCLUDE_FROM_SPEND.includes(cat) || isIncomeCategory_(cat) || reserved.has(String(r[1]).trim().toLowerCase())) return;
    const name = merchantName_(r[3], r[2]);
    (groups[name] = groups[name] || []).push({ date: new Date(r[0]), amt: -amt, cat, text: [r[3], r[2], r[11]].join(' ').toLowerCase() });
  });
  const out = [];
  Object.keys(groups).forEach(name => {
    const all = groups[name].sort((a, b) => a.date - b.date);
    const typical = median(all.map(x => x.amt));
    const steady = all.filter(x => Math.abs(x.amt - typical) <= Math.max(0.2 * typical, 2));
    const last = all[all.length - 1];
    const cats = {};
    all.forEach(x => { cats[x.cat] = (cats[x.cat] || 0) + x.amt; });
    const category = Object.keys(cats).sort((a, b) => cats[b] - cats[a])[0] || '';
    const knownAs = (known || []).find(k => k && all.some(x => x.text.includes(String(k).toLowerCase())));
    const isKnown = !!knownAs;
    let found = null;
    if (steady.length >= 2) {
      const gaps = steady.slice(1).map((x, i) => (x.date - steady[i].date) / day);
      const gap = median(gaps);
      const k = kinds.find(([, lo, hi]) => gap >= lo && gap <= hi);
      if (k && (today - steady[steady.length - 1].date) / day <= k[4]) {
        found = { kind: k[0], perMonth: typical * k[3], last: steady[steady.length - 1] };
      }
    }
    if (!found && isKnown && (today - last.date) / day <= 45) found = { kind: 'monthly?', perMonth: last.amt, last };
    // A known subscription is shown by its listed name ("notely" -> "Notely"), not the bank's.
    const label = knownAs && name !== String(knownAs) && !name.toLowerCase().includes(String(knownAs).toLowerCase())
      ? String(knownAs).replace(/\b\w/g, c => c.toUpperCase()) : name;
    if (found) out.push({ name: label, category, kind: found.kind, typical: Math.round(typical * 100) / 100,
                          perMonth: Math.round(found.perMonth * 100) / 100, last: found.last.date, lastAmt: found.last.amt,
                          count: steady.length, known: isKnown });
  });
  return out.sort((a, b) => b.perMonth - a.perMonth);
}

/**
 * Services from MY_SERVICES, paid per visit or in packs: average per month and visits per month over the last 6 full
 * months. Returned in the same shape as recurringCharges_, as services (not subscriptions).
 */
function regularServices_(vals, today, services) {
  const from = new Date(today.getFullYear(), today.getMonth() - 6, 1), to = new Date(today.getFullYear(), today.getMonth(), 1);
  return (services || []).map(([match, name, category]) => {
    const words = String(match).toLowerCase().split('|').map(w => w.trim()).filter(Boolean);
    const hits = vals.filter(r => {
      const amt = nzdAmount_(r), text = [r[3], r[2], r[11]].join(' ').toLowerCase();
      return amt < 0 && words.some(w => text.includes(w));
    });
    const inWindow = hits.filter(r => new Date(r[0]) >= from && new Date(r[0]) < to);
    if (!hits.length) return null;
    const total = -inWindow.reduce((s, r) => s + nzdAmount_(r), 0);
    const last = hits.reduce((a, r) => new Date(r[0]) > new Date(a[0]) ? r : a);
    return { name, category: category || 'Fitness', kind: Math.round(inWindow.length / 6 * 10) / 10 + ' visits/mo',
             typical: 0, perMonth: Math.round(total / 6 * 100) / 100, last: new Date(last[0]), lastAmt: -nzdAmount_(last),
             count: inWindow.length, known: false, service: true };
  }).filter(x => x && x.perMonth > 0);
}

// Recurring lifestyle: the categories where regular spending is a lifestyle choice rather than a bill or essential.
const LIFESTYLE_CATEGORIES = ['Eating out', 'Fitness', 'Personal care', 'Health', 'Health & self-care', 'Entertainment'];
const isLifestyleCategory_ = c => LIFESTYLE_CATEGORIES.some(x => x.toLowerCase() === String(c).trim().toLowerCase());

/**
 * Your regulars: merchants in lifestyle categories you paid at least twice a month on average over the last 6 full
 * months, averaging at least $20 a month. Same shape as regularServices_.
 */
function lifestyleRegulars_(vals, today, reserved) {
  reserved = reserved || new Set();
  const from = new Date(today.getFullYear(), today.getMonth() - 6, 1), to = new Date(today.getFullYear(), today.getMonth(), 1);
  const by = {};
  vals.forEach(r => {
    const amt = nzdAmount_(r), cat = String(r[7] || '').trim(), date = new Date(r[0]);
    if (!(amt < 0) || !isLifestyleCategory_(cat) || reserved.has(String(r[1]).trim().toLowerCase())) return;
    const name = merchantName_(r[3], r[2]);
    const x = by[name] = by[name] || { visits: 0, total: 0, cats: {}, last: null, lastAmt: 0 };
    if (!x.last || date > x.last) { x.last = date; x.lastAmt = -amt; }
    if (date < from || date >= to) return;
    x.visits++; x.total -= amt; x.cats[cat] = (x.cats[cat] || 0) - amt;
  });
  return Object.keys(by).map(name => {
    const x = by[name], perMonth = x.total / 6;
    if (x.visits < 12 || perMonth < 20) return null;
    return { name, category: Object.keys(x.cats).sort((a, b) => x.cats[b] - x.cats[a])[0], kind: Math.round(x.visits / 6 * 10) / 10 + ' visits/mo',
             typical: 0, perMonth: Math.round(perMonth * 100) / 100, last: x.last, lastAmt: x.lastAmt, count: x.visits,
             known: false, service: true };
  }).filter(Boolean);
}

// ---------- uncategorised ----------

const UNCATEGORISED_DAYS = 90;
const UNCATEGORISED_HEADER_ROW = 3;   // the how-to line sits above it, then a blank row
const UNCATEGORISED_HOW = 'After you categorise, click Finance > Recategorise and refresh.';

/**
 * Uncategorised tab: uncategorised transactions from the last UNCATEGORISED_DAYS days, one row per merchant or payee
 * and direction, biggest first. Pick a My category (and optionally edit Match text or add a Group); the next
 * Recategorise or Sync saves it as a Categories rule. Returns the number of rows.
 */
function buildUncategorised_(ss, reserved) {
  let sh = ss.getSheetByName('Uncategorised');
  if (!sh) sh = ss.insertSheet('Uncategorised', 3);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clearDataValidations().clearNote();
  sh.clear();
  const tx = ss.getSheetByName('Transactions');
  const vals = tx.getLastRow() > 1 ? tx.getRange(2, 1, tx.getLastRow() - 1, 12).getValues() : [];
  const rows = uncategorisedData_(vals, new Date(Date.now() - UNCATEGORISED_DAYS * 864e5), reserved);

  // How to use the tab, at the top: the header row sits under it (UNCATEGORISED_HEADER_ROW).
  const top = UNCATEGORISED_HEADER_ROW, first = top + 1;
  sh.getRange(1, 1).setValue(UNCATEGORISED_HOW);
  sh.getRange(1, 1, 1, 9).merge().setWrap(true).setVerticalAlignment('top').setBackground('#f3f4f6');
  const header = ['Match text (edit if needed)', 'My category (pick one)', 'Group (optional)', 'Money', 'Transactions',
                  'Total (NZD)', 'Last', 'Example', 'Account'];
  sh.getRange(top, 1, 1, header.length).setValues([header]).setFontWeight('bold');
  sh.setFrozenRows(top);
  if (rows.length) {
    sh.getRange(first, 1, rows.length, header.length).setValues(rows.map(r =>
      [r.match, '', '', r.money, r.count, r.total, r.last, r.example, r.accounts]));
    sh.getRange(first, 6, rows.length, 1).setNumberFormat('$#,##0;-$#,##0');
    sh.getRange(first, 7, rows.length, 1).setNumberFormat('d mmm');
    sh.getRange(first, 1, rows.length, 3).setBackground(EDITABLE);   // the columns to fill in
    const cats = Array.from(new Set(loadRules_(ss).rules.map(r => r.cat).concat(DEFAULT_GROUPS.map(g => g[0]),
      ['Ignore', 'Transfer', 'Income']))).filter(Boolean).sort();
    const list = values => SpreadsheetApp.newDataValidation().requireValueInList(values, true).setAllowInvalid(true).build();
    sh.getRange(first, 2, rows.length, 1).setDataValidation(list(cats));
    sh.getRange(first, 3, rows.length, 1).setDataValidation(list(GROUPS));
  } else {
    sh.getRange(first, 1).setValue('Nothing to sort. Everything in the last ' + UNCATEGORISED_DAYS + ' days has a category.');
  }
  sh.setColumnWidth(1, 220);
  sh.setColumnWidth(2, 170);
  sh.setColumnWidth(8, 320);
  return rows.length;
}

/** Rows are Transactions values (12 columns). One entry per merchant and direction; plain data, testable. */
function uncategorisedData_(vals, since, reserved) {
  reserved = reserved || new Set();
  const by = {};
  vals.forEach(r => {
    const cat = String(r[7] || '').trim();
    if (cat && cat !== 'Uncategorised') return;
    const date = new Date(r[0]);
    if (date < since || reserved.has(String(r[1]).trim().toLowerCase())) return;
    const amt = nzdAmount_(r);
    if (!amt) return;
    const money = amt < 0 ? 'out' : 'in';
    const key = merchantName_(r[3], r[2]) + ':' + money;
    const x = by[key] = by[key] || { match: suggestMatch_(r[3], r[2]), money, count: 0, total: 0, last: date,
                                     example: String(r[2] || ''), accounts: new Set() };
    x.count++; x.total += amt; x.accounts.add(r[1]);
    if (date > x.last) { x.last = date; x.example = String(r[2] || ''); }
  });
  return Object.values(by)
    .map(x => Object.assign(x, { total: Math.round(x.total * 100) / 100, accounts: Array.from(x.accounts).join(', ') }))
    .sort((a, b) => Math.abs(b.total) - Math.abs(a.total))
    .slice(0, 60);
}

/** Match text that's guaranteed to appear in the transaction: Akahu's merchant name, or the start of the description. */
function suggestMatch_(merchant, description) {
  if (merchant) return String(merchant).trim().toLowerCase();
  // Leading words of the description up to the first number or "*", until three real words (2+ letters).
  // A short prefix before "*" is a card processor ("SMZ*Corner Cafe"), so use what follows it.
  const parts = String(description || '').toLowerCase().split('*');
  const text = parts.length > 1 && parts[0].trim().length <= 4 ? parts[1] : parts[0];
  const words = text.trim().split(/\s+/);
  while (words.length && /\d/.test(words[0])) words.shift();
  const out = [];
  let real = 0;
  for (const w of words) {
    if (/\d/.test(w) || real === 3) break;
    out.push(w);
    if (/[a-z]{2,}/.test(w)) real++;
  }
  return out.join(' ') || String(description || '').toLowerCase().trim();
}

/** Apply MY_RULE_EDITS (in my-rules.gs) to the Categories tab. Returns how many rows changed. */
function applyRuleEdits_(ss) {
  const edits = typeof MY_RULE_EDITS === 'undefined' ? [] : MY_RULE_EDITS;
  const sh = ss.getSheetByName('Categories');
  if (!edits.length || !sh || sh.getLastRow() < 2) return 0;
  const range = sh.getRange(2, 1, sh.getLastRow() - 1, 2), vals = range.getValues();
  const changed = ruleEdits_(vals, edits);
  if (changed) range.setValues(vals);
  return changed;
}

/** Rewrites matching [match, category] rows in place. Plain data, testable. */
function ruleEdits_(vals, edits) {
  const lower = s => String(s || '').trim().toLowerCase();
  let changed = 0;
  vals.forEach(r => edits.forEach(([match, from, to]) => {
    if (lower(r[0]) === lower(match) && lower(r[1]) === lower(from)) { r[1] = to; changed++; }
  }));
  return changed;
}

/** Turn categories picked on the Uncategorised tab into Categories rules. Returns how many were added. */
function saveSorted_(ss) {
  const sh = ss.getSheetByName('Uncategorised'), cats = ss.getSheetByName('Categories');
  if (!sh || !cats || sh.getLastRow() < 2) return 0;
  const head = uncategorisedHeaderRow_(sh.getRange(1, 1, Math.min(sh.getLastRow(), 5), 1).getValues());
  if (sh.getLastRow() <= head) return 0;
  const existing = new Set((cats.getLastRow() > 1 ? cats.getRange(2, 1, cats.getLastRow() - 1, 2).getValues() : [])
    .map(r => String(r[0]).trim().toLowerCase() + '|' + String(r[1]).trim().toLowerCase()));
  const picked = sh.getRange(head + 1, 1, sh.getLastRow() - head, 4).getValues()
    .filter(r => String(r[0]).trim() && String(r[1]).trim())
    .filter(r => !existing.has(String(r[0]).trim().toLowerCase() + '|' + String(r[1]).trim().toLowerCase()))
    .map(r => [String(r[0]).trim(), String(r[1]).trim(), String(r[2]).trim(), '', r[3] === 'in' || r[3] === 'out' ? r[3] : '']);
  if (picked.length) cats.getRange(cats.getLastRow() + 1, 1, picked.length, 5).setValues(picked);
  return picked.length;
}

/** The Uncategorised header row (1-based), from the first column of its top rows: the one starting "Match text". */
function uncategorisedHeaderRow_(firstColumn) {
  const i = firstColumn.findIndex(r => /^match text/i.test(String(r[0]).trim()));
  return i < 0 ? 1 : i + 1;
}

// ---------- net worth ----------

function holdingCurrencies_(ss) {
  const sh = ss.getSheetByName('Holdings');
  return sh && sh.getLastRow() > 1 ? sh.getRange(2, 4, sh.getLastRow() - 1, 1).getValues().map(r => r[0]).filter(Boolean) : [];
}

/** Live prices for Holdings price symbols, via GOOGLEFINANCE in the FX tab (columns D:E). */
function getPrices_(ss, symbols) {
  const sh = ss.getSheetByName('FX');
  const unique = Array.from(new Set(symbols.filter(Boolean).map(s => String(s).trim())));
  sh.getRange(1, 4, Math.max(sh.getMaxRows(), 1), 2).clearContent();
  sh.getRange(1, 4, 1, 2).setValues([['Price symbol', 'Price']]).setFontWeight('bold');
  if (!unique.length) return {};
  sh.getRange(2, 4, unique.length, 2).setValues(unique.map(s => [s, '=GOOGLEFINANCE("' + s.replace(/"/g, '') + '")']));
  SpreadsheetApp.flush();
  const prices = {};
  sh.getRange(2, 4, unique.length, 2).getValues().forEach(([s, p]) => { if (typeof p === 'number' && p > 0) prices[s] = p; });
  return prices;
}

/**
 * Net worth tab: every synced account plus the Holdings tab, one column per currency (like a hand-kept
 * net worth sheet), then totals converted to NZD. Also records this month's figure in Net worth history.
 */
function buildNetWorth_(ss, rates) {
  const read = name => {
    const t = ss.getSheetByName(name);
    return t && t.getLastRow() > 1 ? t.getRange(2, 1, t.getLastRow() - 1, t.getLastColumn()).getValues() : [];
  };
  const holdings = read('Holdings');
  const prices = getPrices_(ss, holdings.map(h => h[6]));
  const d = netWorthData_(read('Accounts'), holdings, rates, prices, read('Targets'));

  const sh = ss.getSheetByName('Net worth') || ss.insertSheet('Net worth', 2);
  sh.clear();
  sh.setHiddenGridlines(true);
  const { out, cols, totalRow, typeRow, nzdCol, worthRow, types } = netWorthSheet_(d);
  sh.getRange(1, 1, out.length, cols).setValues(out);
  sh.setFrozenRows(1);
  sh.getRange(1, 1, 1, cols).setFontWeight('bold').setBorder(false, false, true, false, false, false);
  sh.getRange(2, 4, out.length - 1, cols - 7).setNumberFormat('$#,##0;-$#,##0');
  sh.getRange(2, cols - 3, out.length - 1, 1).setNumberFormat('0%');
  sh.getRange(2, cols, d.rows.length, 1).setNumberFormat('d mmm yyyy');
  // Manual balances more than about a month old (or never dated) are red: time to update them on Holdings.
  d.rows.forEach((r, i) => {
    const stale = r.source !== 'Synced' && (!(r.updated instanceof Date) || Date.now() - r.updated.getTime() > 35 * 864e5);
    sh.getRange(2 + i, cols - 1, 1, 2).setFontColor(stale ? '#dc2626' : r.source === 'Synced' ? '#6b7280' : null);
  });
  sh.getRange(totalRow, 1, 2, cols).setFontWeight('bold').setBorder(true, false, false, false, false, false);
  sh.getRange(worthRow, 1, 1, cols).setFontWeight('bold').setFontSize(13).setBorder(true, false, false, false, false, false);
  if (out.length > worthRow) sh.getRange(out.length, 1, 1, cols).setFontWeight('bold');
  sh.getRange(typeRow, 1, types, 1).setFontStyle('italic');
  sh.setColumnWidth(3, 240);
  // Two independent workings must agree: the sheet's formulas and the script's own sums. Any gap over $1 is flagged.
  SpreadsheetApp.flush();
  const sheetTotal = sh.getRange(worthRow, nzdCol).getValue();
  const gap = typeof sheetTotal === 'number' ? Math.round((sheetTotal - d.total) * 100) / 100 : null;
  const check = sh.getRange(out.length + 2, 1);
  if (gap === null || Math.abs(gap) > 1) {
    check.setValue('Check failed: the formulas give ' + sheetTotal + ' but the script worked out ' + d.total +
      '. Ask Claude to look into it.').setFontColor('#dc2626').setFontWeight('bold');
  } else {
    check.setValue('Checked: the formulas above match the script\'s own working to the dollar.').setFontColor('#15803d');
  }
  sh.getRange(1, 1).setNote('Synced accounts come from Accounts; Manual ones from Holdings (red when over a month old). Debts count against the total. ' +
    'Currency columns show each account in its own currency. NZD at today\'s rates (FX tab). Updated ' + new Date() +
    (d.missing.length ? '. No rate or price yet for: ' + d.missing.join(', ') : ''));

  // One row per month in Net worth history: this month's row is replaced each time.
  const hist = ss.getSheetByName('Net worth history');
  const month = Utilities.formatDate(new Date(), ss.getSpreadsheetTimeZone(), 'yyyy-MM');
  const typeVal = t => (d.byType.find(x => x[0] === t) || [t, 0])[1];
  const row = [month, new Date(), typeVal('Cash'), typeVal('Investment'), typeVal('Property'), typeVal('Debt'), typeVal('Other'), d.total];
  const months = hist.getLastRow() > 1 ? hist.getRange(2, 1, hist.getLastRow() - 1, 1).getDisplayValues().map(r => r[0]) : [];
  const at = months.indexOf(month);
  const target = at >= 0 ? at + 2 : hist.getLastRow() + 1;
  hist.getRange(target, 1).setNumberFormat('@');   // keep "2026-09" as text, not a date
  hist.getRange(target, 1, 1, row.length).setValues([row]);
  hist.getRange(target, 3, 1, 6).setNumberFormat('$#,##0;-$#,##0');

  // Every account's balance this month, so the Forecast can use each account's own trend.
  const bal = ss.getSheetByName('Balance history');
  const kept = (bal.getLastRow() > 1 ? bal.getRange(2, 1, bal.getLastRow() - 1, 7).getValues() : [])
    .filter(r => monthKey_(r[0]) !== month);
  const fresh = d.rows.map(r => [month, r.account, r.provider, r.type, r.currency, r.value, r.nzd === null ? '' : r.nzd]);
  const all = kept.concat(fresh);
  if (bal.getLastRow() > 1) bal.getRange(2, 1, bal.getLastRow() - 1, 7).clearContent();
  if (all.length) {
    bal.getRange(2, 1, all.length, 1).setNumberFormat('@');
    bal.getRange(2, 1, all.length, 7).setValues(all.map(r => [monthKey_(r[0])].concat(r.slice(1))));
  }
}

/** "2026-09" from a month cell, which Sheets may have turned into a date. */
/**
 * The Net worth tab's cells, as formulas you can click through: each balance links to its row on Accounts or Holdings,
 * NZD values use the FX tab's rate, and totals, type rows and goal progress are sums of the cells above. The script's
 * own numbers (netWorthData_) are only used for the order, types and goals. Plain data, testable.
 */
function netWorthSheet_(d) {
  const cur = d.currencies, n = d.rows.length, last = Math.max(n + 1, 2);
  const L = c => { let s = ''; for (; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + (c - 1) % 26) + s; return s; };
  const nzdCol = 4 + cur.length, nzd = L(nzdCol), goal = L(nzdCol + 1);
  const cols = 3 + cur.length + 6;
  const pad = r => r.concat(Array(cols - r.length).fill(''));
  const rate = c => c === 'NZD' ? '1' : `VLOOKUP("${c}",FX!$A:$B,2,FALSE)`;
  const rowOf = {};
  d.rows.forEach((r, i) => { rowOf[r.account] = i + 2; });
  const balance = r => {
    if (!r.from) return r.value;
    const f = r.from, at = f.tab + '!';
    const raw = f.priced ? `IFERROR(${at}F${f.row}*VLOOKUP(${at}G${f.row},FX!$D:$E,2,FALSE),0)` :
      f.tab === 'Accounts' ? `${at}D${f.row}` : `N(${at}E${f.row})`;
    return '=' + (r.type === 'Debt' ? `-ABS(${raw})` : raw);
  };
  const out = [pad(['Type', 'Provider', 'Account'].concat(cur, ['NZD value', 'Goal (NZD)', 'Progress', 'Goals', 'Source', 'Last updated']))];
  d.rows.forEach((r, i) => {
    const at = i + 2, own = L(4 + cur.indexOf(r.currency)) + at;
    const pool = (r.pool || []).filter(a => rowOf[a]).map(a => nzd + rowOf[a]);
    const progress = r.progress === '' || !pool.length ? '' : `=IFERROR(MIN((${pool.join('+')})/${goal}${at},9.99),"")`;
    out.push(pad([r.type, r.provider, r.account].concat(cur.map(c => c === r.currency ? balance(r) : ''),
      [`=IFERROR(${own}*${rate(r.currency)},"no rate")`, r.goal, progress, r.goals, r.source, r.updated || (r.source === 'Synced' ? '' : 'not set')])));
  });
  const counted = col => `SUMIFS(${col}2:${col}${last},$A$2:$A$${last},"<>Reserved")`;
  out.push(pad([]));
  const totalRow = out.length + 1;
  out.push(pad(['Total', '', 'in each currency'].concat(cur.map((c, j) => '=' + counted(L(4 + j))))));
  out.push(pad(['', '', 'in NZD'].concat(cur.map((c, j) =>
    `=SUMIFS(${nzd}2:${nzd}${last},$A$2:$A$${last},"<>Reserved",${L(4 + j)}2:${L(4 + j)}${last},"<>")`), ['=' + counted(nzd)])));
  out.push(pad([]));
  const typeRow = out.length + 1;
  // KiwiSaver (an Investment with KiwiSaver in its name) is shown on its own: it's locked until a first home or 65.
  const type = t => `$A$2:$A$${last},"${t}"`, nzdRange = `${nzd}2:${nzd}${last}`, ks = `$C$2:$C$${last},"*kiwisaver*"`;
  const hasKs = d.rows.some(r => r.type === 'Investment' && /kiwisaver/i.test(r.account));
  d.byType.forEach(([t]) => {
    const label = t === 'Reserved' ? 'Reserved (not counted)' : t === 'Investment' && hasKs ? 'Investment you can access' : t;
    const sum = t === 'Investment' && hasKs ? `=SUMIFS(${nzdRange},${type(t)},$C$2:$C$${last},"<>*kiwisaver*")` : `=SUMIF(${type(t)},${nzdRange})`;
    out.push(pad([label, '', ''].concat(cur.map(() => ''), [sum])));
    if (t === 'Investment' && hasKs) out.push(pad(['KiwiSaver (locked until a first home or 65)', '', ''].concat(cur.map(() => ''),
      [`=SUMIFS(${nzdRange},${type(t)},${ks})`])));
  });
  const worthRow = out.length + 1;
  out.push(pad(['Net worth', '', 'NZD'].concat(cur.map(() => ''), ['=' + counted(nzd)])));
  if (hasKs) out.push(pad(['Net worth you can access', '', 'without KiwiSaver'].concat(cur.map(() => ''),
    [`=${nzd}${worthRow}-SUMIFS(${nzdRange},${type('Investment')},${ks})`])));
  return { out, cols, totalRow, typeRow, nzdCol, worthRow, types: d.byType.length + (hasKs ? 1 : 0) };
}

function monthKey_(v) {
  return Object.prototype.toString.call(v) === '[object Date]'
    ? v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') : String(v).trim();
}

/** The numbers behind Net worth. Plain data in and out, so it can be tested without a spreadsheet. */
/**
 * A Holdings row with only Type and Account filled in (no Balance, Units or Price symbol) doesn't add an account: it
 * changes the Type of the synced account whose name contains that Account text. Returns [{match, type}].
 */
function typeOverrides_(holdings) {
  return (holdings || [])
    .filter(h => h[0] && h[2] && h[4] === '' && !h[5] && !String(h[6] || '').trim() && !/^example/i.test(String(h[7])))
    .map(h => ({ match: String(h[2]).trim().toLowerCase(),
                 type: WORTH_TYPES.find(t => t.toLowerCase() === String(h[0]).trim().toLowerCase()) || 'Other' }));
}

/** Net worth type for a synced account: a Holdings override if there is one, else from its name and Akahu type. */
function syncedType_(name, type, overrides) {
  const o = (overrides || []).find(x => String(name).toLowerCase().includes(x.match));
  return o ? o.type : worthType_(type, name);
}

function netWorthData_(accounts, holdings, rates, prices, targets) {
  const round = n => Math.round(n * 100) / 100;
  const rows = [], missing = [];
  const overrides = typeOverrides_(holdings);
  // Source says how each balance gets here: Synced (Akahu or Wise, each sync), Manual (you type it on Holdings), or
  // Manual, live price (you keep the units; the price updates itself). Last updated is the sync time or the Holdings date.
  // from: the sheet row the balance comes from (row 2 is the first data row), so the Net worth tab can link to it.
  accounts.forEach((a, i) => { if (a[0] && a[3] !== '') rows.push({
    type: syncedType_(a[0], a[1], overrides), provider: a[8] || '', account: a[0], currency: a[2] || 'NZD', value: Number(a[3]) || 0,
    source: 'Synced', updated: a[6] || '', from: { tab: 'Accounts', row: i + 2 } }); });
  holdings.map((h, i) => [h, i + 2]).filter(([h]) => (h[0] || h[2]) && !/^example/i.test(String(h[7])))
    .filter(([h]) => !overrides.some(o => o.match === String(h[2]).trim().toLowerCase() && h[4] === '' && !h[5]))
    .forEach(([h, row]) => {
    const type = WORTH_TYPES.find(t => t.toLowerCase() === String(h[0]).trim().toLowerCase()) || 'Other';
    const symbol = String(h[6] || '').trim(), units = Number(h[5]);
    let value = Number(h[4]) || 0;
    if (symbol && units) {
      if (prices[symbol] == null) { missing.push(symbol); value = 0; } else value = units * prices[symbol];
    }
    rows.push({ type, provider: h[1], account: h[2], currency: String(h[3] || 'NZD').trim().toUpperCase(), value,
                source: symbol && units ? 'Manual, live price' : 'Manual', updated: h[8] || '',
                from: { tab: 'Holdings', row, priced: !!(symbol && units) } });
  });
  rows.forEach(r => {
    if (r.type === 'Debt') r.value = -Math.abs(r.value);
    r.value = round(r.value);
    r.nzd = rates[r.currency] == null ? null : round(r.value * rates[r.currency]);
    if (r.nzd === null && !missing.includes(r.currency)) missing.push(r.currency);
  });
  // Goals per account from Targets. An account with several savings goals shows their combined amount.
  targets = targets || [];
  const tied = goalBalances_(targets, a => findAccount_(a, rows.map(x => x.account)), () => 0);
  rows.forEach(r => {
    const idx = targets.map((t, i) => i).filter(i => tied[i].accounts.includes(r.account));
    const saving = idx.filter(i => !/debt/i.test(targets[i][1]));
    r.goals = idx.map(i => targets[i][0]).join(', ');
    r.goal = !idx.length ? '' : saving.length ? saving.reduce((s, i) => s + (Number(targets[i][3]) || 0), 0) : 0;
    // A goal spread over several accounts measures progress on all of them together.
    const pool = Array.from(new Set([].concat.apply([r.account], saving.map(i => tied[i].accounts))));
    r.pool = saving.length ? pool : [];
    const held = pool.map(a => (rows.find(x => x.account === a) || {}).nzd);
    r.progress = saving.length && r.goal && held.every(v => v != null) ?
      Math.min(round(held.reduce((a, b) => a + b, 0) / r.goal), 9.99) : '';
  });
  rows.sort((a, b) => WORTH_TYPES.indexOf(a.type) - WORTH_TYPES.indexOf(b.type) ||
    String(a.provider).localeCompare(String(b.provider)) || String(a.account).localeCompare(String(b.account)));

  // Reserved rows are shown but left out of every total.
  const byCurrency = {}, byCurrencyNzd = {};
  rows.forEach(r => { byCurrency[r.currency] = byCurrency[r.currency] || 0; });
  rows.filter(r => r.type !== 'Reserved').forEach(r => {
    byCurrency[r.currency] = round((byCurrency[r.currency] || 0) + r.value);
    byCurrencyNzd[r.currency] = r.nzd === null || byCurrencyNzd[r.currency] === null ? null : round((byCurrencyNzd[r.currency] || 0) + r.nzd);
  });
  const currencies = Object.keys(byCurrency).sort((a, b) => (a === 'NZD' ? -1 : b === 'NZD' ? 1 : (byCurrencyNzd[b] || 0) - (byCurrencyNzd[a] || 0)));
  const byType = WORTH_TYPES.map(t => [t, round(rows.filter(r => r.type === t && r.nzd !== null).reduce((s, r) => s + r.nzd, 0))])
    .filter(([t, v]) => v || rows.some(r => r.type === t));
  const total = round(rows.filter(r => r.type !== 'Reserved').reduce((s, r) => s + (r.nzd || 0), 0));
  return { rows, currencies, byCurrency, byCurrencyNzd, byType, total, missing };
}

// ---------- forecast ----------

/**
 * Forecast tab: when each savings goal or debt payoff is reached at today's pace, and with open savings actions
 * done; this month's spending projected to month-end; planned purchases and the balance they leave in the account
 * they're paid from; net worth over the next 12 months.
 */
function buildForecast_(ss, summary) {
  let sh = ss.getSheetByName('Forecast');
  if (!sh) sh = ss.insertSheet('Forecast', 1);
  sh.getCharts().forEach(c => sh.removeChart(c));
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.showColumns(1, sh.getMaxColumns());
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 200);
  sh.setColumnWidths(2, 12, 100);
  sh.setColumnWidth(1, 260);
  sh.setColumnWidth(2, 220);
  sh.getRange('A1').setValue('Forecast').setFontSize(18).setFontWeight('bold');
  if (!summary) { sh.getRange('A2').setValue('No transactions yet. Run Finance > Sync banking feeds.'); return; }

  const read = name => {
    const t = ss.getSheetByName(name);
    return t && t.getLastRow() > 1 ? t.getRange(2, 1, t.getLastRow() - 1, t.getLastColumn()).getValues() : [];
  };
  const f = forecastData_(summary, read('Accounts'), read('Targets'), read('Savings actions'), read('Net worth history'), new Date(),
                         read('Balance history'));
  const money = '$#,##0;-$#,##0', grey = '#6b7280';
  sh.getRange('A2').setValue('Based on your average over ' + f.basis + '. A goal on an account moves at that account\'s own ' +
    'recent trend, or its Monthly transfer if set. Other goals share your surplus by priority. Open actions add to the ' +
    'surplus. Net worth assumes no investment growth. Edit Targets and Actions to change it.').setFontColor(grey).setWrap(true);
  sh.getRange('A2:I2').merge();
  sh.setRowHeight(2, 36);

  // Four headline figures: column A is wide; B:C, D:E and F:G are merged so each has room.
  [['Typical take-home', f.income, 1, 1], ['Typical spend', f.spend, 2, 2], ['Surplus', f.surplus, 4, 2],
   ['Open actions add', f.actionSaving, 6, 2]].forEach(([label, value, col, width]) => {
    const l = sh.getRange(4, col, 1, width), v = sh.getRange(5, col, 1, width);
    if (width > 1) { l.merge(); v.merge(); }
    l.setValue(label).setFontColor(grey).setFontSize(9);
    v.setValue(value).setNumberFormat('$#,##0"/mo";-$#,##0"/mo"').setFontSize(15).setFontWeight('bold').setHorizontalAlignment('left');
  });

  const table = (row, title, header, rows, formats) => {
    sh.getRange(row, 1).setValue(title).setFontSize(12).setFontWeight('bold');
    sh.getRange(row + 1, 1, 1, header.length).setNumberFormat('@').setValues([header]).setFontColor(grey).setFontSize(9)
      .setBorder(false, false, true, false, false, false, '#d1d5db', null);
    if (rows.length) {
      sh.getRange(row + 2, 1, rows.length, header.length).setValues(rows);
      formats.forEach((fmt, i) => { if (fmt) sh.getRange(row + 2, 1 + i, rows.length, 1).setNumberFormat(fmt); });
    }
    return row + 3 + Math.max(rows.length, 1);
  };
  const statusColor = s => /on track|done|under/i.test(s) ? '#15803d' : /behind|over|not at/i.test(s) ? '#dc2626' : grey;

  // Your goals: what each has, what it gets each month and each pay, and when it's done. Per month is the goal's
  // Monthly transfer if set, else what the plan gives it from the account's own growth or the surplus, by priority.
  const txSh = ss.getSheetByName('Transactions');
  const pay = paySchedule_(txSh && txSh.getLastRow() > 1 ? txSh.getRange(2, 1, txSh.getLastRow() - 1, 12).getValues() : [], new Date());
  const goalsRow = 7;
  let row = table(goalsRow, 'Your goals', ['Goal', 'Accounts', 'Target', 'Saved', 'Left', 'Per month', 'Per pay', 'Pace from',
    'Done by', 'With actions', 'Target date', 'Needs / month', 'Status'],
    f.goals.map(g => [g.name, g.account, g.target, g.saved, g.left,
                      g.perMonth === 'queued' ? 'from ' + Utilities.formatDate(g.startsBy, ss.getSpreadsheetTimeZone(), 'MMM yyyy') : g.perMonth,
                      typeof g.perMonth === 'number' ? Math.round(g.perMonth / pay.perMonth) : '', g.source,
                      g.doneBy || 'not at this pace', g.withActions || 'not at this pace', g.targetDate, g.needs, g.status]),
    ['', '', money, money, money, money, money, '', 'mmm yyyy', 'mmm yyyy', 'mmm yyyy', money, '']);
  if (!f.goals.length) sh.getRange(goalsRow + 2, 1).setValue('No savings goals or debts in Targets yet. Ask Claude to help set some.').setFontColor(grey);
  f.goals.forEach((g, i) => sh.getRange(goalsRow + 2 + i, 13).setFontColor(statusColor(g.status)));
  if (f.goals.length) {
    const sum = row;
    [['Allocated to goals each month', f.allocated], ['Typical surplus', f.surplus], ['Not allocated', Math.round((f.surplus - f.allocated) * 100) / 100]]
      .forEach(([label, v], k) => {
        sh.getRange(sum + k, 1).setValue(label).setFontWeight(k === 2 ? 'bold' : 'normal');
        sh.getRange(sum + k, 6).setValue(v).setNumberFormat(money).setFontWeight(k === 2 ? 'bold' : 'normal');
      });
    sh.getRange(sum + 3, 1).setValue(pay.label + '. "Queued" goals start when the one above them is done. Set a Monthly transfer ' +
      'on Targets to fix an amount yourself.').setFontColor(grey);
    row = sum + 5;
  }

  // Payday plan: the transfers to set up, month by month, from your budget on Targets.
  const accNames = (ss.getSheetByName('Accounts').getLastRow() > 1 ?
    ss.getSheetByName('Accounts').getRange(2, 1, ss.getSheetByName('Accounts').getLastRow() - 1, 1).getValues() : []).map(r => r[0]).filter(Boolean);
  const plan = paydayPlan_(f.budget, f.goalFlows, f.monthNames, accNames, summary.groupOfCat, summary.setAsideRate, pay.account,
                          f.purchaseFlows);
  sh.getRange(row, 1).setValue('Payday plan').setFontSize(12).setFontWeight('bold');
  if (!plan.length) {
    sh.getRange(row + 1, 1).setValue('Set a Monthly savings target on Targets (ask Claude) and this shows what to transfer where each payday.').setFontColor(grey);
    row += 3;
  } else {
    const at = row + 1;
    sh.getRange(at, 1, 1, plan[0].length).setNumberFormat('@').setValues([plan[0]]).setFontColor(grey).setFontSize(9)
      .setBorder(false, false, true, false, false, false, '#d1d5db', null);
    sh.getRange(at + 1, 1, plan.length - 1, plan[0].length).setValues(plan.slice(1));
    sh.getRange(at + 1, 2, plan.length - 1, plan[0].length - 1).setNumberFormat(money);
    sh.getRange(at + 1, 1, 1, plan[0].length).setFontWeight('bold');
    sh.getRange(at + plan.length - 1, 1, 1, plan[0].length).setFontColor(grey);
    sh.getRange(at + plan.length, 1).setValue('Set these up as automatic payments in your banking app, the day after payday. A category\'s ' +
      'account comes from Paid from on Targets (default: Bills group from Bills, the rest from Monthly budget or Everyday).').setFontColor(grey);
    row = at + plan.length + 2;
  }

  // Month by month, left to right: what goes into each goal's account and the balance it grows to.
  if (f.goalGrid.length) {
    const g = f.goalGrid, at = row + 1;
    sh.getRange(row, 1).setValue('Month by month').setFontSize(12).setFontWeight('bold');
    sh.getRange(at, 1, 1, g[0].length).setNumberFormat('@').setValues([g[0]]).setFontColor(grey).setFontSize(9)
      .setBorder(false, false, true, false, false, false, '#d1d5db', null);
    sh.getRange(at + 1, 1, g.length - 1, g[0].length).setValues(g.slice(1)).setFontSize(10);
    sh.getRange(at + 1, 2, g.length - 1, g[0].length - 1).setNumberFormat(money);
    g.slice(1).forEach((r, k) => {
      const line = sh.getRange(at + 1 + k, 1, 1, g[0].length);
      if (/: (into|paid off)/.test(r[0])) line.offset(0, 1, 1, g[0].length - 1).setNumberFormat('+$#,##0;-$#,##0;-').setFontColor('#15803d');
      if (/ (balance|still owed)$/.test(r[0])) line.setFontWeight('bold');
      if (k === 0 || k === g.length - 2) line.setFontColor(grey);
    });
    row = at + g.length + 1;
  }

  const monthRow = row;
  row = table(row, 'This month so far (' + f.dayOfMonth + ' of ' + f.daysInMonth + ' days)',
    ['', 'Spent so far', 'On pace for', 'Compare to', 'Status'],
    f.thisMonth.map(r => [r.name, r.soFar, r.pace, r.compare, r.status]), ['', money, money, money, '']);
  f.thisMonth.forEach((r, i) => sh.getRange(monthRow + 2 + i, 5).setFontColor(statusColor(r.status)));

  // Planned purchases (Kind "Planned purchase" on Targets): what each leaves in its account, and the balance after.
  const planRow = row;
  row = table(row, 'Planned purchases', ['Purchase', 'Paid from', 'Cost', 'When', 'Balance then', 'Left after',
    'Lowest in 12 mo', 'Earn back (mo)', 'Status'],
    f.purchases.map(p => [p.name, p.account, p.cost, p.when, p.before, p.after, p.lowest, p.earnBack || 'not at this pace', p.status]),
    ['', '', money, 'mmm yyyy', money, money, money, '0', '']);
  if (!f.purchases.length) sh.getRange(planRow + 2, 1).setValue('Add one on Targets: Kind "Planned purchase", Applies to = the ' +
    'account it\'s paid from, Target amount = cost, Target date = when.').setFontColor(grey);
  f.purchases.forEach((p, i) => sh.getRange(planRow + 2 + i, 9).setFontColor(/^covered/i.test(p.status) ? '#15803d' : '#dc2626'));

  // Chart data sits in hidden columns from T on.
  const at = 20;
  let chartCol = 0;
  const chart = (data, title, colors, dashed) => {
    const need = at + chartCol + data[0].length - 1;
    if (sh.getMaxColumns() < need) sh.insertColumnsAfter(sh.getMaxColumns(), need - sh.getMaxColumns());
    sh.getRange(1, at + chartCol, data.length, 1).setNumberFormat('@');
    sh.getRange(1, at + chartCol, data.length, data[0].length).setValues(data);
    const series = {};
    (dashed || []).forEach(i => { series[i] = { lineDashStyle: [4, 4] }; });
    sh.insertChart(sh.newChart().asLineChart().addRange(sh.getRange(1, at + chartCol, data.length, data[0].length)).setNumHeaders(1)
      .setHiddenDimensionStrategy(Charts.ChartHiddenDimensionStrategy.SHOW_BOTH).setPosition(row + 1, 1, 0, 0)
      .setOption('title', title).setOption('width', 720).setOption('height', 300).setOption('series', series)
      .setOption('colors', colors).setOption('legend', { position: 'bottom' })
      .setOption('vAxis', { format: '$#,##0' }).build());
    chartCol += data[0].length + 1;
    row += 16;
  };
  if (f.planChart.length) {
    const n = (f.planChart[0].length - 1) / 2, palette = ['#2a9d8f', '#e76f51', '#264653', '#e9c46a'];
    const colors = palette.slice(0, n).concat(palette.slice(0, n));
    chart(f.planChart, 'Paying accounts with your planned purchases, next 12 months (dashed: without them)', colors,
      Array.from({ length: n }, (_, i) => n + i));
  }
  if (f.goalMonths.length) chart(f.goalMonths.map(r => r.slice(0, -1)), 'Your goals, next 12 months',
    ['#2a9d8f', '#e76f51', '#264653', '#e9c46a', '#f4a261', '#8ab17d']);
  if (f.netWorth.length > 1) chart(f.netWorth, 'Net worth, next 12 months', ['#9ca3af', '#2a9d8f', '#e76f51']);
  if (chartCol) sh.hideColumns(at, sh.getMaxColumns() - at + 1);
  return f;
}

/**
 * How often you're paid, from the last three full months of income: big income payments (over 20% of that month's
 * income) per month, and the usual day. Rows are Transactions values. Returns {perMonth, label}; monthly if unclear.
 */
function paySchedule_(vals, today) {
  const key = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  const months = [1, 2, 3].map(k => key(new Date(today.getFullYear(), today.getMonth() - k, 1)));
  const byMonth = {};
  vals.forEach(r => {
    const d = r[0] instanceof Date ? r[0] : new Date(r[0]), amt = Number(r[10]);
    if (isNaN(d) || !(amt > 0) || !isIncomeCategory_(r[7]) || !months.includes(key(d))) return;
    (byMonth[key(d)] = byMonth[key(d)] || []).push({ amt, day: d.getDate(), account: r[1] });
  });
  const counts = [], days = [], into = {};
  months.forEach(m => {
    const list = byMonth[m] || [], total = list.reduce((s, x) => s + x.amt, 0);
    const pays = list.filter(x => x.amt > total * 0.2);
    if (pays.length) { counts.push(pays.length); pays.forEach(x => { days.push(x.day); into[x.account] = (into[x.account] || 0) + x.amt; }); }
  });
  if (!counts.length) return { perMonth: 1, account: 'your pay account', label: 'Per pay assumes you\'re paid monthly' };
  const account = Object.keys(into).sort((a, b) => into[b] - into[a])[0] || 'your pay account';
  const perMonth = Math.max(Math.round(counts.reduce((a, b) => a + b, 0) / counts.length), 1);
  const sorted = days.sort((a, b) => a - b), mid = sorted[Math.floor(sorted.length / 2)];
  const nth = n => n + (n % 10 === 1 && n !== 11 ? 'st' : n % 10 === 2 && n !== 12 ? 'nd' : n % 10 === 3 && n !== 13 ? 'rd' : 'th');
  const label = perMonth === 1 ? 'You\'re paid monthly, around the ' + nth(mid) + ', so per pay is the same as per month'
    : perMonth === 2 ? 'You\'re paid about twice a month' : 'You\'re paid about ' + perMonth + ' times a month';
  return { perMonth, label, account };
}

/**
 * Your monthly budget, savings first: take-home (an Income target on Targets, or typical take-home), less the Monthly
 * savings target, is the spending budget; Spending limit rows give each category its part, and the rest is unassigned.
 * Returns null when there's no Monthly savings row. Plain data, testable.
 */
function budget_(targets, typicalIncome) {
  const live = (targets || []).filter(t => t[0] && !/^example/i.test(String(t[8])));
  const kind = k => live.filter(t => String(t[1]).trim().toLowerCase() === k);
  const saving = kind('monthly savings')[0];
  if (!saving) return null;
  const incomeRow = kind('income target')[0];
  const income = incomeRow && Number(incomeRow[3]) ? Number(incomeRow[3]) : typicalIncome || 0;
  const savings = Number(saving[3]) || 0, spending = income - savings;
  const byCat = {}, from = {}, names = {};   // from: the account a category is paid from (Paid from, col 11); names: as typed
  kind('spending limit').forEach(t => {
    const c = String(t[2]).trim().toLowerCase();
    if (!c) return;
    byCat[c] = (byCat[c] || 0) + (Number(t[3]) || 0);
    names[c] = String(t[2]).trim();
    if (String(t[10] || '').trim()) from[c] = String(t[10]).trim();
  });
  const assigned = Object.keys(byCat).reduce((s, c) => s + byCat[c], 0);
  const r = n => Math.round(n * 100) / 100;
  return { income: r(income), savings: r(savings), spending: r(spending), byCat, from, names, unassigned: r(spending - assigned) };
}

/**
 * Payday plan: what to move where each payday, months left to right. Pay lands in one account; tax goes to the
 * Reserved accounts at your set-aside rate; each goal's share of the savings goes to its account (this changes as goals
 * finish); each budgeted category's amount goes to the account it's paid from; the rest stays where pay lands.
 * Paid from defaults: Bills group from an account named "bills", everything else from one named "monthly" or "budget"
 * if you have one, else "everyday". Pass the Forecast's goalFlows and monthNames. Plain data, testable.
 */
function paydayPlan_(budget, goalFlows, monthNames, accountNames, groupOfCat, taxRate, payAccount, purchaseFlows) {
  if (!budget) return [];
  const r = n => Math.round(n * 100) / 100, low = s => String(s || '').toLowerCase();
  const find = word => accountNames.find(a => low(a).includes(word)) || '';
  const spendAcct = find('monthly') || find('budget') || find('everyday') || 'your spending account';
  const billsAcct = find('bills') || spendAcct;
  const groupLow = {};
  Object.keys(groupOfCat || {}).forEach(c => { groupLow[low(c)] = groupOfCat[c]; });
  const rate = taxRate > 0 && taxRate < 1 ? taxRate : 0;
  const gross = rate ? budget.income / (1 - rate) : budget.income, tax = gross - budget.income;
  const taxAccts = accountNames.filter(a => RESERVED_NAME.test(a)).join(' + ') || 'your tax account';
  const n = monthNames.length, rows = [];
  rows.push(['Pay lands in ' + payAccount].concat(monthNames.map(() => r(gross))));
  if (tax) rows.push(['To ' + taxAccts + ' (tax, ' + Math.round(rate * 100) + '%)'].concat(monthNames.map(() => r(tax))));
  // Savings: each goal's money, grouped by the account it goes into.
  const goalTo = {};
  goalFlows.filter(g => !g.debt && !g.own).forEach(g => {   // KiwiSaver goals fill themselves
    const key = g.into || 'savings';
    goalTo[key] = goalTo[key] || { names: [], paid: Array(n).fill(0) };
    goalTo[key].names.push(g.name);
    g.paid.slice(0, n).forEach((v, k) => { goalTo[key].paid[k] += v; });
  });
  Object.keys(goalTo).forEach(a => rows.push(['To ' + a + ' (' + goalTo[a].names.join(', ') + ')'].concat(goalTo[a].paid.map(r))));
  // Planned purchases: each one's set-aside until its date, grouped by the account that pays for it.
  const buyTo = {};
  (purchaseFlows || []).forEach(p => {
    buyTo[p.into] = buyTo[p.into] || { names: [], paid: Array(n).fill(0) };
    buyTo[p.into].names.push(p.name);
    p.paid.slice(0, n).forEach((v, k) => { buyTo[p.into].paid[k] += v; });
  });
  Object.keys(buyTo).forEach(a => rows.push(['To ' + a + ' (set aside for ' + buyTo[a].names.join(', ') + ')'].concat(buyTo[a].paid.map(r))));
  // Spending: each category's budget, grouped by the account it's paid from.
  const spendTo = {};
  Object.keys(budget.byCat).forEach(c => {
    const acct = budget.from[c] ? (find(low(budget.from[c])) || budget.from[c]) : groupLow[c] === 'Bills' ? billsAcct : spendAcct;
    spendTo[acct] = spendTo[acct] || { cats: [], amt: 0 };
    spendTo[acct].cats.push(c); spendTo[acct].amt += budget.byCat[c];
  });
  Object.keys(spendTo).sort((a, b) => spendTo[b].amt - spendTo[a].amt).forEach(a => {
    const cats = spendTo[a].cats.map(c => (budget.names || {})[c] || c.charAt(0).toUpperCase() + c.slice(1));
    rows.push(['To ' + a + ' (' + (cats.length > 3 ? cats.slice(0, 3).join(', ') + ' and ' + (cats.length - 3) + ' more' : cats.join(', ')) + ')']
      .concat(monthNames.map(() => r(spendTo[a].amt))));
  });
  // What's left stays put: unassigned spending budget, plus any savings no goal needs that month.
  const out = k => rows.slice(1).reduce((s, row) => s + row[1 + k], 0);
  rows.push(['Stays in ' + payAccount + ' (buffer)'].concat(monthNames.map((m, k) => r(gross - out(k)))));
  return [[''].concat(monthNames)].concat(rows);
}

/**
 * Planned purchases, soonest first ({name, account, cost, month}: month is months from now, 0 = this month): what the
 * paying account covers today in that order, and for the rest, a set-aside per payday from now until the month before
 * it (at least one). balanceOf(account) -> its balance now. Plain data, testable.
 */
function purchaseSetAsides_(plans, balanceOf) {
  const left = {};
  return plans.map(p => {
    if (left[p.account] == null) left[p.account] = balanceOf(p.account) || 0;
    const covered = Math.min(Math.max(left[p.account], 0), p.cost);
    left[p.account] -= p.cost;
    const short = p.cost - covered, months = Math.max(p.month - 1, 1);
    return { name: p.name, account: p.account, cost: p.cost, covered, short, months, perMonth: short ? short / months : 0 };
  });
}

/**
 * Net money in or out of each account per month, from Transactions (every row, transfers included): how much each
 * savings account actually received. Returns {account: {'2026-09': amount}}. Plain data, testable.
 */
function accountFlows_(vals) {
  const out = {};
  vals.forEach(r => {
    const amt = nzdAmount_(r);
    if (amt === null || !r[1]) return;
    const m = monthKey_(r[0]);
    const a = (out[r[1]] = out[r[1]] || {});
    a[m] = (a[m] || 0) + amt;
  });
  return out;
}

/** The tab was called "To do"; keep it, with its place, under the new name. */
function renameTodoTab_(ss) {
  const old = ss.getSheetByName('To do');
  if (old && !ss.getSheetByName(TODO_TAB)) old.setName(TODO_TAB);
}

/**
 * Transfers To Do tab: what to move where for the latest invoice, in order, ticked off as the money arrives; one-off
 * transfers (added by Claude, kept across refreshes, Status is yours); and the routine around it. Rebuilt on every
 * refresh.
 */
function buildToDo_(ss, d, tz) {
  renameTodoTab_(ss);
  let sh = ss.getSheetByName(TODO_TAB);
  if (!sh) sh = ss.insertSheet(TODO_TAB, 1);
  const oneOffs = keptTransfers_(sh.getLastRow() ? sh.getRange(1, 1, sh.getLastRow(), 5).getValues() : []);
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart().clearDataValidations();
  sh.clear();
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 30); sh.setColumnWidth(2, 340); sh.setColumnWidth(3, 120); sh.setColumnWidth(4, 170); sh.setColumnWidth(5, 260);
  const grey = '#6b7280', money = '$#,##0;-$#,##0';
  sh.getRange('A1').setValue(TODO_TAB).setFontSize(18).setFontWeight('bold');
  let row = 3;
  const inv = d.invoice;
  sh.getRange(row, 1).setValue('Money in ' + (inv ? inv.account : 'Invoices') + ': what to move').setFontSize(12).setFontWeight('bold');
  if (inv && inv.empty) {
    sh.getRange(row + 1, 2).setValue(inv.account + ' is empty: all $' + Math.round(inv.amount).toLocaleString('en-NZ') +
      ' from the ' + Utilities.formatDate(new Date(inv.date), tz, 'd MMM yyyy') + ' payment has been moved. Where it went:').setFontColor('#15803d');
    if (inv.lines.length) {
      sh.getRange(row + 2, 1, 1, 5).setValues([['', 'To', 'Amount', 'Status', '']]).setFontColor(grey).setFontSize(9)
        .setBorder(false, false, true, false, false, false, '#d1d5db', null);
      sh.getRange(row + 3, 1, inv.lines.length, 5).setValues(inv.lines.map(l => ['', l[1], l[2], l[3], '']));
      sh.getRange(row + 3, 3, inv.lines.length, 1).setNumberFormat(money);
      sh.getRange(row + 3, 4, inv.lines.length, 1).setFontColor('#15803d').setFontWeight('bold');
    }
    row += 5 + inv.lines.length;
  } else if (!inv) {
    sh.getRange(row + 1, 2).setValue('No invoice paid in the last 60 days. Set a budget and Set-aside rates on Targets (ask Claude) and the next one shows here.')
      .setFontColor(grey);
    row += 3;
  } else {
    sh.getRange(row + 1, 2).setValue('$' + Math.round(inv.amount).toLocaleString('en-NZ') + ' to allocate: what\'s in ' + inv.account +
      ' (latest payment ' + Utilities.formatDate(new Date(inv.date), tz, 'd MMM yyyy') + ' from ' + inv.payer + '). Move these from ' +
      inv.account + ' in order; after the next sync each line ticks off.')
      .setFontColor(grey).setWrap(true);
    sh.getRange(row + 1, 2, 1, 4).merge();
    sh.setRowHeight(row + 1, 36);
    const lines = inv.lines.map((l, i) => [i + 1, l[0], l[2], l[3], l[1]])
      .concat(Math.abs(inv.buffer) < 1 ? [['', 'Left in ' + inv.account, 0, '', inv.account]]
        : [['', inv.buffer > 0 ? 'Stays in ' + inv.account : 'Short by', inv.buffer, '', inv.account]]);
    sh.getRange(row + 2, 1, 1, 5).setValues([['#', 'Move', 'Amount', 'Status', 'To']]).setFontColor(grey).setFontSize(9)
      .setBorder(false, false, true, false, false, false, '#d1d5db', null);
    sh.getRange(row + 3, 1, lines.length, 5).setValues(lines);
    sh.getRange(row + 3, 3, lines.length, 1).setNumberFormat(money);
    inv.lines.forEach((l, i) => sh.getRange(row + 3 + i, 4).setFontColor(l[3] === 'Done' ? '#15803d' : l[3] === 'To do' ? '#dc2626' : '#b45309').setFontWeight('bold'));
    const last = row + 3 + lines.length - 1;
    sh.getRange(last, 2, 1, 3).setFontWeight('bold').setBorder(true, false, false, false, false, false, '#9ca3af', null);
    if (inv.buffer < 0) sh.getRange(last, 3).setFontColor('#dc2626');
    row = last + 3;
  }
  // One-off transfers: moves outside the payday split (Claude adds them). Status is yours; Done rows stay until deleted.
  sh.getRange(row, 1).setValue(ONE_OFF_TITLE).setFontSize(12).setFontWeight('bold');
  if (oneOffs.length) {
    sh.getRange(row + 1, 1, 1, 5).setValues([['', 'Transfer', 'Amount', 'Status', 'Why']]).setFontColor(grey).setFontSize(9)
      .setBorder(false, false, true, false, false, false, '#d1d5db', null);
    sh.getRange(row + 2, 1, oneOffs.length, 5).setValues(oneOffs.map(o => [''].concat(o)));
    sh.getRange(row + 2, 3, oneOffs.length, 1).setNumberFormat(money);
    sh.getRange(row + 2, 5, oneOffs.length, 1).setWrap(true).setFontColor(grey);
    sh.getRange(row + 2, 4, oneOffs.length, 1).setBackground(EDITABLE).setFontWeight('bold')
      .setDataValidation(SpreadsheetApp.newDataValidation().requireValueInList(['To do', 'Done'], true).setAllowInvalid(true).build());
    oneOffs.forEach((o, i) => sh.getRange(row + 2 + i, 4).setFontColor(/^done$/i.test(o[2]) ? '#15803d' : '#dc2626'));
    sh.getRange(row + 2, 1, oneOffs.length, 5).setVerticalAlignment('top');
    row += 4 + oneOffs.length;
  } else {
    sh.getRange(row + 1, 2).setValue('None right now. Moves outside payday (ask Claude) show here; set Status to Done once made.').setFontColor(grey);
    row += 3;
  }
  // The routine around it.
  const weekly = (d.targets.find(t => /\(weekly\)$/.test(String(t.name))) || {}).aim;
  const steps = [
    ['When an invoice is paid', 'Nothing to do: it waits in Invoices and funds next month. (Optional: move the GST and tax lines now.)'],
    ['The 1st of the month', 'Finance > Payday: what to move. It syncs and works out the split of everything in Invoices. Make each transfer in your banking app, in order: GST, tax, bills, spending, savings, then what\'s left over to / Savings, so Invoices ends at $0. Run Payday again: each line turns Done. Then ask Claude for the monthly review.'],
    ['Every Monday (automatic)', weekly ? 'An automatic payment moves $' + Math.round(weekly) + ' from Monthly to Everyday. Spend only from Everyday; if it runs low, that is the week\'s signal.'
                                        : 'An automatic payment moves your weekly spending money to Everyday. Spend only from Everyday.'],
    ['Anything new', 'A purchase, a trip, a goal or a question for your accountant: tell Claude, and it goes on Targets or Notes.']
  ];
  sh.getRange(row, 1).setValue('Your routine').setFontSize(12).setFontWeight('bold');
  sh.getRange(row + 1, 2, steps.length, 2).setValues(steps.map(x => [x[0], x[1]]));
  steps.forEach((x, i) => { sh.getRange(row + 1 + i, 3, 1, 3).merge(); });
  sh.getRange(row + 1, 2, steps.length, 1).setFontWeight('bold').setVerticalAlignment('top');
  sh.getRange(row + 1, 3, steps.length, 1).setWrap(true).setVerticalAlignment('top');
}

const ONE_OFF_TITLE = 'One-off transfers';

/**
 * The one-off transfers already on the tab, from its values (columns A to E): the rows between the One-off transfers
 * title and the next section, as [transfer, amount, status, why]. A row with no Transfer is dropped. Plain data, testable.
 */
function keptTransfers_(values) {
  const start = values.findIndex(r => String(r[0]).trim() === ONE_OFF_TITLE);
  if (start < 0) return [];
  const out = [];
  for (let i = start + 1; i < values.length; i++) {
    const r = values[i];
    if (String(r[0]).trim() && !/^\d+$/.test(String(r[0]).trim())) break;   // the next section's title
    const what = String(r[1]).trim();
    if (!what || what === 'Transfer' || /^None right now/.test(what)) continue;
    out.push([what, r[2], String(r[3]).trim() || 'To do', r[4]]);
  }
  return out;
}

/**
 * What to move where for the latest income payment (an invoice), in the order to do it: GST and income tax (Kind
 * "Set-aside rate" on Targets: Applies to is the account, Target amount the rate; GST is taken as the GST inside a
 * GST-inclusive payment, tax as a share of what's left), then bills and spending (the budget accounts), then savings
 * by goal share and planned-purchase set-asides, and the rest stays as the buffer. Each line says whether money that
 * size has arrived in that account since the payment. With no rate rows, one line moves your usual tax-and-GST rate.
 * tx: Transactions rows. Plain data, testable.
 */
function invoiceSplit_(tx, targets, accounts, bud, budgetLines, setAsideRate, today) {
  const r2 = n => Math.round(n * 100) / 100, day = d => new Date(d).toISOString().slice(0, 10);
  const now = today || new Date(), cutoff = new Date(now.getTime() - 60 * 864e5);
  const pays = tx.filter(r => isIncomeCategory_(r[7]) && (nzdAmount_(r) || 0) > 500 && new Date(r[0]) >= cutoff)
    .sort((a, b) => new Date(b[0]) - new Date(a[0]));
  if (!pays.length) return null;
  // Everything in the account pay lands in gets allocated, however many payments that is: its balance now, plus what
  // has already been moved out of it since the latest payment (so a half-done split still adds up).
  const inv = pays[0], since = day(inv[0]);
  const names = accounts.map(a => a[0]);
  const payBalance = Number((accounts.find(a => a[0] === inv[1]) || [])[5]) || 0;
  const movedOut = tx.filter(r => r[1] === inv[1] && (nzdAmount_(r) || 0) < 0 && day(r[0]) >= since && String(r[7]).trim() === 'Transfer')
    .reduce((s, r) => s - nzdAmount_(r), 0);
  const amount = Math.max(payBalance + movedOut, 0);
  // Once the pay account is empty the job is done: show where the money actually went, not a fresh plan from
  // today's balances (which have moved on since).
  if (payBalance < 1) {
    const went = {};
    tx.filter(r => r[1] === inv[1] && (nzdAmount_(r) || 0) < 0 && day(r[0]) >= since).forEach(r => {
      const to = String(r[3] || r[2] || '').replace(/\s+INTERNET XFR.*$/i, '').trim() || 'other';
      went[to] = (went[to] || 0) - nzdAmount_(r);
    });
    return { date: inv[0], amount: r2(movedOut), account: inv[1], payer: inv[3] || inv[2], empty: true, buffer: 0,
             lines: Object.keys(went).map(to => ['Moved', to, r2(went[to]), 'Done']) };
  }
  const live = targets.filter(t => t[0] && !/^example/i.test(String(t[8])));
  const lines = [];
  // 1. Tax and GST
  const rates = live.filter(t => /^set-aside rate$/i.test(String(t[1]).trim()))
    .map(t => ({ name: t[0], acct: findAccount_(t[2], names) || String(t[2]), rate: shareOf_(t[3]), gst: /gst/i.test(t[0] + ' ' + t[2]) }));
  let left = amount;
  if (rates.length) {
    const gst = rates.filter(x => x.gst).reduce((s, x) => s + amount * x.rate / (1 + x.rate), 0);
    rates.filter(x => x.gst).forEach(x => lines.push({ what: x.name, to: x.acct, amt: amount * x.rate / (1 + x.rate) }));
    rates.filter(x => !x.gst).forEach(x => lines.push({ what: x.name + ' (' + Math.round(x.rate * 100) + '% after GST)', to: x.acct, amt: (amount - gst) * x.rate }));
  } else if (setAsideRate) {
    lines.push({ what: 'Tax and GST (' + Math.round(setAsideRate * 100) + '%)', to: names.filter(n => RESERVED_NAME.test(n)).join(' + '), amt: amount * setAsideRate });
  }
  // 2. Bills and spending, 3. savings by goal share, 4. purchase set-asides
  // Budget accounts are topped up, not refilled: this month's amount, less what's already been paid from the account
  // this month in its categories, less what's already in it. Whatever isn't needed falls through to Left over.
  const hasMonthly = budgetLines.some(b => /monthly|budget/i.test(b.a));
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const balOf = a => Number((accounts.find(x => x[0] === a) || [])[5]) || 0;
  budgetLines.forEach(b => {
    const cats = (b.cats || []).map(c => String(c).toLowerCase());
    const paid = tx.filter(r => r[1] === b.a && new Date(r[0]) >= monthStart && cats.includes(String(r[7]).trim().toLowerCase()))
      .reduce((s, r) => s - (nzdAmount_(r) || 0), 0);
    // What's in the account now already counts, but not money that has arrived from this payment (that's this move).
    const fromThis = tx.filter(r => r[1] === b.a && day(r[0]) >= since && String(r[7]).trim() === 'Transfer' && (nzdAmount_(r) || 0) > 0 &&
      tx.some(o => o[1] === inv[1] && Math.abs((nzdAmount_(o) || 0) + nzdAmount_(r)) < 0.01 && Math.abs(new Date(o[0]) - new Date(r[0])) <= 3 * 864e5))
      .reduce((s, r) => s + nzdAmount_(r), 0);
    const there = balOf(b.a) - fromThis, need = Math.max(b.amt - Math.max(paid, 0) - Math.max(there, 0), 0);
    const kind = /bills/i.test(b.a) ? 'Bills' : /everyday/i.test(b.a) && hasMonthly ? 'Automatic payments' : 'Spending';
    lines.push({ what: kind + ' top-up ($' + Math.round(b.amt) + ' budget' + (paid > 0.5 ? ', $' + Math.round(paid) + ' paid' : '') +
                 (there > 0.5 ? ', $' + Math.round(there) + ' there' : '') + ')', to: b.a, amt: need });
  });
  const goals = live.filter(t => isGoalKind_(t[1]) && !/debt/i.test(t[1]) && shareOf_(t[9]));
  goals.forEach(t => {
    const a = findAccount_(goalAccounts_(t[2])[0], names);
    if (a) lines.push({ what: 'Savings: ' + t[0], to: a, amt: bud.savings * shareOf_(t[9]) });
  });
  const isDate = v => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
  const until = d => (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
  const plans = live.filter(t => isPlanKind_(t[1]))
    .map(t => ({ name: t[0], account: findAccount_(t[2], names), cost: Number(t[3]) || 0, month: isDate(t[4]) ? Math.max(until(t[4]), 0) : 0 }))
    .filter(p => p.account).sort((a, b) => a.month - b.month);
  purchaseSetAsides_(plans, a => Number((accounts.find(x => x[0] === a) || [])[5]) || 0)
    .filter(p => p.short > 0).forEach(p => lines.push({ what: 'Set aside: ' + p.name, to: p.account, amt: p.perMonth }));
  // What has already arrived in each account since the payment (shared out in line order).
  const arrived = {};
  // Only money that came out of the account the payment landed in counts: a transfer in, matched by the same amount
  // going out of that account within 3 days. Top-ups from other accounts (say / Savings to / Bills) don't.
  const outOfPay = tx.filter(r => r[1] === inv[1] && (nzdAmount_(r) || 0) < 0 && day(r[0]) >= since);
  const used = new Set();
  tx.forEach(r => {
    const v = nzdAmount_(r);
    if (!(v > 0) || !r[1] || r[1] === inv[1] || day(r[0]) < since || String(r[7]).trim() !== 'Transfer') return;
    const match = outOfPay.find(o => !used.has(o) && Math.abs(-nzdAmount_(o) - v) < 0.01 &&
                                     Math.abs(new Date(o[0]) - new Date(r[0])) <= 3 * 864e5);
    if (!match) return;
    used.add(match);
    arrived[r[1]] = (arrived[r[1]] || 0) + v;
  });
  // 5. Whatever is left goes to your general savings account ("/ Savings", or the first savings account without a
  // goal), so nothing stays where pay lands.
  const goalAccts = new Set(live.filter(t => isGoalKind_(t[1])).map(t => findAccount_(goalAccounts_(t[2])[0], names)).filter(Boolean));
  const leftoverTo = names.find(n => String(n).replace(/^[\/#]\s*/, '').trim().toLowerCase() === 'savings') ||
    names.find(n => /savings/i.test(n) && !goalAccts.has(n) && !RESERVED_NAME.test(n)) || '';
  const before = lines.reduce((s, l) => s + r2(l.amt), 0);
  if (leftoverTo && amount - before > 0) lines.push({ what: 'Left over', to: leftoverTo, amt: amount - before });
  // One transfer per account: lines going to the same account are combined, at the first one's place.
  const merged = [];
  lines.forEach(l => {
    const same = merged.find(m => m.to === l.to);
    if (same) { same.amt += l.amt; same.what += ' + ' + l.what.charAt(0).toLowerCase() + l.what.slice(1); }
    else merged.push(Object.assign({}, l));
  });
  const out = merged.map(l => {
    const amt = r2(l.amt), got = Math.min(arrived[l.to] || 0, amt);
    if (arrived[l.to]) arrived[l.to] -= got;
    left -= amt;
    return [l.what, l.to, amt, amt < 1 ? 'Nothing needed' : got >= amt - 1 ? 'Done' : got > 0 ? 'Moved ' + Math.round(got) + ' of ' + Math.round(amt) : 'To do'];
  });
  return { date: inv[0], amount: r2(amount), account: inv[1], payer: inv[3] || inv[2], lines: out, buffer: r2(left), leftoverTo };
}

/**
 * Dashboard headline tiles from netWorthData_: Net worth, Cash, Invested (investments other than KiwiSaver), KiwiSaver,
 * Debt, Owed to you, and Set aside for tax (Reserved: shown, but not in net worth, as on Net worth). Plain data, testable.
 */
function worthTiles_(nw) {
  const sum = test => Math.round(nw.rows.filter(r => r.nzd !== null && test(r)).reduce((s, r) => s + r.nzd, 0) * 100) / 100;
  const ks = r => /kiwisaver/i.test(r.account);
  const money = '$#,##0;-$#,##0';
  return [['Net worth', nw.total, money], ['Cash', sum(r => r.type === 'Cash'), money],
          ['Invested', sum(r => r.type === 'Investment' && !ks(r)), money], ['KiwiSaver', sum(r => r.type === 'Investment' && ks(r)), money],
          ['Debt', sum(r => r.type === 'Debt'), money], ['Owed to you', sum(r => r.type === 'Owed to you'), money],
          ['Set aside for tax (not counted)', sum(r => r.type === 'Reserved'), money]];
}

/** The numbers behind Forecast. Plain data in and out, so it can be tested without a spreadsheet. */
function forecastData_(summary, accounts, targets, actions, history, today, balances) {
  const { months, income, totals, spend } = summary;
  const round = n => Math.round((n || 0) * 100) / 100;
  const avg = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;
  const lower = s => String(s || '').trim().toLowerCase();
  const isDate = v => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
  const addMonths = n => new Date(today.getFullYear(), today.getMonth() + n, 1);
  const monthsUntil = d => (d.getFullYear() - today.getFullYear()) * 12 + d.getMonth() - today.getMonth();
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  const full3 = months.slice(-4, -1);
  const inc = avg(full3.map(m => income[m])), out = avg(full3.map(m => totals[m]));
  const surplus = inc - out;
  // Goals are paid from your Monthly savings target when you've set one (that's the plan), else your typical surplus.
  const budget = budget_(targets, inc), toSave = budget ? budget.savings : surplus;
  // Only actions you've committed to count toward the "With actions" dates.
  const open = actions.filter(a => a[1] && isCommitted_(a[8]));
  const actionSaving = open.reduce((s, a) => s + (Number(a[3]) || 0), 0);

  // Each account's NZD balance by month, from Balance history (synced accounts and Holdings alike).
  const byAccount = {};
  (balances || []).forEach(b => {
    if (b[6] === '' || b[6] == null) return;
    const m = monthKey_(b[0]);
    (byAccount[b[1]] = byAccount[b[1]] || {})[m] = Number(b[6]) || 0;
  });
  // An exact account name wins, so "/ Savings" means that account and not "/ Savings #Car".
  const names = Object.keys(byAccount).concat(accounts.map(a => a[0]).filter(n => !byAccount[n]));
  const accountFor = appliesTo => findAccount_(appliesTo, names);
  // A goal on several accounts ("#Home + KiwiSaver") is named with " + "; its balance and trend are their sums.
  const sumOf = (name, f) => {
    const vals = name.split(' + ').map(f);
    return vals.every(v => v == null) ? null : vals.reduce((a, v) => a + (v || 0), 0);
  };
  const balanceNow = name => name.includes(' + ') ? sumOf(name, balanceNow) : balanceOne(name);
  const balanceOne = name => {
    const h = byAccount[name];
    if (h) { const ms = Object.keys(h).sort(); return h[ms[ms.length - 1]]; }
    const a = accounts.find(x => x[0] === name);
    return a ? Number(a[5]) || 0 : null;
  };
  // Average monthly change over the last three full months of history (needs at least two). This month is left out:
  // its snapshot may be only days after last month's, which would read as a flat account.
  const thisKey = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0');
  const trendOf = name => name.includes(' + ') ? sumOf(name, trendOne) : trendOne(name);
  const trendOne = name => {
    const h = byAccount[name];
    const ms = h ? Object.keys(h).filter(m => m < thisKey).sort().slice(-4) : [];
    return ms.length < 2 ? null : (h[ms[ms.length - 1]] - h[ms[0]]) / (ms.length - 1);
  };

  // Goals: savings goals (amount left to save) and debts (balance left to pay). Goals sharing an account split its
  // balance by priority (goalBalances_) and take turns on its trend.
  const shared = goalBalances_(targets, accountFor, balanceNow);
  const streams = {};   // account -> monthly trend feeding its goals
  const goals = targets.map((t, i) => [t, shared[i]])
    .filter(([t]) => t[0] && !/^example/i.test(String(t[8])) && isGoalKind_(t[1]))
    .map(([t, g]) => {
      const debt = /debt/i.test(t[1]), acct = g.account;
      const current = t[5] === '' || t[5] == null ? null : Number(t[5]);
      const now = current != null ? current : g.now != null ? g.now : 0;
      const left = debt ? Math.abs(now) : Math.max((Number(t[3]) || 0) - now, 0);
      const trend = acct && current == null ? trendOf(acct) : null;
      const move = trend == null ? null : debt ? -trend : trend;   // debts shrink as the balance rises toward zero
      // A goal on KiwiSaver or a Holdings account (Sharesies and the like) grows by itself, from contributions and
      // returns, never from your payday savings.
      const own = !!acct && acct.split(' + ').every(n => /kiwisaver/i.test(n) || (accounts.length > 0 && !accounts.some(a => a[0] === n)) ||
        /KIWISAVER/i.test(String((accounts.find(a => a[0] === n) || [])[1])));
      const fixed = Number(t[6]) || 0, share = fixed || own ? 0 : shareOf_(t[9]);
      const stream = !fixed && !share && move > 0 ? acct : '';
      if (stream && streams[stream] == null) streams[stream] = move;
      // An account that isn't growing on its own gets a share of the surplus instead, in priority order.
      // How a goal is paid, first that applies: a Monthly transfer, its Share of savings, its account's own growth, or
      // whatever savings are left after those, by priority.
      const source = fixed ? 'Monthly transfer' : share ? Math.round(share * 100) + '% of savings' : move > 0 ? 'Account trend' :
        own ? 'Grows on its own (not enough history yet)' : 'Surplus';
      return { name: t[0], account: acct, left: round(left), fixed, share, stream, source, own, usesSurplus: !fixed && !share && !own && !(move > 0),
               priority: Number(t[7]) || 99, targetDate: isDate(t[4]) ? t[4] : '', debt, target: Number(t[3]) || 0, now };
    })
    .sort((a, b) => a.priority - b.priority);

  // Month by month: goals with their own pace (a transfer or the account's trend) move at that pace; the surplus
  // left after those fills the remaining goals in priority order. When a goal finishes, its pace is freed up.
  // Savings from open actions (extra) go to the highest-priority goal still open, whatever its pace comes from.
  const simulate = (pool, extra) => {
    const rem = goals.map(g => g.left), done = goals.map(g => g.left <= 0 ? 0 : null), first = goals.map(() => 0);
    const start = goals.map(() => null), path = goals.map(() => []), spare = [];   // month each goal starts getting money; left per month
    const before = goals.map(g => g.left);
    const shareAll = Math.min(goals.reduce((s, g) => s + (g.left > 0 ? g.share : 0), 0), 1);   // over 100% counts as 100%
    // Accounts that grow by themselves (KiwiSaver) don't use up the savings; other accounts' growth is your savings.
    const streaming = Object.keys(streams).filter(a => goals.some(g => g.stream === a && g.left > 0 && !g.own));
    const free = Math.max(pool - goals.reduce((s, g) => s + (g.left > 0 ? g.fixed : 0), 0) -
                          streaming.reduce((s, a) => s + streams[a], 0), 0);
    for (let m = 1; m <= 360 && done.some(d => d === null); m++) {
      let avail = free + goals.reduce((s, g, i) => s + (done[i] !== null && g.left > 0 ? g.fixed : 0), 0);
      goals.forEach((g, i) => {
        if (done[i] !== null || !g.fixed) return;
        rem[i] -= g.fixed; if (m === 1) first[i] = g.fixed;
        if (rem[i] <= 0) done[i] = m;
      });
      // Each account's trend goes to its highest-priority goal still open.
      const flow = Object.assign({}, streams);
      goals.forEach((g, i) => {
        if (done[i] !== null || !g.stream || flow[g.stream] <= 0) return;
        const take = Math.min(flow[g.stream], rem[i]);
        rem[i] -= take; flow[g.stream] -= take; if (m === 1) first[i] = take;
        if (rem[i] <= 0.005) done[i] = m;
      });
      // Shares: the shared part of the savings is split between the share goals still open, in proportion, so a
      // finished goal's share goes to the others. Anything a goal doesn't need falls through to the next step.
      // A goal that needs less than its part passes the rest to the other share goals the same month.
      let pot = avail > 0 && goals.some((g, i) => done[i] === null && g.share) ? avail * shareAll : 0;
      while (pot > 0.005) {
        const open = goals.map((g, i) => i).filter(i => done[i] === null && goals[i].share);
        if (!open.length) break;
        const weight = open.reduce((s, i) => s + goals[i].share, 0), round0 = pot;
        open.forEach(i => {
          const take = Math.min(round0 * goals[i].share / weight, rem[i]);
          rem[i] -= take; avail -= take; pot -= take; if (m === 1) first[i] += take;
          if (rem[i] <= 0.005) done[i] = m;
        });
        if (pot >= round0 - 0.005) break;
      }
      goals.forEach((g, i) => {
        if (done[i] !== null || !g.usesSurplus || avail <= 0) return;
        const take = Math.min(avail, rem[i]);
        rem[i] -= take; avail -= take; if (m === 1) first[i] = take;
        if (rem[i] <= 0.005) done[i] = m;
      });
      let bonus = extra || 0;
      goals.forEach((g, i) => {
        if (done[i] !== null || bonus <= 0) return;
        const take = Math.min(bonus, rem[i]);
        rem[i] -= take; bonus -= take;
        if (rem[i] <= 0.005) done[i] = m;
      });
      goals.forEach((g, i) => { if (start[i] === null && rem[i] < before[i] - 0.005) start[i] = m; before[i] = rem[i]; });
      if (m <= 12) { goals.forEach((g, i) => path[i].push(Math.max(rem[i], 0))); spare.push(Math.max(avail, 0)); }
    }
    // Everything finished early: the remaining months stay where they ended.
    goals.forEach((g, i) => { while (path[i].length < 12) path[i].push(Math.max(rem[i], 0)); });
    while (spare.length < 12) spare.push(Math.max(pool, 0));
    return { done, first, start, path, spare };
  };
  const base = simulate(toSave, 0), better = simulate(toSave, actionSaving);
  const goalRows = goals.map((g, i) => {
    const doneBy = base.done[i] === null ? '' : addMonths(base.done[i]);
    const withActions = better.done[i] === null ? '' : addMonths(better.done[i]);
    const monthsLeft = g.targetDate ? Math.max(monthsUntil(g.targetDate), 1) : 0;
    let status = 'No target date';
    if (g.left <= 0) status = 'Done';
    else if (base.done[i] === null) status = 'Not at this pace';
    else if (g.targetDate) status = doneBy <= g.targetDate ? 'On track' : 'Behind';
    const queued = g.left > 0 && !base.first[i] && base.done[i] !== null;   // waiting for a higher-priority goal
    return { name: g.name, account: g.account, source: g.source, left: g.left, perMonth: queued ? 'queued' : round(base.first[i]), doneBy, withActions,
             targetDate: g.targetDate, target: g.debt ? '' : g.target, saved: g.debt ? '' : round(g.now), debt: g.debt, share: g.share,
             startsBy: queued && base.start[i] ? addMonths(base.start[i]) : '',
             needs: g.targetDate && g.left > 0 ? round(g.left / monthsLeft) : '', status };
  });

  // This month, projected to month-end from the days so far.
  const cur = months[months.length - 1];
  const day = today.getDate(), days = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
  const pace = v => round(v / day * days);
  const thisMonth = [{ name: 'Total spend', soFar: round(totals[cur]), pace: pace(totals[cur]), compare: round(out) }];
  targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && /^spending limit$/i.test(String(t[1]).trim()))
    .forEach(t => {
      const key = Object.keys(spend).find(c => lower(c) === lower(t[2]));
      const soFar = key ? spend[key][cur] || 0 : 0;
      thisMonth.push({ name: t[0] + ' (limit)', soFar: round(soFar), pace: pace(soFar), compare: Number(t[3]) || '' });
    });
  thisMonth.forEach(r => {
    r.status = r.compare === '' ? '' : r.pace > r.compare * 1.05 ? 'Over pace' : 'Under pace';
  });

  // Planned purchases: each paying account's balance month by month (its recent trend, less the purchases), and
  // what each purchase leaves behind. With no account, it comes out of all your cash, which moves with the surplus.
  const monthLabel = d => MON[d.getMonth()] + ' ' + d.getFullYear();
  const ALL_CASH = 'All cash';
  const cashNow = accounts.filter(a => CASH_TYPES.includes(String(a[1]).toUpperCase()) && !RESERVED_NAME.test(String(a[0])))
    .reduce((s, a) => s + (Number(a[5]) || 0), 0);
  const listed = targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && isPlanKind_(t[1]))
    .map(t => {
      const named = String(t[2] || '').trim(), acct = named ? accountFor(t[2]) : ALL_CASH;
      return { name: t[0], account: acct || named, missing: !acct, cost: Number(t[3]) || 0,
               date: isDate(t[4]) ? t[4] : '', month: isDate(t[4]) ? Math.max(monthsUntil(t[4]), 0) : 0 };
    })
    .sort((a, b) => a.month - b.month);
  const plans = listed.filter(p => !p.missing);   // one naming no known account is listed but left out of the numbers
  const plan = {};   // account -> {now, trend, without[13], with[13], held}
  plans.forEach(p => {
    if (plan[p.account]) return;
    const all = p.account === ALL_CASH;
    const now = all ? cashNow : balanceNow(p.account) || 0;
    const trend = all ? surplus : trendOf(p.account) || 0;
    const held = shared.reduce((s, g, i) => s + (g.account === p.account && !/debt/i.test(targets[i][1]) ? Number(targets[i][3]) || 0 : 0), 0);
    const without = Array.from({ length: 13 }, (_, m) => now + trend * m);
    const spent = m => plans.filter(q => q.account === p.account && q.month <= m).reduce((s, q) => s + q.cost, 0);
    plan[p.account] = { now, trend, held, without, with: without.map((v, m) => v - spent(m)) };
  });
  const purchases = listed.map(p => {
    if (p.missing) return { name: p.name, account: p.account, cost: round(p.cost), when: p.date || 'Now', before: '', after: '',
                            lowest: '', earnBack: '', status: 'No account matches "Applies to"' };
    const a = plan[p.account], m = Math.min(p.month, 12), i = plans.indexOf(p);
    const earlier = plans.slice(0, i).filter(q => q.account === p.account).reduce((s, q) => s + q.cost, 0);
    const before = a.without[m] - earlier, after = before - p.cost;
    const pace = a.trend > 0 ? a.trend : surplus + actionSaving > 0 ? surplus + actionSaving : 0;
    let status = 'Covered';
    if (after < 0) status = 'Short by $' + Math.round(-after);
    else if (a.held && after < a.held) status = 'Dips into goals on this account';
    return { name: p.name, account: p.account, cost: round(p.cost), when: p.date || 'Now', before: round(before), after: round(after),
             lowest: round(Math.min.apply(null, a.with.slice(m))), earnBack: pace ? Math.ceil(p.cost / pace) : '', status };
  });
  // Set-asides: what each purchase still needs beyond what its account holds today, spread over the paydays before it.
  const purchaseFlows = purchaseSetAsides_(plans, a => a === ALL_CASH ? cashNow : balanceNow(a)).filter(p => p.short > 0)
    .map(p => ({ name: p.name, into: p.account, paid: Array.from({ length: 12 }, (_, k) => k < p.months ? round(p.perMonth) : 0) }));
  const planAccounts = Object.keys(plan);
  const planChart = !plans.length ? [] : [['Month'].concat(planAccounts.map(a => a + ' with purchases'), planAccounts.map(a => a + ' without'))]
    .concat(Array.from({ length: 13 }, (_, m) => [monthLabel(addMonths(m))]
      .concat(planAccounts.map(a => round(plan[a].with[m])), planAccounts.map(a => round(plan[a].without[m])))));
  const planSpent = m => plans.filter(p => p.month <= m).reduce((s, p) => s + p.cost, 0);

  // Net worth: latest figure, plus the surplus each month (and with actions, and less any planned purchases).
  const hist = (history || []).filter(h => h[7] !== '' && h[7] != null);
  const nw = hist.length ? Number(hist[hist.length - 1][7]) || 0 : null;
  const netWorth = nw === null ? [] : [['Month', 'At current pace', 'With open actions'].concat(plans.length ? ['With planned purchases'] : [])]
    .concat(Array.from({ length: 13 }, (_, m) => [monthLabel(addMonths(m)), round(nw + surplus * m), round(nw + (surplus + actionSaving) * m)]
      .concat(plans.length ? [round(nw + surplus * m - planSpent(m))] : [])));

  // Month by month: what each goal holds (or, for a debt, what's still owed) at the end of each of the next 12 months,
  // and the surplus not yet given to any goal.
  const goalMonths = !goals.length ? [] : [['Month'].concat(goals.map(g => g.name + (g.debt ? ' (owed)' : '')), ['Not allocated'])]
    .concat(Array.from({ length: 12 }, (_, k) => [MON[addMonths(k + 1).getMonth()] + ' ' + addMonths(k + 1).getFullYear()]
      .concat(goals.map((g, i) => round(g.debt ? base.path[i][k] : g.target - base.path[i][k])), [round(base.spare[k])])));
  // The same, months left to right: what you have to put away, what goes into each goal's account, and the balance it
  // grows to. A goal on several accounts gets its money in the first one ("#Home" of "#Home + KiwiSaver").
  const monthNames = Array.from({ length: 12 }, (_, k) => MON[addMonths(k + 1).getMonth()] + ' ' + addMonths(k + 1).getFullYear());
  const goalFlows = goals.map((g, i) => ({ name: g.name, debt: g.debt, own: g.own, into: String(g.account || '').split(' + ')[0] || '',
    paid: base.path[i].map((v, k) => round((k ? base.path[i][k - 1] : g.left) - v)) }));
  const goalGrid = !goals.length ? [] : [[''].concat(monthNames), [(budget ? 'Savings target to allocate' : 'Savings to allocate')].concat(monthNames.map(() => round(Math.max(toSave, 0))))]
    .concat([].concat.apply([], goals.map((g, i) => {
      const into = String(g.account || '').split(' + ')[0] || 'surplus';
      const paid = base.path[i].map((v, k) => round((k ? base.path[i][k - 1] : g.left) - v));
      const level = base.path[i].map(v => round(g.debt ? v : g.target - v));
      return [[g.name + (g.debt ? ': paid off' : ': into ' + into)].concat(paid),
              [g.name + (g.debt ? ' still owed' : ' balance')].concat(level)];
    })), [['Not allocated'].concat(base.spare.map(round))]);
  const allocated = round(goalRows.reduce((s, g) => s + (typeof g.perMonth === 'number' ? g.perMonth : 0), 0));

  const lab = m => MON[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4);
  return { basis: lab(full3[0]) + ' to ' + lab(full3[full3.length - 1]), income: round(inc), spend: round(out),
           surplus: round(surplus), actionSaving: round(actionSaving), goals: goalRows, thisMonth,
           dayOfMonth: day, daysInMonth: days, netWorth, purchases, planChart, goalMonths, goalGrid, allocated,
           toSave: round(toSave), savingsTarget: budget ? budget.savings : '', goalFlows, monthNames, budget, purchaseFlows };
}

// ---------- home scenarios ----------

const SCENARIOS_TAB = 'Home scenarios';

/**
 * Home scenarios tab: two homes side by side (Scenario A and B), the assumptions behind them and what they mean, and
 * which one the house deposit goal is for. Yellow cells are yours and are kept by label and column (the first build
 * also takes them from the old House plan tab, then removes it); everything else is rewritten on every sync. Results
 * are sheet formulas, so they update as soon as you change an assumption. What's saved comes from the House deposit
 * goals on Targets (as the Forecast works them out); rent and monthly savings come from Targets.
 * goals: the Forecast's goal rows.
 */
function buildHomeScenarios_(ss, summary, goals) {
  let sh = ss.getSheetByName(SCENARIOS_TAB);
  if (!sh) sh = ss.insertSheet(SCENARIOS_TAB, 3);
  const old = ss.getSheetByName('House plan');
  const full3 = summary ? summary.months.slice(-4, -1) : [];
  const avg = series => full3.length ? full3.reduce((s, m) => s + ((series || {})[m] || 0), 0) / full3.length : 0;
  const rows = resolveInputs_(homeScenariosLayout_(Object.assign({
    takeHome: summary ? avg(summary.income) : 0, spend: summary ? avg(summary.totals) : 0,
    gross: summary ? avg(summary.gross) * 12 : 0, rent: summary ? avg(summary.spend['Rent']) : 0,
    foreign: foreignNzd_(ss) }, housePlanFunds_(goals || []))), scenarioInputs_(sh, old));
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  if (sh.getMaxRows() < rows.length) sh.insertRowsAfter(sh.getMaxRows(), rows.length - sh.getMaxRows());
  if (sh.getMaxColumns() < 4) sh.insertColumnsAfter(sh.getMaxColumns(), 4 - sh.getMaxColumns());
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).clear();
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 330); sh.setColumnWidths(2, 2, 130); sh.setColumnWidth(4, 520);
  sh.getRange(1, 1, rows.length, 4).setValues(rows.map(r => [r.label, r.a, r.b, r.note]))
    .setFontSize(10).setVerticalAlignment('top');
  sh.getRange(1, 4, rows.length, 1).setFontColor('#6b7280').setWrap(true);
  rows.forEach((r, i) => {
    const at = i + 1, both = sh.getRange(at, 2, 1, 2), one = sh.getRange(at, 2);
    const cells = r.kind === 'input' || r.kind === 'calc' ? both : one;
    if (r.kind === 'title') sh.getRange(at, 1).setFontSize(18).setFontWeight('bold');
    if (r.kind === 'section') sh.getRange(at, 1).setFontSize(12).setFontWeight('bold');
    if (r.kind === 'header') sh.getRange(at, 2, 1, 3).setFontWeight('bold');
    if (r.kind === 'input' || r.kind === 'own') cells.setBackground(EDITABLE);
    if (r.format) cells.setNumberFormat(r.format);
    if (r.strong) cells.setFontWeight('bold');
    if (!/^(title|note|section|text|blank)$/.test(r.kind)) both.setHorizontalAlignment('right');
  });
  sh.getRange('A2:D2').merge().setFontColor('#6b7280').setWrap(true);
  if (old) ss.deleteSheet(old);
}

/** Your inputs on the Home scenarios tab and the old House plan tab, as keptInputs_ reads them. */
function scenarioInputs_(sh, old) {
  const read = t => t && t.getLastRow() > 0 ? t.getRange(1, 1, t.getLastRow(), Math.min(3, t.getLastColumn())).getValues() : [];
  return keptInputs_(read(sh), read(old));
}

/**
 * Your inputs by label: kept = {label: [Scenario A, Scenario B]} from this tab (the first row with that label), and
 * oldKept = {label: value} from the old House plan tab, used for one-value inputs this tab doesn't have yet.
 * Plain data, testable.
 */
function keptInputs_(rows, oldRows) {
  const kept = {}, oldKept = {};
  (rows || []).forEach(r => { if (r[0] !== '' && !(r[0] in kept)) kept[r[0]] = [r[1], r[2]]; });
  (oldRows || []).forEach(r => { if (r[0] !== '' && !(r[0] in oldKept)) oldKept[r[0]] = r[1]; });
  return { kept, oldKept };
}

/** The layout's rows with your inputs in place of the defaults. Plain data, testable. */
function resolveInputs_(rows, inputs) {
  const { kept = {}, oldKept = {} } = inputs || {};
  const has = v => v !== '' && v !== undefined && v !== null;
  return rows.map(r => {
    const k = kept[r.label] || [];
    if (r.kind === 'input') return Object.assign({}, r, { a: has(k[0]) ? k[0] : r.a, b: has(k[1]) ? k[1] : r.b });
    if (r.kind === 'own') return Object.assign({}, r, { a: has(k[0]) ? k[0] : has(oldKept[r.label]) ? oldKept[r.label] : r.a });
    return r;
  });
}

/** Needed in total for the selected scenario, worked out from the resolved rows; null when none is selected. Plain data. */
function selectedNeed_(rows) {
  const row = key => rows.find(r => r.key === key) || {};
  const pick = String(row('selected').a || '').trim().toUpperCase();
  if (pick !== 'A' && pick !== 'B') return null;
  const n = key => Number(row(key)[pick === 'A' ? 'a' : 'b']) || 0;
  return Math.round(n('price') * n('depositPct') + n('costs') + (/^y/i.test(String(row('useKs').a)) ? 1000 : 0));
}

/**
 * Sizes the house deposit to the selected scenario: the one House deposit goal that takes a share of your monthly
 * savings absorbs the difference, so all House deposit goals on Targets add up to what the scenario needs.
 * Returns {index, target} for the Targets row to change (0-based), or null when nothing changes, nothing is selected,
 * or there isn't exactly one such goal. Plain data, testable.
 */
function houseGoalResize_(targets, need) {
  if (!(need > 0)) return null;
  const house = targets.map((t, i) => [t, i]).filter(([t]) => t[0] && !/^example/i.test(String(t[8])) &&
    /^savings goal$/i.test(String(t[1]).trim()) && /^house/i.test(String(t[0]).trim()));
  const takers = house.filter(([t]) => shareOf_(t[9]) > 0);
  if (takers.length !== 1) return null;
  const total = house.reduce((s, [t]) => s + (Number(t[3]) || 0), 0);
  const [t, index] = takers[0];
  const target = Math.max(Math.round((Number(t[3]) || 0) + need - total), 0);
  return target === Number(t[3]) ? null : { index, target };
}

/** Before the Forecast is built: resize the house deposit goal on Targets to the selected scenario. */
function syncHouseGoal_(ss) {
  const sh = ss.getSheetByName(SCENARIOS_TAB), t = ss.getSheetByName('Targets');
  if (!sh || !t || t.getLastRow() < 2) return;
  const rows = resolveInputs_(homeScenariosLayout_({}), scenarioInputs_(sh, ss.getSheetByName('House plan')));
  const change = houseGoalResize_(t.getRange(2, 1, t.getLastRow() - 1, 11).getValues(), selectedNeed_(rows));
  if (change) t.getRange(change.index + 2, 4).setValue(change.target);
}

/** NZD value of everything on the Net worth tab not held in NZD. */
function foreignNzd_(ss) {
  const sh = ss.getSheetByName('Net worth');
  return sh && sh.getLastRow() > 1 ? foreignFromNetWorth_(sh.getRange(1, 1, sh.getLastRow(), sh.getLastColumn()).getValues()) : 0;
}

/** From the Net worth tab's values: its "in NZD" row, summed over the currency columns other than NZD. Plain data. */
function foreignFromNetWorth_(values) {
  const head = values[0] || [], row = values.find(r => String(r[2]).trim() === 'in NZD');
  if (!row) return 0;
  let sum = 0;
  for (let c = 3; c < head.length && head[c] !== 'NZD value'; c++) if (head[c] !== 'NZD') sum += Number(row[c]) || 0;
  return Math.round(sum * 100) / 100;
}

/**
 * Where the house deposit stands, from the Forecast's goal rows: savings goals named "House..." split into KiwiSaver
 * and the rest, what they add up to, and what's left on other goals that share your monthly savings (the car), which
 * get paid alongside. Plain data, testable.
 */
function housePlanFunds_(goals) {
  const house = goals.filter(g => !g.debt && /^house/i.test(String(g.name).trim()));
  const ks = g => /kiwisaver/i.test(g.account || g.name);
  const sum = (list, f) => Math.round(list.reduce((s, g) => s + (Number(f(g)) || 0), 0) * 100) / 100;
  const others = goals.filter(g => !g.debt && !house.includes(g) && g.share > 0);
  return { saved: sum(house.filter(g => !ks(g)), g => g.saved), kiwiSaver: sum(house.filter(ks), g => g.saved),
           goalTotal: sum(house, g => g.target), parts: house.filter(g => !ks(g)).map(g => g.name),
           ahead: sum(others, g => g.left), aheadNames: others.map(g => g.name) };
}

/**
 * The Home scenarios rows, in order: {kind, label, key, a, b, format, note, strong}. a and b are Scenario A and B
 * (columns B and C). Kinds: title, note, header, section, text (a label and a note); input (yours) and calc (a
 * formula) are per scenario; own (yours) and sum (a formula or a number from your data) are one value, in column B.
 * A blank row spaces out each section. Formulas find each other by key, so rows can move. Plain data, testable.
 * defaults: {takeHome, spend, gross, rent} per month (gross per year), from your last three full months, foreign
 * (NZD held in other currencies), plus housePlanFunds_().
 */
function homeScenariosLayout_(defaults) {
  const d = defaults || {};
  const round = n => Math.max(Math.round((n || 0) / 50) * 50, 0);
  const money = '$#,##0;-$#,##0', signed = '+$#,##0;-$#,##0', pct = '0.0%';
  const list = names => (names || []).join(', ').replace(/house deposit\s*/ig, '') || 'none yet';
  const upkeep = price => round(price * 0.015 / 12);
  // A Targets amount by kind (and Applies to), or the fallback when there's no such row.
  const fromTargets = (kind, appliesTo, fallback) => `=IFERROR(INDEX(FILTER(Targets!D:D,Targets!B:B="${kind}"` +
    (appliesTo ? `,Targets!C:C="${appliesTo}"` : '') + `),1),${fallback})`;
  const spec = [
    ['title', 'Home scenarios'],
    ['note', 'Two homes side by side. Yellow cells are your assumptions: change them and everything below updates. ' +
             'What you\'ve saved comes from the House deposit goals on Targets on each sync, and the selected scenario sets their total.'],
    ['header', '', '', 'Scenario A', 'Scenario B', '', 'Notes'],
    ['section', 'The home'],
    ['input', 'Price', 'price', 750000, 1000000, money],
    ['input', 'Deposit', 'depositPct', 0.2, 0.2, '0%', '20% is the standard. Below that, banks lend only a limited share and usually charge a low-equity margin or fee.'],
    ['input', 'Buying costs', 'costs', 10000, 10000, money, 'Lawyer, building report, LIM, valuation, moving.'],
    ['input', 'Interest rate', 'rate', 0.055, 0.055, '0.00%', 'A typical fixed rate. A mortgage adviser can say what you would get.'],
    ['input', 'Stress-test rate', 'stress', 0.07, 0.07, '0.00%', 'What repayments would be if rates rise.'],
    ['input', 'Term (years)', 'term', 30, 30, '0'],
    ['input', 'Rates, insurance and upkeep, per month', 'running', upkeep(750000), upkeep(1000000), money, 'An estimate. An apartment or unit adds body corporate fees.'],
    ['section', 'Your money'],
    ['own', 'Use KiwiSaver for it? (Yes / No)', 'useKs', 'Yes', '', '@', 'For a first home, after 3+ years in KiwiSaver, you can take out all but $1,000.'],
    ['sum', 'In savings now', 'haveSave', d.saved || 0, '', money, 'House deposit goals on Targets: ' + list(d.parts) + '.'],
    ['sum', 'In KiwiSaver now', 'haveKs', R => `=IF(${R('useKs')}="Yes",${d.kiwiSaver || 0},0)`, '', money, 'The House deposit (KiwiSaver) goal on Targets.'],
    ['sum', 'You save per month', 'monthly', fromTargets('Monthly savings', '', round(d.takeHome - d.spend)), '', money,
      'Monthly savings on Targets (change it there). Until they\'re done, ' + list(d.aheadNames) + ' share it.'],
    ['sum', 'Other goals sharing your savings, still to save', 'ahead', d.ahead || 0, '', money, 'Paid alongside the house until they\'re done, as on the Forecast.'],
    ['own', 'Added to KiwiSaver per month (you, employer, government)', 'ksMonthly', 0, '', money],
    ['own', 'Growth on what you\'ve saved, per year', 'growth', 0, '', pct, 'Interest on savings, and any KiwiSaver returns. 0% is the cautious choice.'],
    ['own', 'Income before tax, per year', 'gross', round(d.gross), '', money, 'Banks test the loan against this. If you\'re self-employed, they usually use net taxable income from your tax returns.'],
    ['own', 'Take-home per month', 'takeHome', round(d.takeHome), '', money],
    ['sum', 'Rent now, per month', 'rent', fromTargets('Spending limit', 'Rent', round(d.rent)), '', money, 'The Rent limit on Targets.'],
    ['sum', 'Other spending limits, per month', 'otherSpend', R => `=SUMIF(Targets!B:B,"Spending limit",Targets!D:D)-${R('rent')}`, '', money, 'Every Spending limit on Targets except rent.'],
    ['section', 'The deposit'],
    ['calc', 'Deposit amount', 'deposit', R => `=${R('price')}*${R('depositPct')}`, '', money],
    ['calc', 'Needed in total', 'needed', R => `=${R('deposit')}+${R('costs')}+IF(${R('useKs')}="Yes",1000,0)`, '', money, 'Deposit, buying costs, and the $1,000 that stays in KiwiSaver.', true],
    ['calc', 'Still to save', 'left', R => `=MAX(${R('needed')}-${R('haveSave')}-${R('haveKs')},0)`, '', money],
    ['calc', 'Months to go', 'months', R => `=IF(${R('left')}=0,0,IF(${R('monthly')}+${R('ksMonthly')}<=0,"Not at this rate",` +
      `IF(${R('growth')}=0,ROUNDUP((${R('left')}+${R('ahead')})/(${R('monthly')}+${R('ksMonthly')})),` +
      `ROUNDUP(NPER(${R('growth')}/12,-(${R('monthly')}+${R('ksMonthly')}),-(${R('haveSave')}+${R('haveKs')}-${R('ahead')}),${R('needed')})))))`, '', '0'],
    ['calc', 'Ready by', 'when', R => `=IF(${R('months')}=0,"Now",IF(ISNUMBER(${R('months')}),EDATE(TODAY(),${R('months')}),""))`, '', 'mmm yyyy', '', true],
    ['section', 'Owning it'],
    ['calc', 'Loan', 'loan', R => `=${R('price')}-${R('deposit')}`, '', money],
    ['calc', 'Loan to income', 'dti', R => `=IF(${R('gross')}>0,${R('loan')}/${R('gross')},"")`, '', '0.0"x"', 'Most owner-occupier loans are capped at 6x income before tax.'],
    ['calc', 'Repayments per month', 'pay', R => `=PMT(${R('rate')}/12,${R('term')}*12,-${R('loan')})`, '', money, 'Principal and interest.', true],
    ['calc', 'Repayments at stress-test rate', 'payStress', R => `=PMT(${R('stress')}/12,${R('term')}*12,-${R('loan')})`, '', money],
    ['calc', 'Total cost to own, per month', 'own', R => `=${R('pay')}+${R('running')}`, '', money, 'Repayments plus rates, insurance and upkeep.', true],
    ['calc', 'More than rent now, per month', 'vsRent', R => `=${R('own')}-${R('rent')}`, '', signed],
    ['calc', 'More than rent now, per week', 'vsRentWeek', R => `=${R('vsRent')}*12/52`, '', signed, 'The monthly difference spread over the year\'s 52 weeks.'],
    ['calc', 'Share of take-home', 'share', R => `=IF(${R('takeHome')}>0,${R('own')}/${R('takeHome')},"")`, '', '0%'],
    ['calc', 'Left to save after other spending, per month', 'spare', R => `=${R('takeHome')}-${R('own')}-${R('otherSpend')}`, '', money, 'Take-home less the cost to own and your other Spending limits.'],
    ['calc', 'Verdict', 'verdict', R => `=IF(${R('gross')}<=0,"Add your income",IF(${R('dti')}>6,"Loan is over 6x income: most banks stop there",` +
      `IF(${R('share')}>0.4,"Costs over 40% of take-home: tight","Affordable on these assumptions")))`, '', '@', 'A rough check, not a lending decision. A mortgage adviser can say what a bank would approve.', true],
    ['section', 'Your house goal'],
    ['own', 'Selected scenario (A or B)', 'selected', '', '', '@', 'The House deposit goals on Targets are sized to this scenario: on each refresh, the one that takes a share of your monthly savings changes to make up the difference. Leave blank to set them yourself.'],
    ['sum', 'Selected scenario needs', 'selNeeded', R => `=IF(UPPER(TRIM(${R('selected')}))="A",${R('needed', 'B')},IF(UPPER(TRIM(${R('selected')}))="B",${R('needed', 'C')},""))`, '', money, '', true],
    ['sum', 'House deposit goals on Targets add up to', 'goalTotal', d.goalTotal || 0, '', money, 'As at the last refresh.'],
    ['sum', 'Difference', 'gap', R => `=IF(ISNUMBER(${R('selNeeded')}),${R('goalTotal')}-${R('selNeeded')},"")`, '', signed, 'Zero once the goals match. The next refresh closes it.'],
    ['section', 'Money held overseas'],
    ['sum', 'Held in other currencies, NZD', 'foreign', d.foreign || 0, '', money, 'Everything on Net worth not held in NZD, tax reserves left out.'],
    ['own', 'Exchange-rate move to test', 'fxMove', 0.1, '', '0%'],
    ['sum', 'Changes the NZD value by', 'fxHit', R => `=${R('foreign')}*${R('fxMove')}`, '', money, 'Either way. Nobody can reliably predict which way the NZ dollar moves.'],
    ['text', 'Convert all at once', '', '', '', '', 'Earns NZ interest straight away and fixes the NZD amount. Takes whatever exchange rate applies that day.'],
    ['text', 'Convert in stages', '', '', '', '', 'Averages the exchange rate, so one bad day matters less. Earns nothing while waiting.'],
    ['text', 'Convert when buying', '', '', '', '', 'Keeps the chance of a better rate. Exchange-rate risk until settlement, and paperwork rushed at the end.'],
    ['text', 'Bank checks', '', '', '', '', 'Lenders verify where the deposit came from. A clear trail into your NZ account is simplest.'],
    ['text', 'Tax', '', '', '', '', 'Check with an accountant before bringing money home: any overseas tax on selling investments, and how NZ taxes what it earns here.']
  ];
  // A blank row before each section after the first, to space them out.
  for (let i = spec.length - 1, first = spec.findIndex(s => s[0] === 'section'); i > first; i--) if (spec[i][0] === 'section') spec.splice(i, 0, ['blank', '']);
  const perScenario = new Set(spec.filter(s => s[0] === 'input' || s[0] === 'calc').map(s => s[2]));
  const ref = {};
  spec.forEach((s, i) => { if (s[2]) ref[s[2]] = i + 1; });
  // R(key) is that row in the same scenario's column, or column B for a one-value row; R(key, col) picks the column.
  const resolver = col => (key, at) => (perScenario.has(key) ? (at || col) : '$B') + ref[key];
  const fill = (v, col) => typeof v === 'function' ? v(resolver(col)) : v === undefined ? '' : v;
  return spec.map(([kind, label, key, a, b, format, note, strong]) => {
    const calc = kind === 'calc';
    return { kind, label, key: key || '', a: fill(a, 'B'), b: calc ? fill(a, 'C') : fill(b, 'C'),
             format: format || '', note: note || '', strong: !!strong };
  });
}

// ---------- dashboard ----------

/**
 * Dashboard tab: headline numbers, open savings actions, targets and three charts, rebuilt on every sync.
 * Everything on it is generated; edit Actions and Targets, not this tab.
 */
function buildDashboard_(ss, summary, merchants, toSort) {
  let sh = ss.getSheetByName('Dashboard');
  if (!sh) { sh = ss.insertSheet('Dashboard', 0); }
  sh.getCharts().forEach(c => sh.removeChart(c));
  sh.getRange(1, 1, sh.getMaxRows(), sh.getMaxColumns()).breakApart();
  sh.clear();
  sh.showColumns(1, sh.getMaxColumns());
  sh.setHiddenGridlines(true);
  sh.setColumnWidth(1, 40);
  sh.setColumnWidth(2, 300);
  sh.setColumnWidths(3, 11, 100);

  const tz = ss.getSpreadsheetTimeZone();
  sh.getRange('A1').setValue('Personal Finance').setFontSize(18).setFontWeight('bold');
  if (!summary) {
    sh.getRange('A2').setValue('No transactions yet. Run Finance > Sync banking feeds.');
    return;
  }
  const read = name => {
    const t = ss.getSheetByName(name);
    return t && t.getLastRow() > 1 ? t.getRange(2, 1, t.getLastRow() - 1, t.getLastColumn()).getValues() : [];
  };
  const txTab = ss.getSheetByName('Transactions');
  const txVals = txTab.getLastRow() > 1 ? txTab.getRange(2, 1, txTab.getLastRow() - 1, 12).getValues() : [];
  const myServices = typeof MY_SERVICES === 'undefined' ? [] : MY_SERVICES;
  const serviceWords = myServices.flatMap(s => String(s[0]).toLowerCase().split('|').map(w => w.trim()).filter(Boolean));
  let recurring = recurringCharges_(txVals, new Date(), typeof MY_SUBSCRIPTIONS === 'undefined' ? [] : MY_SUBSCRIPTIONS, reservedAccounts_(ss))
    .filter(r => !serviceWords.some(w => r.name.toLowerCase().includes(w)))   // listed services are shown once, below
    .concat(regularServices_(txVals, new Date(), myServices));
  // Regulars: for lifestyle places, their 6-month total beats a billing pattern found in a few same-priced visits.
  const regulars = lifestyleRegulars_(txVals, new Date(), reservedAccounts_(ss))
    .filter(r => !serviceWords.some(w => r.name.toLowerCase().includes(w)));
  const regularNames = new Set(regulars.map(r => r.name.toLowerCase()));
  const combined = recurring.filter(r => !(regularNames.has(r.name.toLowerCase()) && !r.known)).concat(regulars);
  recurring = combined;
  summary.expectedIncome = Array.from(new Set(loadRules_(ss).rules.map(r => r.cat).filter(isIncomeCategory_).map(incomeSource_)))
    .filter(src => src !== 'Other');
  // Holdings accounts (Sharesies and the like) join the synced ones, at their latest NZD value from Balance history,
  // so a goal can sit on them too. Cash ones (Type Cash on Holdings) count toward runway; investments don't.
  const withHoldings = accountsWithHoldings_(read('Accounts'), read('Balance history'));
  const d = dashboardData_(summary, merchants, withHoldings, read('Targets'), read('Savings actions'), read('Net worth history'),
                           read('Holdings'), recurring, accountFlows_(txVals), txVals);
  const money = '$#,##0;-$#,##0';
  const grey = '#6b7280';
  // Headline tiles: what you own, the same split as the Net worth tab, from today's balances and rates (FX tab).
  const fx = ss.getSheetByName('FX'), fxVals = fx && fx.getLastRow() > 1 ? fx.getRange(2, 1, fx.getLastRow() - 1, 5).getValues() : [];
  const rates = {}, prices = {};
  fxVals.forEach(r => { if (r[0] && typeof r[1] === 'number') rates[r[0]] = r[1]; if (r[3] && typeof r[4] === 'number') prices[r[3]] = r[4]; });
  d.kpis = worthTiles_(netWorthData_(read('Accounts'), read('Holdings'), rates, prices, read('Targets')));
  sh.getRange('A2').setValue('What you own, as on the Net worth tab. Month figures are in Month over month below. Updated ' +
    Utilities.formatDate(new Date(), tz, 'd MMM yyyy, h:mm a') + '.' +
    (toSort ? ' ' + toSort + ' merchants to sort on the Uncategorised tab.' : '')).setFontColor(grey);

  // Headline numbers: up to two rows of four. Column B is wide; C:D, E:F and G:H are merged so every figure has room.
  const slots = [[2, 1], [3, 2], [5, 2], [7, 2]];
  d.kpis.slice(0, 8).forEach((k, i) => {
    const [col, width] = slots[i % 4], top = 4 + Math.floor(i / 4) * 2;
    const label = sh.getRange(top, col, 1, width), value = sh.getRange(top + 1, col, 1, width);
    if (width > 1) { label.merge(); value.merge(); }
    label.setValue(k[0]).setFontColor(grey).setFontSize(9);
    value.setValue(k[1]).setNumberFormat(k[2]).setFontSize(15).setFontWeight('bold').setHorizontalAlignment('left');
  });

  // Tables
  const table = (row, title, header, rows, formats) => {
    sh.getRange(row, 1).setValue(title).setFontSize(12).setFontWeight('bold');
    sh.getRange(row + 1, 1, 1, header.length).setNumberFormat('@').setValues([header]).setFontColor(grey).setFontSize(9)
      .setBorder(false, false, true, false, false, false, '#d1d5db', null);
    if (rows.length) {
      sh.getRange(row + 2, 1, rows.length, header.length).setValues(rows).setVerticalAlignment('top');
      formats.forEach((f, i) => { if (f) sh.getRange(row + 2, 1 + i, rows.length, 1).setNumberFormat(f); });
    }
    return row + 3 + Math.max(rows.length, 1);
  };

  buildToDo_(ss, d, tz);

  // Goals and plans: savings goals, then the purchases you're planning, each with a bar.
  const targetsRow = 9;
  // Columns: B Goal, C Aim, D Now, E Remaining (Aim less Now), F Progress, G the bar, H Where (account names; long
  // ones run into the empty cells to the right), I a note.
  // Remaining is for goals and purchases; for a budget account, Now is what's left to spend, so it stays blank.
  const remaining = t => !t.budget && typeof t.aim === 'number' && typeof t.now === 'number' ? Math.max(Math.round((t.aim - t.now) * 100) / 100, 0) : '';
  let row = table(targetsRow, 'Goals and plans', ['', 'Goal', 'Aim', 'Now', 'Remaining', 'Progress', '', 'Where'],
    d.targets.map(t => ['', t.name, t.aim, t.now, remaining(t), t.ratio, '', t.kind]), ['', '', money, money, money, '0%', '', '@']);
  if (!d.targets.length) sh.getRange(targetsRow + 2, 2).setValue('No savings goals yet. Ask Claude to help set some.').setFontColor(grey);
  if (d.targets.length) sh.getRange(targetsRow + 2, 8, d.targets.length, 1).setHorizontalAlignment('left').setFontWeight('normal');
  d.targets.forEach((t, i) => {
    if (!/^\s/.test(t.name)) {   // top-level rows bold (not Where), parts indented below
      sh.getRange(targetsRow + 2 + i, 2).setFontWeight('bold');
      sh.getRange(targetsRow + 2 + i, 3, 1, 4).setFontWeight('bold');
      sh.getRange(targetsRow + 2 + i, 2, 1, 7).setBorder(null, null, true, null, null, null, '#9ca3af', null);   // a line under it
    }
    if (t.ratio === '') return;
    const color = t.plan && t.ratio < 1 ? '#e9a23b' : '#2a9d8f';   // a purchase the account can't fully cover yet is amber
    const r = targetsRow + 2 + i;
    sh.getRange(r, 7).setFormula('=SPARKLINE(F' + r + ',{"charttype","bar";"max",1;"color1","' + color + '"})');
  });

  const actionsRow = row;
  row = table(actionsRow, 'Savings actions', ['#', 'Action', 'Saves / month', 'Per year', 'Status', 'Progress'],
    d.actions, ['0', '', money, money, '', '']);
  if (!d.actions.length) sh.getRange(actionsRow + 2, 2).setValue('No open actions yet. Ask Claude: "what should I cut?"').setFontColor(grey);
  sh.getRange(actionsRow + 2, 2, Math.max(d.actions.length, 1), 1).setWrap(true);

  // Month over month: the latest months, Target and 3-month average beside the labels, then the history.
  const momRow = row;
  const n = d.mom.labels.length;
  // Headline rows (income, spend, left over, net worth) in a shaded band, then a blank row, then the breakdown.
  const headline = r => ['income', 'incomePart', 'spend', 'net'].includes(r.kind);
  const shown = [];
  d.mom.rows.forEach((r, i) => {
    if (i > 0 && headline(d.mom.rows[i - 1]) && !headline(r)) shown.push(null);
    shown.push(r);
  });
  // Layout, left to right: labels, then what matters now right beside them (last full month, this month so far,
  // Target from your budget on Targets, 3-month average), a blank column, then the earlier months in order.
  // The last full month is green when it met its target and red when it didn't.
  // Columns: B label, C last full month, D this month so far, E Target (the outlined block), F 3-month average,
  // then the earlier months from G.
  const hist = n - 2, width = 6 + hist;
  const arrange = (label, v, target, avg) => ['', label, v[n - 2], v[n - 1], target, avg].concat(v.slice(0, hist));
  row = table(row, 'Month over month', arrange('', d.mom.labels, 'Target', '3-month avg'),
    shown.map(r => r ? arrange(r.name, r.values, r.target, r.avg) : Array(width).fill('')),
    ['', '', money, money, money, money].concat(Array(hist).fill(money)));
  sh.getRange(momRow + 1, 4).setFontStyle('italic');
  sh.getRange(momRow + 1, 5).setFontWeight('bold');
  if (!d.mom.budget) sh.getRange(momRow + 1, 5).setNote('Ask Claude to set a budget: a Monthly savings target and Spending limits on Targets.');
  shown.forEach((r, i) => {
    if (!r) return;
    const at = momRow + 2 + i, line = sh.getRange(at, 2, 1, width - 1);
    sh.getRange(at, 4).setFontColor(grey).setFontStyle('italic');   // this month, so far
    sh.getRange(at, 5).setFontWeight('bold').setFontSize(11);   // generated from Targets, so not yellow
    if (headline(r) && r.kind !== 'incomePart') sh.getRange(at, 3, 1, 3).setFontSize(12);   // the figures that matter now
    if (r.target !== '' && r.values.length > 1 && r.values[n - 2] !== '') {
      const over = ['spend', 'group', 'category'].includes(r.kind) ? r.values[n - 2] > r.target * 1.005 : r.values[n - 2] < r.target * 0.995;
      sh.getRange(at, 3).setFontColor(over ? '#dc2626' : '#15803d');
    }
    if (r.kind !== 'category' && r.kind !== 'incomePart') line.setFontWeight('bold');
    if (headline(r)) line.setBackground('#eef2f7');
    if (headline(r) && r.kind !== 'incomePart') sh.getRange(at, 2).setFontSize(11);
    if (r.note) sh.getRange(at, 2).setNote(r.note);
    if (r.kind === 'group') line.setBorder(true, false, false, false, false, false, '#d1d5db', null);
    // The current block (C:E) stays white; the 3-month average (F) and earlier months (G on) are greyed back.
    sh.getRange(at, 3, 1, 3).setBackground(null);
    sh.getRange(at, 6, 1, 1 + hist).setBackground('#f1f3f5');
  });
  sh.getRange(momRow + 1, 3, shown.length + 1, 3)
    .setBorder(null, true, null, true, null, null, '#64748b', SpreadsheetApp.BorderStyle.SOLID_MEDIUM);

  // Totals row written into the blank line a table leaves after its rows.
  const totalRow = (values, moneyCols) => {
    sh.getRange(row - 1, 1, 1, values.length).setValues([values]).setFontWeight('bold').setBorder(true, false, false, false, false, false);
    moneyCols.forEach(c => sh.getRange(row - 1, c).setNumberFormat(money));
    row += 1;
  };
  const sum = (list, i) => list.reduce((s, x) => s + (Number(x[i]) || 0), 0);

  // Living costs: rent, office, power, internet, phone and so on, by category.
  const livingStart = row;
  row = table(row, 'Living costs', ['', 'Cost', 'Paid to', d.monthName, 'Avg / month', 'Per year'],
    d.livingCosts.map(c => [''].concat(c)), ['', '', '', money, money, money]);
  if (d.livingCosts.length) totalRow(['', 'Total', '', sum(d.livingCosts, 2), sum(d.livingCosts, 3), sum(d.livingCosts, 4)], [4, 5, 6]);
  else sh.getRange(livingStart + 2, 2).setValue('No living costs found yet. Tag rent and bills in Categories.').setFontColor(grey);

  // Subscriptions: services you could cancel or downgrade.
  const subsStart = row;
  row = table(row, 'Subscriptions', ['', 'Merchant', 'Category', 'How often', 'Last charged', 'Last amount', 'Per month', 'Per year'],
    d.subscriptions.map(s => [''].concat(s)), ['', '', '', '', 'd mmm', money, money, money]);
  if (d.subscriptions.length) totalRow(['', 'Total', '', '', '', '', sum(d.subscriptions, 5), sum(d.subscriptions, 6)], [7, 8]);
  else sh.getRange(subsStart + 2, 2).setValue('No subscriptions charged in the last 45 days.').setFontColor(grey);

  // Recurring lifestyle: gym, massage, barber, your regular cafes and the like, paid for regularly.
  if (d.services.length) {
    row = table(row, 'Recurring lifestyle', ['', 'Where', 'Category', 'How often', 'Last paid', 'Last amount', 'Per month', 'Per year'],
      d.services.map(s => [''].concat(s)), ['', '', '', '', 'd mmm', money, money, money]);
    totalRow(['', 'Total', '', '', '', '', sum(d.services, 5), sum(d.services, 6)], [7, 8]);
  }

  // No charts here: the Forecast has them.
  if (sh.getMaxColumns() > 20) sh.showColumns(20, sh.getMaxColumns() - 19);
}

/** The numbers behind the Dashboard. Plain data in and out, so it can be tested without a spreadsheet. */
function dashboardData_(summary, merchants, accounts, targets, actions, history, holdings, recurring, flows, tx) {
  const { months, income, totals, spend } = summary;
  const groupTotals = summary.groupTotals || {}, order = summary.order || [];
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const label = m => MON[Number(m.slice(5)) - 1] + ' ' + m.slice(0, 4);
  const round = n => Math.round((n || 0) * 100) / 100;
  const avg = list => list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0;

  const last = months[months.length - 2];                              // last full month
  const prev3 = months.slice(-5, -2);                                  // the three before it
  const full3 = months.slice(-4, -1);                                  // last three full months
  const typicalSpend = avg(full3.map(m => totals[m]));
  const overrides = typeOverrides_(holdings);
  const cash = accounts.filter(a => CASH_TYPES.includes(String(a[1]).toUpperCase()) && syncedType_(a[0], a[1], overrides) === 'Cash')
    .reduce((sum, a) => sum + (Number(a[5]) || 0), 0);
  // Saved last month: for committed or done actions with a Track, the drop from Baseline to last month's spend;
  // otherwise the Actual saving you entered on a Done action.
  const saved = actions.filter(a => a[1] && (isCommitted_(a[8]) || /^done$/i.test(String(a[8]).trim()))).reduce((sum, a) => {
    if (String(a[11] || '').trim() && a[14] !== '' && a[14] != null && Number(a[12])) return sum + Math.max(0, Number(a[12]) - Number(a[14]));
    return sum + (/^done$/i.test(String(a[8]).trim()) ? Number(a[9]) || 0 : 0);
  }, 0);

  // Order matters: the Dashboard shows these as two rows of four (Net worth is added first when there's history).
  const kpis = [
    ['Take-home income', round(income[last]), '$#,##0'],
    ['Spent', round(totals[last]), '$#,##0'],
    ['Left over', round(income[last] - totals[last]), '$#,##0;-$#,##0'],
    ['Spent vs 3-mo avg', round(totals[last] - avg(prev3.map(m => totals[m]))), '+$#,##0;-$#,##0;$0'],
    ['Bills', round((groupTotals.Bills || {})[last]), '$#,##0'],
    ['Runway', typicalSpend ? Math.round(cash / typicalSpend * 10) / 10 : '', '0.0 "mo"'],
    ['Saved by actions last month', round(saved), '$#,##0']
  ];

  // Net worth by month from Net worth history (one row per month, latest figure in that month).
  const worth = {};
  (history || []).forEach(h => {
    const m = Object.prototype.toString.call(h[0]) === '[object Date]'
      ? h[0].getFullYear() + '-' + String(h[0].getMonth() + 1).padStart(2, '0') : String(h[0]).trim();
    if (/^\d{4}-\d{2}$/.test(m) && h[7] !== '') worth[m] = Number(h[7]) || 0;
  });
  const worthMonths = Object.keys(worth).sort();
  if (worthMonths.length) kpis.unshift(['Net worth', round(worth[worthMonths[worthMonths.length - 1]]), '$#,##0']);
  const netWorth = [['Month', 'Net worth']].concat(worthMonths.slice(-12).map(m => [label(m), round(worth[m])]));

  // Committed actions first, then suggestions, by rank.
  const open = actions
    .filter(a => a[1] && !/^(done|dropped)$/i.test(String(a[8]).trim()))
    .sort((a, b) => (isCommitted_(b[8]) - isCommitted_(a[8])) || (Number(a[0]) || 99) - (Number(b[0]) || 99))
    .slice(0, 10)
    .map(a => [a[0], a[1], Number(a[3]) || '', Number(a[3]) ? round(a[3] * 12) : '', a[8] || 'Suggested', a[16] || '']);

  const lower = s => String(s || '').trim().toLowerCase();
  const shared = goalBalances_(targets, a => findAccount_(a, accounts.map(x => x[0])),
    name => { const x = accounts.find(y => y[0] === name); return x ? Number(x[5]) || 0 : null; });
  const catSpend = name => {
    const key = Object.keys(spend).find(c => lower(c) === lower(name));
    return key ? spend[key][last] || 0 : 0;
  };
  // Only savings goals and debts: spending limits show as the Target column in Month over month, and planned
  // purchases on the Forecast.
  // Where a goal's money sits: just the account name(s), e.g. "Save" or "Growth portfolio + Kids portfolio".
  const accRow = n => accounts.find(a => a[0] === n) || [];
  const shortName = n => String(n).replace(/\s*\([^)]*\)\s*$/, '');
  // With the provider in front, once per provider: "BNZ / Savings #Home", "Sharesies / Growth portfolio + Kids portfolio".
  const providerOf = n => String(accRow(n)[8] || '').trim();
  const whereOf = list => {
    const byProvider = {};
    (list || []).forEach(n => { const p = providerOf(n); (byProvider[p] = byProvider[p] || []).push(p ? shortName(n).replace(/^[\/#]\s*/, '') : shortName(n)); });
    return Object.keys(byProvider).map(p => (p ? p + ' / ' : '') + byProvider[p].join(' + ')).join(' + ');
  };
  // Goals that fill themselves (KiwiSaver, Holdings) never get payday transfers.
  const isOwn = list => (list || []).length > 0 && list.every(n => /KIWISAVER|^HOLDING/.test(String(accRow(n)[1] || '').toUpperCase()) || /kiwisaver/i.test(n));
  // Biggest goal first (House, then Car, ...), then debts; planned purchases follow below.
  const tgts = targets
    .map((t, i) => [t, shared[i]])
    .filter(([t]) => t[0] && !/^example/i.test(String(t[8])) && isGoalKind_(t[1]))
    .sort(([a], [b]) => (/debt/i.test(a[1]) - /debt/i.test(b[1])) || (Number(b[3]) || 0) - (Number(a[3]) || 0))
    .map(([t, g]) => {
      const kind = String(t[1]).trim(), aim = Number(t[3]) || '', current = t[5] === '' ? null : Number(t[5]);
      let now = '';
      if (kind === 'Savings goal') now = current != null ? current : g.now != null ? g.now : '';
      else if (kind === 'Spending limit') now = catSpend(t[2]);
      else if (kind === 'Income target') now = income[last];
      else if (kind === 'Debt payoff') now = current != null ? current : g.now != null ? Math.abs(g.now) : '';
      else if (isPlanKind_(kind)) {   // the paying account's balance, so Progress shows whether it's covered
        const acct = accounts.find(x => lower(x[0]) === lower(t[2])) || accounts.find(x => appliesToAccount_(t[2], x[0]));
        now = acct ? Number(acct[5]) || 0 : '';
      }
      const ratio = kind !== 'Debt payoff' && aim && now !== '' ? Math.min(round(now / aim), 9.99) : '';
      return { name: t[0], kind: whereOf(g.accounts) || kind, aim, now: now === '' ? '' : round(now), ratio, own: isOwn(g.accounts) };
    });
  // Goals named "Base (part)" that share a base, like "House deposit (Cash)" and "House deposit (KiwiSaver)", become a
  // section: a bold row with the full target and what's saved across them, then each part indented.
  const baseOf = n => (String(n).match(/^(.*\S)\s*\(([^)]+)\)\s*$/) || [])[1] || '';
  const sections = {};
  tgts.forEach(g => { const b = baseOf(g.name); if (b) sections[b] = (sections[b] || 0) + 1; });
  const grouped = [], done = new Set();
  tgts.forEach(g => {
    const b = baseOf(g.name);
    if (!b || sections[b] < 2) { grouped.push(g); return; }
    if (done.has(b)) return;
    done.add(b);
    const parts = tgts.filter(x => baseOf(x.name) === b);
    const aim = parts.reduce((s, x) => s + (Number(x.aim) || 0), 0), now = parts.reduce((s, x) => s + (Number(x.now) || 0), 0);
    grouped.push({ name: b, kind: '', aim: round(aim), now: round(now), ratio: aim ? Math.min(round(now / aim), 9.99) : '',
                   header: true, note: /house/i.test(b) ? 'Full deposit target: the selected scenario on Home scenarios' : '' });
    parts.forEach(x => grouped.push(Object.assign({}, x, { name: '    ' + String(x.name).match(/\(([^)]+)\)\s*$/)[1] })));
  });
  tgts.length = 0;
  grouped.forEach(g => tgts.push(g));

  // Planned purchases, soonest first: Now is what the paying account (or all cash) has for it after the purchases
  // before it, so Progress is how much of the cost is covered today.
  const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isDate = v => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
  const cashAll = accounts.filter(a => CASH_TYPES.includes(String(a[1]).toUpperCase()) && !RESERVED_NAME.test(String(a[0])))
    .reduce((s, a) => s + (Number(a[5]) || 0), 0);
  // Grouped by the account that pays: a header row with the account's balance against everything planned from it
  // (and a bar), then its purchases indented underneath.
  const remaining = {}, byAcct = {};
  targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && isPlanKind_(t[1]))
    .map(t => ({ t, when: isDate(t[4]) ? t[4].getTime() : 0 })).sort((a, b) => a.when - b.when)
    .forEach(({ t }) => {
      const acct = String(t[2] || '').trim() ? findAccount_(t[2], accounts.map(a => a[0])) : 'All cash';
      const when = isDate(t[4]) ? MON3[t[4].getMonth()] + ' ' + t[4].getFullYear() : 'now';
      if (!acct) {
        (byAcct['?'] = byAcct['?'] || []).push({ name: '    ' + t[0] + ', ' + when, kind: 'no account matches Applies to', aim: Number(t[3]) || 0,
                                                  now: '', ratio: '', plan: true });
        return;
      }
      if (remaining[acct] == null) remaining[acct] = acct === 'All cash' ? cashAll : Number((accounts.find(a => a[0] === acct) || [])[5]) || 0;
      const cost = Number(t[3]) || 0, have = Math.max(Math.min(remaining[acct], cost), 0);
      remaining[acct] -= cost;
      (byAcct[acct] = byAcct[acct] || []).push({ name: '    ' + t[0] + ', ' + when, kind: acct === 'All cash' ? acct : whereOf([acct]), aim: cost, now: round(have),
                                                  ratio: cost ? round(have / cost) : '', plan: true });
    });
  Object.keys(byAcct).forEach(acct => {
    const items = byAcct[acct], planned = items.reduce((s, x) => s + x.aim, 0);
    if (acct !== '?') {
      const bal = acct === 'All cash' ? cashAll : Number((accounts.find(a => a[0] === acct) || [])[5]) || 0;
      tgts.push({ name: 'Planned purchases', kind: acct === 'All cash' ? acct : whereOf([acct]), aim: round(planned),
                  now: round(bal), ratio: planned ? Math.min(round(bal / planned), 1) : '', plan: true, header: true });
    }
    items.forEach(x => tgts.push(x));
  });

  // Unallocated: each account's balance not claimed by a goal or a planned purchase, so every dollar shows somewhere.
  // An account holding a savings goal belongs to its goals entirely: like the goals themselves, the last one takes
  // whatever is left, growth past the target included. Purchases claim their cost. Tax money, debts and money owed
  // to you are left out (they have their own place on Net worth).
  const bal = n => Number(accRow(n)[5]) || 0;
  const claimed = {};
  const claim = (n, v) => { claimed[n] = (claimed[n] || 0) + v; };
  targets.forEach((t, i) => {
    if (!t[0] || /^example/i.test(String(t[8])) || !isGoalKind_(t[1]) || /debt/i.test(t[1])) return;
    (shared[i].accounts || []).forEach(n => claim(n, Infinity));
  });
  targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && isPlanKind_(t[1])).forEach(t => {
    const n = String(t[2] || '').trim() ? findAccount_(t[2], accounts.map(a => a[0])) : '';
    if (n) claim(n, Number(t[3]) || 0);
  });
  // Set aside for tax: the tax and GST accounts, money owed to IRD. Shown so every dollar appears, not counted as yours.
  const taxAccts = accounts.filter(a => a[0] && RESERVED_NAME.test(String(a[0]))), taxRows = [];
  if (taxAccts.length) {
    taxRows.push({ name: 'Tax & GST', kind: '', aim: '', now: round(taxAccts.reduce((s, a) => s + bal(a[0]), 0)), ratio: '', header: true, reserved: true });
    taxAccts.forEach(a => taxRows.push({ name: '    ' + shortName(a[0]).replace(/^[\/#]\s*/, ''), kind: whereOf([a[0]]), aim: '', now: round(bal(a[0])), ratio: '', reserved: true }));
  }
  // Budget: the accounts your spending budget runs through (Paid from on Targets, else Bills group from Bills and the
  // rest from Monthly or Everyday), plus where pay lands as the buffer. Aim is the monthly amount (weekly for
  // Everyday when Monthly feeds it), Now the balance. They belong to the budget, so they aren't unallocated.
  const bud = budget_(targets, avg(full3.map(m => income[m] || 0)));
  let budgetLines = [];   // [{a, amt}] each budget account's monthly amount, for the invoice split
  const budgetRows = [];   // shown last, after Unallocated
  if (bud) {
    const names = accounts.map(a => a[0]), find = w => names.find(n => String(n).toLowerCase().includes(w)) || '';
    const monthly = find('monthly') || find('budget'), everyday = find('everyday'), bills = find('bills') || monthly || everyday;
    const groupLow = {};
    Object.keys(summary.groupOfCat || {}).forEach(c => { groupLow[c.toLowerCase()] = summary.groupOfCat[c]; });
    const perAcct = {}, catsOf = {};
    Object.keys(bud.byCat).forEach(c => {
      const a = bud.from[c] ? findAccount_(bud.from[c], names) : groupLow[c] === 'Bills' ? bills : monthly || everyday;
      if (a && !claimed[a]) { perAcct[a] = (perAcct[a] || 0) + bud.byCat[c]; (catsOf[a] = catsOf[a] || []).push(c); }
    });
    budgetLines = Object.keys(perAcct).map(a => ({ a, amt: perAcct[a], cats: catsOf[a] }));
    const rows = Object.keys(perAcct).map(a => ({ a, aim: perAcct[a], label: shortName(a).replace(/^[\/#]\s*/, '') }));
    // Everyday gets the weekly top-up from Monthly; if categories are also paid from it (automatic payments), its
    // monthly amount is those, and the label says both.
    if (monthly && everyday && perAcct[monthly] && !claimed[everyday]) {
      const weekly = Math.round(perAcct[monthly] * 12 / 52), base = shortName(everyday).replace(/^[\/#]\s*/, '');
      const own = rows.find(r => r.a === everyday);
      if (own) own.label = base + ' (automatic payments, plus $' + weekly + ' a week from ' + shortName(monthly).replace(/^[\/#]\s*/, '') + ')';
      else rows.push({ a: everyday, aim: perAcct[monthly] * 12 / 52, label: base + ' (weekly)' });
    }
    const pay = find('invoice');
    if (pay && !claimed[pay] && !perAcct[pay]) rows.push({ a: pay, aim: 0, label: shortName(pay).replace(/^[\/#]\s*/, '') + ' (pay lands, then moved out)' });
    if (rows.length) {
      // The weekly Everyday top-up comes out of Monthly's amount, so it isn't added to the total again.
      const sumAim = rows.reduce((s, r) => s + (/\(weekly\)$/.test(r.label) ? 0 : r.aim), 0), sumNow = rows.reduce((s, r) => s + bal(r.a), 0);
      budgetRows.push({ name: 'Budget', kind: '', aim: round(sumAim), now: round(sumNow), ratio: '', header: true, budget: true });
      rows.forEach(r => {
        claim(r.a, Infinity);
        budgetRows.push({ name: '    ' + r.label, kind: whereOf([r.a]), aim: round(r.aim), now: round(bal(r.a)),
                          ratio: r.aim ? Math.min(round(bal(r.a) / r.aim), 9.99) : '', budget: true });
      });
    }
  }
  const invoice = bud && tx ? invoiceSplit_(tx, targets, accounts, bud, budgetLines, summary.setAsideRate) : null;
  const free = accounts
    .filter(a => a[0] && !RESERVED_NAME.test(String(a[0])) && !/CREDITCARD|LOAN|MORTGAGE/i.test(String(a[1])) &&
                 !/^(debt|owed to you|reserved)$/i.test(String(a[9] || '')))
    .map(a => ({ n: a[0], v: round(bal(a[0]) - Math.min(Math.max(bal(a[0]), 0), claimed[a[0]] || 0)) }))
    .filter(x => x.v > 1).sort((a, b) => b.v - a.v);
  // Unallocated savings: always shown, so it's clear when every dollar has a job ($0) and when one doesn't.
  tgts.push({ name: 'Unallocated savings', kind: free.length ? '' : 'every dollar has a job', aim: '', now: round(free.reduce((s, x) => s + x.v, 0)),
              ratio: '', header: true, unalloc: true });
  free.forEach(x => tgts.push({ name: '    ' + shortName(x.n).replace(/^[\/#]\s*/, ''), kind: whereOf([x.n]), aim: '', now: x.v, ratio: '', unalloc: true }));
  taxRows.forEach(r => tgts.push(r));
  budgetRows.forEach(r => tgts.push(r));   // order: goals, planned purchases, unallocated savings, tax & GST, budget

  const trend = [['Month', 'Income', 'Spend']].concat(months.map((m, i) =>
    [label(m) + (i === months.length - 1 ? ' (so far)' : ''), round(income[m]), round(totals[m])]));

  const prev = months[months.length - 3];
  const prev2 = months[months.length - 4];
  const momRow = (name, kind, series) => {
    const l = round(series[last] || 0), p = round(series[prev] || 0);
    return { name, kind, values: months.map(m => round(series[m] || 0)), prev2: round(series[prev2] || 0), prev: p, last: l, change: round(l - p), pct: p ? Math.round((l - p) / Math.abs(p) * 100) / 100 : '',
             avg: round(avg(prev3.map(m => series[m] || 0))) };
  };
  const left = {};
  months.forEach(m => { left[m] = income[m] - totals[m]; });
  // Each group, then its categories underneath, largest first (by the last three full months).
  const groupOfCat = summary.groupOfCat || {};
  const avg3 = c => full3.reduce((s, m) => s + (spend[c][m] || 0), 0);
  const nested = [];
  order.forEach(g => {
    nested.push(momRow(g, 'group', groupTotals[g]));
    Object.keys(spend).filter(c => (groupOfCat[c] || 'Other') === g).sort((a, b) => avg3(b) - avg3(a))
      .map(c => momRow('    ' + c, 'category', spend[c])).filter(r => r.values.some(v => v))
      .forEach(r => nested.push(r));
  });
  // Income sources: those with money in, plus any you have a rule for (summary.expectedIncome), so a new one shows
  // as $0 until it starts paying.
  const incomeBy = Object.assign({}, ...(summary.expectedIncome || []).map(src => ({ [src]: {} })), summary.incomeBy || {});
  const mom = { labels: months.map((m, i) => label(m) + (i === months.length - 1 ? ' (so far)' : '')),
                prev2Name: label(prev2), prevName: label(prev),
                rows: [momRow('Income', 'income', income)]
                  .concat(incomeSources_(incomeBy).map(src => momRow('    ' + src, 'incomePart', incomeBy[src])),
                          summary.setAsideRate ? [Object.assign(momRow('    Set aside for tax & GST (' + Math.round(summary.setAsideRate * 100) + '%)', 'incomePart',
                            Object.fromEntries(months.map(m => [m, -((summary.setAside || {})[m] || 0)]))),
                            { note: 'Your tax and GST rate: money you moved into Income Tax and Income GST over the last 12 months, divided by ' +
                                    'your gross income over the same 12 months (' + Math.round(summary.setAsideRate * 100) + '%). Each month\'s ' +
                                    'income is reduced by that rate, so take-home stays steady even though you move tax money in batches. ' +
                                    'It covers both income tax and GST, because both accounts count.' })] : [],
                          [momRow('Total spend', 'spend', totals), momRow('Left over', 'net', left)])
                  .concat(worth[last] != null && (worth[prev] != null || worth[prev2] != null) ? [momRow('Net worth', 'net', worth)] : [],
                          nested) };
  // Budget targets beside the months: income, spending budget, savings (Left over), and each category's limit; a
  // group's target is the sum of its categories' limits.
  const plan = budget_(targets, avg(full3.map(m => income[m] || 0)));   // same months as the Forecast and Payday plan
  mom.budget = plan;
  mom.rows.forEach(r => {
    const cat = r.name.trim().toLowerCase();
    r.target = !plan ? '' : r.kind === 'income' ? plan.income : r.name === 'Total spend' ? plan.spending :
      r.name === 'Left over' ? plan.savings : r.kind === 'category' ? (plan.byCat[cat] != null ? plan.byCat[cat] : '') :
      r.kind === 'group' ? (() => { const cs = Object.keys(spend).filter(c => (groupOfCat[c] || 'Other') === r.name && plan.byCat[c.toLowerCase()] != null);
        return cs.length ? round(cs.reduce((s, c) => s + plan.byCat[c.toLowerCase()], 0)) : ''; })() : '';
  });
  if (plan) mom.rows.splice(mom.rows.findIndex(r => r.name === 'Left over') + 1, 0,
    { name: '    Buffer: budget not given to a category', kind: 'incomePart', values: months.map(() => ''), change: '', pct: '', avg: '', target: plan.unassigned });
  // Under Left over: where the savings went, account by account (largest goal first, then other savings accounts),
  // from money actually moved into each account, against its part of your Monthly savings target.
  if (flows) {
    const names = accounts.map(a => a[0]);
    const goalRows = targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && isGoalKind_(t[1]) && !/debt/i.test(t[1]))
      .map(t => ({ t, acct: findAccount_(goalAccounts_(t[2])[0], names) }))
      .filter(g => g.acct && !/kiwisaver/i.test(g.acct) && !/^HOLDING/.test(String((accounts.find(a => a[0] === g.acct) || [])[1]).toUpperCase()))
      .sort((a, b) => (Number(b.t[3]) || 0) - (Number(a.t[3]) || 0));
    const used = goalRows.map(g => g.acct);
    const others = names.filter(n => /savings/i.test(n) && !used.includes(n) && !RESERVED_NAME.test(n) &&
      !/^HOLDING/.test(String((accounts.find(a => a[0] === n) || [])[1]).toUpperCase()));
    const flowOf = list => Object.fromEntries(months.map(m => [m, list.reduce((s, a) => s + ((flows[a] || {})[m] || 0), 0)]));
    const isDateV = v => Object.prototype.toString.call(v) === '[object Date]' && !isNaN(v);
    const now = new Date(), until = d => (d.getFullYear() - now.getFullYear()) * 12 + d.getMonth() - now.getMonth();
    const plans = targets.filter(t => t[0] && !/^example/i.test(String(t[8])) && isPlanKind_(t[1]))
      .map(t => ({ name: t[0], account: findAccount_(t[2], names), cost: Number(t[3]) || 0, month: isDateV(t[4]) ? Math.max(until(t[4]), 0) : 0 }))
      .filter(p => p.account).sort((a, b) => a.month - b.month);
    const setAside = purchaseSetAsides_(plans, a => Number((accounts.find(x => x[0] === a) || [])[5]) || 0);
    const savingRows = goalRows.map(g => Object.assign(momRow('    Saved to ' + g.acct + ' (' + g.t[0] + ')', 'incomePart', flowOf([g.acct])),
      { target: plan && shareOf_(g.t[9]) ? round(plan.savings * shareOf_(g.t[9])) : '' }));
    if (others.length) savingRows.push(Object.assign(momRow('    Saved to ' + others.join(' + '), 'incomePart', flowOf(others)),
      { target: round(setAside.filter(p => others.includes(p.account)).reduce((s, p) => s + p.perMonth, 0)) || '' }));
    mom.rows.splice(mom.rows.findIndex(r => r.name === 'Left over') + 1, 0, ...savingRows);
  }

  // Current subscriptions: recurring merchants (or Subscriptions / Work categories) charged in the last 45 days,
  // leaving out fixed bills (anything else in the Bills group). Merchants rows: name, category, group, avg / month,
  // per year, charges / month, months seen, likely recurring, last charged, last amount.
  const recent = Date.now() - 45 * 864e5;
  // Other recurring merchants count only if the last charge is close to their monthly average (a fixed price) and
  // they aren't food, groceries or shopping, which recur without being subscriptions.
  const subCategory = c => /^(subscriptions|work|work tools)$|software|streaming/i.test(String(c).trim());
  const habit = c => /eating|restaurant|cafe|fast food|takeaway|grocer|supermarket|shopping|retail|bars/i.test(String(c));
  const fixedPrice = r => Number(r[3]) > 0 && Math.abs((Number(r[9]) || 0) - Number(r[3])) / Number(r[3]) <= 0.25;
  const row_ = r => [r[0], r[1], r[8], Number(r[9]) || '', round(Number(r[3]) || 0), round((Number(r[3]) || 0) * 12)];
  const charged = merchants.filter(r => r[8] && new Date(r[8]).getTime() >= recent);
  // Rows: merchant, category, how often, last charged, last amount, per month, per year.
  // Recurring charges split in two: Subscriptions (software and apps: your known list, or anything else that isn't
  // lifestyle, a bill or a habit) and Recurring lifestyle (eating out, fitness, personal care, health and
  // entertainment you pay for regularly, on a billing cycle, per visit or as a regular).
  const serviceCategory = c => isLifestyleCategory_(c);
  const asRow = r => [r.name, r.category, r.kind, r.last, r.lastAmt, round(r.perMonth), round(r.perMonth * 12)];
  const services = (recurring || []).filter(r => (r.service || (!r.known && serviceCategory(r.category))) && r.perMonth >= 10).map(asRow)
    .sort((a, b) => b[5] - a[5]);
  const subs = recurring
    ? recurring
        .filter(r => r.known || (!serviceCategory(r.category) && !isLivingCost_(r.category, groupOf_({}, r.category)) &&
                                 !habit(r.category) && !/^(trips|transport|rent|office rent)$/i.test(r.category)))
        .map(asRow)
    : charged
        .filter(r => !isLivingCost_(r[1], r[2]) && r[2] !== 'Transfer')
        .filter(r => subCategory(r[1]) || (r[7] === 'Yes' && !habit(r[1]) && fixedPrice(r)))
        .map(r => [r[0], r[1], 'monthly', r[8], Number(r[9]) || '', round(Number(r[3]) || 0), round((Number(r[3]) || 0) * 12)])
        .sort((a, b) => b[5] - a[5]);

  // Living costs: rent, office, power, internet, phone, insurance and the like, one row per category, from Summary.
  const livingCosts = Object.keys(spend).filter(c => isLivingCost_(c, (summary.groupOfCat || {})[c]))
    .map(c => {
      const avg3 = avg(full3.map(m => spend[c][m] || 0));
      const names = merchants.filter(r => r[1] === c).sort((a, b) => b[3] - a[3]).slice(0, 3).map(r => r[0]).join(', ');
      return [c, names, round(spend[c][last] || 0), round(avg3), round(avg3 * 12)];
    })
    .filter(r => r[2] || r[3])
    .sort((a, b) => b[3] - a[3]);

  return { invoice, monthName: label(last), kpis, mom, netWorth, subscriptions: subs, services, livingCosts, actions: open, targets: tgts, trend };
}

/** A stable merchant name: Akahu's merchant if there is one, else the description without card numbers, dates and refs. */
function merchantName_(merchant, description) {
  if (merchant) return String(merchant).trim();
  const noise = ['POS', 'EFTPOS', 'WD', 'VISA', 'DEBIT', 'CARD', 'PURCHASE', 'AP', 'DD', 'TFR'];
  // A short prefix before "*" is a card processor ("SMZ*Corner Cafe Co"), so name the business after it.
  const parts = String(description || '').split('*');
  description = parts.length > 1 && parts[0].trim().length <= 4 ? parts.slice(1).join(' ') : description;
  const words = String(description || '').toUpperCase().replace(/[^A-Z&' ]+/g, ' ').split(/\s+/)
    .filter(w => w.length > 1 && !noise.includes(w));
  return words.slice(0, 2).join(' ') || 'UNKNOWN';
}

/**
 * Money moving between your own accounts shows up twice: out of one, into another.
 * Pair same-currency, same-size amounts on different accounts within PAIR_WINDOW_DAYS and mark both
 * Transfer, so a BNZ -> Wise top-up isn't counted as spending and income. If one side is already
 * Transfer or Credit card payment, the other side gets the same. Rows in an Income category are never
 * paired, so a Categories rule mapping a payer to Income stops a false match.
 */
function markOwnTransfers_(ss) {
  const sh = ss.getSheetByName('Transactions');
  if (sh.getLastRow() < 3) return;
  const vals = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
  const cats = pairTransfers_(vals, loadRules_(ss).ruled);
  if (cats.some((c, i) => c[0] !== vals[i][7])) sh.getRange(2, 8, cats.length, 1).setValues(cats);
}

/**
 * Rows are Transactions values (at least 10 columns). Returns the My category column, updated.
 * ruled: lower-case categories that a Categories rule assigns. Those rows are never paired, so a rule tagging a
 * transfer as Rent (or a payer as Income) always wins.
 */
function pairTransfers_(vals, ruled) {
  ruled = ruled || new Set();
  const cats = vals.map(r => [r[7]]);
  const outs = [], ins = {};
  vals.forEach((r, i) => {
    const amt = Number(r[4]);
    if (!amt || isIncomeCategory_(r[7]) || ruled.has(String(r[7]).trim().toLowerCase())) return;
    const key = (r[9] || 'NZD') + ':' + Math.abs(amt).toFixed(2);
    if (amt < 0) outs.push({ i, key }); else (ins[key] = ins[key] || []).push(i);
  });
  outs.forEach(({ i, key }) => {
    const when = new Date(vals[i][0]).getTime();
    const j = (ins[key] || []).find(j => vals[j][1] !== vals[i][1] &&
      Math.abs(new Date(vals[j][0]).getTime() - when) <= PAIR_WINDOW_DAYS * 864e5);
    if (j === undefined) return;
    ins[key] = ins[key].filter(k => k !== j);
    const cat = [cats[i][0], cats[j][0]].find(c => EXCLUDE_FROM_SPEND.includes(c)) || 'Transfer';
    cats[i][0] = cat; cats[j][0] = cat;
  });
  return cats;
}
