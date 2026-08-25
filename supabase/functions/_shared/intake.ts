export const ORG_CODE = 'SAI-CIPEDAK';

export const STATUS_LABELS: Record<string, string> = {
  SUBMITTED: 'Laporan Diterima',
  UNDER_REVIEW: 'Sedang Ditelaah',
  MORE_INFO_REQUIRED: 'Informasi Tambahan Diperlukan',
  REFERRED_GRIEVANCE: 'Sedang Ditangani',
  REFERRED_SAFEGUARDING: 'Sedang Ditangani',
  COMMITTEE_FORMATION: 'Sedang Ditangani',
  INVESTIGATION: 'Pemeriksaan Sedang Berlangsung',
  AUTHORITY_REVIEW: 'Hasil Sedang Ditinjau',
  REMEDIATION: 'Tindak Lanjut Sedang Dilakukan',
  CLOSED: 'Selesai Ditangani',
  OUT_OF_SCOPE: 'Tidak Dilanjutkan',
};

export const CLASSIFICATION_LABELS: Record<string, string> = {
  INTEGRITY: 'Pelanggaran Integritas',
  SAFEGUARDING: 'Keselamatan & Perlindungan Anak',
  GRIEVANCE: 'Keluhan / Pengaduan Layanan',
  OUT_OF_SCOPE: 'Di Luar Ruang Lingkup',
};

const encoder = new TextEncoder();
const BASE32 = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export type IntakePayload = {
  title: string;
  narrative: string;
  incidentDate: string | null;
  incidentTimeText: string | null;
  locationText: string | null;
  peopleInvolvedText: string | null;
  childSafetyRisk: boolean;
  ongoingRisk: boolean;
};

export function jsonResponse(body: unknown, status = 200, corsHeaders: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
  });
}

export function normalizeIntake(raw: Record<string, unknown>): IntakePayload {
  const title = String(raw.title ?? '').trim();
  const narrative = String(raw.narrative ?? '').trim();
  const incidentDate = nullableText(raw.incidentDate, 10);
  const incidentTimeText = nullableText(raw.incidentTimeText, 80);
  const locationText = nullableText(raw.locationText, 240);
  const peopleInvolvedText = nullableText(raw.peopleInvolvedText, 2000);

  if (title.length < 5 || title.length > 180) {
    throw new Error('Judul laporan harus 5–180 karakter.');
  }
  if (narrative.length < 20 || narrative.length > 10000) {
    throw new Error('Uraian kejadian harus 20–10.000 karakter.');
  }
  if (incidentDate && !/^\d{4}-\d{2}-\d{2}$/.test(incidentDate)) {
    throw new Error('Format tanggal kejadian tidak valid.');
  }

  return {
    title,
    narrative,
    incidentDate,
    incidentTimeText,
    locationText,
    peopleInvolvedText,
    childSafetyRisk: raw.childSafetyRisk === true,
    ongoingRisk: raw.ongoingRisk === true,
  };
}

function nullableText(value: unknown, max: number): string | null {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.length > max) throw new Error(`Isian terlalu panjang (maksimum ${max} karakter).`);
  return text;
}

export function generatePublicCaseId() {
  const year = String(new Date().getUTCFullYear()).slice(-2);
  return `SAI-CIP-${year}-${randomBase32(10)}`;
}

export function generateSecretKey() {
  const raw = randomBase32(20);
  return `WBS-${raw.slice(0, 5)}-${raw.slice(5, 10)}-${raw.slice(10, 15)}-${raw.slice(15, 20)}`;
}

function randomBase32(length: number) {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (b) => BASE32[b % BASE32.length]).join('');
}

export async function sha256Base64(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

export async function verifyPbkdf2(
  value: string,
  saltB64: string,
  iterations: number,
  expectedHashB64: string,
) {
  const key = await crypto.subtle.importKey('raw', encoder.encode(value), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      hash: 'SHA-256',
      salt: base64ToBytes(saltB64),
      iterations,
    },
    key,
    256,
  );
  return timingSafeEqual(new Uint8Array(bits), base64ToBytes(expectedHashB64));
}

export function timingSafeEqual(a: Uint8Array, b: Uint8Array) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function bytesToBase64(bytes: Uint8Array) {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
