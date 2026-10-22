#!/usr/bin/env python3
"""Verify quote-intent safety against the recorded books using independent arithmetic."""
import gzip
import hashlib
import json
import math
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path


def fee(shares, price, params):
    q, p, r, e = map(lambda x: Decimal(str(x)), [shares, price, params['rate'], params['exponent']])
    return float((q*r*(p*(1-p))**e).quantize(Decimal('0.00001'), rounding=ROUND_HALF_UP))


def main(directory):
    root = Path(directory)
    report = json.loads((root/'report.json').read_text())
    assert report['status'] == 'completed'
    assert report['ordersSubmitted'] == 0 and report['amountSpentUsd'] == 0 and report['simulatedFills'] == 0
    assert report['realizedPnlUsd'] is None and report['portfolioSharpe'] is None
    cfg = report['config']
    markets = {}
    observations = quotes = messages = records = 0
    with gzip.open(root/'events.jsonl.gz', 'rt') as stream:
        for line in stream:
            row = json.loads(line)
            records += 1
            assert row['sequence'] == records
            data = row['data']
            if row['type'] == 'market':
                markets[data['conditionId']] = data
            elif row['type'] == 'wire':
                messages += 1
            elif row['type'] == 'quote-plan':
                observations += 1
                m = markets[data['conditionId']]
                plan, snapshots, at = data['plan'], data['snapshots'], data['evaluationAt']
                if not plan['quotes']:
                    continue
                quotes += 1
                assert m['eventAt']-at > cfg['eventBufferMs']
                assert abs(snapshots[0]['serverAt']-snapshots[1]['serverAt']) <= 250
                for book in snapshots:
                    assert book['usable']
                    assert 0 <= at-book['receivedAt'] <= cfg['maxAgeMs']
                    assert -1000 <= at-book['serverAt'] <= cfg['maxAgeMs']
                reserve = unit_cost = 0
                bids = 0
                for q in plan['quotes']:
                    # The observer begins with zero inventory and cannot offer asks.
                    assert q['side'] == 'BUY' and q['postOnly'] is True
                    assert m['minShares'] <= q['shares'] <= cfg['maxOrderShares']
                    assert 0 < q['price'] < 1
                    assert q['price'] < snapshots[q['outcomeIndex']]['bestAsk']
                    assert abs(q['price']/m['tick']-round(q['price']/m['tick'])) < 1e-7
                    assert q['expiresAt']-at == 2000
                    reserve += q['shares']*q['price']+fee(q['shares'],q['price'],m['fee'])
                    unit_cost += q['price']+fee(1,q['price'],m['fee'])
                    bids += 1
                assert math.isclose(reserve,plan['buyReservationUsd'],abs_tol=1e-7)
                assert reserve <= cfg['maxMarketUsd']+1e-7
                assert reserve+data['capital']['event'] <= cfg['maxEventUsd']+1e-7
                assert reserve+data['capital']['portfolio'] <= cfg['maxPortfolioUsd']+1e-7
                if bids == 2:
                    assert unit_cost <= 1-cfg['reservePerShare']+1e-7
    assert observations == report['observations']
    assert quotes == report['quoteIntentObservations']
    assert messages == report['messages']
    for filename,digest in json.loads((root/'source.json').read_text())['files'].items():
        archived = root/'sources'/filename
        assert hashlib.sha256(archived.read_bytes()).hexdigest() == digest
    result = {'status':'passed','records':records,'messages':messages,'quotePlanObservations':observations,
              'quoteIntentObservations':quotes,'sourceHashesMatch':True,'journalComplete':True,
              'journalSha256':hashlib.sha256((root/'events.jsonl.gz').read_bytes()).hexdigest(),
              'executionOrProfitVerified':False}
    (root/'independent-audit.json').write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))


if __name__ == '__main__':
    main(sys.argv[1])
