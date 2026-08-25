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

## Admin separation
Role `SYSTEM_ADMIN` tidak memberi hak membaca case. Akses teknis dan akses substansi dipisahkan.

## Audit
`audit_logs` tidak dapat UPDATE/DELETE dari aplikasi. Jangan menyalin isi PII atau evidence ke `details`; audit hanya menyimpan metadata aktivitas yang diperlukan.
