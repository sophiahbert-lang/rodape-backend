// ================================================================
// RODAPÉ · robô "por que está em alta" + sentimento da cobertura
// Lê os assuntos ativos + suas manchetes reais e pede ao Claude,
// numa só chamada: (1) o porquê do pico e (2) a classificação de
// tom (positivo/neutro/negativo) das manchetes. Grava why + sentiment.
// Node 18+. Sem dependências.
// ================================================================

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) { console.error('Faltam variáveis'); process.exit(1); }
const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const MODEL = 'claude-haiku-4-5-20251001';
const MAX = 25;
const today = new Date().toISOString().slice(0, 10);

async function activeSubjects() {
  const r = await fetch(`${REST}/v_pulse?select=subject_id,nome,growth,evidence,sentiment&order=growth.desc`, { headers: SB });
  const rows = r.ok ? await r.json() : [];
  return rows.filter(x => Array.isArray(x.evidence) && x.evidence.length).slice(0, MAX);
}

async function analyze(row) {
  const heads = row.evidence.slice(0, 8).map(e => `- [${e.source}] ${e.title}`).join('\n');
  const system = `Você analisa a COBERTURA (manchetes/títulos) de um assunto cultural, em português do Brasil.
Faça DUAS coisas com base APENAS nas manchetes fornecidas (não invente):
1) "why": 1 ou 2 frases curtas e diretas explicando por que o assunto está em alta. Se não houver gatilho claro, diga que cresceu sem estopim único evidente.
2) Classifique o TOM de cada manchete em relação ao assunto: positivo, neutro ou negativo. Conte quantas de cada. Manchete meramente informativa = neutro.
Responda SOMENTE um objeto JSON, sem texto ao redor:
{"why":"...","pos":0,"neu":0,"neg":0}`;
  const user = `Assunto: ${row.nome}\nCrescimento: ${row.growth >= 0 ? '+' : ''}${row.growth}%\nManchetes:\n${heads}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 300, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) { console.error('  anthropic', row.subject_id, r.status); return null; }
  const j = await r.json();
  let txt = (j.content && j.content[0] && j.content[0].text || '').trim();
  txt = txt.replace(/^```json\s*|^```\s*|\s*```$/g, '').trim();
  const s = txt.indexOf('{'), e = txt.lastIndexOf('}');
  if (s < 0 || e < 0) return null;
  try { return JSON.parse(txt.slice(s, e + 1)); } catch { return null; }
}

async function save(subject_id, why, sentiment) {
  await fetch(`${REST}/subjects?subject_id=eq.${subject_id}`, {
    method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' },
    body: JSON.stringify({ why, why_at: new Date().toISOString(), sentiment, sentiment_at: new Date().toISOString() }),
  }).catch(() => {});
}

const rows = await activeSubjects();
console.log(`analisando ${rows.length} assuntos`);
for (const row of rows) {
  try {
    const a = await analyze(row);
    if (!a) continue;
    const pos = +a.pos || 0, neu = +a.neu || 0, neg = +a.neg || 0, tot = pos + neu + neg;
    const score = tot > 0 ? Math.round((pos - neg) / tot * 100) : 0;
    let hist = (row.sentiment && Array.isArray(row.sentiment.history)) ? row.sentiment.history.filter(h => h.d !== today) : [];
    hist.push({ d: today, s: score });
    hist = hist.slice(-30);
    const sentiment = { pos, neu, neg, score, history: hist };
    await save(row.subject_id, a.why || null, sentiment);
    console.log('.', row.subject_id, `tom ${score >= 0 ? '+' : ''}${score}`, '|', (a.why || '').slice(0, 50));
  } catch (e) { console.error('  ', row.subject_id, e.message); }
  await new Promise(r => setTimeout(r, 400));
}
console.log('análise concluída');
