// ================================================================
// RODAPÉ · robô de coleta diária
// Puxa Wikipédia + YouTube + Reddit + Notícias (GDELT) e grava no
// Supabase via API REST (PostgREST) — sem SDK, sem dependências,
// então não precisa nem de `npm install`. Node 18+ (fetch nativo).
// ================================================================

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  YOUTUBE_API_KEY,
  REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1);
}
const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const SB_HEADERS = {
  apikey: SUPABASE_SERVICE_KEY,
  Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
  'Content-Type': 'application/json',
};
const UA = 'rodape-observatorio/1.0 (TCC; contato: mofo.ws)';
const today = new Date().toISOString().slice(0, 10);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- Supabase via REST -------------------------------------------
async function sbSelectSubjects() {
  const r = await fetch(`${REST}/subjects?select=*&active=eq.true`, { headers: SB_HEADERS });
  if (!r.ok) throw new Error(`subjects ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbUpsert(rows) {
  if (!rows.length) return;
  const r = await fetch(`${REST}/metrics_daily?on_conflict=subject_id,d,source`, {
    method: 'POST',
    headers: { ...SB_HEADERS, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) console.error('  upsert', r.status, (await r.text()).slice(0, 200));
}

// ---- WIKIPEDIA (backfill ~32 dias por run, idempotente) ----------
async function wiki(s) {
  const title = (s.wiki_title || s.nome).replace(/ /g, '_');
  const lang = s.wiki_lang || 'en';
  const start = new Date(Date.now() - 33 * 864e5), end = new Date(Date.now() - 864e5);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia.org/all-access/all-agents/${encodeURIComponent(title)}/daily/${ymd(start)}/${ymd(end)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) { console.error('  wiki', s.subject_id, r.status); return; }
  const j = await r.json();
  const rows = (j.items || []).map(it => ({
    subject_id: s.subject_id,
    d: `${it.timestamp.slice(0,4)}-${it.timestamp.slice(4,6)}-${it.timestamp.slice(6,8)}`,
    source: 'wikipedia',
    value: it.views,
  }));
  await sbUpsert(rows);
}

// ---- YOUTUBE (videos publicados nas ultimas 24h = atividade) -----
async function youtube(s) {
  if (!YOUTUBE_API_KEY) return;
  const after = new Date(Date.now() - 864e5).toISOString();
  const q = encodeURIComponent(s.youtube_query || s.nome);
  const url = `https://www.googleapis.com/youtube/v3/search?part=id&type=video&order=date&publishedAfter=${after}&maxResults=50&q=${q}&key=${YOUTUBE_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.error('  yt', s.subject_id, r.status); return; }
  const j = await r.json();
  const n = (j.pageInfo && j.pageInfo.totalResults) ?? (j.items ? j.items.length : 0);
  await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'youtube', value: n }]);
}

// ---- REDDIT (posts do ultimo dia via OAuth userless) -------------
let RTOKEN = null;
async function redditToken() {
  if (RTOKEN) return RTOKEN;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return null;
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
    body: 'grant_type=client_credentials',
  });
  if (!r.ok) { console.error('  reddit token', r.status); return null; }
  RTOKEN = (await r.json()).access_token;
  return RTOKEN;
}
async function reddit(s) {
  const tok = await redditToken(); if (!tok) return;
  const q = encodeURIComponent(s.reddit_query || s.nome);
  const url = `https://oauth.reddit.com/search?q=${q}&sort=new&limit=100&t=day&type=link`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': UA } });
  if (!r.ok) { console.error('  reddit', s.subject_id, r.status); return; }
  const j = await r.json();
  const n = j?.data?.children?.length || 0;
  await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'reddit', value: n }]);
}

// ---- NOTICIAS (GDELT, sem chave: artigos nas ultimas 24h) --------
async function news(s) {
  const q = encodeURIComponent(`"${s.news_query || s.nome}"`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=250&timespan=1d&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) { console.error('  news', s.subject_id, r.status); return; }
  let j; try { j = await r.json(); } catch { return; }
  const n = j?.articles?.length || 0;
  await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'news', value: n }]);
}

// ---- LOOP --------------------------------------------------------
const subs = await sbSelectSubjects();
console.log(`coletando ${subs.length} assuntos - ${today}`);

for (const s of subs) {
  console.log('.', s.subject_id);
  for (const [name, fn] of [['wiki', wiki], ['youtube', youtube], ['reddit', reddit], ['news', news]]) {
    try { await fn(s); } catch (e) { console.error(`  ${name}`, s.subject_id, e.message); }
  }
  await sleep(1000);
}
console.log('coleta concluida');
