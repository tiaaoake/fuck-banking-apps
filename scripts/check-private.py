#!/usr/bin/env python3
"""Stop personal data reaching git. Runs as the pre-commit hook and on GitHub.

    python3 scripts/check-private.py            every tracked file
    python3 scripts/check-private.py --staged   what's about to be committed (the pre-commit hook)
    python3 scripts/check-private.py --candidates  every file git would pick up, staged or not (the Claude Code guard)
    python3 scripts/check-private.py --message FILE  a commit message, where dollar amounts are blocked too

Blocks: your own files (my-*, .clasp.json, exports, .cache), emails, bank account and card numbers, Google file IDs,
API tokens, and any word in .private-words (gitignored: one per line, e.g. names of people you pay, your surname).
A line with "private-ok" in it is skipped, for a false alarm.
"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

# Files that are yours: the .example next to each is what gets committed.
PRIVATE_FILES = [
    (r'(^|/)my-[^/]*$', 'your own file; commit the .example instead'),
    (r'(^|/)\.clasp(rc)?\.json$', 'clasp login or script ID'),
    (r'\.(csv|xlsx|xls|ofx|qif)$', 'a money export'),
    (r'(^|/)(\.cache|exports)/', 'a local copy of the sheet'),
    (r'(^|/)\.env$', 'environment secrets'),
    (r'(^|/)\.private-words$', 'your private word list'),
]
EXAMPLE = re.compile(r'\.example$')

PATTERNS = [
    (r'[\w.+-]+@[\w-]+\.[\w.-]+', 'an email address',
     lambda m: m.endswith(('@anthropic.com', '@example.com')) or m.startswith('git@github.com')),
    (r'\b\d{2}-\d{4}-\d{7}-\d{2,3}\b', 'a NZ bank account number', None),
    (r'\b\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{4}\b', 'a card number', None),
    (r'\b1[A-Za-z0-9_-]{40,}\b', 'a Google file or script ID', None),
    (r'\b(user|app)_token_[A-Za-z0-9]+', 'an Akahu token', None),
    (r'\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b', 'a token or ID (UUID)', None),
]


def git(*args):
    return subprocess.run(['git', *args], cwd=ROOT, capture_output=True, text=True, check=True).stdout


def private_words():
    path = os.path.join(ROOT, '.private-words')
    if not os.path.exists(path):
        return []
    return [w.strip().lower() for w in open(path) if w.strip() and not w.startswith('#')]


# Commit messages only: amounts belong in the sheet, not in git history.
AMOUNT = (r'\$\s?\d[\d,]*(\.\d+)?\s?(k\b)?', 'a dollar amount')


def scan_lines(name, text, words, extra=()):
    found = []
    for n, line in enumerate(text.splitlines(), 1):
        if 'private-ok' in line:
            continue
        for pat, why, allow in PATTERNS:
            for m in re.finditer(pat, line):
                if not (allow and allow(m.group(0))):
                    found.append('%s:%d: %s' % (name, n, why))
        for pat, why in extra:
            if re.search(pat, line):
                found.append('%s:%d: %s' % (name, n, why))
        low = line.lower()
        found += ['%s:%d: a word from .private-words' % (name, n) for w in words if w in low]
    return found


def report(problems, what):
    if problems:
        print('Personal data found, so this is blocked:\n  ' + '\n  '.join(sorted(set(problems))))
        print('Move it to a my-* file (gitignored), or add "private-ok" to the line if it is a false alarm.')
        sys.exit(1)
    print('No personal data found in %s.' % what)


def main():
    words = private_words()
    if '--message' in sys.argv:
        path = sys.argv[sys.argv.index('--message') + 1]
        text = '\n'.join(l for l in open(path).read().splitlines() if not l.startswith('#'))
        report(scan_lines('commit message', text, words, [AMOUNT]), 'the commit message')
        return
    staged = '--staged' in sys.argv
    if staged:
        files = [f for f in git('diff', '--cached', '--name-only', '--diff-filter=ACMR').splitlines() if f]
        read = lambda f: git('show', ':' + f)
    else:
        args = ['ls-files', '-co', '--exclude-standard'] if '--candidates' in sys.argv else ['ls-files']
        files = [f for f in git(*args).splitlines() if f and os.path.exists(os.path.join(ROOT, f))]
        read = lambda f: open(os.path.join(ROOT, f), encoding='utf-8', errors='replace').read()
    problems = []
    for f in files:
        if not EXAMPLE.search(f):
            hit = next((why for pat, why in PRIVATE_FILES if re.search(pat, f)), None)
            if hit:
                problems.append('%s: %s' % (f, hit))
                continue
        try:
            text = read(f)
        except (subprocess.CalledProcessError, OSError):
            continue
        if '\0' not in text:
            problems += scan_lines(f, text, words)
    report(problems, '%d file%s' % (len(files), '' if len(files) == 1 else 's'))


if __name__ == '__main__':
    main()
