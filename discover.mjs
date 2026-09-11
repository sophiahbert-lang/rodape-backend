// ================================================================
// RODAPÉ · robô de descoberta de assuntos
// Lê os artigos mais vistos da Wikipédia (ontem), pede ao Claude
// (Haiku 4.5) pra escolher até N assuntos CULTURAIS relevantes que
// ainda não existem, e cria como novos assuntos no banco.
// O robô de coleta (ingest.mjs) passa a monitorá-los sozinho.
// Node 18+ (fetch nativo). Sem dependências.
// ================================================================

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) { console.error('Faltam SUPABASE_URL / SUPABASE_SERVICE_KEY'); process.exit(1); }
if (!ANTHROPIC_API_KEY) { console.error('Falta ANTHROPIC_API_KEY'); process.exit(1); }

const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const UA = 'rodape-observatorio/1.0 (TCC; contato: mofo.ws)';
const MAX_NEW = 5;           // no máximo 5 assuntos novos por dia
const MODEL = 'claude-haiku-4-5-20251001';

const slug = s => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

// ---- 1) assuntos que já existem (pra não duplicar) ---------------
async function existing() {
  const r = await fetch(`${REST}/subjects?select=subject_id,wiki_title`, { headers: SB });
  const rows = r.ok ? await r.json() : [];
  const ids = new Set(), titles = new Set();
  rows.forEach(x => { ids.add(x.subject_id); if (x.wiki_title) titles.add(x.wiki_title.toLowerCase()); });
  return { ids, titles };
}

// ---- 2) candidatos: mais vistos da Wikipédia (ontem) -------------
async function candidates() {
  const d = new Date(Date.now() - 2 * 864e5); // 2 dias atrás (o ranking tem atraso)
  const y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  const out = [];
  for (const lang of ['en', 'pt']) {
    try {
      const url = `https://wikimedia.org/api/rest_v1/metrics/pageviews/top/${lang}.wikipedia.org/all-access/${y}/${m}/${day}`;
      const r = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const j = await r.json();
      const arts = (j.items && j.items[0] && j.items[0].articles) || [];
      for (const a of arts) {
        const t = a.article;
        if (/[:/]/.test(t)) continue;                          // Special:, Portal:, etc.
        if (/^(Main_Page|P%C3%A1gina_principal|Wikipedia|Special)/i.test(t)) continue;
        if (/^List_of|^Lista_de|_deaths|deaths_in_/i.test(t)) continue;
        out.push({ title: t.replace(/_/g, ' '), wiki_title: t.replace(/_/g, ' '), views: a.views, lang });
      }
    } catch (_) {}
  }
  // dedup por título, ordena por views, corta em 120 (economiza tokens)
  const seen = new Set(), uniq = [];
  out.sort((a, b) => b.views - a.views);
  for (const c of out) { const k = c.title.toLowerCase(); if (seen.has(k)) continue; seen.add(k); uniq.push(c); }
  return uniq.slice(0, 120);
}

// ---- 3) curadoria pela IA (Claude Haiku) -------------------------
async function curate(cands) {
  const list = cands.map(c => `- ${c.title} (${c.views} views)`).join('\n');
  const system = `Você seleciona assuntos para um observatório de conversação cultural (uso de Relações Públicas, foco em cultura pop global e brasileira).
Dada a lista dos artigos mais vistos da Wikipédia ontem, escolha ATÉ ${MAX_NEW} que sejam assuntos CULTURAIS relevantes e em ascensão: cinema, séries, música/artistas, games, livros, celebridades, moda, fenômenos de internet/memes/estéticas.
EXCLUA: política, eleições, esportes e atletas, notícia dura, guerra, obituários (a menos que figura cultural relevante), lugares/geografia, empresas/tecnologia genérica, conteúdo adulto, temas puramente técnicos ou enciclopédicos sem circulação cultural atual.
Prefira o que gera conversa cultural. Se quase nada se qualificar, devolva menos itens (ou lista vazia). Nunca invente itens fora da lista.
Responda SOMENTE com um array JSON, sem texto ao redor, cada item no formato:
{"subject_id":"slug-curto","nome":"Nome","tipo":"obra|pessoa|tema","kind":"rótulo curto em PT (ex: 'Filme · 2026', 'Cantora', 'Série', 'Fenômeno de internet')","wiki_title":"Título exato do artigo em inglês"}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 900, system, messages: [{ role: 'user', content: `Artigos mais vistos ontem:\n${list}` }] }),
  });
  if (!r.ok) { console.error('anthropic', r.status, (await r.text()).slice(0, 300)); return []; }
  const j = await r.json();
  let txt = (j.content && j.content[0] && j.content[0].text || '').trim();
  txt = txt.replace(/^```json\s*|^```\s*|\s*```$/g, '').trim();
  const s = txt.indexOf('['), e = txt.lastIndexOf(']');
  if (s < 0 || e < 0) { console.error('resposta sem JSON:', txt.slice(0, 200)); return []; }
  try { return JSON.parse(txt.slice(s, e + 1)); } catch (err) { console.error('parse', err.message); return []; }
}

// ---- 4) inserir novos assuntos -----------------------------------
async function insert(items) {
  if (!items.length) return;
  const r = await fetch(`${REST}/subjects?on_conflict=subject_id`, {
    method: 'POST',
    headers: { ...SB, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(items),
  });
  if (!r.ok) console.error('insert', r.status, (await r.text()).slice(0, 300));
}

// ---- run ---------------------------------------------------------
const { ids, titles } = await existing();
const cands = (await candidates()).filter(c => !titles.has(c.wiki_title.toLowerCase()));
console.log(`candidatos: ${cands.length} (após remover os que já existem)`);
if (!cands.length) { console.log('nada novo pra avaliar'); process.exit(0); }

const picks = await curate(cands);
console.log(`IA escolheu: ${picks.length}`);

const clean = [];
for (const p of picks.slice(0, MAX_NEW)) {
  if (!p || !p.nome) continue;
  const id = slug(p.subject_id || p.nome);
  if (!id || ids.has(id)) continue;
  ids.add(id);
  clean.push({
    subject_id: id, nome: p.nome, tipo: (p.tipo || 'tema'),
    kind: p.kind || '', wiki_title: p.wiki_title || p.nome, wiki_lang: 'en',
    youtube_query: p.nome, reddit_query: p.nome, news_query: p.nome, active: true,
  });
}
await insert(clean);
console.log('novos assuntos criados:', clean.map(c => c.subject_id).join(', ') || '(nenhum)');
