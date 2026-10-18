// Foto disimpan di disk: <PHOTOS_DIR>/<user id>/<uuid>.<ext>
// Aturannya sama dengan bucket "photos" versi Supabase:
//   upload: semua anggota aktif, ke folder miliknya sendiri
//   lihat : semua anggota aktif
//   hapus : hanya owner
import { createReadStream } from 'node:fs';
import { mkdir, stat, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { withUser } from './db.js';
import { HttpError, reply } from './router.js';

const PHOTOS_DIR = process.env.PHOTOS_DIR ?? './data/photos';
export const MAX_PHOTO_BYTES = 10 * 1024 * 1024;

const TYPES = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
};
const EXT_TYPES = Object.fromEntries(Object.entries(TYPES).map(([t, e]) => [e, t]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const FILE = /^([0-9a-f-]{36})\.(jpg|png|webp|heic)$/;

async function requireMember(user) {
  const [{ ok }] = await withUser(user.id, (tx) => tx`select public.is_member() as ok`);
  if (!ok) throw new HttpError(403, 'forbidden');
}

function safePath(owner, file) {
  const m = FILE.exec(file);
  if (!UUID.test(owner) || !m || !UUID.test(m[1])) throw new HttpError(404, 'not found');
  return { full: join(PHOTOS_DIR, owner, file), ext: m[2] };
}

export async function upload(user, form) {
  await requireMember(user);
  const file = form.get('file');
  if (!file || typeof file === 'string') throw new HttpError(400, 'send the image in a form field named "file"');
  const ext = TYPES[file.type];
  if (!ext) throw new HttpError(415, `only ${Object.keys(TYPES).join(', ')} are allowed`);
  if (file.size > MAX_PHOTO_BYTES) throw new HttpError(413, 'photo is larger than 10 MB');

  const name = `${randomUUID()}.${ext}`;
  await mkdir(join(PHOTOS_DIR, user.id), { recursive: true });
  await writeFile(join(PHOTOS_DIR, user.id, name), Buffer.from(await file.arrayBuffer()));
  // Simpan nilai "path" ini di kolom photos / photo pada tabel.
  return reply(201, { path: `${user.id}/${name}` });
}

export async function serve(user, owner, file) {
  await requireMember(user);
  const { full, ext } = safePath(owner, file);
  const info = await stat(full).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, 'not found');
  return reply(200, createReadStream(full), {
    'content-type': EXT_TYPES[ext],
    'content-length': String(info.size),
    'cache-control': 'private, max-age=86400',
  });
}

export async function remove(user, owner, file) {
  const [{ ok }] = await withUser(user.id, (tx) => tx`select public.is_owner() as ok`);
  if (!ok) throw new HttpError(403, 'only the owner can delete photos');
  const { full } = safePath(owner, file);
  await unlink(full).catch(() => { throw new HttpError(404, 'not found'); });
  return { deleted: `${owner}/${file}` };
}
