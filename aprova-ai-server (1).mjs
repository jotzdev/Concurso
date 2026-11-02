#!/usr/bin/env node
/**
 * Aprova Professor — servidor de IA (Node >= 18, sem dependências).
 *
 * Responsabilidades (o frontend nunca vê chaves):
 *   POST /api/summarize  { url, topicId?, syllabus?, transcript? }  -> resumo estruturado
 *   POST /api/chat       { system, context, messages }              -> { text }
 *   GET  /api/health                                                -> status dos provedores
 *   GET  /                                                          -> serve aprova-professor.html (opcional)
 *
 * Fluxo de /api/summarize:
 *   1. valida e normaliza a URL (allowlist YouTube/Instagram/TikTok, https, sem credenciais/porta)
 *   2. metadados via oEmbed oficial (título, canal, miniatura)
 *   3. transcrição, na ordem: texto enviado pelo aluno (opcional) -> provedores configurados
 *   4. se não houver transcrição: erro NO_TRANSCRIPT (nada é inventado)
 *   5. IA (Anthropic Messages API) gera o JSON estruturado
 *
 * Variáveis de ambiente:
 *   ANTHROPIC_API_KEY   (obrigatória para IA)
 *   AI_MODEL            (padrão: claude-sonnet-5-5)
 *   ALLOWED_ORIGINS     origens permitidas para CORS, separadas por vírgula (ex.: https://meusite.com)
 *   PORT                (padrão: 8787)
 *   META_OEMBED_TOKEN   token do app Meta para o oEmbed oficial do Instagram (opcional)
 *   TRANSCRIPT_API_URL  provedor externo contratado por você (POST {url,platform,lang} -> {text,title?,channel?})
 *   TRANSCRIPT_API_KEY  chave do provedor acima (Authorization: Bearer)
 *   ENABLE_YT_PAGE_CAPTIONS=1  lê legendas públicas da página do YouTube (opt-in; confira os termos de uso)
 *   STATIC_FILE         arquivo HTML a servir em "/" (padrão: aprova-professor.html)
 */
import http from 'node:http';
import dns from 'node:dns/promises';
import net from 'node:net';
import { readFile } from 'node:fs/promises';

const ENV = process.env;
const PORT = +ENV.PORT || 8787;
const ORIGINS = (ENV.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const MODEL = ENV.AI_MODEL || 'claude-sonnet-5-5';
const MAX_TRANSCRIPT = 100000;

const HOSTS = {
  youtube: ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be'],
  tiktok: ['tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com'],
  instagram: ['instagram.com', 'www.instagram.com'],
};
const FETCH_HOSTS = new Set([...Object.values(HOSTS).flat(), 'graph.facebook.com']);

class AppError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

/* ---------- validação de URL / SSRF ---------- */
export function classify(raw) {
  let u;
  try { u = new URL(String(raw).trim()); } catch { throw new AppError('INVALID_URL', 'Link inválido.'); }
  if (!/^https?:$/.test(u.protocol)) throw new AppError('INVALID_URL', 'Use um link http(s).');
  if (u.username || u.password) throw new AppError('INVALID_URL', 'Links com credenciais não são aceitos.');
  if (u.port && u.port !== '443' && u.port !== '80') throw new AppError('INVALID_URL', 'Porta não permitida.');
  u.protocol = 'https:'; u.port = ''; u.hash = '';
  const host = u.hostname.toLowerCase();
  const platform = Object.keys(HOSTS).find(p => HOSTS[p].includes(host));
  if (!platform) throw new AppError('UNSUPPORTED_PLATFORM', 'Plataforma não suportada. Use YouTube, Instagram ou TikTok.');
  let id = '';
  if (platform === 'youtube') {
    if (host === 'youtu.be') id = u.pathname.slice(1).split('/')[0];
    else if (u.pathname === '/watch') id = u.searchParams.get('v') || '';
    else { const m = u.pathname.match(/^\/(shorts|embed|live)\/([\w-]{11})/); id = m ? m[2] : ''; }
    if (!/^[\w-]{11}$/.test(id)) throw new AppError('INVALID_URL', 'Não encontrei o ID do vídeo do YouTube neste link.');
    return { platform, id, url: `https://www.youtube.com/watch?v=${id}` };
  }
  if (platform === 'instagram') {
    const m = u.pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]+)/);
    if (!m) throw new AppError('INVALID_URL', 'Use o link de um post, reel ou vídeo do Instagram.');
    return { platform, id: m[2], url: `https://www.instagram.com/${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}/` };
  }
  if (!/^\/@[\w.-]+\/video\/\d+/.test(u.pathname) && !['vm.tiktok.com', 'vt.tiktok.com'].includes(host))
    throw new AppError('INVALID_URL', 'Use o link de um vídeo do TikTok.');
  u.search = '';
  return { platform, id: '', url: u.toString() };
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivateIp(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}
async function assertPublicHost(host) {
  if (net.isIP(host)) throw new AppError('INVALID_URL', 'Endereços IP não são permitidos.');
  const addrs = await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => isPrivateIp(a.address))) throw new AppError('INVALID_URL', 'Destino não permitido.');
}

/** fetch seguro: allowlist de hosts, https, redirecionamentos manuais revalidados, timeout e limite de tamanho. */
async function safeFetch(url, { headers = {}, timeoutMs = 10000, maxBytes = 3_000_000 } = {}) {
  let cur = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = new URL(cur);
    if (u.protocol !== 'https:' || !FETCH_HOSTS.has(u.hostname.toLowerCase()) || u.username || u.password)
      throw new AppError('INVALID_URL', 'Redirecionamento não permitido.');
    await assertPublicHost(u.hostname);
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    let res;
    try { res = await fetch(cur, { headers: { 'user-agent': 'AprovaProfessor/1.0', ...headers }, redirect: 'manual', signal: ctl.signal }); }
    catch (e) { throw new AppError(e.name === 'AbortError' ? 'TIMEOUT' : 'UNAVAILABLE', 'Não foi possível acessar a plataforma agora.', 504); }
    finally { clearTimeout(t); }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { cur = new URL(res.headers.get('location'), cur).toString(); continue; }
    const reader = res.body.getReader(); const chunks = []; let size = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > maxBytes) { reader.cancel(); break; } chunks.push(value); }
    return { status: res.status, ok: res.ok, text: Buffer.concat(chunks).toString('utf8') };
  }
  throw new AppError('INVALID_URL', 'Redirecionamentos demais.');
}

/* ---------- provedores de metadados ---------- */
const metaProviders = {
  async youtube(v) { return oembed(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(v.url)}`); },
  async tiktok(v) { return oembed(`https://www.tiktok.com/oembed?url=${encodeURIComponent(v.url)}`); },
  async instagram(v) {
    if (!ENV.META_OEMBED_TOKEN) return {};
    return oembed(`https://graph.facebook.com/v19.0/instagram_oembed?omitscript=true&url=${encodeURIComponent(v.url)}&access_token=${encodeURIComponent(ENV.META_OEMBED_TOKEN)}`);
  },
};
async function oembed(endpoint) {
  const r = await safeFetch(endpoint, { maxBytes: 200000 });
  if ([401, 403, 404].includes(r.status)) throw new AppError('UNAVAILABLE', 'Não conseguimos acessar este vídeo. Ele pode ser privado, restrito ou ter sido removido.', 404);
  if (!r.ok) return {};
  try { const j = JSON.parse(r.text); return { title: j.title || '', channel: j.author_name || '', thumbnail: j.thumbnail_url || '' }; } catch { return {}; }
}

/* ---------- provedores de transcrição (substituíveis) ---------- */
// Cada provedor: async ({platform,id,url}) => { text, title?, channel? } | null. Lance AppError para falhas definitivas.
const transcriptProviders = [];

// 1) Provedor externo contratado por você (também pode fazer ASR de áudio, desde que autorizado).
if (ENV.TRANSCRIPT_API_URL) transcriptProviders.push({
  name: 'external',
  async get(v) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 90000);
    try {
      const r = await fetch(ENV.TRANSCRIPT_API_URL, { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', ...(ENV.TRANSCRIPT_API_KEY ? { authorization: `Bearer ${ENV.TRANSCRIPT_API_KEY}` } : {}) }, body: JSON.stringify({ url: v.url, platform: v.platform, lang: 'pt' }) });
      if (!r.ok) return null;
      const j = await r.json(); return j && j.text ? { text: String(j.text), title: j.title, channel: j.channel } : null;
    } catch { return null; } finally { clearTimeout(t); }
  },
});

// 2) Legendas públicas da página do YouTube (opt-in). Não contorna login nem proteções: se o vídeo exigir, falha.
if (ENV.ENABLE_YT_PAGE_CAPTIONS === '1') transcriptProviders.push({
  name: 'youtube-page-captions',
  async get(v) {
    if (v.platform !== 'youtube') return null;
    const page = await safeFetch(`https://www.youtube.com/watch?v=${v.id}&hl=pt`, { headers: { 'accept-language': 'pt-BR,pt;q=0.9,en;q=0.5' }, maxBytes: 4_000_000 });
    const pr = extractJson(page.text, 'ytInitialPlayerResponse');
    if (!pr) return null;
    const st = pr.playabilityStatus && pr.playabilityStatus.status;
    if (st && st !== 'OK') throw new AppError('UNAVAILABLE', 'Este vídeo está indisponível, é privado ou restrito.', 404);
    const tracks = pr.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
    const tr = tracks.find(t => (t.languageCode || '').startsWith('pt')) || tracks[0];
    if (!tr?.baseUrl) return null;
    const cap = await safeFetch(tr.baseUrl + '&fmt=json3', { maxBytes: 3_000_000 });
    let text = '';
    try { text = (JSON.parse(cap.text).events || []).map(e => (e.segs || []).map(s => s.utf8).join('')).join(' ').replace(/\s+/g, ' ').trim(); } catch { return null; }
    return text ? { text, title: pr.videoDetails?.title, channel: pr.videoDetails?.author } : null;
  },
});
function extractJson(html, key) {
  const i = html.indexOf(key + ' = '); if (i < 0) return null;
  const s = html.indexOf('{', i); let depth = 0, inStr = false, esc = false;
  for (let k = s; k < html.length; k++) {
    const ch = html[k];
    if (inStr) { if (esc) esc = false; else if (ch === '\\') esc = true; else if (ch === '"') inStr = false; continue; }
    if (ch === '"') inStr = true; else if (ch === '{') depth++; else if (ch === '}' && --depth === 0) { try { return JSON.parse(html.slice(s, k + 1)); } catch { return null; } }
  }
  return null;
}

/* ---------- IA ---------- */
async function anthropic(system, messages, max_tokens = 6000) {
  if (!ENV.ANTHROPIC_API_KEY) throw new AppError('NO_AI', 'A IA não está configurada no servidor (ANTHROPIC_API_KEY).', 503);
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 150000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', signal: ctl.signal, headers: { 'content-type': 'application/json', 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model: MODEL, max_tokens, system, messages }) });
    if (r.status === 429) throw new AppError('RATE_LIMIT', 'Limite de uso da IA atingido. Aguarde um pouco.', 429);
    if (!r.ok) throw new AppError('AI_FAIL', 'A IA não respondeu corretamente. Tente novamente.', 502);
    const j = await r.json();
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  } catch (e) { if (e instanceof AppError) throw e; throw new AppError(e.name === 'AbortError' ? 'TIMEOUT' : 'AI_FAIL', 'A IA demorou demais ou falhou.', 504); }
  finally { clearTimeout(t); }
}
const SCHEMA = '{"overview":{"subject":"","summary":""},"mainIdeas":[""],"notes":[{"heading":"","points":[""],"definitions":[{"term":"","definition":""}],"examples":[""],"distinctions":[""]}],"examRelevance":{"topicId":"","topicTitle":"","matchNote":"","fromVideo":[""],"fromSyllabus":[""],"additional":[""],"lessRelevant":[""]},"keyConcepts":[{"term":"","explanation":""}],"quickRevision":[""],"questions":[{"q":"","options":{"A":"","B":"","C":"","D":"","E":""},"answer":"A","explanation":"","concept":"","wrong":{"B":""},"extra":false}],"flashcards":[{"front":"","back":""}]}';
const SYS = 'Você é um assistente de estudos para o concurso de Professor de Conceição do Almeida/BA (2026, banca Objetiva). Regras: (1) use SOMENTE a transcrição como fonte do conteúdo do vídeo; não invente fatos, citações, números de lei, marcações de tempo ou detalhes ausentes dela; (2) em examRelevance, escolha topicId somente entre os ids da lista de tópicos do edital e apenas se o vídeo realmente tratar do tópico (senão deixe vazio e explique em matchNote); separe fromVideo (dito no vídeo), fromSyllabus (o que o texto oficial do edital registra) e additional (explicações adicionais suas, rotuladas como tais); liste em lessRelevant o que parece secundário para o edital; nunca afirme que algo "cai na prova"; (3) crie 3 a 5 questões de múltipla escolha com 5 alternativas A–E, baseadas na transcrição, com explicação, o conceito do vídeo e o motivo de cada alternativa errada; (4) crie de 4 a 8 flashcards; (5) responda em português do Brasil, somente com JSON válido no esquema fornecido.';
function parseJson(t) {
  t = t.replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a < 0 || b < a) throw new AppError('AI_FAIL', 'A IA devolveu um formato inválido. Tente novamente.', 502);
  try { return JSON.parse(t.slice(a, b + 1)); } catch { throw new AppError('AI_FAIL', 'A resposta da IA veio incompleta. Tente novamente.', 502); }
}
const cleanTranscript = t => String(t || '').replace(/^WEBVTT.*$/gm, '').replace(/^\d+\s*$/gm, '').replace(/^.*-->.*$/gm, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();

/* ---------- handlers ---------- */
async function summarize(body) {
  const v = classify(body.url);
  let meta = {};
  try { meta = await metaProviders[v.platform](v); }
  catch (e) { if (e instanceof AppError && e.code === 'UNAVAILABLE' && !body.transcript) throw e; /* metadados são opcionais */ }

  let text = cleanTranscript(body.transcript), source = 'user';
  if (text.length < 200) {
    text = ''; source = '';
    for (const p of transcriptProviders) {
      try { const r = await p.get(v); if (r && r.text && r.text.length >= 200) { text = cleanTranscript(r.text); source = p.name; meta = { ...meta, title: meta.title || r.title, channel: meta.channel || r.channel }; break; } }
      catch (e) { if (e instanceof AppError && e.code === 'UNAVAILABLE') throw e; }
    }
  }
  if (!text) throw new AppError('NO_TRANSCRIPT', 'Não conseguimos obter legendas ou transcrição deste vídeo. Ele pode ser privado, restrito ou não permitir transcrição automática.', 422);
  const truncated = text.length > MAX_TRANSCRIPT; if (truncated) text = text.slice(0, MAX_TRANSCRIPT);

  const syl = Array.isArray(body.syllabus) ? body.syllabus.slice(0, 80).map(s => ({ id: String(s.id || '').slice(0, 200), subject: String(s.subject || '').slice(0, 80), title: String(s.title || '').slice(0, 200), desc: String(s.desc || '').slice(0, 500) })) : [];
  const hint = body.topicId ? `\nO aluno indicou o tópico (id): ${String(body.topicId).slice(0, 200)}` : '';
  const out = await anthropic(SYS, [{ role: 'user', content: `Vídeo: ${meta.title || '(sem título)'} — ${meta.channel || ''} (${v.platform})\nTÓPICOS DO EDITAL:\n${JSON.stringify(syl)}${hint}\n\nESQUEMA JSON:\n${SCHEMA}\n\nTRANSCRIÇÃO:\n"""\n${text}\n"""` }]);
  const summary = parseJson(out);
  if (!summary.overview || !summary.overview.summary) throw new AppError('AI_FAIL', 'A IA devolveu um resumo vazio. Tente novamente.', 502);
  return { meta: { ...meta, platform: v.platform }, summary, transcriptSource: source, truncated };
}
async function chat(body) {
  const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-12).filter(m => m && ['user', 'assistant'].includes(m.role)).map(m => ({ role: m.role, content: String(m.content || '').slice(0, 8000) }));
  if (!msgs.length || msgs[0].role !== 'user') throw new AppError('BAD_REQUEST', 'Mensagem inválida.');
  const system = String(body.system || '').slice(0, 6000) + (body.context ? '\n\nCONTEXTO:\n' + String(body.context).slice(0, 40000) : '');
  return { text: await anthropic(system, msgs, 3000) };
}

/* ---------- servidor ---------- */
const hits = new Map();
function limited(ip) { const now = Date.now(), a = (hits.get(ip) || []).filter(t => now - t < 3600e3); a.push(now); hits.set(ip, a); return a.length > 60; }
function cors(req, res) {
  const o = req.headers.origin;
  if (o && (ORIGINS.includes(o) || ORIGINS.includes('*'))) { res.setHeader('access-control-allow-origin', o); res.setHeader('vary', 'origin'); }
  res.setHeader('access-control-allow-headers', 'content-type'); res.setHeader('access-control-allow-methods', 'GET,POST,OPTIONS');
}
const send = (res, status, obj) => { res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(obj)); };
function readBody(req) { return new Promise((ok, no) => { let n = 0; const c = []; req.on('data', d => { n += d.length; if (n > 1_500_000) { no(new AppError('BAD_REQUEST', 'Requisição grande demais.', 413)); req.destroy(); } else c.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(c).toString() || '{}')); } catch { no(new AppError('BAD_REQUEST', 'JSON inválido.')); } }); }); }

export const server = http.createServer(async (req, res) => {
  cors(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
  const path = new URL(req.url, 'http://x').pathname;
  try {
    if (req.method === 'GET' && path === '/api/health')
      return send(res, 200, { ok: true, service: 'aprova-ai', ai: !!ENV.ANTHROPIC_API_KEY, providers: { oembed: true, instagramOembed: !!ENV.META_OEMBED_TOKEN, youtubeCaptions: ENV.ENABLE_YT_PAGE_CAPTIONS === '1', transcriptApi: !!ENV.TRANSCRIPT_API_URL } });
    if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
      try { const html = await readFile(ENV.STATIC_FILE || 'aprova-professor.html'); res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(html); }
      catch { return send(res, 404, { error: { code: 'NOT_FOUND', message: 'Arquivo HTML não encontrado.' } }); }
    }
    if (req.method === 'POST' && (path === '/api/summarize' || path === '/api/chat')) {
      if (limited(req.socket.remoteAddress || '?')) throw new AppError('RATE_LIMIT', 'Muitas requisições. Tente mais tarde.', 429);
      const body = await readBody(req);
      return send(res, 200, path === '/api/chat' ? await chat(body) : await summarize(body));
    }
    send(res, 404, { error: { code: 'NOT_FOUND', message: 'Rota inexistente.' } });
  } catch (e) {
    if (!(e instanceof AppError)) console.error('erro interno:', e.message);
    const err = e instanceof AppError ? e : new AppError('INTERNAL', 'Erro interno do servidor.', 500);
    send(res, err.status, { error: { code: err.code, message: err.message } });
  }
});
if (import.meta.url === `file://${process.argv[1]}`) server.listen(PORT, () => console.log(`Aprova AI server em http://localhost:${PORT}`));
