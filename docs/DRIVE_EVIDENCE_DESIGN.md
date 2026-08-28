# Google Drive Evidence Repository

## Pola penyimpanan

Google Drive menyimpan file fisik dalam folder privat yang dimiliki akun organisasi melalui OAuth 2.0 offline access. Supabase menyimpan metadata:
- case_id
- drive_file_id
- drive_folder_id
- original_filename
- mime_type
- file_size
- sha256_hash
- uploader context
- timestamp

## Authorization backend

Edge Function menukar refresh token menjadi access token jangka pendek. Client ID, client secret, refresh token, dan root folder ID hanya disimpan sebagai Supabase Edge Function secrets. Browser tidak pernah menerima credential Google.

Scope Google dibatasi ke `drive.file`. Root folder dibuat oleh OAuth client yang sama agar aplikasi hanya mengelola repositori evidence miliknya.

## Larangan desain
- Tidak menggunakan `Anyone with the link` atau permission domain-wide.
- Tidak menyimpan credential Google di browser atau repository.
- Tidak menjadikan nama pihak terlapor atau identitas pelapor sebagai nama folder.
- Tidak menganggap URL Drive sebagai authorization control.

## Struktur folder konseptual

WBS-SAI-EVIDENCE/
  ev-<random-uuid>/
    <random-uuid>.<extension>

## Operasi file

Upload menggunakan resumable upload setelah case authorization. Download diproksikan oleh Edge Function setelah pemeriksaan case-scoped access. Removal memindahkan file ke Trash Drive dan mempertahankan metadata serta audit trail.
