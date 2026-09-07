# Security Model — Baseline V1

## Trust boundaries

### Public frontend
Frontend adalah public asset. Tidak boleh memuat secret, service-role key, Google service-account credential, atau logic yang dianggap sebagai security boundary.

### Supabase Auth
Mengautentikasi identified user. Authentication tidak otomatis berarti user berhak membaca case.

### PostgreSQL + RLS
Authorization internal dijalankan per-row. Role sistem saja tidak cukup untuk membuka sebuah case; case-scoped assignment tetap diperlukan untuk Tim Pemeriksa.

### Edge Functions
Dipakai untuk operasi privileged seperti anonymous submission, pembentukan case, pemberian akses, pembukaan identitas pelapor, policy activation, dan integrasi Google Drive.

### Google Drive
Evidence repository bersifat private. Aplikasi menyimpan `drive_file_id`, bukan public share link. Credential Drive hanya berada sebagai server-side secret.

## Identity isolation
`case_reporter_identities` dipisahkan dari `cases`. Investigator tidak mendapat SELECT pada tabel identity hanya karena memiliki assignment pada case.

Data kontak dan anak OTS disimpan di `reporter_profiles` dan `reporter_children`, terpisah dari `profiles` yang digunakan untuk identitas akun dasar. Kedua tabel reporter bersifat service-side only: RLS aktif dan tidak ada grant untuk `anon` maupun `authenticated`.

## Reporter onboarding and eligibility

- OTS melakukan self-registration setelah login Google dengan Kode Akses Komunitas aktif. Kode diverifikasi di Edge Function terhadap PBKDF2 hash; plaintext tidak disimpan.
- Email pada allowlist lama tetap dapat melengkapi profile tanpa kode selama masa transisi.
- Kelayakan membuat laporan baru dibatasi per tahun ajaran dan diperiksa ulang di RPC transaksi saat case dibuat.
- Suspend reporter hanya memblokir case beridentitas baru. Session akun dan akses ke case lama tidak dicabut.
- Akun dengan role internal aktif melewati onboarding OTS; invitation internal tetap memakai flow claim terpisah.

## Admin separation
Role `SYSTEM_ADMIN` tidak memberi hak membaca case. Akses teknis dan akses substansi dipisahkan.

Admin dapat melihat profile OTS untuk verifikasi operasional serta mengubah status reporter `ACTIVE`/`SUSPENDED`. Mutasi ini dilakukan lewat RPC service-only dan dicatat di audit log.

## Audit
`audit_logs` tidak dapat UPDATE/DELETE dari aplikasi. Jangan menyalin isi PII atau evidence ke `details`; audit hanya menyimpan metadata aktivitas yang diperlukan.
