#!/usr/bin/env python3
"""Where am I up to? Checks every setup step, in order, and says what to do next.

    python3 scripts/doctor.py            every check, including reading the sheet
    python3 scripts/doctor.py --offline  skip the checks that read the sheet

Safe to run any time. It reads, never writes (except the sheet cache read-sheet.py keeps), and never prints tokens
or balances: just counts, dates and percentages. The getting-started skill runs it to know which step comes next.
"""
import importlib.util, json, os, re, shutil, subprocess, sys
from datetime import date, datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OK, NO, SKIP = '[x]', '[ ]', '[-]'
results = []   # (section, mark, text, next step)


def check(section, ok, text, fix=''):
    results.append((section, OK if ok else NO, text, '' if ok else fix))
    return ok


def skip(section, text):
    results.append((section, SKIP, text, ''))


def path(p):
    return os.path.join(ROOT, p)


def version(cmd):
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=20).stdout
        m = re.search(r'(\d+)\.(\d+)', out)
        return (int(m.group(1)), int(m.group(2))) if m else None
    except Exception:
        return None


def tools():
    s = '1. Tools'
    check(s, shutil.which('git'), 'git installed', 'brew install git')
    node = version(['node', '--version'])
    check(s, node and node[0] >= 18, 'Node.js 18 or later', 'brew install node')
    check(s, sys.version_info >= (3, 8), 'Python 3.8 or later', 'brew install python')
    check(s, shutil.which('clasp'), 'clasp installed', 'npm install -g @google/clasp')


def local_files():
    s = '2. Your local files'
    mine = ['apps-script/my-rules.gs', 'apps-script/my-actions.gs',
            '.claude/skills/personal-finance-review/my-preferences.md', '.private-words']
    missing = [f for f in mine if not os.path.exists(path(f))]
    check(s, not missing, 'your my-* files exist', 'scripts/setup-local.sh')
    hooks = subprocess.run(['git', 'config', 'core.hooksPath'], cwd=ROOT, capture_output=True, text=True).stdout.strip()
    check(s, hooks == '.githooks', 'commit check turned on', 'scripts/setup-local.sh')
    words = []
    if os.path.exists(path('.private-words')):
        words = [w.strip() for w in open(path('.private-words')) if w.strip() and not w.startswith('#')]
    check(s, words and words != ['your surname'], '.private-words has your own words in it',
          'add your surname, employer and people you pay to .private-words, one per line')


def google():
    s = '3. Google'
    logged_in = check(s, os.path.exists(os.path.expanduser('~/.clasprc.json')), 'signed in to clasp',
                      'turn on the Apps Script API at script.google.com/home/usersettings, then: clasp login')
    conf = {}
    if os.path.exists(path('apps-script/.clasp.json')):
        try:
            conf = json.load(open(path('apps-script/.clasp.json')))
        except ValueError:
            pass
    sid, pid = str(conf.get('scriptId', '')), str(conf.get('parentId', '') or '')
    has_ids = check(s, sid and 'PASTE' not in sid and pid and 'PASTE' not in pid, 'sheet created, IDs in apps-script/.clasp.json',
                    'cd apps-script && clasp create --type sheets --title "Personal Finance" --rootDir . '
                    '(then restore appsscript.json from git and clasp push; see README step 3)')
    return logged_in and has_ids


def load_sheet():
    spec = importlib.util.spec_from_file_location('read_sheet', path('scripts/read-sheet.py'))
    rs = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(rs)
    sheet_id = json.load(open(path('apps-script/.clasp.json')))['parentId']
    tabs, _ = rs.parse(rs.export_xlsx(sheet_id, rs.access_token()))
    os.makedirs(path('.cache'), exist_ok=True)
    with open(path('.cache/sheet.json'), 'w') as f:
        json.dump({'readAt': datetime.now().isoformat(), 'tabs': tabs}, f, indent=1, default=str)
    return tabs


def num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def sheet(tabs):
    s = '4. Sheet and bank feeds'
    if not check(s, 'Dashboard' in tabs and 'Targets' in tabs, 'tabs created (setup has run)',
                 'clasp push, then in the Apps Script editor run setup (README step 6)'):
        return
    accounts = [r for r in tabs.get('Accounts', [])[1:] if r and r[0]]
    tx = [r for r in tabs.get('Transactions', [])[1:] if len(r) > 10 and r[0]]
    if not check(s, accounts, 'bank feeds connected (%d accounts)' % len(accounts),
                 'add AKAHU_APP_TOKEN and AKAHU_USER_TOKEN in Apps Script > Project Settings > Script properties, '
                 'then run sync (README steps 4 to 6)'):
        return
    check(s, tx, 'transactions synced (%d)' % len(tx), 'run Finance > Sync banking feeds')
    updated = [str(r[6])[:10] for r in accounts if len(r) > 6 and re.match(r'\d{4}-\d\d-\d\d', str(r[6]))]
    if updated:
        age = (date.today() - date.fromisoformat(max(updated))).days
        check(s, age <= 2, 'synced recently (%d days ago)' % age,
              'run installAutoRefresh once in the Apps Script editor for a daily sync (README step 7)')
    return tx


def dashboard(tabs, tx):
    s = '5. Your dashboard (say "set up my dashboard")'
    # Spending in the last 3 months that is still uncategorised.
    y, m = date.today().year, date.today().month - 3
    cutoff = date(y - 1, m + 12, 1) if m <= 0 else date(y, m, 1)
    out, unc = 0.0, 0.0
    for r in tx or []:
        amt, cat = num(r[10]), str(r[7]).strip()
        if amt is None or amt >= 0 or not re.match(r'\d{4}-\d\d-\d\d', str(r[0])) or str(r[0])[:10] < cutoff.isoformat():
            continue
        if cat in ('Transfer', 'Credit card payment', 'Ignore', 'Loan'):
            continue
        out += -amt
        if cat == 'Uncategorised':
            unc += -amt
    share = round(100 * unc / out) if out else 0
    check(s, out and share <= 5, 'spending categorised (%d%% of the last 3 months still uncategorised)' % share,
          'sort the top rows on Uncategorised, or ask the AI to propose rules')
    sources = {str(r[7]).strip() for r in tx or [] if re.match(r'(?i)^income\s*:', str(r[7]).strip())}
    check(s, sources, 'income split by source (%d sources)' % len(sources),
          'give each payer an "Income: <Source>" rule (finance-setup step 3)')
    rules = open(path('apps-script/my-rules.gs')).read() if os.path.exists(path('apps-script/my-rules.gs')) else ''
    placeholders = [p for p in ('sent money to your name', 'employer name', 'landlord name') if p in rules]
    check(s, not placeholders, 'my-rules.gs placeholders replaced',
          'swap these in apps-script/my-rules.gs for your own, or delete them: ' + ', '.join(placeholders))
    targets = [r for r in tabs.get('Targets', [])[1:] if r and r[0] and not str(r[0]).lower().startswith('e.g')
               and 'example' not in ' '.join(str(v) for v in r).lower()]
    kinds = {str(r[1]).strip().lower() for r in targets if len(r) > 1}
    check(s, 'savings goal' in kinds, 'savings goals set (%d targets)' % len(targets), 'finance-setup step 7')
    check(s, any(str(r[0]).lower().startswith('stretch') or 'stretch' in str(r[8] if len(r) > 8 else '').lower()
                 for r in targets), 'a stretch goal set', 'finance-setup step 7')
    check(s, 'monthly savings' in kinds and 'spending limit' in kinds, 'monthly budget set (savings and spending limits)',
          'finance-setup step 8')
    prefs = path('.claude/skills/personal-finance-review/my-preferences.md')
    check(s, os.path.exists(prefs) and '# pay plan' in open(prefs).read().lower(), 'pay plan made (what moves where each payday)',
          'say "sort my pay"')
    actions = [r for r in tabs.get('Savings actions', [])[1:] if r and len(r) > 1 and r[1]]
    check(s, actions, 'first monthly review done', 'say "run my monthly review"')


def main():
    offline = '--offline' in sys.argv
    tools()
    local_files()
    ready = google()
    if offline:
        skip('4. Sheet and bank feeds', 'skipped (--offline)')
    elif not ready:
        skip('4. Sheet and bank feeds', 'needs the Google steps first')
    else:
        try:
            tabs = load_sheet()
            tx = sheet(tabs)
            if tx:
                dashboard(tabs, tx)
        except Exception as e:
            check('4. Sheet and bank feeds', False, "couldn't read the sheet (%s)" % type(e).__name__,
                  'run clasp login again; if you made the sheet by hand, see README step 3')
    section = None
    for sec, mark, text, fix in results:
        if sec != section:
            print('\n' + sec)
            section = sec
        print('  %s %s' % (mark, text) + ('\n        -> ' + fix if fix else ''))
    todo = [r for r in results if r[1] == NO]
    print('\nNext: ' + (todo[0][3] if todo else 'all set. Say "run my monthly review" once a month.'))


if __name__ == '__main__':
    main()
