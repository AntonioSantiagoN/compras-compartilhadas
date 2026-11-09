'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');

const PORT = Number(process.env.PORT || 3000);
const USER_PASSWORD = process.env.USER_PASSWORD || 'teste123';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'adm1234!';
const SESSION_SECRET = process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
// No Railway, o banco fica no Volume montado (persistente entre deploys e reinícios).
const ON_RAILWAY = Boolean(process.env.RAILWAY_ENVIRONMENT);
const VOLUME_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH;
const DB_FILE = process.env.DB_FILE || path.join(VOLUME_DIR || __dirname, 'compras.sqlite');
const COOKIE_SECURE = process.env.COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production' || ON_RAILWAY;
if (ON_RAILWAY) {
  if (!VOLUME_DIR && !process.env.DB_FILE) console.warn('AVISO: nenhum Volume do Railway montado. Os dados serão APAGADOS a cada deploy. Crie um Volume no serviço.');
  if (!process.env.USER_PASSWORD || !process.env.ADMIN_PASSWORD) console.warn('AVISO: USER_PASSWORD/ADMIN_PASSWORD não definidas; usando as senhas padrão públicas do repositório.');
  if (!process.env.SESSION_SECRET) console.warn('AVISO: SESSION_SECRET não definida; todos serão deslogados a cada reinício.');
}
fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
const root = path.join(__dirname, 'public');
const db = new DatabaseSync(DB_FILE);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS lists (
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT NOT NULL DEFAULT '',
 starts_at TEXT NOT NULL, duration_days INTEGER NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
 id INTEGER PRIMARY KEY AUTOINCREMENT, list_id INTEGER NOT NULL REFERENCES lists(id) ON DELETE CASCADE,
 name TEXT NOT NULL, position INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS registrations (
 id INTEGER PRIMARY KEY AUTOINCREMENT, product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
 lot INTEGER NOT NULL, name TEXT NOT NULL, phone TEXT NOT NULL, quantity INTEGER NOT NULL,
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reg_product_lot ON registrations(product_id, lot);
`);

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
  for await (const chunk of req) { bytes += chunk.length; if (bytes > 32768) throw Object.assign(new Error('Dados muito grandes.'), { status: 413 }); chunks.push(chunk); }
  try { return JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { throw Object.assign(new Error('Dados inválidos.'), { status: 400 }); }
}
const clean = (s, max) => typeof s === 'string' ? s.trim().slice(0, max) : '';
const getList = id => db.prepare('SELECT * FROM lists WHERE id=?').get(id);
const getProduct = id => db.prepare('SELECT p.*, l.starts_at, l.duration_days FROM products p JOIN lists l ON l.id=p.list_id WHERE p.id=?').get(id);
const endOf = list => new Date(Date.parse(list.starts_at) + list.duration_days * 86400000).toISOString();
const isOpen = list => Date.now() >= Date.parse(list.starts_at) && Date.now() < Date.parse(endOf(list));
const attempts = new Map();
function rateLimit(ip) {
  const t = Date.now(); const entry = attempts.get(ip) || { count: 0, until: t + 60000 };
  if (entry.until < t) { entry.count = 0; entry.until = t + 60000; }
  entry.count++; attempts.set(ip, entry); return entry.count <= 20;
}
function listDetails(id) {
  const list = getList(id); if (!list) return null;
  const products = db.prepare('SELECT * FROM products WHERE list_id=? ORDER BY position,id').all(id);
  const rows = db.prepare(`SELECT r.id,r.product_id,r.lot,r.name,r.phone,r.quantity,r.created_at
    FROM registrations r JOIN products p ON p.id=r.product_id WHERE p.list_id=? ORDER BY r.product_id,r.lot,r.id`).all(id);
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
    if (!rateLimit(req.socket.remoteAddress || 'unknown')) return json(res, 429, { error: 'Muitas tentativas. Tente novamente em um minuto.' });
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
  if (url.pathname === '/api/lists' && method === 'GET') {
    const lists = db.prepare('SELECT * FROM lists ORDER BY id DESC').all().map(l => ({ ...l, ends_at: endOf(l), open: isOpen(l) }));
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
    db.exec('BEGIN IMMEDIATE');
    try {
      const created = db.prepare('INSERT INTO lists(title, description, starts_at, duration_days, created_at) VALUES(?,?,?,?,?)').run(title, description, new Date(startsAt).toISOString(), durationDays, now());
      const p = db.prepare('INSERT INTO products(list_id,name,position) VALUES(?,?,?)');
      productNames.forEach((name, index) => p.run(created.lastInsertRowid, name, index));
      db.exec('COMMIT');
      return json(res, 201, { id: Number(created.lastInsertRowid) });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const matchList = url.pathname.match(/^\/api\/lists\/(\d+)$/);
  if (matchList && method === 'GET') { const item = listDetails(Number(matchList[1])); return item ? json(res, 200, { list: item }) : json(res, 404, { error: 'Lista não encontrada.' }); }
  const matchRegistration = url.pathname.match(/^\/api\/products\/(\d+)\/register$/);
  if (matchRegistration && method === 'POST') {
    const productId = Number(matchRegistration[1]);
    const data = await body(req), name = clean(data.name, 90), phone = clean(data.phone, 30), quantity = Number(data.quantity);
    if (name.length < 2 || !/^\+?[\d\s()\-]{8,22}$/.test(phone) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10000)
      return json(res, 400, { error: 'Informe nome, telefone válido e quantidade entre 1 e 10.000.' });
    db.exec('BEGIN IMMEDIATE');
    try {
      const product = getProduct(productId);
      if (!product) { db.exec('ROLLBACK'); return json(res, 404, { error: 'Produto não encontrado.' }); }
      if (!isOpen(product)) { db.exec('ROLLBACK'); return json(res, 400, { error: 'Esta lista ainda não começou ou já encerrou.' }); }
      // Uma compra por telefone e produto em cada lista; evita duplicações acidentais.
      const normalized = phone.replace(/\D/g, '');
      const existing = db.prepare('SELECT phone FROM registrations WHERE product_id=?').all(productId);
      if (existing.some(r => r.phone.replace(/\D/g, '') === normalized)) { db.exec('ROLLBACK'); return json(res, 409, { error: 'Este telefone já está cadastrado neste produto. Peça ao administrador para corrigir.' }); }
      const count = db.prepare('SELECT COUNT(*) AS n FROM registrations WHERE product_id=?').get(productId).n;
      const lot = Math.floor(count / 4) + 1;
      const inserted = db.prepare('INSERT INTO registrations(product_id,lot,name,phone,quantity,created_at) VALUES(?,?,?,?,?,?)').run(productId, lot, name, phone, quantity, now());
      db.exec('COMMIT');
      return json(res, 201, { id: Number(inserted.lastInsertRowid), lot });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const deleteReg = url.pathname.match(/^\/api\/registrations\/(\d+)$/);
  if (deleteReg && method === 'DELETE') {
    if (!auth(req, res, true)) return;
    db.exec('BEGIN IMMEDIATE');
    try {
      const reg = db.prepare('SELECT product_id FROM registrations WHERE id=?').get(Number(deleteReg[1]));
      if (!reg) { db.exec('ROLLBACK'); return json(res, 404, { error: 'Inscrição não encontrada.' }); }
      db.prepare('DELETE FROM registrations WHERE id=?').run(Number(deleteReg[1]));
      // Reenumera lotes mantendo a sequência de inscrições após exclusões.
      const others = db.prepare('SELECT id FROM registrations WHERE product_id=? ORDER BY id').all(reg.product_id);
      const update = db.prepare('UPDATE registrations SET lot=? WHERE id=?');
      others.forEach((r, i) => update.run(Math.floor(i / 4) + 1, r.id));
      db.exec('COMMIT'); return json(res, 200, { ok: true });
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  return json(res, 404, { error: 'Endereço não encontrado.' });
}
const mime = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://localhost');
    if (['POST', 'DELETE', 'PATCH', 'PUT'].includes(req.method)) {
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) return json(res, 403, { error: 'Origem não permitida.' });
    }
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (req.method !== 'GET') return json(res, 405, { error: 'Método não permitido.' });
    const item = url.pathname === '/' ? '/index.html' : url.pathname;
    const resolved = path.resolve(root, '.' + decodeURIComponent(item));
    if (!(resolved === root || resolved.startsWith(root + path.sep))) return json(res, 403, { error: 'Acesso negado.' });
    fs.readFile(resolved, (err, data) => {
      if (err) { res.writeHead(404); return res.end('Não encontrado'); }
      res.writeHead(200, { 'Content-Type': mime[path.extname(resolved)] || 'application/octet-stream', 'X-Content-Type-Options': 'nosniff' }); res.end(data);
    });
  } catch (err) { console.error(err); json(res, err.status || 500, { error: err.status ? err.message : 'Ocorreu um erro. Tente novamente.' }); }
});
if (require.main === module) server.listen(PORT, '0.0.0.0', () => console.log(`Compras Compartilhadas disponível em http://localhost:${PORT}`));
module.exports = { server, db };
