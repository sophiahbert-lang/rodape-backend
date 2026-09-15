// ================================================================
// RODAPÉ · robô de conexões (afinidade pela IA)
// Pega os assuntos ativos (com nome, tipo e o "porquê" como contexto)
// e pede ao Claude quais se relacionam de verdade e por quê. Grava
// as ligações em subjects.related [{id, via}]. Roda depois do explain.
// Node 18+. Sem dependências.
// ================================================================

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) { console.error('Faltam variáveis'); process.exit(1); }
const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_PER = 6; // no máximo 6 conexões por assunto

async function subjects() {
  const r = await fetch(`${REST}/v_pulse?select=subject_id,nome,kind,why&order=vol30.desc`, { headers: SB });
  return r.ok ? await r.json() : [];
}

async function askPairs(subs) {
  const list = subs.map(s => `${s.subject_id} | ${s.nome}${s.kind ? ' ('+s.kind+')' : ''}${s.why ? ' — '+String(s.why).slice(0,90) : ''}`).join('\n');
  const system = `Você conecta assuntos culturais de um observatório brasileiro. Recebe uma lista (id | nome (tipo) — contexto).
Identifique PARES que se relacionam DE VERDADE e de forma reconhecível: mesma franquia/obra, mesmo criador/artista, mesmo gênero ou movimento, rivais/comparados no momento, tema-irmão, adaptação, fandom compartilhado.
Seja CONSERVADOR: só ligue quando a relação é real e você reconhece os dois. NÃO invente relações. Se não tiver certeza, não ligue.
Para cada par, dê os DOIS ids (exatamente como na lista) e um rótulo curto da relação em português (via), de 1 a 3 palavras (ex.: "mesma franquia", "mesmo diretor", "terror coreano", "rivais do momento", "tema irmão").
Responda SOMENTE um array JSON, sem texto ao redor: [{"a":"id1","b":"id2","via":"..."}]. No máximo 50 pares.`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 1500, system, messages: [{ role: 'user', content: list }] }),
  });
  if (!r.ok) { console.error('anthropic', r.status, (await r.text()).slice(0, 200)); return []; }
  const j = await r.json();
  let txt = (j.content && j.content[0] && j.content[0].text || '').trim().replace(/^```json\s*|^```\s*|\s*```$/g, '').trim();
  const s = txt.indexOf('['), e = txt.lastIndexOf(']');
  if (s < 0 || e < 0) return [];
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return []; }
}

async function save(subject_id, related) {
  await fetch(`${REST}/subjects?subject_id=eq.${subject_id}`, {
    method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' }, body: JSON.stringify({ related }),
  }).catch(() => {});
}

const subs = await subjects();
console.log(`conectando ${subs.length} assuntos`);
if (subs.length < 2) { console.log('poucos assuntos'); process.exit(0); }

const valid = new Set(subs.map(s => s.subject_id));
const pairs = await askPairs(subs);
console.log(`IA sugeriu ${pairs.length} pares`);

// monta a adjacência (bidirecional) a partir dos pares
const adj = {};
for (const p of pairs) {
  if (!p || !p.a || !p.b || p.a === p.b) continue;
  if (!valid.has(p.a) || !valid.has(p.b)) continue;
  const via = (p.via || 'relacionado').toString().slice(0, 40);
  (adj[p.a] = adj[p.a] || []).push({ id: p.b, via });
  (adj[p.b] = adj[p.b] || []).push({ id: p.a, via });
}

// grava related em cada assunto (limpa quem não tiver mais conexão)
let n = 0;
for (const s of subs) {
  const rel = (adj[s.subject_id] || []).slice(0, MAX_PER);
  await save(s.subject_id, rel);
  if (rel.length) n++;
}
console.log(`conexões gravadas em ${n} assuntos`);
