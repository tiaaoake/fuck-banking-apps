#!/usr/bin/env python3
"""Read and resolve comments on the Personal Finance sheet, with the clasp login (like read-sheet.py).

    python3 scripts/comments.py                     list open comments
    python3 scripts/comments.py resolve FILE.json   reply to and resolve comments: {"comment id": "reply text", ...}

Comments are read through the Drive API. Nothing is stored; replies come from a file so their text never sits in a
shell command.
"""
import importlib.util, json, os, sys, urllib.parse, urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
spec = importlib.util.spec_from_file_location('read_sheet', os.path.join(ROOT, 'scripts/read-sheet.py'))
read_sheet = importlib.util.module_from_spec(spec)
spec.loader.exec_module(read_sheet)


def call(url, body=None):
    req = urllib.request.Request(url, data=json.dumps(body).encode() if body else None,
                                 headers={'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json'})
    with urllib.request.urlopen(req) as r:
        return json.load(r)


TOKEN = read_sheet.access_token()
SHEET = json.load(open(os.path.join(ROOT, 'apps-script/.clasp.json')))['parentId']
BASE = 'https://www.googleapis.com/drive/v3/files/%s/comments' % SHEET


def main():
    if len(sys.argv) > 2 and sys.argv[1] == 'resolve':
        for cid, text in json.load(open(sys.argv[2])).items():
            call('%s/%s/replies?fields=id' % (BASE, cid), {'content': text, 'action': 'resolve'})
            print('resolved', cid)
        return
    fields = urllib.parse.quote('comments(id,content,resolved,quotedFileContent,createdTime,replies(content))')
    for c in call('%s?pageSize=100&fields=%s' % (BASE, fields)).get('comments', []):
        if c.get('resolved'):
            continue
        quoted = (c.get('quotedFileContent') or {}).get('value', '').strip()
        print('-', c['id'], c['createdTime'][:16], '|', quoted[:60], '|', c['content'].replace('\n', ' '))


if __name__ == '__main__':
    main()
