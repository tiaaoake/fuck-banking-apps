#!/usr/bin/env node
// Preview the daily money email locally, built by the same code the sheet sends it with. Nothing is sent.
//
//   python3 scripts/read-sheet.py                     refresh .cache/sheet.json from the live sheet first
//   node scripts/preview-email.js                      today, and the next Friday (shows the Friday plan)
//   node scripts/preview-email.js 2026-10-06 2026-10-09   chosen dates
//   node scripts/preview-email.js --sample             made-up data, for trying it without a sheet
//
// Writes .cache/email-preview.html (gitignored: it holds your numbers) and prints its path.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.join(__dirname, '..');
const ctx = { Utilities: { formatDate: d => '' }, console };
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(root, 'apps-script/finance-sync.gs'), 'utf8') +
  ';this.data=dailyEmailData_;this.render=dailyEmailHtml_;this.withHoldings=accountsWithHoldings_;', ctx);

const args = process.argv.slice(2), sample = args.includes('--sample');
const dates = args.filter(a => /^\d{4}-\d{2}-\d{2}$/.test(a)).map(a => new Date(a + 'T07:00:00'));
if (!dates.length) {
  const today = new Date(); today.setHours(7, 0, 0, 0);
  const friday = new Date(today); friday.setDate(today.getDate() + ((5 - today.getDay() + 7) % 7 || 7));
  dates.push(today, friday);
}

let tx, accounts, targets, groupOf, url = '#';
if (sample) {
  const d = n => { const x = new Date(); x.setDate(x.getDate() - n); return x; };
  const row = (n, acc, amt, cat, who) => [d(n), acc, '', who, amt, '', '', cat, 'id', 'NZD', amt, ''];
  tx = [row(1, '# Everyday', -24, 'Eating out', 'Corner Cafe'), row(2, '# Everyday', -160, 'Eating out', 'Friday Bistro'),
        row(3, '# Everyday', -85, 'Groceries', 'Supermarket'), row(35, '# Everyday', -900, 'Eating out', 'Last month')];
  accounts = [['# Everyday', 'CHECKING', 'NZD', 420, 0, 420], ['# Monthly', 'CHECKING', 'NZD', 2100, 0, 2100], ['/ Savings #Home', 'CHECKING', 'NZD', 8000, 0, 8000]];
  targets = [['Monthly savings', 'Monthly savings', '', 2000, '', '', '', '', ''], ['Eating out', 'Spending limit', 'Eating out', 400, '', '', '', '', ''],
             ['Groceries', 'Spending limit', 'Groceries', 700, '', '', '', '', ''], ['House deposit', 'Savings goal', '#Home', 40000, '', '', '', 1, '', 1]];
  groupOf = () => 'Everyday';
} else {
  const file = path.join(root, '.cache/sheet.json');
  if (!fs.existsSync(file)) { console.error('No .cache/sheet.json yet. Run: python3 scripts/read-sheet.py (or use --sample)'); process.exit(1); }
  const tabs = JSON.parse(fs.readFileSync(file, 'utf8')).tabs;
  const body = name => (tabs[name] || []).slice(1).filter(r => r.length)
    .map(r => r.map(v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : v));
  tx = body('Transactions'); accounts = ctx.withHoldings(body('Accounts'), body('Balance history')); targets = body('Targets');
  const groups = {};
  (tabs['Summary'] || []).slice(1).forEach(r => { if (r[0] && r[1]) groups[String(r[0]).trim()] = r[1]; });
  groupOf = c => groups[c] || 'Everyday';
  try { url = 'https://docs.google.com/spreadsheets/d/' + JSON.parse(fs.readFileSync(path.join(root, 'apps-script/.clasp.json'), 'utf8')).parentId + '/edit'; } catch (e) {}
}

const day = d => d.toLocaleDateString('en-NZ', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' });
const drafts = dates.map(d => {
  const m = ctx.data(tx, accounts, targets, d, groupOf), e = ctx.render(m, url);
  return '<section style="border:1px solid #ddd;border-radius:8px;padding:16px 20px;margin:0 0 28px;background:#fff">' +
    '<div style="color:#666;font-size:13px">' + day(d) + ' at 7am' + (sample ? ' (sample data)' : '') + '</div>' +
    '<div style="margin:6px 0 14px"><b>Subject:</b> ' + m.subject + '</div><hr style="border:0;border-top:1px solid #eee">' + e.html + '</section>';
});
const out = path.join(root, '.cache/email-preview.html');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Daily email preview</title><body style="background:#f6f6f6;max-width:640px;margin:24px auto;padding:0 16px;font:15px/1.55 Arial,sans-serif;color:#111">' +
  '<h2 style="font-size:18px">Daily email preview (not sent)</h2>' + drafts.join('') + '</body>');
console.log(out);
