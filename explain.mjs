// ================================================================
// RODAPÉ · robô "por que está em alta"
// Lê os assuntos mais ativos + suas manchetes reais (evidence) e
// pede ao Claude (Haiku) uma explicação curta do pico. Grava em
// subjects.why. Roda depois da coleta. Node 18+. Sem dependências.
// ================================================================

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, ANTHROPIC_API_KEY } = process.env;
if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY || !ANTHROPIC_API_KEY) { console.error('Faltam variáveis (SUPABASE_URL / SUPABASE_SERVICE_KEY / ANTHROPIC_API_KEY)'); process.exit(1); }
const REST = `${SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
const SB = { apikey: SUPABASE_SERVICE_KEY, Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`, 'Content-Type': 'application/json' };
const MODEL = 'claude-haiku-4-5-20251001';
const MAX = 20; // no máximo 20 explicações por dia (custo ~centavos)

async function activeSubjects() {
  // v_pulse traz growth + evidence; pega os mais ativos que têm manchetes
  const r = await fetch(`${REST}/v_pulse?select=subject_id,nome,growth,evidence&order=growth.desc`, { headers: SB });
  const rows = r.ok ? await r.json() : [];
  return rows.filter(x => Array.isArray(x.evidence) && x.evidence.length).slice(0, MAX);
}

async function explain(row) {
  const heads = row.evidence.slice(0, 8).map(e => `- [${e.source}] ${e.title}`).join('\n');
  const system = `Você explica, em 1 ou 2 frases curtas e diretas (português do Brasil), POR QUE um assunto cultural está em alta, com base APENAS nas manchetes/títulos reais fornecidos. Não invente fatos. Se as manchetes não indicarem um gatilho claro, diga que o interesse cresceu sem um estopim único evidente. Tom informativo e objetivo, sem floreio. Responda só a explicação, sem preâmbulo nem aspas.`;
  const user = `Assunto: ${row.nome}\nCrescimento recente: ${row.growth >= 0 ? '+' : ''}${row.growth}%\nManchetes/títulos coletados:\n${heads}`;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: MODEL, max_tokens: 200, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) { console.error('  anthropic', row.subject_id, r.status); return null; }
  const j = await r.json();
  const txt = (j.content && j.content[0] && j.content[0].text || '').trim();
  return txt || null;
}

async function save(subject_id, why) {
  await fetch(`${REST}/subjects?subject_id=eq.${subject_id}`, {
    method: 'PATCH', headers: { ...SB, Prefer: 'return=minimal' },
    body: JSON.stringify({ why, why_at: new Date().toISOString() }),
  }).catch(() => {});
}

const rows = await activeSubjects();
console.log(`explicando ${rows.length} assuntos ativos`);
for (const row of rows) {
  try {
    const why = await explain(row);
    if (why) { await save(row.subject_id, why); console.log('.', row.subject_id, '→', why.slice(0, 70)); }
  } catch (e) { console.error('  ', row.subject_id, e.message); }
  await new Promise(r => setTimeout(r, 400));
}
console.log('explicações concluídas');
