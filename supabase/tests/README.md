# Security tests

Security UAT harus dilakukan pada Supabase project setelah migration diterapkan. Minimum checks:

1. `anon` tidak dapat SELECT/INSERT pada tabel case.
2. Authenticated user tanpa role tidak dapat SELECT case internal.
3. `SYSTEM_ADMIN` tidak otomatis dapat SELECT case.
4. Active investigator hanya dapat SELECT case yang di-assign.
5. Setelah assignment di-REVOKED, akses case hilang.
6. Investigator tidak dapat SELECT `case_reporter_identities` melalui Data API.
7. Client tidak dapat UPDATE/DELETE `audit_logs`.
8. Client tidak dapat membuat/mengaktifkan policy version secara direct.
9. Dekom hanya memperoleh akses authority ketika routing/takeover case menunjuk Dekom atau case assignment memberi akses.
10. Evidence file tidak pernah memiliki public Drive permission.

Batch berikutnya akan menambahkan executable UAT fixtures setelah Auth test users tersedia.
