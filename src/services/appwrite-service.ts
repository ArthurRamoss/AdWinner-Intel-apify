/**
 * AdWinner Intel - Appwrite Storage Service
 *
 * Uploads media files to Appwrite Storage so Gemini can access
 * a stable, public URL (Appwrite buckets must allow read("any")).
 */

import { Client, Storage, Tokens, ID, Permission, Role } from 'node-appwrite';

// =============================================================================
// CONFIGURATION
// =============================================================================

const APPWRITE_ENDPOINT = process.env.APPWRITE_ENDPOINT;
const APPWRITE_PROJECT_ID = process.env.APPWRITE_PROJECT_ID;
const APPWRITE_API_KEY = process.env.APPWRITE_API_KEY;
const APPWRITE_BUCKET_ID = process.env.APPWRITE_BUCKET_ID;
const APPWRITE_PUBLIC_ENDPOINT = process.env.APPWRITE_PUBLIC_ENDPOINT || APPWRITE_ENDPOINT;
const APPWRITE_SIGNED_URLS = (process.env.APPWRITE_SIGNED_URLS ?? 'true').toLowerCase() !== 'false';
const APPWRITE_SIGNED_URL_TTL_SECONDS = Number(process.env.APPWRITE_SIGNED_URL_TTL_SECONDS || '3600');

interface AppwriteClients {
  storage: Storage;
  tokens: Tokens;
}

let appwriteClients: AppwriteClients | null = null;

export function isAppwriteConfigured(): boolean {
  return Boolean(APPWRITE_ENDPOINT && APPWRITE_PROJECT_ID && APPWRITE_API_KEY && APPWRITE_BUCKET_ID);
}

function getClients(): AppwriteClients | null {
  if (!isAppwriteConfigured()) {
    return null;
  }
  if (appwriteClients) {
    return appwriteClients;
  }
  const client = new Client()
    .setEndpoint(APPWRITE_ENDPOINT!)
    .setProject(APPWRITE_PROJECT_ID!)
    .setKey(APPWRITE_API_KEY!);

  appwriteClients = {
    storage: new Storage(client),
    tokens: new Tokens(client),
  };

  return appwriteClients;
}

function buildPublicFileUrl(fileId: string, token?: string): string {
  const endpoint = (APPWRITE_PUBLIC_ENDPOINT || '').replace(/\/$/, '');
  const bucketId = APPWRITE_BUCKET_ID || '';
  const query = new URLSearchParams();

  if (APPWRITE_PROJECT_ID) {
    query.set('project', APPWRITE_PROJECT_ID);
  }
  if (token) {
    query.set('token', token);
  }

  const suffix = query.toString();
  return `${endpoint}/storage/buckets/${bucketId}/files/${fileId}/view${suffix ? `?${suffix}` : ''}`;
}

function getSignedUrlExpiry(): string | undefined {
  if (!Number.isFinite(APPWRITE_SIGNED_URL_TTL_SECONDS) || APPWRITE_SIGNED_URL_TTL_SECONDS <= 0) {
    return undefined;
  }

  const expiry = new Date(Date.now() + APPWRITE_SIGNED_URL_TTL_SECONDS * 1000);
  return expiry.toISOString();
}

async function createViewToken(tokens: Tokens, fileId: string): Promise<string | null> {
  if (!APPWRITE_SIGNED_URLS) {
    return null;
  }

  try {
    const expire = getSignedUrlExpiry();
    const created = await tokens.createFileToken({
      bucketId: APPWRITE_BUCKET_ID!,
      fileId,
      expire,
    });
    return created.secret || null;
  } catch (error) {
    console.warn('[AppwriteService] Failed to create file token, falling back to direct URL:', error);
    return null;
  }
}

export interface UploadResult {
  fileId: string;
  url: string;
  signed: boolean;
}

export interface UploadBufferOptions {
  buffer: Buffer;
  filename: string;
  contentType?: string;
  permissions?: string[];
}

/**
 * Upload a buffer to Appwrite storage and return a public URL.
 */
/**
 * Max bytes to download for video creatives.
 * ~4MB ≈ first 10-15 seconds at typical Facebook ad bitrates (2-4 Mbps).
 * This limits Gemini token cost by only sending the "Hook Zone" (first seconds).
 * Images are almost always < 4MB so they come through in full.
 */
const CREATIVE_MAX_BYTES = 4 * 1024 * 1024; // 4MB

/**
 * Download a creative from a source URL and upload it to Appwrite storage.
 * Returns the permanent Appwrite URL + fileId for later cleanup, or null on failure.
 *
 * Used to persist Facebook Ad Library snapshot creatives whose CDN URLs expire in minutes.
 *
 * TOKEN OPTIMIZATION: Uses HTTP Range header to download at most ~4MB.
 * - Images (typically 50KB-2MB): come through in full, no truncation.
 * - Videos (typically 5-50MB): truncated to first ~4MB ≈ first 10-15 seconds.
 *   Gemini processes frames individually, so truncated MP4s work fine for hook analysis.
 */
export async function cacheCreativeInAppwrite(
  sourceUrl: string,
  adId: string,
  platform: string,
): Promise<UploadResult | null> {
  if (!isAppwriteConfigured() || !sourceUrl) return null;

  try {
    // Use Range header to cap download size — saves bandwidth and ensures
    // videos are truncated to the "hook zone" (first ~10-15 seconds).
    const response = await fetch(sourceUrl, {
      signal: AbortSignal.timeout(8000),
      headers: { 'Range': `bytes=0-${CREATIVE_MAX_BYTES - 1}` },
    });

    // 200 = full file (smaller than range), 206 = partial content (truncated)
    if (!response.ok && response.status !== 206) {
      console.warn(`[AppwriteService] Creative download failed (${response.status}): ${sourceUrl.slice(0, 80)}...`);
      return null;
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    const wasTruncated = response.status === 206;

    // Skip tiny files (likely error pages / redirects)
    if (buffer.length < 1024) {
      console.warn(`[AppwriteService] Creative skipped (${buffer.length} bytes): ${sourceUrl.slice(0, 80)}...`);
      return null;
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    const isVideo = contentType.includes('video');
    const ext = isVideo ? 'mp4' : contentType.includes('png') ? 'png' : 'jpg';
    const safeAdId = adId.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);
    const filename = `${platform}-${safeAdId}-${Date.now()}.${ext}`;

    if (wasTruncated && isVideo) {
      console.log(`[AppwriteService] Video truncated to ${buffer.length} bytes (~first 10-15s hook zone)`);
    }

    const result = await uploadBufferToAppwrite({ buffer, filename, contentType });
    if (result) {
      console.log(`[AppwriteService] Creative cached: ${filename} (${buffer.length} bytes) -> ${result.url.slice(0, 80)}...`);
    }
    return result;
  } catch (error) {
    console.warn(`[AppwriteService] Creative cache failed for ${adId}:`, (error as Error).message);
    return null;
  }
}

/**
 * Delete a creative file from Appwrite storage (non-blocking cleanup).
 * Called after Gemini analysis is cached so we don't accumulate storage.
 */
export async function deleteCreativeFromAppwrite(fileId: string): Promise<void> {
  const clients = getClients();
  if (!clients || !fileId) return;

  try {
    await clients.storage.deleteFile({
      bucketId: APPWRITE_BUCKET_ID!,
      fileId,
    });
    console.log(`[AppwriteService] Creative deleted: ${fileId}`);
  } catch (error) {
    console.warn(`[AppwriteService] Creative delete failed for ${fileId}:`, (error as Error).message);
  }
}

export async function uploadBufferToAppwrite(options: UploadBufferOptions): Promise<UploadResult | null> {
  const clients = getClients();
  if (!clients) {
    return null;
  }

  const FileCtor = (globalThis as unknown as { File?: new (...args: unknown[]) => unknown }).File;
  if (!FileCtor) {
    throw new Error('File constructor is not available in this runtime.');
  }

  const fileId = ID.unique();
  const permissions = options.permissions?.length
    ? options.permissions
    : [Permission.read(Role.any())];

  const file = new (FileCtor as any)(
    [options.buffer],
    options.filename,
    options.contentType ? { type: options.contentType } : undefined
  );

  const created = await clients.storage.createFile({
    bucketId: APPWRITE_BUCKET_ID!,
    fileId,
    file: file as any,
    permissions,
  });

  const resolvedId = created.$id || fileId;
  const token = await createViewToken(clients.tokens, resolvedId);
  return {
    fileId: resolvedId,
    url: buildPublicFileUrl(resolvedId, token || undefined),
    signed: Boolean(token),
  };
}
