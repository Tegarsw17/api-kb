// Kebun Durian API. Jalankan: node src/server.js
// Env wajib: DATABASE_URL, JWT_SECRET. Opsional: PORT (3000), PHOTOS_DIR.
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { Router, HttpError, reply } from './router.js';
import { sql, withUser, toHttpError } from './db.js';
import {
  hashPassword, verifyPassword, DUMMY_HASH, signToken, verifyToken,
  checkLoginRate, clearLoginRate,
} from './auth.js';
import * as crud from './crud.js';
import * as photos from './photos.js';

const PORT = Number(process.env.PORT ?? 3000);
const JWT_SECRET = process.env.JWT_SECRET ?? '';
if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

const MAX_JSON_BYTES = 1024 * 1024;
const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/login', 'POST /api/auth/setup']);

const app = new Router();
const tokenFor = (id, role) => signToken({ sub: id, role }, JWT_SECRET);

// ---------------------------------------------------------------------
// Auth & akun
// ---------------------------------------------------------------------
app.get('/api/health', async () => {
  await sql`select 1`;
  return { ok: true };
});

// Membuat akun owner pertama. Setelah owner ada, endpoint ini menolak.
app.post('/api/auth/setup', async (ctx) => {
  const { username, full_name, password } = await ctx.json();
  const hash = await hashPassword(password);
  try {
    const [{ id }] = await withUser(null, (tx) => tx`
      select public.create_user(${username}, ${full_name ?? ''}, ${hash}, 'owner') as id`);
    return reply(201, { token: tokenFor(id, 'owner'), user_id: id });
  } catch (err) {
    if (err.code === 'P0001' && /not allowed/.test(err.message)) {
      throw new HttpError(403, 'setup already done: an owner exists');
    }
    throw err;
  }
});

app.post('/api/auth/login', async (ctx) => {
  checkLoginRate(ctx.ip);
  const { username, password } = await ctx.json();
  const [row] = await sql`select * from public.login_lookup(${String(username ?? '')})`;
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) throw new HttpError(401, 'wrong username or password');
  if (!row.active) throw new HttpError(403, 'account is disabled');
  clearLoginRate(ctx.ip);
  return { token: tokenFor(row.user_id, row.role), user_id: row.user_id, role: row.role };
});

app.get('/api/auth/me', async (ctx) => {
  const [me] = await withUser(ctx.user.id, (tx) => tx`
    select * from profiles where id = public.current_user_id()`);
  if (!me) throw new HttpError(401, 'account no longer exists');
  return me;
});

// Owner membuat akun pekerja (pengganti edge function admin-users).
app.post('/api/users', async (ctx) => {
  const { username, full_name, password, role } = await ctx.json();
  const hash = await hashPassword(password);
  const profile = await withUser(ctx.user.id, async (tx) => {
    const [{ id }] = await tx`
      select public.create_user(${username}, ${full_name ?? ''}, ${hash}, ${role ?? 'worker'}) as id`;
    const [p] = await tx`select * from profiles where id = ${id}`;
    return p;
  });
  return reply(201, profile);
});

// Ganti password: diri sendiri, atau owner untuk siapa pun.
app.put('/api/users/:id/password', async (ctx) => {
  const { password } = await ctx.json();
  const hash = await hashPassword(password);
  await withUser(ctx.user.id, (tx) => tx`select public.set_password(${ctx.params.id}, ${hash})`);
  return { ok: true };
});

// ---------------------------------------------------------------------
// Fungsi khusus (pengganti supabase.rpc)
// ---------------------------------------------------------------------
app.post('/api/rpc/complete_task', async (ctx) => {
  const { task_id, note, photo } = await ctx.json();
  await withUser(ctx.user.id, (tx) => tx`
    select public.complete_task(${task_id}, ${note ?? ''}, ${photo ?? null})`);
  return { ok: true };
});

app.post('/api/rpc/set_my_language', async (ctx) => {
  const { language } = await ctx.json();
  await withUser(ctx.user.id, (tx) => tx`select public.set_my_language(${language})`);
  return { ok: true };
});

// ---------------------------------------------------------------------
// Foto
// ---------------------------------------------------------------------
app.post('/api/photos', async (ctx) => photos.upload(ctx.user, await ctx.formData()));
app.get('/api/photos/:owner/:file', (ctx) => photos.serve(ctx.user, ctx.params.owner, ctx.params.file));
app.delete('/api/photos/:owner/:file', (ctx) => photos.remove(ctx.user, ctx.params.owner, ctx.params.file));

// ---------------------------------------------------------------------
// Tabel (generik). Didaftarkan terakhir agar rute di atas didahulukan.
// ---------------------------------------------------------------------
app.get('/api/:table', (ctx) => crud.list(ctx.user, ctx.params.table, ctx.url.searchParams));
app.post('/api/:table', async (ctx) => reply(201, await crud.create(ctx.user, ctx.params.table, await ctx.json())));
app.get('/api/:table/:id', (ctx) => crud.get(ctx.user, ctx.params.table, ctx.params.id));
app.patch('/api/:table/:id', async (ctx) => crud.update(ctx.user, ctx.params.table, ctx.params.id, await ctx.json()));
app.delete('/api/:table/:id', (ctx) => crud.remove(ctx.user, ctx.params.table, ctx.params.id));

// ---------------------------------------------------------------------
// Server HTTP
// ---------------------------------------------------------------------
function makeContext(req, url, params) {
  return {
    req,
    url,
    params,
    ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim(),
    user: null,
    async json() {
      const len = Number(req.headers['content-length'] ?? 0);
      if (len > MAX_JSON_BYTES) throw new HttpError(413, 'body too large');
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_JSON_BYTES) throw new HttpError(413, 'body too large');
        chunks.push(chunk);
      }
      if (size === 0) return {};
      try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        throw new HttpError(400, 'invalid JSON');
      }
    },
    async formData() {
      const len = Number(req.headers['content-length'] ?? 0);
      if (!len) throw new HttpError(411, 'content-length required');
      if (len > photos.MAX_PHOTO_BYTES + 64 * 1024) throw new HttpError(413, 'photo is larger than 10 MB');
      const request = new Request(url, {
        method: req.method, headers: req.headers, body: Readable.toWeb(req), duplex: 'half',
      });
      try {
        return await request.formData();
      } catch {
        throw new HttpError(400, 'invalid multipart form data');
      }
    },
  };
}

function authenticate(ctx) {
  const header = ctx.req.headers.authorization ?? '';
  // ?token= hanya untuk foto, karena tag <img> tidak bisa mengirim header.
  const token = header.startsWith('Bearer ')
    ? header.slice(7)
    : ctx.url.pathname.startsWith('/api/photos/') ? ctx.url.searchParams.get('token') : null;
  const payload = verifyToken(token, JWT_SECRET);
  if (!payload?.sub) throw new HttpError(401, 'login required');
  ctx.user = { id: payload.sub, role: payload.role };
}

function send(res, status, body, headers = {}) {
  if (body instanceof Readable) {
    res.writeHead(status, headers);
    body.pipe(res);
    return;
  }
  const json = JSON.stringify(body ?? null);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(json),
    ...headers,
  });
  res.end(json);
}

const server = createServer(async (req, res) => {
  const started = Date.now();
  const url = new URL(req.url, 'http://localhost');
  let status = 500;
  try {
    const { handler, params, pathMatched } = app.match(req.method, url.pathname);
    if (!handler) throw new HttpError(pathMatched ? 405 : 404, pathMatched ? 'method not allowed' : 'not found');
    const ctx = makeContext(req, url, params);
    if (!PUBLIC.has(`${req.method} ${url.pathname}`)) authenticate(ctx);
    const result = await handler(ctx);
    if (result?.__reply) {
      status = result.status;
      send(res, result.status, result.body, result.headers);
    } else {
      status = 200;
      send(res, 200, result);
    }
  } catch (err) {
    const e = toHttpError(err);
    status = e.status;
    if (!res.headersSent) send(res, e.status, { error: e.message });
    else res.destroy();
  } finally {
    console.log(`${req.method} ${url.pathname} ${status} ${Date.now() - started}ms`);
  }
});

await crud.loadSchema();
server.listen(PORT, () => console.log(`kebun-api listening on :${PORT}`));

// Berhenti dengan rapi saat container dihentikan (docker stop / deploy baru).
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`${signal} received, shutting down`);
    server.close(async () => {
      await sql.end({ timeout: 5 });
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10_000).unref();
  });
}
