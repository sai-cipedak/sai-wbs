# Batch 1 Acceptance Criteria

- [ ] Supabase project khusus WBS tersedia.
- [ ] Migration foundation berjalan tanpa error.
- [ ] Organisasi `SAI-CIPEDAK` tersedia.
- [ ] Default policy `1.0` aktif.
- [ ] Role TRIAGE, SECRETARIAT, HSE, GRIEVANCE_COORDINATOR, DEKOM, POLICY_ADMIN, SYSTEM_ADMIN, AUDITOR tersedia.
- [ ] RLS aktif pada seluruh tabel exposed yang sensitif.
- [ ] User tanpa role tidak dapat membaca daftar case internal.
- [ ] Investigator tidak dapat membaca case tanpa active case assignment.
- [ ] SYSTEM_ADMIN tidak otomatis dapat membaca case.
- [ ] `case_reporter_identities` tidak dapat dibaca investigator melalui direct Data API.
- [ ] `audit_logs` tidak dapat diubah atau dihapus melalui role client.
- [ ] Evidence table hanya menyimpan metadata Google Drive.
- [ ] Frontend tidak mengandung secret/service role key.
- [ ] Health Edge Function dapat dipanggil.
