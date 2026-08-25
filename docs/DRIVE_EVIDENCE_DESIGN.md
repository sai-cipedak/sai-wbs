# Google Drive Evidence Repository

## Pola penyimpanan

Google Drive menyimpan file fisik. Supabase menyimpan metadata:
- case_id
- drive_file_id
- drive_folder_id
- original_filename
- mime_type
- file_size
- sha256_hash
- uploader context
- timestamp

## Larangan desain
- Tidak menggunakan `Anyone with the link`.
- Tidak menyimpan credential Google di browser.
- Tidak menjadikan nama pihak terlapor sebagai nama folder.
- Tidak menganggap URL Drive sebagai authorization control.

## Struktur folder konseptual

WBS-SAI-EVIDENCE/
  CASE-<internal-uuid-or-random-code>/
    evidence files

## Batch 2
Upload akan diorkestrasi oleh Edge Function setelah case authorization. Implementasi final dapat memakai resumable upload sehingga payload file tidak perlu disimpan di Supabase Storage.
