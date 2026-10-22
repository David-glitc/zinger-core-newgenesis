#!/usr/bin/env python3
"""Audit completed paper-session journals independently of the TypeScript ledger."""
import gzip
import hashlib
import json
import math
import re
import sys
from email.utils import parsedate_to_datetime
from pathlib import Path
from mm_depth_audit import FinalDepthAudit
from mm_ctf_audit import CtfMatchAudit, MODEL as CTF_MODEL


def main(directory, failed_accounting_only=False):
    root = Path(directory)
    r = json.loads((root/'report.json').read_text())
    depth = FinalDepthAudit(r) if r.get('valuationAt') is not None else None
    # A direct control can inherit a prior CTF phase. Keep its full native
    # history and transaction budget, rather than validating only the last mode.
    ctf = CtfMatchAudit(r) if r.get('matchingModel') == CTF_MODEL or r.get('initialMatchingModel') == CTF_MODEL or r.get('recoveryParent') else None
    if failed_accounting_only:
        assert r['status'] == 'failed', 'Diagnostic mode requires a failed run'
    else:
        assert r['status'] in {'completed', 'interrupted', 'risk_stopped'}
    assert r['ordersSubmitted'] == 0 and r['actualSpendUsd'] == 0
    cash, realized, fees = r['bankrollUsd'], 0.0, 0.0
    holdings, orders, prints, seen, markets, book_health = {}, {}, {}, set(), {}, {}
    cancel_requests, print_evidence = {}, {}
    native_prints, native_resolutions = {}, set()
    version = r.get('evidenceVersion', 1)
    fills = merges = splits = settlements = records = 0
    sub_microshare_receipts = 0
    leases_renewed = 0
    fill_rule = r.get('fillRule', 'exact-price')
    fill_rule = r.get('initialFillRule', fill_rule)
    activation_latency = r.get('initialLatencyMs', r.get('latencyMs', 0))
    cancel_latency = r.get('initialCancelLatencyMs', r.get('cancelLatencyMs', 0))
    cash_loss_limit = r.get('initialMaxCashLossUsd', r.get('config', {}).get('maxCashLossUsd'))
    matching_model = r.get('initialMatchingModel', r.get('matchingModel', 'direct'))
    expiry_policy = r.get('initialExpiryPolicy', r.get('expiryPolicy', 'fixed-expiry'))
    recovery_quarantine_until = 0
    prefix = hashlib.sha256()
    assert fill_rule in {'exact-price', 'price-through'}
    risk_keys = {'maxPortfolioUsd', 'maxMarketUsd', 'maxEventUsd', 'maxNetShares', 'maxOrderShares'}
    risk_verified = risk_keys <= r.get('config', {}).keys()

    def validate_risk():
        if not risk_verified:
            return
        cfg = r['config']
        total, events = 0.0, {}
        for condition, m in markets.items():
            tokens = [t['id'] for t in m['tokens']]
            committed = sum(holdings.get(t, {}).get('cost', 0) for t in tokens)
            positive = negative = 0.0
            for o in orders.values():
                if o['token'] not in tokens or o['remaining'] <= 1e-9:
                    continue
                if o['side'] == 'BUY':
                    fee = m['fee']
                    reserve = o['remaining'] * fee['rate'] * (o['price'] * (1-o['price'])) ** fee['exponent']
                    committed += o['remaining'] * o['price'] + math.floor(reserve*1e5+.5)/1e5
                else:
                    assert o['remaining'] <= holdings.get(o['token'], {}).get('shares', 0)+1e-7, 'Unbacked ask'
                if (o['token'] == tokens[0]) == (o['side'] == 'BUY'):
                    positive += o['remaining']
                else:
                    negative += o['remaining']
            net = holdings.get(tokens[0], {}).get('shares', 0)-holdings.get(tokens[1], {}).get('shares', 0)
            assert net+positive <= cfg['maxNetShares']+1e-7 and net-negative >= -cfg['maxNetShares']-1e-7, 'Worst-case outcome exposure exceeded'
            assert committed <= cfg['maxMarketUsd']+1e-7, 'Market cap exceeded'
            total += committed
            events[m['event']] = events.get(m['event'], 0)+committed
        assert total <= cfg['maxPortfolioUsd']+1e-7, 'Portfolio cap exceeded'
        assert all(v <= cfg['maxEventUsd']+1e-7 for v in events.values()), 'Event cap exceeded'
        reserved = total-sum(h['cost'] for h in holdings.values())
        assert reserved <= cash+1e-7, 'Cash over-reserved'
        if cash_loss_limit is not None:
            assert reserved <= cash-max(0, r['bankrollUsd']-cash_loss_limit)+1e-7, 'Cash loss budget exceeded'

    with gzip.open(root/'events.jsonl.gz','rt') as stream:
        for line in stream:
            row = json.loads(line)
            records += 1
            assert row['sequence'] == records
            d, kind = row['data'], row['type']
            if kind == 'paper-recovery':
                parent = d['parent']
                assert parent['records'] == records-1 and parent['prefixSha256'] == prefix.hexdigest(), 'Recovery prefix changed'
                parent_root = Path(parent['directory']).resolve()
                for filename, digest in parent['files'].items():
                    target = (parent_root/filename).resolve()
                    assert parent_root in target.parents, 'Invalid recovery evidence path'
                    assert hashlib.sha256(target.read_bytes()).hexdigest() == digest, 'Recovery source changed'
                assert d['bankrollUsd'] == r['bankrollUsd'] and math.isclose(d['cashUsd'], cash, abs_tol=1e-7), 'Recovery reset capital'
                expected = {token: h for token, h in holdings.items() if h['shares'] > 1e-9}
                reported = {h['token']: h for h in d['inventory'] if h['shares'] > 1e-9}
                assert expected.keys() == reported.keys()
                for token, h in expected.items():
                    assert math.isclose(h['shares'], reported[token]['shares'], abs_tol=1e-7) and math.isclose(h['cost'], reported[token]['costUsd'], abs_tol=1e-7)
                assert set(d['outstandingOrders']) == {oid for oid, o in orders.items() if o['remaining'] > 1e-9}
                fill_rule = d['fillRule']
                activation_latency, cancel_latency = d['latencyMs'], d['cancelLatencyMs']
                recovery_quarantine_until = max([row['at']] + [cancel_requests.get(oid, {}).get('ackAt', row['at']+cancel_latency) for oid in d['outstandingOrders']])
                cash_loss_limit = d.get('maxCashLossUsd')
                matching_model = d.get('matchingModel', 'direct')
                expiry_policy = d.get('expiryPolicy', 'fixed-expiry')
                assert fill_rule in {'exact-price', 'price-through'}
                assert 0 <= activation_latency <= 2000 and 0 <= cancel_latency <= 2000
            prefix.update(line.encode('utf8'))
            if depth:
                depth.consume(row, markets)
            if ctf:
                ctf.consume(row, markets)
            if kind == 'wire' and version >= 2:
                if 'last_trade_price' in d['wire'] or 'market_resolved' in d['wire']:
                    events = json.loads(d['wire'])
                    for event in events if isinstance(events, list) else [events]:
                        typ, p = event.get('event_type', event.get('type')), event.get('payload', event)
                        if typ == 'last_trade_price':
                            tx = str(p.get('transaction_hash', p.get('transactionHash', ''))).lower()
                            token = str(p.get('asset_id', p.get('assetId', '')))
                            if not re.fullmatch(r'0x[0-9a-f]{64}', tx):
                                continue
                            try:
                                key = (tx, token, float(p['timestamp']), float(p['price']), float(p['size']), p['side'])
                            except (KeyError, ValueError, TypeError):
                                continue
                            if not all(math.isfinite(v) for v in key[2:5]):
                                continue
                            native_prints[key] = d.get('receivedAt', row['at'])
                        elif typ == 'market_resolved':
                            condition = str(p.get('market', p.get('conditionId', '')))
                            winner = str(p.get('winning_asset_id', p.get('winningAssetId', '')))
                            native_resolutions.add((condition, winner))
            elif kind == 'market':
                tokens = [t['id'] for t in d['tokens']]
                assert len(tokens) == 2 and len(set(tokens)) == 2
                for condition, existing in markets.items():
                    old = [t['id'] for t in existing['tokens']]
                    assert tokens == old if condition == d['conditionId'] else not set(tokens).intersection(old)
                markets[d['conditionId']] = d
            elif kind == 'paper-order':
                assert d['id'] not in orders
                assert d.get('minimumFillShares') in (None, 1e-6), 'Unknown minimum fill policy'
                assert d.get('matchingModel', 'direct') == matching_model
                assert d.get('expiryPolicy', 'fixed-expiry') == expiry_policy
                assert expiry_policy in ('fixed-expiry', 'renewable-client-lease-v1')
                assert expiry_policy == 'fixed-expiry' or (matching_model == CTF_MODEL and cancel_latency > 0)
                assert d.get('fillRule', 'exact-price') == fill_rule
                if version >= 2:
                    m = markets[d['conditionId']]
                    assert d['token'] in [t['id'] for t in m['tokens']]
                    assert m['minShares'] <= d['shares'] <= r['config']['maxOrderShares']
                    assert math.isclose(d['price']/m['tick'], round(d['price']/m['tick']), abs_tol=1e-7)
                    assert d['activateAt'] == d['placedAt'] + activation_latency
                    assert d['expiresAt'] > d['activateAt']
                if 'queueModel' in d:
                    assert d['queueModel'] in {'same-price', 'legacy-cumulative'}
                    levels = d['queueEvidence']['levels']
                    if d['queueModel'] == 'same-price':
                        expected_queue = sum(l['size'] for l in levels if abs(l['price']-d['price']) < 1e-9)
                    else:
                        expected_queue = sum(l['size'] for l in levels if (l['price'] >= d['price'] if d['side'] == 'BUY' else l['price'] <= d['price']))
                    assert math.isclose(expected_queue, d['queueAhead'], abs_tol=1e-7)
                if matching_model == CTF_MODEL:
                    assert ctf
                    ctf.order(d, markets[d['conditionId']], orders)
                orders[d['id']] = dict(d, remaining=d['shares'])
                assert not any(o['id'] != d['id'] and o['remaining'] > 1e-9 and o['token'] == d['token'] and o['side'] == d['side'] for o in orders.values()), 'Overlapping same-side orders'
                validate_risk()
            elif kind == 'paper-print':
                p = d['print']
                if not d['accepted']:
                    continue
                assert d.get('matchingModel', 'direct') == matching_model
                assert d['healthy'] and p['id'] and p['id'] not in seen
                assert d['receivedAt'] >= recovery_quarantine_until, 'Print accepted during recovery quarantine'
                if version >= 2:
                    parts = p['id'].split(':')
                    assert len(parts) == 6
                    key = (parts[0].lower(), parts[1], float(parts[2]), float(parts[3]), float(parts[4]), parts[5])
                    assert key == (parts[0].lower(), p['token'], p['at'], p['price'], p['shares'], p['aggressor'])
                    assert key in native_prints and native_prints[key] == d['receivedAt']
                assert p['at'] <= d['receivedAt'] and d['receivedAt']-p['at'] <= 1500
                if r.get('bookFreshness') == 'verified-snapshot':
                    h = book_health[p['token']]
                    now = d['receivedAt']
                    assert h['receivedAt'] == now and h['structural']
                    assert 0 <= now-h['bookReceivedAt'] <= 1500
                    assert h['bookServerAt'] <= now+1000
                    if now-h['bookServerAt'] > 1500:
                        proof = h['confirmation']
                        assert proof and proof['token'] == p['token']
                        assert re.fullmatch(r'[0-9a-fA-F]{40,64}', proof['hash'])
                        assert 0 <= proof['receivedAt']-proof['requestedAt'] <= 1500
                        assert abs(proof['receivedAt']-parsedate_to_datetime(proof['date']).timestamp()*1000) <= 2000
                        assert float(proof['age'] or 0) == 0
                        assert (proof['cacheStatus'] or 'NONE').upper() in {'DYNAMIC','MISS','BYPASS','NONE'}
                        assert proof['revision'] == h['bookRevision'] and proof['serverAt'] == h['bookServerAt']
                        assert 0 <= now-proof['receivedAt'] <= 1500
                seen.add(p['id'])
                joint = ctf.print(d, markets, orders, fill_rule, cancel_requests, book_health) if ctf else None
                if matching_model == CTF_MODEL:
                    assert joint is not None
                    prints[p['id']] = joint
                    print_evidence[p['id']] = dict(p)
                    continue
                expected = {}
                for oid,o in orders.items():
                    exact = abs(o['price']-p['price']) <= 1e-9
                    through = fill_rule == 'price-through' and (p['price'] < o['price'] if o['side'] == 'BUY' else p['price'] > o['price'])
                    if o['token'] != p['token'] or o['side'] == p['aggressor'] or not (exact or through):
                        continue
                    if not o['activateAt'] < p['at'] < o['expiresAt'] or not o['activateAt'] <= d['receivedAt'] < min(o['expiresAt'], cancel_requests.get(oid, {}).get('ackAt', math.inf)):
                        continue
                    consumed = min(o['queueAhead'],p['shares'])
                    o['queueAhead'] -= consumed
                    qty = min(o['remaining'],p['shares']-consumed)
                    if qty > 0 and (o.get('minimumFillShares') is None or qty >= o['minimumFillShares']-1e-9):
                        expected[oid] = qty
                        o['remaining'] -= qty
                prints[p['id']] = expected
                print_evidence[p['id']] = dict(p)
            elif kind == 'print-book-health':
                book_health[d['token']] = d
            elif kind == 'paper-cancel-request':
                assert d['id'] in orders and d['id'] not in cancel_requests
                assert d['ackAt'] >= d['requestedAt'] + cancel_latency
                if d['reason'] == 'lease_expired':
                    assert orders[d['id']].get('expiryPolicy') == 'renewable-client-lease-v1' and d['requestedAt'] >= orders[d['id']]['expiresAt']
                cancel_requests[d['id']] = d
            elif kind == 'paper-lease-renewal':
                assert ctf and d['id'] in orders
                order = orders[d['id']]
                ctf.renew(d, row['at'], markets[order['conditionId']], order, cancel_requests)
                leases_renewed += 1
                validate_risk()
            elif kind == 'paper-cancel':
                assert d['reason'] != 'expired' or orders[d['id']].get('expiryPolicy', 'fixed-expiry') == 'fixed-expiry', 'GTC cancellation bypassed acknowledgment'
                if cancel_latency > 0 and d['reason'] not in {'expired', 'market_resolved'}:
                    assert d['id'] in cancel_requests and row['at'] >= cancel_requests[d['id']]['ackAt']
                orders.pop(d['id'],None)
                cancel_requests.pop(d['id'],None)
            elif kind == 'paper-fill':
                p = d['print']
                assert p['id'] in prints
                assert p == print_evidence[p['id']]
                order = orders[d['orderId']]
                if order.get('minimumFillShares') is not None:
                    assert d['shares'] >= order['minimumFillShares']-1e-9, 'Sub-microshare fill receipt'
                assert d['orderId'] in prints[p['id']], 'Fill has no remaining eligible print volume or active order'
                assert d.get('matchingModel', 'direct') == order.get('matchingModel', 'direct')
                if matching_model == CTF_MODEL:
                    assert ctf
                    ctf.fill(d)
                token = d.get('token', p['token'])
                assert token == order['token'] and (matching_model == CTF_MODEL or token == p['token']), 'Fill credited wrong token'
                assert d['side'] == order['side'] and math.isclose(d['price'], order['price'], abs_tol=1e-9)
                assert math.isclose(prints[p['id']].pop(d['orderId']),d['shares'],abs_tol=1e-9)
                assert d['feeUsd'] == 0
                assert d.get('fillRule', 'exact-price') == fill_rule
                h = holdings.setdefault(token,{'shares':0.0,'cost':0.0})
                qty, premium = d['shares'], d['shares']*d['price']
                assert qty > 0
                if qty < 1e-6-1e-9:
                    sub_microshare_receipts += 1
                if d['side'] == 'BUY':
                    cash -= premium
                    h['shares'] += qty
                    h['cost'] += premium
                else:
                    assert h['shares'] >= qty-1e-9
                    cost = h['cost']*qty/h['shares']
                    h['shares'] -= qty
                    h['cost'] -= cost
                    cash += premium
                    realized += premium-cost
                assert cash >= -1e-9
                assert math.isclose(cash,d['cashUsd'],abs_tol=1e-7)
                fills += 1
                validate_risk()
            elif kind == 'paper-split':
                m = markets[d['conditionId']]
                assert m['negativeRisk'] is False
                assert d['tokens'] == [t['id'] for t in m['tokens']]
                assert d['shares'] > 0 and d['feeUsd'] >= 0
                assert d['id'] not in seen
                seen.add(d['id'])
                cash -= d['shares'] + d['feeUsd']
                assert cash >= -1e-9
                for token in d['tokens']:
                    h = holdings.setdefault(token, {'shares': 0.0, 'cost': 0.0})
                    h['shares'] += d['shares']
                    h['cost'] += (d['shares'] + d['feeUsd']) / 2
                fees += d['feeUsd']
                assert math.isclose(cash, d['cashUsd'], abs_tol=1e-7)
                assert math.isclose(realized, d['realizedPnlUsd'], abs_tol=1e-7)
                splits += 1
                validate_risk()
            elif kind == 'paper-merge':
                m = markets[d['conditionId']]
                assert m['negativeRisk'] is False
                assert d['tokens'] == [t['id'] for t in m['tokens']]
                costs = 0.0
                for token in d['tokens']:
                    h = holdings[token]
                    assert h['shares'] >= d['shares']-1e-9
                    cost = h['cost']*d['shares']/h['shares']
                    h['shares'] -= d['shares']
                    h['cost'] -= cost
                    costs += cost
                cash += d['shares']-d['feeUsd']
                realized += d['shares']-d['feeUsd']-costs
                fees += d['feeUsd']
                assert math.isclose(cash,d['cashUsd'],abs_tol=1e-7)
                merges += 1
            elif kind == 'paper-settlement':
                m = markets[d['conditionId']]
                assert d['tokens'] == [t['id'] for t in m['tokens']]
                assert d['winner'] in d['tokens']
                if version >= 2:
                    assert (d['conditionId'], d['winner']) in native_resolutions
                expected_payouts = [1 if token == d['winner'] else 0 for token in d['tokens']]
                assert d['payouts'] == expected_payouts
                proceeds = costs = 0.0
                for i, token in enumerate(d['tokens']):
                    h = holdings.setdefault(token, {'shares': 0.0, 'cost': 0.0})
                    proceeds += h['shares'] * expected_payouts[i]
                    costs += h['cost']
                    h['shares'] = h['cost'] = 0.0
                assert 0 <= d['feeUsd'] <= proceeds
                cash += proceeds - d['feeUsd']
                realized += proceeds - d['feeUsd'] - costs
                fees += d['feeUsd']
                assert math.isclose(cash, d['cashUsd'], abs_tol=1e-7)
                assert math.isclose(realized, d['realizedPnlUsd'], abs_tol=1e-7)
                settlements += 1
    assert all(not pending for pending in prints.values())
    assert math.isclose(cash,r['cashUsd'],abs_tol=1e-7)
    assert math.isclose(realized,r['realizedPnlUsd'],abs_tol=1e-7)
    assert math.isclose(fees,r['feesUsd'],abs_tol=1e-7)
    assert fills == r['simulatedFills'] and merges == r['simulatedMerges']
    assert splits == r.get('simulatedSplits', 0)
    assert settlements == r.get('simulatedSettlements', 0)
    assert fill_rule == r.get('fillRule', 'exact-price')
    if 'maxCashLossUsd' in r.get('config', {}):
        assert cash_loss_limit == r['config']['maxCashLossUsd']
    validate_risk()
    if 'inventory' in r:
        reported = {h['token']: h for h in r['inventory'] if h['shares'] > 1e-9}
        actual = {token: h for token, h in holdings.items() if h['shares'] > 1e-9}
        assert reported.keys() == actual.keys()
        for token, h in actual.items():
            assert math.isclose(reported[token]['shares'], h['shares'], abs_tol=1e-7)
            assert math.isclose(reported[token]['costUsd'], h['cost'], abs_tol=1e-7)
    flat = not any(h['shares'] > 1e-9 for h in holdings.values())
    if 'leasesRenewed' in r:
        assert r['leasesRenewed'] == leases_renewed, 'Lease renewal counter differs from journal'
    depth_verified = depth.verify(holdings, cash, markets) if depth else False
    if flat:
        for key in ('midEquityUsd', 'liquidationEquityUsd'):
            if r.get(key) is not None:
                assert math.isclose(r[key], cash, abs_tol=1e-7), 'Incorrect final flat-account equity'
        for key in ('midPnlUsd', 'liquidationPnlUsd'):
            if r.get(key) is not None:
                assert math.isclose(r[key], cash-r['bankrollUsd'], abs_tol=1e-7), 'Incorrect final flat-account P/L'
    for filename,digest in json.loads((root/'source.json').read_text())['files'].items():
        assert hashlib.sha256((root/'sources'/filename).read_bytes()).hexdigest() == digest
    result={'status':'reconciled_failed_run' if failed_accounting_only else 'passed',
            'scope':'failed-run-accounting-only' if failed_accounting_only else 'complete-journal-accounting-risk-and-available-valuation',
            'captureStatus':r['status'],'performanceClaimEligible':False,
            'records':records,'startingCapitalUsd':r['bankrollUsd'],'endingCashUsd':cash,
            'simulatedFills':fills,'materialSimulatedFills':fills-sub_microshare_receipts,'subMicroshareFillReceipts':sub_microshare_receipts,
            'leasesRenewed':leases_renewed,
            'simulatedMerges':merges,'simulatedSplits':splits,'simulatedSettlements':settlements,'realizedPnlUsd':realized,
            'fillRule':fill_rule,
            'riskCapsVerified':risk_verified,
            'finalValuationVerified':depth_verified or (flat and r.get('midEquityUsd') is not None and r.get('liquidationEquityUsd') is not None),
            'journalComplete':True,'actualSpendUsd':0,'actualExecutionVerified':False,
            'auditorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),
            'depthAuditorSha256':hashlib.sha256(Path(__file__).with_name('mm_depth_audit.py').read_bytes()).hexdigest(),
            'ctfAuditorSha256':hashlib.sha256(Path(__file__).with_name('mm_ctf_audit.py').read_bytes()).hexdigest(),
            'reportSha256':hashlib.sha256((root/'report.json').read_bytes()).hexdigest(),
            'journalSha256':hashlib.sha256((root/'events.jsonl.gz').read_bytes()).hexdigest()}
    (root/('failed-accounting-audit.json' if failed_accounting_only else 'independent-audit.json')).write_text(json.dumps(result,indent=2))
    print(json.dumps(result,indent=2))


if __name__ == '__main__':
    assert len(sys.argv) in (2, 3)
    if len(sys.argv) == 3:
        assert sys.argv[2] == '--failed-accounting-only'
    main(sys.argv[1], len(sys.argv) == 3)
