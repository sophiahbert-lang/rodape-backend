// ================================================================
// RODAPÉ · robô de coleta diária
// Puxa Wikipédia + YouTube + Reddit + Notícias (GDELT) e grava no
// Supabase. Roda no GitHub Actions (cron) — ou local com `node ingest.mjs`.
// Node 18+ (usa fetch nativo).
// ================================================================
import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL, SUPABASE_SERVICE_KEY,
  YOUTUBE_API_KEY,
  REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1);
}
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, { auth: { persistSession: false } });
const UA = 'rodape-observatorio/1.0 (TCC; contato: mofo.ws)';
const today = new Date().toISOString().slice(0, 10);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function upsert(subject_id, d, source, value) {
  const { error } = await sb.from('metrics_daily')
    .upsert({ subject_id, d, source, value, updated_at: new Date().toISOString() },
            { onConflict: 'subject_id,d,source' });
  if (error) console.error('  upsert', subject_id, source, error.message);
}

// ---- WIKIPÉDIA (backfill ~32 dias por run, idempotente) ----------
async function wiki(s) {
  const title = (s.wiki_title || s.nome).replace(/ /g, '_');
  const lang = s.wiki_lang || 'en';
  const start = new Date(Date.now() - 33 * 864e5), end = new Date(Date.now() - 864e5);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia.org/all-access/all-agents/${encodeURIComponent(title)}/daily/${ymd(start)}/${ymd(end)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) { console.error('  wiki', s.subject_id, r.status); return; }
  const j = await r.json();
  for (const it of (j.items || [])) {
    const t = it.timestamp;
    const d = `${t.slice(0,4)}-${t.slice(4,6)}-${t.slice(6,8)}`;
    await upsert(s.subject_id, d, 'wikipedia', it.views);
  }
}

// ---- YOUTUBE (vídeos publicados nas últimas 24h = atividade) -----
async function youtube(s) {
  if (!YOUTUBE_API_KEY) return;
  const after = new Date(Date.now() - 864e5).toISOString();
  const q = encodeURIComponent(s.youtube_query || s.nome);
  const url = `https://www.googleapis.com/youtube/v3/search?part=id&type=video&order=date&publishedAfter=${after}&maxResults=50&q=${q}&key=${YOUTUBE_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) { console.error('  yt', s.subject_id, r.status); return; }
  const j = await r.json();
  const n = (j.pageInfo && j.pageInfo.totalResults) ?? (j.items ? j.items.length : 0);
  await upsert(s.subject_id, today, 'youtube', n);
}

// ---- REDDIT (posts do último dia via OAuth userless) -------------
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
  await upsert(s.subject_id, today, 'reddit', n);
}

// ---- NOTÍCIAS (GDELT, sem chave: artigos nas últimas 24h) --------
async function news(s) {
  const q = encodeURIComponent(`"${s.news_query || s.nome}"`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=250&timespan=1d&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) { console.error('  news', s.subject_id, r.status); return; }
  let j; try { j = await r.json(); } catch { return; }
  const n = j?.articles?.length || 0;
  await upsert(s.subject_id, today, 'news', n);
}

// ---- LOOP --------------------------------------------------------
const { data: subs, error } = await sb.from('subjects').select('*').eq('active', true);
if (error) { console.error(error.message); process.exit(1); }
console.log(`coletando ${subs.length} assuntos · ${today}`);

for (const s of subs) {
  console.log('·', s.subject_id);
  for (const [name, fn] of [['wiki', wiki], ['youtube', youtube], ['reddit', reddit], ['news', news]]) {
    try { await fn(s); } catch (e) { console.error(`  ${name}`, s.subject_id, e.message); }
  }
  await sleep(1200); // educado com as APIs
}
console.log('coleta concluída');
