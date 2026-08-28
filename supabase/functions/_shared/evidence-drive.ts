const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let cachedToken: { value: string; expiresAt: number } | null = null;

function b64url(input: Uint8Array | string) {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function pemBytes(pemValue: string) {
  const normalized = pemValue.replace(/\\n/g, '\n').trim();
  const body = normalized
    .replace(/-----BEGIN PRIVATE KEY-----/g, '')
    .replace(/-----END PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  if (!body) throw new Error('DRIVE_NOT_CONFIGURED');
  const binary = atob(body);
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export function driveConfigured() {
  return Boolean(
    Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL') &&
    Deno.env.get('GOOGLE_PRIVATE_KEY') &&
    Deno.env.get('GOOGLE_DRIVE_ROOT_FOLDER_ID')
  );
}

async function serviceAccountToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const email = Deno.env.get('GOOGLE_SERVICE_ACCOUNT_EMAIL') ?? '';
  const privateKey = Deno.env.get('GOOGLE_PRIVATE_KEY') ?? '';
  if (!email || !privateKey) throw new Error('DRIVE_NOT_CONFIGURED');

  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64url(JSON.stringify({
    iss: email,
    scope: DRIVE_SCOPE,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${claim}`;
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemBytes(privateKey),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = new Uint8Array(await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  ));
  const assertion = `${unsigned}.${b64url(sig)}`;

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!response.ok) {
    console.error('Google token exchange failed', response.status, await response.text());
    throw new Error('DRIVE_AUTH_FAILED');
  }
  const data = await response.json() as { access_token?: string; expires_in?: number };
  if (!data.access_token) throw new Error('DRIVE_AUTH_FAILED');
  cachedToken = {
    value: data.access_token,
    expiresAt: Date.now() + Math.max(300, Number(data.expires_in ?? 3600)) * 1000,
  };
  return cachedToken.value;
}

async function authorizedFetch(url: string, init: RequestInit = {}, retry = true) {
  const token = await serviceAccountToken();
  const headers = new Headers(init.headers ?? {});
  headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(url, { ...init, headers });
  if (response.status === 401 && retry) {
    cachedToken = null;
    return authorizedFetch(url, init, false);
  }
  return response;
}

async function driveJson(url: string, init: RequestInit = {}) {
  const response = await authorizedFetch(url, init);
  if (!response.ok) {
    const detail = await response.text();
    console.error('Google Drive request failed', response.status, detail.slice(0, 1000));
    throw new Error(`DRIVE_HTTP_${response.status}`);
  }
  return response.status === 204 ? null : await response.json();
}

export async function ensureCaseEvidenceFolder(
  admin: any,
  caseId: string,
  createdByUserId: string | null,
) {
  if (!driveConfigured()) throw new Error('DRIVE_NOT_CONFIGURED');
  const { data: existing, error: existingError } = await admin
    .from('case_evidence_folders')
    .select('case_id,drive_folder_id,folder_token')
    .eq('case_id', caseId)
    .maybeSingle();
  if (existingError) throw existingError;
  if (existing?.drive_folder_id) return String(existing.drive_folder_id);

  const rootFolderId = Deno.env.get('GOOGLE_DRIVE_ROOT_FOLDER_ID') ?? '';
  const folderToken = crypto.randomUUID();
  const created = await driveJson(
    `${DRIVE_API}/files?supportsAllDrives=true&fields=id`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({
        name: `ev-${folderToken}`,
        mimeType: 'application/vnd.google-apps.folder',
        parents: [rootFolderId],
        appProperties: { sai_evidence_folder: folderToken },
      }),
    },
  ) as { id?: string };
  if (!created?.id) throw new Error('DRIVE_FOLDER_CREATE_FAILED');

  const { error: insertError } = await admin.from('case_evidence_folders').insert({
    case_id: caseId,
    drive_folder_id: created.id,
    folder_token: folderToken,
    created_by_user_id: createdByUserId,
  });
  if (!insertError) return created.id;

  if (insertError.code === '23505') {
    const { data: raced, error: racedError } = await admin
      .from('case_evidence_folders')
      .select('drive_folder_id')
      .eq('case_id', caseId)
      .single();
    if (racedError || !raced?.drive_folder_id) throw insertError;
    await authorizedFetch(`${DRIVE_API}/files/${encodeURIComponent(created.id)}?supportsAllDrives=true`, { method: 'DELETE' }).catch(() => null);
    return String(raced.drive_folder_id);
  }
  throw insertError;
}

export async function generateDriveFileId() {
  const data = await driveJson(`${DRIVE_API}/files/generateIds?count=1&space=drive&type=files`) as { ids?: string[] };
  const id = data?.ids?.[0];
  if (!id) throw new Error('DRIVE_ID_GENERATION_FAILED');
  return id;
}

export async function startResumableDriveUpload(args: {
  sessionId: string;
  driveFileId: string;
  driveFolderId: string;
  storageFilename: string;
  mimeType: string;
  fileSizeBytes: number;
}) {
  const response = await authorizedFetch(
    `${DRIVE_UPLOAD_API}/files?uploadType=resumable&supportsAllDrives=true&fields=id,name,mimeType,size,parents,trashed`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Type': args.mimeType,
        'X-Upload-Content-Length': String(args.fileSizeBytes),
      },
      body: JSON.stringify({
        id: args.driveFileId,
        name: args.storageFilename,
        parents: [args.driveFolderId],
        appProperties: { sai_evidence_session: args.sessionId },
      }),
    },
  );
  if (!response.ok) {
    const detail = await response.text();
    console.error('Drive resumable init failed', response.status, detail.slice(0, 1000));
    throw new Error(`DRIVE_UPLOAD_INIT_${response.status}`);
  }
  const uploadUrl = response.headers.get('Location');
  if (!uploadUrl) throw new Error('DRIVE_UPLOAD_SESSION_MISSING');
  return uploadUrl;
}

export async function getDriveFileMetadata(fileId: string) {
  return await driveJson(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,name,mimeType,size,parents,trashed,appProperties`,
  ) as {
    id?: string;
    name?: string;
    mimeType?: string;
    size?: string;
    parents?: string[];
    trashed?: boolean;
    appProperties?: Record<string, string>;
  };
}

export async function trashDriveFile(fileId: string) {
  await driveJson(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?supportsAllDrives=true&fields=id,trashed`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify({ trashed: true }),
    },
  );
}

export async function getDriveFileContent(fileId: string) {
  const response = await authorizedFetch(
    `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media&supportsAllDrives=true`,
  );
  if (!response.ok) {
    console.error('Drive download failed', response.status, (await response.text()).slice(0, 1000));
    throw new Error(`DRIVE_DOWNLOAD_${response.status}`);
  }
  return response;
}
