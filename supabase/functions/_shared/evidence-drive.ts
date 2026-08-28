const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

let cachedToken: { value: string; expiresAt: number } | null = null;

export function driveConfigured() {
  return Boolean(
    Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') &&
    Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') &&
    Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN') &&
    Deno.env.get('GOOGLE_DRIVE_ROOT_FOLDER_ID')
  );
}

async function driveAccessToken() {
  if (cachedToken && cachedToken.expiresAt > Date.now() + 60_000) return cachedToken.value;

  const clientId = Deno.env.get('GOOGLE_OAUTH_CLIENT_ID') ?? '';
  const clientSecret = Deno.env.get('GOOGLE_OAUTH_CLIENT_SECRET') ?? '';
  const refreshToken = Deno.env.get('GOOGLE_OAUTH_REFRESH_TOKEN') ?? '';
  if (!clientId || !clientSecret || !refreshToken) throw new Error('DRIVE_NOT_CONFIGURED');

  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  });
  if (!response.ok) {
    console.error('Google OAuth refresh failed', response.status, (await response.text()).slice(0, 1000));
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
  const token = await driveAccessToken();
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

export async function verifyDriveRepository() {
  if (!driveConfigured()) return { ready: false, privateAccessEnforced: false };
  const rootId = Deno.env.get('GOOGLE_DRIVE_ROOT_FOLDER_ID') ?? '';
  const file = await driveJson(
    `${DRIVE_API}/files/${encodeURIComponent(rootId)}?supportsAllDrives=true&fields=id,mimeType,trashed,capabilities(canAddChildren)`,
  ) as { id?: string; mimeType?: string; trashed?: boolean; capabilities?: { canAddChildren?: boolean } };
  const permissions = await driveJson(
    `${DRIVE_API}/files/${encodeURIComponent(rootId)}/permissions?supportsAllDrives=true&fields=permissions(type,role,allowFileDiscovery)`,
  ) as { permissions?: Array<{ type?: string; role?: string; allowFileDiscovery?: boolean }> };
  const broadPermission = (permissions.permissions ?? []).some((item) => item.type === 'anyone' || item.type === 'domain');
  return {
    ready: file.id === rootId && file.mimeType === 'application/vnd.google-apps.folder' && !file.trashed && file.capabilities?.canAddChildren !== false,
    privateAccessEnforced: !broadPermission,
  };
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
