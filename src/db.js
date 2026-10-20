import postgres from 'postgres';
import { HttpError } from './router.js';

export const sql = postgres(process.env.DATABASE_URL, {
  max: 10,                 // cukup untuk VPS kecil (Postgres max_connections = 30)
  idle_timeout: 30,
  connect_timeout: 10,
  transform: { undefined: null },
  types: {
    // Kolom DATE dikirim apa adanya ('2026-10-18'), bukan objek Date,
    // supaya tidak bergeser karena zona waktu.
    date: { to: 1082, from: [1082], serialize: (x) => x, parse: (x) => x },
    // Kolom NUMERIC dikirim sebagai angka JSON (seperti Supabase), bukan string "12.50".
    numeric: { to: 1700, from: [1700], serialize: (x) => String(x), parse: (x) => Number(x) },
  },
});

// Semua query untuk user yang login WAJIB lewat sini.
// set_config(..., true) = hanya berlaku di transaksi ini, jadi koneksi yang
// dipakai ulang oleh pool tidak membawa identitas user sebelumnya.
export function withUser(userId, fn) {
  return sql.begin(async (tx) => {
    await tx`select set_config('app.user_id', ${userId ?? ''}, true)`;
    return fn(tx);
  });
}

// Terjemahkan error Postgres menjadi status HTTP yang masuk akal.
export function toHttpError(err) {
  if (err instanceof HttpError) return err;
  switch (err.code) {
    case '42501': // RLS menolak / tidak punya hak
      return new HttpError(403, 'forbidden');
    case 'P0001': // raise exception dari fungsi SQL
      if (/not found/i.test(err.message)) return new HttpError(404, err.message);
      if (/not allowed/i.test(err.message)) return new HttpError(403, err.message);
      return new HttpError(400, err.message);
    case '23505':
      return new HttpError(409, `already exists: ${err.detail ?? err.message}`);
    case '23503':
      return new HttpError(400, `related record problem: ${err.detail ?? err.message}`);
    case '23502': // not null
    case '23514': // check constraint
    case '22P02': // format salah (uuid, angka)
    case '22007': // format tanggal salah
    case '22008':
    case '22003': // angka terlalu besar
    case '22001': // teks terlalu panjang
      return new HttpError(400, err.message);
    default:
      console.error(err);
      return new HttpError(500, 'internal error');
  }
}
