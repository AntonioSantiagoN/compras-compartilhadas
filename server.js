'use strict';
// Rodando localmente (`npm start`), carrega variáveis do arquivo .env, se existir.
if (require.main === module) { try { process.loadEnvFile(); } catch {} }

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Pool } = require('pg');

const PORT = Number(process.env.PORT || 3000);
const ON_VERCEL = Boolean(process.env.VERCEL);
const DATABASE_URL = process.env.DATABASE_URL;
const USER_PASSWORD = process.env.USER_PASSWORD || (ON_VERCEL ? '' : 'teste123');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || (ON_VERCEL ? '' : 'adm1234!');
const SESSION_SECRET = process.env.SESSION_SECRET || (ON_VERCEL ? '' : crypto.randomBytes(32).toString('hex'));
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' || ON_VERCEL;
const root = path.join(__dirname, 'public');

// Na Vercel não há senhas padrão: sem estas variáveis o site recusa funcionar.
const missingConfig = [
  !DATABASE_URL && 'DATABASE_URL',
  !USER_PASSWORD && 'USER_PASSWORD',
  !ADMIN_PASSWORD && 'ADMIN_PASSWORD',
  !SESSION_SECRET && 'SESSION_SECRET',
].filter(Boolean);
if (missingConfig.length) console.error('Configuração incompleta. Defina: ' + missingConfig.join(', '));

// Banco PostgreSQL (no Railway). Conexões locais não usam SSL; remotas usam
// SSL sem validar o certificado, pois o Postgres do Railway usa certificado próprio.
const isLocalDb = /@(localhost|127\.0\.0\.1)(:|\/)/.test(DATABASE_URL || '');
const pool = DATABASE_URL ? new Pool({
  connectionString: DATABASE_URL,
  ssl: isLocalDb || process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: ON_VERCEL ? 3 : 10,
  idleTimeoutMillis: 10000,
  connectionTimeoutMillis: 10000,
}) : null;
if (pool) pool.on('error', err => console.error('Erro na conexão com o banco:', err.message));

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lists (
 id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 starts_at TEXT NOT NULL, duration_days INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
 id SERIAL PRIMARY KEY, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
 name TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registrations (
 id SERIAL PRIMARY KEY, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 lot INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, quantity INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_product_lot ON registrations(product_id, lot);
CREATE INDEX IF NOT EXISTS idx_products_list ON products(list_id);
`;
let schemaReady = null;
function ensureSchema() {
  // Cria as tabelas na primeira requisição de cada instância; tenta de novo se falhar.
  if (!schemaReady) schemaReady = pool.query(SCHEMA).catch(err => { schemaReady = null; throw err; });
  return schemaReady;
}
const query = async (text, params) => (await pool.query(text, params)).rows;
async function transaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn((text, params) => client.query(text, params).then(r => r.rows));
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally { client.release(); }
}
// Erro "esperado" que encerra a transação e vira uma resposta ao usuário.
const httpError = (status, message) => Object.assign(new Error(message), { status });

const now = () => new Date().toISOString();
const json = (res, status, value) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
};
const secureEq = (a, b) => {
  const x = Buffer.from(String(a)); const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
const sign = value => crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url');
const makeToken = role => { const val = Buffer.from(JSON.stringify({ role, exp: Date.now() + 7 * 86400000 })).toString('base64url'); return val + '.' + sign(val); };
function roleFrom(req) {
  const match = (req.headers.cookie || '').match(/(?:^|;\s*)cc_session=([^;]+)/);
  if (!match) return null;
  const token = decodeURIComponent(match[1]);
  const split = token.split('.');
  if (split.length !== 2 || !secureEq(split[1], sign(split[0]))) return null;
  try { const payload = JSON.parse(Buffer.from(split[0], 'base64url').toString()); return payload.exp > Date.now() && ['user', 'admin'].includes(payload.role) ? payload.role : null; }
  catch { return null; }
}
function auth(req, res, admin = false) {
  const role = roleFrom(req);
  if (!role) { json(res, 401, { error: 'Entre com a senha para continuar.' }); return false; }
  if (admin && role !== 'admin') { json(res, 403, { error: 'Acesso reservado à administração.' }); return false; }
  return true;
}
async function body(req) {
  let bytes = 0, chunks = [];
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw httpError(413, 'Dados muito grandes.'); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw httpError(400, 'Dados inválidos.'); }
}
const clean = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const endOf = list => new Date(Date.parse(list.starts_at) + list.duration_days * 86400000).toISOString();
const isOpen = list => Date.now() >= Date.parse(list.starts_at) && Date.now() < Date.parse(endOf(list));
// Na Vercel a memória não é compartilhada entre instâncias, então este limite é aproximado.
const attempts = new Map();
function rateLimit(ip) {
  const t = Date.now(); const entry = attempts.get(ip) || { count: 0, until: t + 60000 };
  if (entry.until < t) { entry.count = 0; entry.until = t + 60000; }
  entry.count++; attempts.set(ip, entry); return entry.count <= 20;
}
const clientIp = req => (ON_VERCEL && req.headers['x-real-ip']) || req.socket.remoteAddress || 'unknown';
async function listDetails(id) {
  const [list] = await query('SELECT * FROM lists WHERE id=$1', [id]); if (!list) return null;
  const products = await query('SELECT * FROM products WHERE list_id=$1 ORDER BY position,id', [id]);
  const rows = await query(`SELECT r.id,r.product_id,r.lot,r.name,r.phone,r.quantity,r.created_at
    FROM registrations r JOIN products p ON p.id=r.product_id WHERE p.list_id=$1 ORDER BY r.product_id,r.lot,r.id`, [id]);
  return { ...list, ends_at: endOf(list), open: isOpen(list), products: products.map(p => {
    const records = rows.filter(r => r.product_id === p.id);
    const largest = records.length ? Math.max(...records.map(r => r.lot)) : 1;
    const lots = [];
    for (let n = 1; n <= largest; n++) lots.push({ number: n, registrations: records.filter(r => r.lot === n) });
    return { ...p, lots, total_participants: records.length, total_quantity: records.reduce((sum, r) => sum + r.quantity, 0) };
  }) };
}
async function api(req, res, url) {
  const method = req.method;
  if (url.pathname === '/api/session' && method === 'GET') return json(res, 200, { role: roleFrom(req) });
  if (url.pathname === '/api/login' && method === 'POST') {
    if (!rateLimit(clientIp(req))) return json(res, 429, { error: 'Muitas tentativas. Tente novamente em um minuto.' });
    const data = await body(req);
    const role = secureEq(data.password || '', ADMIN_PASSWORD) ? 'admin' : secureEq(data.password || '', USER_PASSWORD) ? 'user' : null;
    if (!role) return json(res, 401, { error: 'Senha incorreta.' });
    res.setHeader('Set-Cookie', `cc_session=${makeToken(role)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${COOKIE_SECURE ? '; Secure' : ''}`);
    return json(res, 200, { role });
  }
  if (url.pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', `cc_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${COOKIE_SECURE ? '; Secure' : ''}`);
    return json(res, 200, { ok: true });
  }
  if (!auth(req, res)) return;
  await ensureSchema();
  if (url.pathname === '/api/lists' && method === 'GET') {
    const lists = (await query('SELECT * FROM lists ORDER BY id DESC')).map(l => ({ ...l, ends_at: endOf(l), open: isOpen(l) }));
    return json(res, 200, { lists });
  }
  if (url.pathname === '/api/lists' && method === 'POST') {
    if (!auth(req, res, true)) return;
    const data = await body(req);
    const title = clean(data.title, 100), description = clean(data.description, 500);
    const startsAt = Date.parse(data.starts_at);
    const durationDays = Number(data.duration_days);
    const productNames = Array.isArray(data.products) ? data.products.map(x => clean(x, 100)).filter(Boolean) : [];
    if (!title || !Number.isFinite(startsAt) || !Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365 || !productNames.length || productNames.length > 40)
      return json(res, 400, { error: 'Informe título, início, duração (1 a 365 dias) e pelo menos um produto.' });
    const id = await transaction(async q => {
      const [created] = await q('INSERT INTO lists(title, description, starts_at, duration_days, created_at) VALUES($1,$2,$3,$4,$5) RETURNING id',
        [title, description, new Date(startsAt).toISOString(), durationDays, now()]);
      for (const [index, name] of productNames.entries()) await q('INSERT INTO products(list_id,name,position) VALUES($1,$2,$3)', [created.id, name, index]);
      return created.id;
    });
    return json(res, 201, { id });
  }
  const matchList = url.pathname.match(/^\/api\/lists\/(\d+)$/);
  if (matchList && method === 'GET') { const item = await listDetails(Number(matchList[1])); return item ? json(res, 200, { list: item }) : json(res, 404, { error: 'Lista não encontrada.' }); }
  const matchRegistration = url.pathname.match(/^\/api\/products\/(\d+)\/register$/);
  if (matchRegistration && method === 'POST') {
    const productId = Number(matchRegistration[1]);
    const data = await body(req), name = clean(data.name, 90), phone = clean(data.phone, 30), quantity = Number(data.quantity);
    if (name.length < 2 || !/^\+?[\d\s()\-]{8,22}$/.test(phone) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
      return json(res, 400, { error: 'Informe nome, telefone válido e quantidade entre 1 e 10.000.' });
    const result = await transaction(async q => {
      // FOR UPDATE trava o produto: inscrições simultâneas no mesmo produto entram uma de cada vez,
      // então a contagem de lotes nunca é calculada em duplicidade.
      const [product] = await q('SELECT p.id, l.starts_at, l.duration_days FROM products p JOIN lists l ON l.id=p.list_id WHERE p.id=$1 FOR UPDATE OF p', [productId]);
      if (!product) throw httpError(404, 'Produto não encontrado.');
      if (!isOpen(product)) throw httpError(400, 'Esta lista ainda não começou ou já encerrou.');
      // Uma compra por telefone e produto em cada lista; evita duplicações acidentais.
      const normalized = phone.replace(/\D/g, '');
      const existing = await q('SELECT phone FROM registrations WHERE product_id=$1', [productId]);
      if (existing.some(r => r.phone.replace(/\D/g, '') === normalized)) throw httpError(409, 'Este telefone já está cadastrado neste produto. Peça ao administrador para corrigir.');
      const lot = Math.floor(existing.length / 4) + 1;
      const [inserted] = await q('INSERT INTO registrations(product_id,lot,name,phone,quantity,created_at) VALUES($1,$2,$3,$4,$5,$6) RETURNING id', [productId, lot, name, phone, quantity, now()]);
      return { id: inserted.id, lot };
    });
    return json(res, 201, result);
  }
  const deleteReg = url.pathname.match(/^\/api\/registrations\/(\d+)$/);
  if (deleteReg && method === 'DELETE') {
    if (!auth(req, res, true)) return;
    const regId = Number(deleteReg[1]);
    await transaction(async q => {
      const [reg] = await q('SELECT product_id FROM registrations WHERE id=$1', [regId]);
      if (!reg) throw httpError(404, 'Inscrição não encontrada.');
      await q('SELECT id FROM products WHERE id=$1 FOR UPDATE', [reg.product_id]);
      const deleted = await q('DELETE FROM registrations WHERE id=$1 RETURNING id', [regId]);
      if (!deleted.length) throw httpError(404, 'Inscrição não encontrada.');
      // Reenumera lotes mantendo a sequência de inscrições após exclusões.
      const others = await q('SELECT id FROM registrations WHERE product_id=$1 ORDER BY id', [reg.product_id]);
      for (const [i, r] of others.entries()) await q('UPDATE registrations SET lot=$1 WHERE id=$2', [Math.floor(i / 4) + 1, r.id]);
    });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: 'Endereço não encontrado.' });
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
// Atende a API e, rodando localmente, também os arquivos de /public.
// Na Vercel, /public é servido direto pela CDN e só /api/* chega aqui (via api/index.js).
async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (['POST', 'DELETE', 'PATCH', 'PUT'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Origem não permitida.' });
    }
    if (url.pathname.startsWith('/api/')) {
      if (missingConfig.length) return json(res, 500, { error: 'Servidor sem configuração completa. Avise o administrador.' });
      return await api(req, res, url);
    }
    if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
    const item = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = path.resolve(root, '.' + decodeURIComponent(item));
    if (!(resolved === root || resolved.startsWith(root + path.sep))) return json(res, 403, { error: 'Acesso negado.' });
    fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Não encontrado'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(resolved)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
    });
  } catch (err) {
    if (!err.status) console.error(err);
    if (!res.headersSent) json(res, err.status || 500, { error: err.status ? err.message : 'Ocorreu um erro. Tente novamente.' });
  }
}
const server = http.createServer(handler);
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Compras Compartilhadas disponível em http://localhost:${PORT}`));
module.exports = { handler, server, pool };
