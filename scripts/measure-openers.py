#!/usr/bin/env python3
"""Measure how many reasoning blocks open with a given phrase.

Usage:
  measure-openers.py <session-dir> [--phrase "We need"] [--cutoff ISO8601] [--split-step N]

Counts assistant reasoning blocks, optionally split before/after a cutoff instant,
and optionally separated into first-step vs later-step blocks.
"""
import argparse, datetime, glob, json, os, subprocess, sys


def load_events(session_dir: str):
    files = glob.glob(os.path.join(session_dir, '*.zstd'))
    if not files:
        sys.exit('no .zstd record in ' + session_dir)
    raw = subprocess.run(['zstd', '-dc', files[0]], capture_output=True).stdout.decode('utf-8', 'replace')
    for line in raw.splitlines():
        try:
            yield json.loads(line)
        except Exception:
            continue


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument('session_dir')
    ap.add_argument('--phrase', default='We need')
    ap.add_argument('--cutoff', default=None, help='ISO8601, e.g. 2026-10-27T08:00:53Z')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    cutoff = None
    if args.cutoff:
        cutoff = datetime.datetime.fromisoformat(args.cutoff.replace('Z', '+00:00')).timestamp() * 1000

    buckets = {'all': [0, 0], 'before': [0, 0], 'after': [0, 0]}
    rows = []
    for event in load_events(args.session_dir):
        if event.get('type') != 'assistant/message':
            continue
        at = event.get('time') or 0
        step = (event.get('data') or {}).get('step')
        message = (event.get('data') or {}).get('message') or {}
        for part in message.get('content') or []:
            if not (isinstance(part, dict) and part.get('type') == 'reasoning'):
                continue
            head = ' '.join((part.get('text') or '').split())
            hit = head.startswith(args.phrase)
            buckets['all'][0] += 1
            buckets['all'][1] += hit
            key = 'after' if cutoff is not None and at >= cutoff else 'before' if cutoff is not None else None
            if key:
                buckets[key][0] += 1
                buckets[key][1] += hit
            rows.append((at, step, hit, head[:60]))

    for key in ('all', 'before', 'after'):
        n, hit = buckets[key]
        if n:
            print('%-7s blocks=%3d  %s=%3d (%.0f%%)' % (key, n, args.phrase, hit, 100.0 * hit / n))
    if args.verbose:
        for _, step, hit, head in rows:
            print(('  HIT  ' if hit else '   .   ') + 'step=%s %s' % (step, head))


if __name__ == '__main__':
    main()
