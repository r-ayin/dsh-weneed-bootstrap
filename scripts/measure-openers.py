#!/usr/bin/env python3
"""Measure how many reasoning blocks open with a given phrase.

Usage:
  measure-openers.py <session-dir> [<session-dir> ...] [--phrase "We need"]
                     [--cutoff ISO8601] [--model SUBSTR] [--verbose]

Unit = one reasoning part of an assistant/message event.
Every block is tagged with:
  * model  - from the latest request/header (config) or model/selection seen before it
  * step   - data.step; step 1 = first block of a new turn, step >= 2 = in-turn
  * phase  - before/after --cutoff (if given)
Buckets are printed per model, so different models are never pooled (EXPLORATION.md section 6).
"""
import argparse, collections, datetime, glob, json, os, subprocess, sys


def load_events(session_dir):
    files = sorted(glob.glob(os.path.join(session_dir, '*.zstd')))
    if not files:
        sys.exit('no .zstd record in ' + session_dir)
    for f in files:
        raw = subprocess.run(['zstd', '-dc', f], capture_output=True).stdout.decode('utf-8', 'replace')
        for line in raw.splitlines():
            try:
                yield json.loads(line)
            except Exception:
                continue


def model_of(obj):
    """Find a model id inside a header/config/selection payload."""
    if not isinstance(obj, dict):
        return None
    for key in ('model', 'modelId', 'model_id'):
        v = obj.get(key)
        if isinstance(v, str) and v:
            prov = obj.get('provider') or obj.get('providerId')
            return (prov + '/' + v) if isinstance(prov, str) and prov and '/' not in v else v
        if isinstance(v, dict):
            inner = model_of(v)
            if inner:
                return inner
    for key in ('config', 'header', 'selection', 'adapterDefaults', 'target'):
        inner = model_of(obj.get(key))
        if inner:
            return inner
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('session_dirs', nargs='+')
    ap.add_argument('--phrase', default='We need')
    ap.add_argument('--cutoff', default=None, help='ISO8601, e.g. 2026-10-27T08:00:53Z')
    ap.add_argument('--model', default=None, help='only count blocks whose model contains this substring')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    cutoff = None
    if args.cutoff:
        cutoff = datetime.datetime.fromisoformat(args.cutoff.replace('Z', '+00:00')).timestamp() * 1000

    buckets = collections.defaultdict(lambda: [0, 0])
    rows = []
    for sd in args.session_dirs:
        model = 'unknown'
        for event in load_events(sd):
            t = event.get('type')
            data = event.get('data') or {}
            if t in ('request/header', 'model/selection'):
                model = model_of(data) or model
                continue
            if t != 'assistant/message':
                continue
            if args.model and args.model not in model:
                continue
            at = event.get('time') or 0
            step = data.get('step')
            pos = 'step1' if step == 1 else 'step2+'
            phase = None if cutoff is None else ('after' if at >= cutoff else 'before')
            for part in (data.get('message') or {}).get('content') or []:
                if not (isinstance(part, dict) and part.get('type') == 'reasoning'):
                    continue
                head = ' '.join((part.get('text') or '').split())
                if not head:
                    continue
                hit = head.startswith(args.phrase)
                keys = [(model, 'all', 'all'), (model, 'all', pos)]
                if phase:
                    keys += [(model, phase, 'all'), (model, phase, pos)]
                for k in keys:
                    buckets[k][0] += 1
                    buckets[k][1] += hit
                rows.append((model, phase, step, hit, head[:70]))

    order = {'all': 0, 'before': 1, 'after': 2, 'step1': 1, 'step2+': 2}
    for k in sorted(buckets, key=lambda k: (k[0], order[k[1]], order[k[2]])):
        n, hit = buckets[k]
        warn = '' if n >= 5 else '  (n<5: no conclusion)'
        print('%-40s %-6s %-6s blocks=%4d  %s=%4d (%5.1f%%)%s' % (k[0][:40], k[1], k[2], n, args.phrase, hit, 100.0 * hit / n, warn))
    if args.verbose:
        for model, phase, step, hit, head in rows:
            print(('  HIT ' if hit else '   .  ') + '%s %s step=%s %s' % (model[:24], phase or '', step, head))


if __name__ == '__main__':
    main()
