"""Independent conservative CTF tape/queue checks; no TypeScript imports."""
import math
import re
from mm_depth_audit import FinalDepthAudit

MODEL = 'ctf-max-transaction-volume-v1'
SCALE = 1000000


def units(value, up=False):
    scaled = value*SCALE
    assert math.isfinite(scaled) and scaled >= 0
    nearest = math.floor(scaled+.5)
    result = nearest if abs(scaled-nearest) < 1e-4 else math.ceil(scaled) if up else math.floor(scaled)
    assert result <= 9007199254740991
    return result


def axis(market, token, side, price):
    tokens = [t['id'] for t in market['tokens']]
    assert token in tokens and side in ('BUY', 'SELL')
    inverse = token == tokens[1]
    return (('SELL' if side == 'BUY' else 'BUY') if inverse else side,
            (1-price) if inverse else price)


class CtfMatchAudit:
    def __init__(self, report):
        self.depth = FinalDepthAudit(report)
        self.maxima, self.expected, self.budgets = {}, {}, {}

    def consume(self, row, markets):
        if row['type'] == 'market':
            self.depth.tokens.update(t['id'] for t in row['data']['tokens'])
        self.depth.consume(row, markets)

    def order(self, d, market, orders):
        assert market['negativeRisk'] is False and market['protocol'] == 'v1'
        assert d['queueModel'] == 'same-price' and d['minimumFillShares'] == 1e-6
        if d.get('expiryPolicy', 'fixed-expiry') == 'renewable-client-lease-v1':
            deadline = market['eventAt']-market.get('eventBufferMs', self.depth.report['config']['eventBufferMs'])
            assert d['quoteDeadlineAt'] == deadline and d['placedAt'] < d['expiresAt'] <= min(deadline, d['placedAt']+self.depth.report['config'].get('quoteLifetimeMs', 2000)), 'Invalid new client lease deadline'
        assert self.depth.fresh(d['token'], self.depth.book(d['token']), d['placedAt'], self.depth.confirmations.get(d['token'])), 'CTF order book lacks native fresh evidence'
        ladder = self.depth.book(d['token'])['bids' if d['side'] == 'BUY' else 'asks']
        assert {x['price']: x['size'] for x in d['queueEvidence']['levels']} == ladder, 'CTF queue differs from native depth'
        a = axis(market, d['token'], d['side'], d['price'])
        a = (a[0], math.floor(a[1]*SCALE+.5))
        for o in orders.values():
            if o['conditionId'] != d['conditionId'] or o['remaining'] <= 1e-9:
                continue
            b = axis(market, o['token'], o['side'], o['price'])
            b = (b[0], math.floor(b[1]*SCALE+.5))
            assert a != b, 'Overlapping economic CTF quotes'
            assert a[0] == b[0] or (a[1] < b[1] if a[0] == 'BUY' else a[1] > b[1]), 'Synthetic CTF self-cross'

    def renew(self, d, row_at, market, order, cancel_requests):
        assert order.get('expiryPolicy') == 'renewable-client-lease-v1' and d['id'] not in cancel_requests, 'Renewed cancelled or non-GTC order'
        assert all(math.isfinite(d[k]) for k in ('renewedAt', 'expiresAt', 'previousExpiresAt', 'remainingShares', 'originalShares'))
        now, cfg = d['renewedAt'], self.depth.report['config']
        assert now <= row_at <= now+cfg['maxAgeMs'] and now < order['expiresAt'], 'Expired or future lease renewal'
        assert d['previousExpiresAt'] == order['expiresAt'] and order['expiresAt'] < d['expiresAt'] <= now+cfg.get('quoteLifetimeMs', 2000), 'Invalid lease renewal duration'
        deadline = market['eventAt']-market.get('eventBufferMs', cfg['eventBufferMs'])
        assert d['quoteDeadlineAt'] == order['quoteDeadlineAt'] == deadline and d['expiresAt'] <= deadline, 'Renewal crossed lifecycle deadline'
        for key in ('token', 'side', 'price', 'conditionId'):
            assert d[key] == order[key], 'Lease changed order identity or price'
        assert d['originalShares'] == order['shares'] and math.isclose(d['remainingShares'], order['remaining'], abs_tol=1e-9), 'Lease changed remaining quantity'
        assert d['maintenanceOf'] in (None, d['id'])
        token = order['token']
        b = self.depth.book(token)
        assert self.depth.fresh(token, b, now, self.depth.confirmations.get(token)), 'Lease renewed on stale native book'
        evidence = d['bookEvidence']
        for side in ('bids', 'asks'):
            assert {x['price']: x['size'] for x in evidence[side]} == b[side], 'Lease book evidence differs from native depth'
        assert order['price'] < min(b['asks']) if order['side'] == 'BUY' else order['price'] > max(b['bids']), 'Lease kept marketable quote'
        order['expiresAt'] = d['expiresAt']

    def print(self, d, markets, orders, fill_rule, cancel_requests, book_health):
        p = d['print']
        market = next(m for m in markets.values() if p['token'] in [t['id'] for t in m['tokens']])
        tx = p['id'].split(':')[0].lower()
        if not re.fullmatch(r'0x[0-9a-f]{64}', tx):
            assert d.get('matchingModel', 'direct') == 'direct'
            return None
        key = market['conditionId']+':'+tx
        observed, previous = units(p['shares']), self.maxima.get(key, 0)
        self.maxima[key] = max(previous, observed)
        if d.get('matchingModel', 'direct') == 'direct':
            return None
        assert d['matchingModel'] == MODEL
        proof = dict(key=key, previousShares=previous/SCALE, observedShares=observed/SCALE, availableShares=max(0, observed-previous)/SCALE)
        assert d['volumeBudget'] == proof, 'CTF transaction volume reused or invented'
        self.budgets[p['id']] = proof
        now = d['receivedAt']
        required = [p['token']] if not d['complementHealthy'] else [t['id'] for t in market['tokens']]
        for token in required:
            h, b = book_health[token], self.depth.book(token)
            assert h['receivedAt'] == now and h['structural'], 'Missing CTF book health proof'
            assert (h['bookRevision'], h['bookServerAt'], h['bookReceivedAt']) == (b['revision'], b['serverAt'], b['receivedAt']), 'CTF book health differs from native source'
        assert self.depth.fresh(p['token'], self.depth.book(p['token']), now, self.depth.confirmations.get(p['token'])), 'Native CTF print book is stale or absent'
        if d['complementHealthy']:
            assert market['negativeRisk'] is False and market['protocol'] == 'v1'
            for t in market['tokens']:
                assert self.depth.fresh(t['id'], self.depth.book(t['id']), now, self.depth.confirmations.get(t['id'])), 'Complementary CTF book is stale or absent'
        side, price = axis(market, p['token'], p['aggressor'], p['price'])
        candidates = []
        for oid, o in orders.items():
            if o['conditionId'] != market['conditionId']:
                continue
            a, b = axis(market, o['token'], o['side'], o['price'])
            expiry = o['expiresAt']
            if o.get('expiryPolicy', 'fixed-expiry') == 'renewable-client-lease-v1':
                assert now < expiry or oid in cancel_requests, 'Expired client lease lacks cancellation request'
                expiry = math.inf
            if a == side or not o['activateAt'] < p['at'] or not o['activateAt'] <= now < min(expiry, cancel_requests.get(oid, {}).get('ackAt', math.inf)):
                continue
            if o['token'] != p['token'] and not d['complementHealthy']:
                continue
            if not (abs(b-price) <= 1e-9 or fill_rule == 'price-through' and (b > price if a == 'BUY' else b < price)):
                continue
            candidates.append(((-b if a == 'BUY' else b), o['activateAt'], oid, o))
        budget, expected = max(0, observed-previous), {}
        for _, _, oid, o in sorted(candidates):
            if budget <= 0:
                break
            ahead, remaining = units(o['queueAhead'], True), units(o['remaining'])
            consumed = min(ahead, budget)
            budget -= consumed
            qty = min(remaining, budget)
            budget -= qty
            o['queueAhead'] = (ahead-consumed)/SCALE
            if qty:
                o['remaining'] = (remaining-qty)/SCALE
                expected[oid] = qty/SCALE
                self.expected[(p['id'], oid)] = dict(token=o['token'], route='direct' if o['token'] == p['token'] else 'mint' if o['side'] == 'BUY' else 'merge')
        return expected

    def fill(self, d):
        expected = self.expected.pop((d['print']['id'], d['orderId']))
        assert d['matchingModel'] == MODEL and d['token'] == expected['token'] and d['route'] == expected['route'], 'Invalid CTF token or route'
        assert d['volumeBudget'] == self.budgets[d['print']['id']], 'Changed CTF receipt volume budget'
        assert d['shares'] >= 1e-6-1e-9 and math.isclose(d['shares']*SCALE, round(d['shares']*SCALE), abs_tol=1e-4), 'Unrepresentable CTF fill quantity'
