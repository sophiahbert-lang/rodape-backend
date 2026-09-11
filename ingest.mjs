// ================================================================
// RODAPÉ · robô de coleta diária (v2 — com títulos/evidências + RSS)
// Fontes: Wikipédia (volume/curva) + YouTube + Reddit + Notícias(GDELT) + RSS(BR).
// Além de contar, agora GUARDA manchetes/títulos reais por assunto
// (subjects.evidence) — combustível da aba "Por que está em alta".
// Grava via HTTP/PostgREST. Node 18+. Sem dependências.
// ================================================================

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, YOUTUBE_API_KEY, REDDIT_CLIENT_ID, REDDIT_CLIENT_SECRET } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const UA = 'rodape-observatorio/1.0 (TCC; contato: mofo.ws)';
const today = new Date().toISOString().slice(0, 10);
const pad = n => String(n).padStart(2, '0');
const ymd = d => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function sbSelectSubjects() {
  const r = await fetch(`${REST}/subjects?select=*&active=eq.true`, { headers: SB });
  if (!r.ok) throw new Error(`subjects ${r.status}: ${await r.text()}`);
  return r.json();
}
async function sbUpsert(rows) {
  if (!rows.length) return;
  const r = await fetch(`${REST}/metrics_daily?on_conflict=subject_id,d,source`, {
    method: 'POST', headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(rows),
  });
  if (!r.ok) console.error('  upsert', r.status, (await r.text()).slice(0, 160));
}
async function sbSaveEvidence(subject_id, evidence) {
  const r = await fetch(`${REST}/subjects?subject_id=eq.${subject_id}`, {
    method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify({ evidence }),
  });
  if (!r.ok) console.error('  evidence', subject_id, r.status);
}

// ---- WIKIPÉDIA (volume/curva) ------------------------------------
async function wiki(s, ev) {
  const title = (s.wiki_title || s.nome).replace(/ /g, '_');
  const lang = s.wiki_lang || 'en';
  const start = new Date(Date.now() - 33 * 864e5), end = new Date(Date.now() - 864e5);
  const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/${lang}.wikipedia.org/all-access/all-agents/${encodeURIComponent(title)}/daily/${ymd(start)}/${ymd(end)}`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return;
  const j = await r.json();
  const rows = (j.items || []).map(it => ({ subject_id: s.subject_id, d: `${it.timestamp.slice(0,4)}-${it.timestamp.slice(4,6)}-${it.timestamp.slice(6,8)}`, source: 'wikipedia', value: it.views }));
  await sbUpsert(rows);
}

// ---- YOUTUBE (contagem + TÍTULOS dos vídeos de hoje) -------------
async function youtube(s, ev) {
  if (!YOUTUBE_API_KEY) return;
  const after = new Date(Date.now() - 864e5).toISOString();
  const q = encodeURIComponent(s.youtube_query || s.nome);
  const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&order=viewCount&publishedAfter=${after}&maxResults=10&q=${q}&key=${YOUTUBE_API_KEY}`;
  const r = await fetch(url);
  if (!r.ok) return;
  const j = await r.json();
  const n = (j.pageInfo && j.pageInfo.totalResults) ?? (j.items ? j.items.length : 0);
  await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'youtube', value: n }]);
  (j.items || []).slice(0, 3).forEach(it => {
    const t = it.snippet && it.snippet.title;
    if (t) ev.push({ source: 'YouTube', title: t, url: `https://www.youtube.com/watch?v=${it.id && it.id.videoId}` });
  });
}

// ---- REDDIT (posts do último dia) --------------------------------
let RTOKEN = null;
async function redditToken() {
  if (RTOKEN) return RTOKEN;
  if (!REDDIT_CLIENT_ID || !REDDIT_CLIENT_SECRET) return null;
  const basic = Buffer.from(`${REDDIT_CLIENT_ID}:${REDDIT_CLIENT_SECRET}`).toString('base64');
  const r = await fetch('https://www.reddit.com/api/v1/access_token', { method: 'POST', headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA }, body: 'grant_type=client_credentials' });
  if (!r.ok) return null;
  RTOKEN = (await r.json()).access_token; return RTOKEN;
}
async function reddit(s, ev) {
  const tok = await redditToken(); if (!tok) return;
  const q = encodeURIComponent(s.reddit_query || s.nome);
  const r = await fetch(`https://oauth.reddit.com/search?q=${q}&sort=top&limit=25&t=day&type=link`, { headers: { Authorization: `Bearer ${tok}`, 'User-Agent': UA } });
  if (!r.ok) return;
  const j = await r.json();
  const ch = (j.data && j.data.children) || [];
  await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'reddit', value: ch.length }]);
  ch.slice(0, 2).forEach(c => { const p = c.data; if (p && p.title) ev.push({ source: 'Reddit', title: p.title, url: 'https://reddit.com' + p.permalink }); });
}

// ---- NOTÍCIAS (GDELT: contagem + TÍTULOS das manchetes) ---------
async function news(s, ev) {
  const q = encodeURIComponent(`"${s.news_query || s.nome}"`);
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${q}&mode=artlist&maxrecords=25&timespan=1d&sort=hybridrel&format=json`;
  const r = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!r.ok) return;
  let j; try { j = await r.json(); } catch { return; }
  const arts = j.articles || [];
  await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'news', value: arts.length }]);
  arts.slice(0, 3).forEach(a => { if (a.title) ev.push({ source: 'Notícia', title: a.title, url: a.url }); });
}

// ---- RSS (portais BR de cultura — títulos casados por nome) ------
const RSS_FEEDS = [
  'https://g1.globo.com/rss/g1/pop-arte/',
  'https://www.tenhomaisdiscosqueamigos.com/feed/',
  'https://www.legiaourbana.com.br/feed/',
];
let RSS_ITEMS = null;
async function rssLoad() {
  if (RSS_ITEMS) return RSS_ITEMS;
  RSS_ITEMS = [];
  for (const f of RSS_FEEDS) {
    try {
      const r = await fetch(f, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const xml = await r.text();
      const items = xml.split(/<item[ >]/).slice(1);
      for (const it of items.slice(0, 40)) {
        const tm = it.match(/<title>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/title>/);
        const lm = it.match(/<link>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/link>/);
        if (tm) RSS_ITEMS.push({ title: tm[1].trim(), url: (lm ? lm[1].trim() : '') });
      }
    } catch (_) {}
  }
  return RSS_ITEMS;
}
async function rss(s, ev) {
  const items = await rssLoad();
  const name = (s.nome || '').toLowerCase();
  if (name.length < 3) return;
  const hits = items.filter(i => i.title.toLowerCase().includes(name));
  if (hits.length) await sbUpsert([{ subject_id: s.subject_id, d: today, source: 'rss', value: hits.length }]);
  hits.slice(0, 2).forEach(h => ev.push({ source: 'Portal', title: h.title, url: h.url }));
}

// ---- LOOP --------------------------------------------------------
const subs = await sbSelectSubjects();
console.log(`coletando ${subs.length} assuntos - ${today}`);
for (const s of subs) {
  console.log('.', s.subject_id);
  const ev = [];
  for (const [name, fn] of [['wiki', wiki], ['youtube', youtube], ['reddit', reddit], ['news', news], ['rss', rss]]) {
    try { await fn(s, ev); } catch (e) { console.error(`  ${name}`, s.subject_id, e.message); }
  }
  if (ev.length) { try { await sbSaveEvidence(s.subject_id, ev.slice(0, 8)); } catch (_) {} }
  await sleep(900);
}
console.log('coleta concluida');
