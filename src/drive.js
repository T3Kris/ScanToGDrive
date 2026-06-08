import { Readable } from 'node:stream';
import path from 'node:path';
import { driveClientFor } from './auth.js';
import { config } from './config.js';
import { createLogger } from './logger.js';
import { withRetry } from './retry.js';

const log = createLogger('drive-upload');

// Per-user cache of the destination folder id so we don't search every upload.
const folderCache = new Map();

/**
 * Find (or create) the destination folder in the recipient's Drive and return
 * its id. Cached per user for the lifetime of the process.
 */
async function ensureFolder(userEmail) {
  if (folderCache.has(userEmail)) return folderCache.get(userEmail);

  const drive = driveClientFor(userEmail);
  const name = config.driveFolderName;
  const escaped = name.replace(/'/g, "\\'");

  const res = await withRetry(() => drive.files.list({
    q: `mimeType='application/vnd.google-apps.folder' and name='${escaped}' and trashed=false`,
    fields: 'files(id, name)',
    spaces: 'drive',
  }));

  let folderId = res.data.files?.[0]?.id;
  if (!folderId) {
    const created = await withRetry(() => drive.files.create({
      requestBody: { name, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id',
    }));
    folderId = created.data.id;
    log.info('Created destination folder', { metadata: { userEmail, folder: name, folderId } });
  }

  folderCache.set(userEmail, folderId);
  return folderId;
}

/**
 * Build a non-colliding filename. If a file with the same name already exists
 * in the folder, append a timestamp before the extension.
 */
async function resolveFilename(drive, folderId, filename) {
  const escaped = filename.replace(/'/g, "\\'");
  const res = await withRetry(() => drive.files.list({
    q: `name='${escaped}' and '${folderId}' in parents and trashed=false`,
    fields: 'files(id)',
    spaces: 'drive',
  }));
  if (!res.data.files?.length) return filename;

  const ext = path.extname(filename);
  const stem = path.basename(filename, ext);
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stem}_${stamp}${ext}`;
}

/**
 * Upload a single attachment to the recipient's Drive. Returns the created
 * file's id. Throws on permanent failure (caller handles per-attachment skip).
 */
export async function uploadAttachment({ userEmail, filename, mimeType, buffer, receivedAt }) {
  const drive = driveClientFor(userEmail);
  const folderId = await ensureFolder(userEmail);
  const safeName = await resolveFilename(drive, folderId, filename);

  const created = await withRetry(
    () => drive.files.create({
      requestBody: {
        name: safeName,
        parents: [folderId],
        // Preserve the email's received time as the file's created time.
        modifiedTime: receivedAt || undefined,
      },
      media: {
        mimeType,
        body: Readable.from(buffer),
      },
      fields: 'id, name, size',
    }),
    { onRetry: ({ attempt, delay, error }) => log.warn('Retrying Drive upload', { metadata: { userEmail, filename: safeName, attempt, delay, error: error.message } }) },
  );

  return { fileId: created.data.id, name: created.data.name };
}
