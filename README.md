# SAI Cipedak — Sistem Pelaporan Integritas, Perlindungan & Pengaduan

Scaffold **Batch 1: Foundation & Security**.

## Scope batch ini
- Struktur organisasi SAI Cipedak
- Profile dan role internal
- Case core schema
- Pemisahan identitas pelapor
- Case-scoped assignment
- Deklarasi benturan kepentingan
- Policy versioning dan routing rules
- Metadata evidence Google Drive (file fisik tidak disimpan di Supabase)
- Audit log append-only
- RLS baseline
- Health Edge Function
- Frontend shell Bahasa Indonesia

## Prinsip keamanan
1. Evidence file berada di Google Drive private repository; database hanya menyimpan `drive_file_id` + metadata.
2. Identitas pelapor disimpan terpisah dari isi laporan.
3. Reporter tidak membaca tabel internal secara langsung. Reporter portal nanti melalui Edge Function/RPC yang hanya mengembalikan field aman.
4. Investigator hanya mendapat akses pada case yang di-assign.
5. Admin IT tidak otomatis mendapat akses isi laporan.
6. Semua privileged flow akan dilakukan server-side melalui Edge Functions.
7. Secret/service-role key tidak pernah diletakkan di frontend atau repository.

## Setup awal
1. Buat Supabase project **terpisah** untuk WBS.
2. Jalankan migration di `supabase/migrations/202608250001_foundation.sql`.
3. Set Google OAuth untuk internal/identified users.
4. Copy `public/assets/js/config.example.js` menjadi `config.js`, isi Supabase URL dan **publishable key** saja.
5. Deploy `public/` ke GitHub Pages.
6. Deploy Edge Function `health`.

## Belum termasuk
- Form laporan
- Anonymous case credential
- Google Drive upload integration
- Penelaahan UI
- Committee workflow
- Findings/approval
- Reporter portal

Semua itu masuk Batch 2 dan seterusnya.
