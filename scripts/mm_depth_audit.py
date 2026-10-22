"""Independent final depth reconstruction from captured public wire/REST data."""
import json
import math
import re
from email.utils import parsedate_to_datetime


def number(value):
    try:
        return float(value)
    except (ValueError, TypeError):
        return float('nan')


class FinalDepthAudit:
    def __init__(self, report):
        self.report = report
        self.tokens = {h['token'] for h in report.get('inventory', []) if h['shares'] > 1e-9}
        self.books, self.rest, self.confirmations = {}, {}, {}
        self.evidence = None

    def book(self, token):
        return self.books.setdefault(token, dict(bids={}, asks={}, serverAt=0, receivedAt=0, revision=0, seeded=False, issue='unseeded'))

    def ingest(self, event, received):
        p, kind = event.get('payload', event), event.get('event_type', event.get('type'))
        if kind == 'book' or ('bids' in p and 'asks' in p):
            token = str(p.get('asset_id', p.get('assetId', '')))
            if token not in self.tokens:
                return
            b, at = self.book(token), number(p.get('timestamp'))
            b['revision'] += 1
            if not at > 0 or at < b['serverAt']:
                b['issue'] = 'out_of_order'
                return
            for side in ('bids', 'asks'):
                b[side] = {number(l.get('price')): number(l.get('size')) for l in p.get(side, []) if 0 <= number(l.get('price')) <= 1 and number(l.get('size')) > 0 and math.isfinite(number(l.get('size')))}
            b.update(serverAt=at, receivedAt=received, seeded=True, issue=None)
        elif kind == 'price_change':
            changes = p.get('price_changes', p.get('priceChanges', []))
            changed = {}
            for c in changes:
                token = str(c.get('asset_id', c.get('assetId', '')))
                if token not in self.tokens:
                    continue
                b, at = self.book(token), number(p.get('timestamp'))
                b['revision'] += 1
                changed[token] = c
                if not b['seeded'] or not at > 0 or at < b['serverAt'] or b['issue']:
                    b['issue'] = b['issue'] or 'out_of_order'
                    continue
                price, size = number(c.get('price')), number(c.get('size'))
                side = {'BUY': 'bids', 'SELL': 'asks'}.get(c.get('side'))
                if not side or not 0 <= price <= 1 or not math.isfinite(size) or size < 0:
                    b['issue'] = 'malformed_delta'
                    continue
                if size == 0:
                    b[side].pop(price, None)
                else:
                    b[side][price] = size
                b.update(serverAt=at, receivedAt=received)
            for token, c in changed.items():
                b = self.book(token)
                bid, ask = max(b['bids'], default=-math.inf), min(b['asks'], default=math.inf)
                if bid > ask:
                    b['issue'] = 'crossed'
                for snake, camel, expected, levels in [('best_bid', 'bestBid', bid, b['bids']), ('best_ask', 'bestAsk', ask, b['asks'])]:
                    advertised = c.get(snake, c.get(camel))
                    if advertised is not None and levels and abs(number(advertised)-expected) > 1e-9:
                        b['issue'] = 'touch_mismatch'

    def consume(self, row, markets):
        d, kind = row['data'], row['type']
        if kind == 'http' and '/book?' in d['url'] and d['status'] == 200:
            raw = json.loads(d['body'])
            token = str(raw.get('asset_id', ''))
            if token in self.tokens:
                key = (token, raw.get('hash'), number(raw.get('timestamp')))
                self.rest.pop(key, None)
                self.rest[key] = raw
                # Only the current/recent confirmations are needed, not all history.
                if len(self.rest) > 100:
                    del self.rest[next(iter(self.rest))]
        elif kind == 'book-seeded' and d['token'] in self.tokens:
            raw = self.rest[(d['token'], d.get('hash'), d['serverAt'])]
            assert raw['market'] == d['conditionId']
            self.ingest(dict(raw, event_type='book'), d['receivedAt'])
            assert self.book(d['token'])['revision'] == d['revision']
        elif kind == 'wire':
            events = json.loads(d['wire'])
            for e in events if isinstance(events, list) else [events]:
                self.ingest(e, d.get('receivedAt', row['at']))
        elif kind in {'book-reset', 'retired-socket-closed'}:
            for t in markets.get(d['conditionId'], {}).get('tokens', []):
                self.books.pop(t['id'], None)
                self.confirmations.pop(t['id'], None)
        elif kind == 'book-confirmed':
            self.confirmations[d['token']] = d
        elif kind == 'paper-recovery':
            self.evidence = None
            # Money/IDs survive recovery; a new producer creates a new
            # DepthState. Old revisions and confirmation leases do not carry.
            self.books.clear()
            self.rest.clear()
            self.confirmations.clear()
        elif kind == 'valuation-evidence':
            assert self.evidence is None
            self.evidence = d

    def fresh(self, token, b, now, proof):
        age = self.report['config']['maxAgeMs']
        if not b['seeded'] or b['issue'] or not b['bids'] or not b['asks'] or max(b['bids']) >= min(b['asks']) or now < b['receivedAt'] or b['serverAt'] > now+1000:
            return False
        if now-b['receivedAt'] <= age and now-b['serverAt'] <= age:
            return True
        if self.report.get('bookFreshness') != 'verified-snapshot' or not proof:
            return False
        assert proof == self.confirmations.get(token), 'Invented final confirmation'
        assert proof['token'] == token and re.fullmatch(r'[0-9a-fA-F]{40,64}', proof['hash'])
        assert (token, proof['hash'], proof['serverAt']) in self.rest
        valid = 0 <= proof['receivedAt']-proof['requestedAt'] <= age and abs(proof['receivedAt']-parsedate_to_datetime(proof['date']).timestamp()*1000) <= 2000
        valid = valid and float(proof['age'] or 0) == 0 and (proof['cacheStatus'] or 'NONE').upper() in {'DYNAMIC', 'MISS', 'BYPASS', 'NONE'}
        return valid and proof['revision'] == b['revision'] and proof['serverAt'] == b['serverAt'] and 0 <= now-proof['receivedAt'] <= age

    def verify(self, holdings, cash, markets):
        r = self.report
        if r.get('valuationAt') is None:
            return False
        assert self.evidence and self.evidence['at'] == r['valuationAt']
        now = r['valuationAt']
        assert r['startedAt'] <= now <= r['updatedAt']
        evidence = {x['token']: x for x in self.evidence['books']}
        assert set(evidence) == self.tokens
        mid, liquidation = cash, cash
        complete_mid = complete_liquidation = True
        for token in self.tokens:
            h, b, e = holdings[token], self.book(token), evidence[token]
            s = e['snapshot']
            for key in ('revision', 'serverAt', 'receivedAt', 'seeded', 'issue'):
                assert s[key] == b[key], ('Final book identity differs', token, key)
            for side in ('bids', 'asks'):
                assert {x['price']: x['size'] for x in s[side]} == b[side], ('Final depth differs', token)
            if not self.fresh(token, b, now, e.get('confirmation')):
                complete_mid = complete_liquidation = False
                continue
            mid += h['shares'] * (max(b['bids'])+min(b['asks']))/2
            m = next(m for m in markets.values() if token in [t['id'] for t in m['tokens']])
            if r.get('liquidationConstraints') == 'ctf-minimum-and-two-decimal-size-v1' and (h['shares']+1e-9 < m['minShares'] or abs(h['shares']*100-round(h['shares']*100)) > 1e-7):
                complete_liquidation = False
                continue
            remaining = h['shares']
            for price, size in sorted(b['bids'].items(), reverse=True):
                qty = min(size, remaining)
                if qty <= 1e-9:
                    break
                assert 0 < price < 1
                fee = qty*m['fee']['rate']*(price*(1-price))**m['fee']['exponent']
                liquidation += qty*price-math.floor(fee*1e5+.5)/1e5
                remaining -= qty
            if remaining > 1e-9:
                complete_liquidation = False
        for key, expected in [('midEquityUsd', mid if complete_mid else None), ('liquidationEquityUsd', liquidation if complete_liquidation else None)]:
            actual = r.get(key)
            assert actual is None if expected is None else actual is not None and math.isclose(actual, expected, abs_tol=1e-7), ('Final valuation differs', key, actual, expected)
            pnl = r.get(key.replace('Equity', 'Pnl'))
            assert pnl is None if expected is None else pnl is not None and math.isclose(pnl, expected-r['bankrollUsd'], abs_tol=1e-7)
        return complete_mid and complete_liquidation
