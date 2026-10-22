#!/usr/bin/env python3
"""Independent reconstruction of public API audit pages; no trading dependencies."""
import gzip
import hashlib
import json
import math
import sys
from collections import defaultdict
from pathlib import Path
from urllib.parse import urlparse, parse_qs


def main(directory):
    root = Path(directory)
    report = json.loads((root / 'report.json').read_text())
    assert report['status'] == 'completed'
    assert report['ordersSubmitted'] == 0 and report['amountSpentUsd'] == 0
    start, end = report['window']['start'], report['window']['end']
    feeds = defaultdict(lambda: {'rows': 0, 'gross': 0.0, 'markets': set(), 'terminal': False})
    lifecycle = defaultdict(lambda: defaultdict(lambda: {'rows': 0, 'cash': 0.0}))
    pnls = {}
    http_reads = 0
    with gzip.open(root / 'requests.jsonl.gz', 'rt') as stream:
        for line in stream:
            entry = json.loads(line)
            http_reads += 1
            parsed = urlparse(entry['url'])
            assert parsed.scheme == 'https'
            assert parsed.hostname in {'data-api.polymarket.com', 'gamma-api.polymarket.com', 'clob.polymarket.com'}
            if entry['status'] != 200:
                continue
            body, query = json.loads(entry['body']), parse_qs(parsed.query)
            if parsed.path == '/v2/trades':
                user, role = query['user'][0], query['taker_only'][0]
                assert int(query['start'][0]) == start and int(query['end'][0]) == end
                summary = feeds[(user, role)]
                for trade in body['data']:
                    assert trade['proxy_wallet'].lower() == user.lower()
                    assert start <= trade['timestamp'] <= end
                    assert trade['side'] in {'BUY', 'SELL'}
                    summary['rows'] += 1
                    summary['gross'] += float(trade['price']) * float(trade['size'])
                    summary['markets'].add(trade['condition_id'])
                summary['terminal'] |= not body['pagination']['has_more']
            elif parsed.path == '/v2/activity' and query.get('type') == ['MERGE,SPLIT,REDEEM']:
                for activity in body['data']:
                    a = lifecycle[query['user'][0]][activity['type']]
                    assert start <= activity['timestamp'] <= end
                    a['rows'] += 1
                    a['cash'] += float(activity['usdc_size'])
            elif parsed.path == '/v2/user-pnl':
                pnls[query['user'][0]] = body['data']
    assertions = 0
    for wallet in report['wallets']:
        user = wallet['wallet']
        for role, label in [('false', 'all'), ('true', 'taker')]:
            actual, expected = feeds[(user, role)], wallet[label]
            assert actual['terminal'] and expected['coverage']['complete']
            assert actual['rows'] == expected['rows']
            assert len(actual['markets']) == expected['marketCount']
            assert math.isclose(actual['gross'], expected['grossUsd'], abs_tol=1e-6)
            assertions += 4
        total, taker = feeds[(user, 'false')], feeds[(user, 'true')]
        assert wallet['makerEstimate']['makerRows'] == total['rows'] - taker['rows']
        assert math.isclose(wallet['makerEstimate']['makerNotionalShare'], 1-taker['gross']/total['gross'], abs_tol=1e-10)
        assertions += 2
        for kind, actual in lifecycle[user].items():
            expected = wallet['lifecycle']['types'][kind]
            assert actual['rows'] == expected['rows']
            assert math.isclose(actual['cash'], expected['cashUsd'], abs_tol=1e-6)
            assertions += 2
        cutoff = end // 86400 * 86400
        points = [p for p in pnls[user]['points'] if p['timestamp'] % 86400 == 0 and p['timestamp'] <= cutoff]
        assert all(b['timestamp'] - a['timestamp'] == 86400 for a, b in zip(points, points[1:]))
        economic = points[-1]['economic_pnl'] - points[0]['economic_pnl']
        assert math.isclose(economic, wallet['pnl']['economicPnlChangeUsd'], abs_tol=1e-6)
        assert wallet['pnl']['portfolioSharpe'] is None
        assertions += 3
    source = json.loads((root / 'source.json').read_text())
    for filename, digest in source['files'].items():
        archived = root / 'sources' / filename
        source_file = archived if archived.exists() else Path(filename)
        assert hashlib.sha256(source_file.read_bytes()).hexdigest() == digest, filename
        assertions += 1
    result = {'status': 'passed', 'httpReads': http_reads, 'assertions': assertions,
              'tradeRows': sum(f['rows'] for f in feeds.values()),
              'allRoleTradeRows': sum(f['rows'] for (u, role), f in feeds.items() if role == 'false'),
              'journalSha256': hashlib.sha256((root / 'requests.jsonl.gz').read_bytes()).hexdigest(),
              'reportSha256': hashlib.sha256((root / 'report.json').read_bytes()).hexdigest(),
              'sourceHashesMatch': True, 'portfolioSharpeVerified': False}
    (root / 'independent-audit.json').write_text(json.dumps(result, indent=2))
    print(json.dumps(result, indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
