/** Public GET-only transport. This module cannot import account or trading clients. */
export interface PublicPage<T> { data: T[]; pagination: { has_more: boolean; next_cursor: string | null } }
export interface Coverage { rows: number; pages: number; complete: boolean; reason: string | null }
export type PublicJournal = (entry: object) => void;
const hosts = new Set(['data-api.polymarket.com', 'gamma-api.polymarket.com', 'clob.polymarket.com']);
export async function publicJson(url: string, journal: PublicJournal = () => {}, fetcher = fetch, signal?:AbortSignal): Promise<any> {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !hosts.has(u.hostname) || u.username || u.password) throw Error('Unsupported public endpoint');
  for (let attempt = 0; attempt < 3; attempt++) {
    signal?.throwIfAborted();
    const at = Date.now();
    const timeout=new AbortController(),timer=setTimeout(()=>timeout.abort(new Error('Public read deadline')),20_000);
    let response:Response,body:string;
    try{
      response = await fetcher(u, { method: 'GET', credentials:'omit', headers:{accept:'application/json','user-agent':'Zinger-paper-research/1.2'}, signal: signal?AbortSignal.any([timeout.signal,signal]):timeout.signal });
      body = await response.text();
    }finally{clearTimeout(timer);}
    const text=body;
    journal({ at, url: String(u), status: response.status, body: text });
    if (response.ok) return JSON.parse(text);
    if (![429, 503].includes(response.status) || attempt === 2) throw Error(`Public endpoint HTTP ${response.status}: ${text.slice(0,200)}`);
    const delay = Number(response.headers.get('retry-after') ?? 1);
    if (!Number.isFinite(delay) || delay < 0 || delay > 20) throw Error('Public service requested a longer retry; rerun later');
    await new Promise<void>((resolve,reject)=>{
      const done=()=>{signal?.removeEventListener('abort',aborted);resolve();};
      const timer=setTimeout(done,Math.max(1000,delay*1000));
      const aborted=()=>{clearTimeout(timer);signal?.removeEventListener('abort',aborted);reject(signal?.reason??new Error('Public read aborted'));};
      signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
    });
  }
  throw Error('Read retries exhausted');
}
export async function walkPublicPages<T>(url: string, maxPages: number, consume: (rows: T[]) => void,
  read: (url: string) => Promise<PublicPage<T>> = publicJson): Promise<Coverage> {
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 500) throw Error('Invalid page budget');
  const base = new URL(url); let cursor: string | null = null, rows = 0;
  const cursors = new Set<string>();
  for (let page = 1; page <= maxPages; page++) {
    const u = new URL(base); if (cursor) u.searchParams.set('cursor', cursor);
    const result = await read(String(u));
    if (!Array.isArray(result.data) || typeof result.pagination?.has_more !== 'boolean') throw Error('Malformed public page');
    consume(result.data); rows += result.data.length;
    if (!result.pagination.has_more) {
      if (result.pagination.next_cursor != null) throw Error('Inconsistent terminal cursor');
      return { rows, pages: page, complete: true, reason: null };
    }
    const next = result.pagination.next_cursor;
    if (!next || cursors.has(next) || result.data.length === 0) throw Error('Missing or repeating pagination cursor');
    cursors.add(next); cursor = next;
  }
  return { rows, pages: maxPages, complete: false, reason: 'page_budget_exhausted' };
}
