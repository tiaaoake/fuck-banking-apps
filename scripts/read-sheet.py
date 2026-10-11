#!/usr/bin/env python3
"""Read the Personal Finance sheet with your clasp login, so Claude Code can review it without a Drive connector.

    python3 scripts/read-sheet.py              every tab to .cache/sheet.json, plus a size summary
    python3 scripts/read-sheet.py Dashboard    one tab, tab-separated

The sheet ID comes from apps-script/.clasp.json (parentId). clasp created the sheet, and clasp's login may read
files it created, so this exports it through the Drive API as .xlsx and parses it with the standard library.
Nothing leaves this machine except calls to Google. Run `clasp login` again if sign-in fails.
"""
import io, json, os, re, sys, urllib.parse, urllib.request, zipfile
from datetime import datetime, timedelta
from xml.etree import ElementTree as ET

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NS = {'m': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
      'p': 'http://schemas.openxmlformats.org/package/2006/relationships'}


def access_token():
    creds = json.load(open(os.path.expanduser('~/.clasprc.json')))['tokens']['default']
    body = urllib.parse.urlencode({'client_id': creds['client_id'], 'client_secret': creds['client_secret'],
                                   'refresh_token': creds['refresh_token'], 'grant_type': 'refresh_token'}).encode()
    with urllib.request.urlopen('https://oauth2.googleapis.com/token', body) as r:
        return json.load(r)['access_token']


def export_xlsx(sheet_id, token):
    mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    url = 'https://www.googleapis.com/drive/v3/files/%s/export?mimeType=%s' % (sheet_id, urllib.parse.quote(mime))
    req = urllib.request.Request(url, headers={'Authorization': 'Bearer ' + token})
    with urllib.request.urlopen(req) as r:
        return r.read()


def col_index(ref):
    n = 0
    for ch in re.match(r'[A-Z]+', ref).group(0):
        n = n * 26 + ord(ch) - 64
    return n - 1


def parse(xlsx):
    z = zipfile.ZipFile(io.BytesIO(xlsx))
    shared = []
    if 'xl/sharedStrings.xml' in z.namelist():
        for si in ET.fromstring(z.read('xl/sharedStrings.xml')).findall('m:si', NS):
            shared.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
    # Which cell styles are dates, so serial numbers come back as dates.
    styles = ET.fromstring(z.read('xl/styles.xml'))
    custom = {int(f.get('numFmtId')): f.get('formatCode') for f in styles.findall('m:numFmts/m:numFmt', NS)}
    def is_date(fid):
        code = custom.get(fid, '')
        return 14 <= fid <= 22 or (bool(re.search(r'[dy]', re.sub(r'"[^"]*"', '', code), re.I)) and '#' not in code)
    date_style = [is_date(int(x.get('numFmtId', 0))) for x in styles.findall('m:cellXfs/m:xf', NS)]

    rels = {r.get('Id'): r.get('Target') for r in ET.fromstring(z.read('xl/_rels/workbook.xml.rels')).findall('p:Relationship', NS)}
    tabs, hidden = {}, []
    for s in ET.fromstring(z.read('xl/workbook.xml')).findall('m:sheets/m:sheet', NS):
        name = s.get('name')
        if s.get('state') in ('hidden', 'veryHidden'):
            hidden.append(name)
        target = rels[s.get('{%s}id' % NS['r'])].lstrip('/')
        path = target if target.startswith('xl/') else 'xl/' + target
        rows = []
        for row in ET.fromstring(z.read(path)).findall('m:sheetData/m:row', NS):
            vals = {}
            for c in row.findall('m:c', NS):
                v, t = c.find('m:v', NS), c.get('t')
                if t == 's' and v is not None:
                    val = shared[int(v.text)]
                elif t == 'inlineStr':
                    val = ''.join(x.text or '' for x in c.iter('{%s}t' % NS['m']))
                elif v is None:
                    continue
                elif t in ('str', 'b', 'e'):
                    val = v.text
                else:
                    num = float(v.text)
                    if date_style[int(c.get('s', 0))] if int(c.get('s', 0)) < len(date_style) else False:
                        val = (datetime(1899, 12, 30) + timedelta(days=num)).strftime('%Y-%m-%d')
                    else:
                        val = int(num) if num.is_integer() else round(num, 4)
                vals[col_index(c.get('r'))] = val
            r = int(row.get('r')) - 1
            while len(rows) < r:
                rows.append([])
            rows.append([vals.get(i, '') for i in range(max(vals) + 1)] if vals else [])
        tabs[name] = rows
    return tabs, hidden


def main():
    sheet_id = json.load(open(os.path.join(ROOT, 'apps-script/.clasp.json'))).get('parentId')
    if not sheet_id:
        sys.exit('No parentId in apps-script/.clasp.json.')
    tabs, hidden = parse(export_xlsx(sheet_id, access_token()))
    if len(sys.argv) > 1:
        name = sys.argv[1]
        if name not in tabs:
            sys.exit('No tab "%s". Tabs: %s' % (name, ', '.join(tabs)))
        print('\n'.join('\t'.join(str(v) for v in r) for r in tabs[name]))
        return
    os.makedirs(os.path.join(ROOT, '.cache'), exist_ok=True)
    with open(os.path.join(ROOT, '.cache/sheet.json'), 'w') as f:
        json.dump({'readAt': datetime.now().isoformat(), 'tabs': tabs}, f, indent=1, default=str)
    print('Saved to .cache/sheet.json')
    for name, rows in tabs.items():
        print('  %-20s%5d rows%s' % (name, len(rows), '  (hidden)' if name in hidden else ''))


if __name__ == '__main__':
    main()
