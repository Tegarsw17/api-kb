// API generik untuk semua tabel: GET/POST/PATCH/DELETE /api/<tabel>.
// Hak akses TIDAK dicek di sini: RLS di Postgres yang menentukan siapa
// boleh melihat/mengubah apa. Di sini hanya validasi nama tabel/kolom
// (dari daftar yang dibaca dari database) supaya query selalu aman.
import { sql, withUser } from './db.js';
import { HttpError } from './router.js';

// Tabel yang boleh diakses lewat API dan operasi yang diizinkan.
// profiles: tidak bisa POST (akun dibuat lewat /api/users agar password ikut tersimpan).
const TABLES = {
  profiles:          { ops: ['list', 'get', 'update', 'delete'] },
  sites:             {},
  varieties:         {},
  trees:             {},
  supplies:          {},
  supply_movements:  {},
  schedules:         {},
  activities:        {},
  tasks:             {},
  daily_reports:     {},
  tree_events:       {},
  harvests:          {},
  sales:             {},
  expenses:          {},
  overdue_schedules: { ops: ['list'] },
};
const ALL_OPS = ['list', 'get', 'create', 'update', 'delete'];

const OPS = {
  eq:  (c, v) => sql`${sql(c)} = ${v}`,
  neq: (c, v) => sql`${sql(c)} <> ${v}`,
  gt:  (c, v) => sql`${sql(c)} > ${v}`,
  gte: (c, v) => sql`${sql(c)} >= ${v}`,
  lt:  (c, v) => sql`${sql(c)} < ${v}`,
  lte: (c, v) => sql`${sql(c)} <= ${v}`,
  in:  (c, v) => sql`${sql(c)}::text = any(${v.split(',')}::text[])`,
  ilike: (c, v) => sql`${sql(c)}::text ilike ${v.replaceAll('*', '%')}`,
  is: (c, v) => {
    if (v === 'null') return sql`${sql(c)} is null`;
    if (v === 'true') return sql`${sql(c)} is true`;
    if (v === 'false') return sql`${sql(c)} is false`;
    throw new HttpError(400, `"is" only accepts null, true or false`);
  },
};

let schema = null; // { table: { columns: Set, writable: Set, pk } }

// Membaca struktur tabel dari database sekali saat server start.
export async function loadSchema() {
  const cols = await sql`
    select table_name, column_name, is_generated
    from information_schema.columns
    where table_schema = 'public'
    order by table_name, ordinal_position`;
  const pks = await sql`
    select c.relname as table_name, a.attname as column_name
    from pg_index i
    join pg_class c on c.oid = i.indrelid
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum = any(i.indkey)
    where i.indisprimary and n.nspname = 'public'`;

  schema = {};
  for (const name of Object.keys(TABLES)) {
    const tableCols = cols.filter((c) => c.table_name === name);
    if (tableCols.length === 0) throw new Error(`table "${name}" not found in database`);
    const pk = pks.find((p) => p.table_name === name)?.column_name ?? 'id';
    schema[name] = {
      columns: new Set(tableCols.map((c) => c.column_name)),
      writable: new Set(
        tableCols
          .filter((c) => c.is_generated !== 'ALWAYS' && c.column_name !== 'created_at')
          .map((c) => c.column_name),
      ),
      pk,
    };
  }
}

function tableFor(name, op) {
  const cfg = TABLES[name];
  if (!cfg) throw new HttpError(404, `unknown table "${name}"`);
  if (!(cfg.ops ?? ALL_OPS).includes(op)) throw new HttpError(405, `${op} not allowed on ${name}`);
  return schema[name];
}

function pickColumns(t, body, { allowPk }) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'body must be a JSON object');
  }
  const keys = Object.keys(body);
  const unknown = keys.filter((k) => !t.writable.has(k) || (!allowPk && k === t.pk));
  if (unknown.length) throw new HttpError(400, `column(s) not writable: ${unknown.join(', ')}`);
  if (keys.length === 0) throw new HttpError(400, 'no columns given');
  return keys;
}

// GET /api/<tabel>?site_id=eq.<uuid>&done_on=gte.2026-01-01&order=done_on.desc&limit=50
export async function list(user, name, query) {
  const t = tableFor(name, 'list');
  const filters = [];
  let order = null, limit = 100, offset = 0;

  for (const [key, raw] of query) {
    if (key === 'limit') { limit = Math.min(Math.max(parseInt(raw, 10) || 100, 1), 1000); continue; }
    if (key === 'offset') { offset = Math.max(parseInt(raw, 10) || 0, 0); continue; }
    if (key === 'token') continue;
    if (key === 'order') {
      order = raw.split(',').map((part) => {
        const [col, dir = 'asc'] = part.split('.');
        if (!t.columns.has(col)) throw new HttpError(400, `unknown column "${col}"`);
        if (dir !== 'asc' && dir !== 'desc') throw new HttpError(400, `order must be asc or desc`);
        return dir === 'desc' ? sql`${sql(col)} desc` : sql`${sql(col)} asc`;
      });
      continue;
    }
    if (!t.columns.has(key)) throw new HttpError(400, `unknown column "${key}"`);
    const dot = raw.indexOf('.');
    const op = dot > 0 ? raw.slice(0, dot) : '';
    const fn = OPS[op];
    filters.push(fn ? fn(key, raw.slice(dot + 1)) : OPS.eq(key, raw));
  }

  const where = filters.length
    ? filters.reduce((acc, f) => sql`${acc} and ${f}`, sql`where true`)
    : sql``;
  const orderBy = order
    ? order.reduce((acc, o, i) => (i === 0 ? sql`order by ${o}` : sql`${acc}, ${o}`), sql``)
    : sql``;

  return withUser(user.id, (tx) => tx`
    select * from ${sql(name)} ${where} ${orderBy} limit ${limit} offset ${offset}`);
}

export async function get(user, name, id) {
  const t = tableFor(name, 'get');
  const [row] = await withUser(user.id, (tx) => tx`
    select * from ${sql(name)} where ${sql(t.pk)} = ${id}`);
  if (!row) throw new HttpError(404, 'not found');
  return row;
}

const MAX_BULK = 1000;

// Body objek -> satu baris. Body array -> banyak baris dalam satu transaksi
// (semua berhasil atau semua batal). Semua baris harus punya kolom yang sama,
// supaya kolom yang tidak diisi tetap memakai nilai default, bukan NULL.
export async function create(user, name, body) {
  const t = tableFor(name, 'create');
  const allowPk = t.pk !== 'id'; // varieties memakai "code"
  if (!Array.isArray(body)) {
    const cols = pickColumns(t, body, { allowPk });
    const [row] = await withUser(user.id, (tx) => tx`
      insert into ${sql(name)} ${sql(body, cols)} returning *`);
    return row;
  }
  if (body.length === 0) return [];
  if (body.length > MAX_BULK) throw new HttpError(413, `max ${MAX_BULK} rows per request`);
  const cols = pickColumns(t, body[0], { allowPk });
  const key = [...cols].sort().join(',');
  for (const row of body) {
    if (pickColumns(t, row, { allowPk }).sort().join(',') !== key) {
      throw new HttpError(400, 'all rows must have the same columns');
    }
  }
  return withUser(user.id, (tx) => tx`
    insert into ${sql(name)} ${sql(body, cols)} returning *`);
}

export async function update(user, name, id, body) {
  const t = tableFor(name, 'update');
  const cols = pickColumns(t, body, { allowPk: false });
  const [row] = await withUser(user.id, (tx) => tx`
    update ${sql(name)} set ${sql(body, cols)} where ${sql(t.pk)} = ${id} returning *`);
  if (!row) throw new HttpError(404, 'not found or not allowed');
  return row;
}

export async function remove(user, name, id) {
  const t = tableFor(name, 'delete');
  const [row] = await withUser(user.id, (tx) => tx`
    delete from ${sql(name)} where ${sql(t.pk)} = ${id} returning ${sql(t.pk)}`);
  if (!row) throw new HttpError(404, 'not found or not allowed');
  return { deleted: row[t.pk] };
}
