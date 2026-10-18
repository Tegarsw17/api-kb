# kebun-api

Backend Kebun Durian: Node.js 24 tanpa framework + PostgreSQL.
Hanya satu dependency (`postgres`). RAM ±70 MB.

Semua aturan akses owner/worker ada di **database (RLS)**. Backend hanya
memeriksa token login, lalu memberi tahu database siapa user-nya
(`set_config('app.user_id', ...)`). Jadi endpoint baru tidak perlu
menulis ulang pengecekan hak akses.

## Struktur

```
src/
  server.js   rute + server HTTP
  router.js   router kecil (gaya Express)
  db.js       koneksi Postgres, withUser(), terjemahan error
  auth.js     hash password (scrypt), token (JWT HS256), batas login
  crud.js     API generik untuk semua tabel
  photos.js   upload / lihat / hapus foto
```

## Development di laptop

```bash
cp .env.example .env          # isi DATABASE_URL & JWT_SECRET
npm install                   # sekali; commit package-lock.json yang dihasilkan
ssh -N -L 5433:127.0.0.1:5432 ubuntu@43.157.235.41   # terminal terpisah
npm run dev                   # restart otomatis saat file berubah
```

## Endpoint

Semua endpoint (kecuali tiga yang pertama) butuh header
`Authorization: Bearer <token>`.

| Method & path | Keterangan |
|---|---|
| `GET /api/health` | Cek server + database |
| `POST /api/auth/setup` | `{username, full_name, password}`. Membuat owner pertama. Ditolak (403) jika owner sudah ada. |
| `POST /api/auth/login` | `{username, password}` → `{token, user_id, role}`. Token berlaku 30 hari. Maks 10 percobaan gagal / 15 menit / IP. |
| `GET /api/auth/me` | Profil user yang login |
| `POST /api/users` | Owner: `{username, full_name, password, role?}` membuat akun pekerja |
| `PUT /api/users/:id/password` | `{password}`. Diri sendiri, atau owner untuk siapa pun |
| `POST /api/rpc/complete_task` | `{task_id, note?, photo?}` |
| `POST /api/rpc/set_my_language` | `{language: 'id' \| 'en'}` |
| `POST /api/photos` | Form multipart, field `file` (jpg/png/webp/heic, maks 10 MB) → `{path}` |
| `GET /api/photos/:path` | Gambar. Untuk `<img>` pakai `?token=<token>` |
| `DELETE /api/photos/:path` | Owner saja |
| `GET /api/<tabel>` | Daftar baris (filter di bawah) |
| `GET /api/<tabel>/:id` | Satu baris |
| `POST /api/<tabel>` | Tambah baris, body JSON |
| `PATCH /api/<tabel>/:id` | Ubah kolom tertentu |
| `DELETE /api/<tabel>/:id` | Hapus |

Tabel: `profiles` (tanpa POST), `sites`, `varieties` (id = `code`), `trees`,
`supplies`, `supply_movements`, `schedules`, `activities`, `tasks`,
`daily_reports`, `tree_events`, `harvests`, `sales`, `expenses`,
`overdue_schedules` (baca saja).

### Filter, urutan, halaman

```
GET /api/trees?site_id=eq.<uuid>&variety_code=in.DH,MK&order=name.asc
GET /api/activities?done_on=gte.2026-10-01&done_on=lte.2026-10-31&order=done_on.desc&limit=50&offset=0
GET /api/trees?name=ilike.*dh*          GET /api/trees?planted_on=is.null
```

Operator: `eq` (default), `neq`, `gt`, `gte`, `lt`, `lte`, `in`, `ilike`
(`*` = wildcard), `is` (`null`/`true`/`false`). `limit` default 100, maks 1000.

### Status error

`400` input salah · `401` belum login / token salah · `403` tidak boleh ·
`404` tidak ada **atau** tidak boleh mengubahnya (RLS menyembunyikan baris) ·
`409` data duplikat · `413` terlalu besar · `429` terlalu banyak percobaan login.
Body error: `{"error": "pesan"}`.

## Dari supabase-js ke API ini

| Sebelumnya | Sekarang |
|---|---|
| `supabase.auth.signInWithPassword({email, password})` | `POST /api/auth/login` `{username, password}` |
| `supabase.from('trees').select('*').eq('site_id', id).order('name')` | `GET /api/trees?site_id=eq.<id>&order=name.asc` |
| `supabase.from('trees').insert(row).select()` | `POST /api/trees` |
| `supabase.from('trees').update(cols).eq('id', id)` | `PATCH /api/trees/<id>` |
| `supabase.from('trees').delete().eq('id', id)` | `DELETE /api/trees/<id>` |
| `supabase.rpc('complete_task', {p_task_id, p_note, p_photo})` | `POST /api/rpc/complete_task` `{task_id, note, photo}` |
| `supabase.storage.from('photos').upload(...)` | `POST /api/photos` (multipart) |
| `supabase.functions.invoke('admin-users', ...)` | `POST /api/users` |

Catatan: `select('*, trees(name)')` (join otomatis) tidak didukung. Ambil
data terkait dengan request kedua, atau minta endpoint khusus.
