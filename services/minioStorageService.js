/**
 * MinIO Storage Service
 * Replaces local disk storage with S3-compatible MinIO object storage
 */
const {
  minioClient,
  presignClient,
  BUCKET_NAME,
  ensureBucket,
} = require('../client/minioClient');

let bucketReady = false;

const init = async () => {
  if (!bucketReady) {
    await ensureBucket();
    bucketReady = true;
  }
};

/**
 * Upload a file buffer to MinIO
 * @param {string} objectName - The object key (e.g. "folder/file.pdf")
 * @param {Buffer} buffer - File content
 * @param {string} contentType - MIME type (e.g. "application/pdf")
 * @returns {Promise<string>} The object name stored
 */
const putObject = async (
  objectName,
  buffer,
  contentType = 'application/octet-stream',
) => {
  await init();
  await minioClient.putObject(BUCKET_NAME, objectName, buffer, buffer.length, {
    'Content-Type': contentType,
  });
  console.log(`[MinIO] Uploaded: ${objectName} (${buffer.length} bytes)`);
  return objectName;
};

/**
 * Get a file from MinIO as a Buffer
 * @param {string} objectName
 * @returns {Promise<Buffer>}
 */
const getObject = async (objectName) => {
  await init();
  const stream = await minioClient.getObject(BUCKET_NAME, objectName);
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', (chunk) => chunks.push(chunk));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
};

/**
 * Get a presigned URL for downloading an object
 * @param {string} objectName
 * @param {number} expirySeconds - URL expiry in seconds
 * @returns {Promise<string>}
 */
const getPresignedGetUrl = async (objectName, expirySeconds = 3600) => {
  await init();
  const safeExpiry = Number.isFinite(Number(expirySeconds))
    ? Math.max(60, Math.min(7 * 24 * 3600, Math.round(Number(expirySeconds))))
    : 3600;
  return presignClient.presignedGetObject(BUCKET_NAME, objectName, safeExpiry);
};

/**
 * Check if an object exists in MinIO
 * @param {string} objectName
 * @returns {Promise<boolean>}
 */
const objectExists = async (objectName) => {
  await init();
  try {
    await minioClient.statObject(BUCKET_NAME, objectName);
    return true;
  } catch (err) {
    if (err.code === 'NotFound') return false;
    throw err;
  }
};

/**
 * Delete a single object from MinIO
 * @param {string} objectName
 */
const removeObject = async (objectName) => {
  await init();
  await minioClient.removeObject(BUCKET_NAME, objectName);
  console.log(`[MinIO] Deleted: ${objectName}`);
};

/**
 * Delete all objects with a given prefix (simulates folder deletion)
 * @param {string} prefix - e.g. "folderName/"
 */
const removeObjectsByPrefix = async (prefix) => {
  await init();
  const objectsList = [];
  const stream = minioClient.listObjects(BUCKET_NAME, prefix, true);

  await new Promise((resolve, reject) => {
    stream.on('data', (obj) => objectsList.push(obj.name));
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  if (objectsList.length > 0) {
    await minioClient.removeObjects(BUCKET_NAME, objectsList);
    console.log(
      `[MinIO] Deleted ${objectsList.length} object(s) with prefix: ${prefix}`,
    );
  }

  return objectsList.length;
};

/**
 * List "folders" (unique prefixes) in the bucket
 * Uses delimiter '/' to simulate folder listing
 * @returns {Promise<string[]>} Array of folder names
 */
const listFolders = async () => {
  await init();
  const folders = [];
  const stream = minioClient.listObjects(BUCKET_NAME, '', false);

  await new Promise((resolve, reject) => {
    stream.on('data', (obj) => {
      if (obj.prefix) {
        // Remove trailing slash
        folders.push(obj.prefix.replace(/\/$/, ''));
      }
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return folders;
};

/**
 * List objects in bucket
 * @param {string} prefix
 * @returns {Promise<Array<{name:string,size:number,lastModified:Date}>>}
 */
const listObjects = async (prefix = '') => {
  await init();
  const objects = [];
  const stream = minioClient.listObjects(BUCKET_NAME, prefix, true);

  await new Promise((resolve, reject) => {
    stream.on('data', (obj) => {
      if (!obj?.name) return;
      objects.push({
        name: obj.name,
        size: Number(obj.size || 0),
        lastModified: obj.lastModified || null,
      });
    });
    stream.on('end', resolve);
    stream.on('error', reject);
  });

  return objects;
};

/**
 * Copy an object to a new key (used for rename)
 * MinIO doesn't have native rename, so we copy + delete
 * @param {string} oldName
 * @param {string} newName
 */
const renameObject = async (oldName, newName) => {
  await init();
  // Copy to new location
  await minioClient.copyObject(
    BUCKET_NAME,
    newName,
    `/${BUCKET_NAME}/${oldName}`,
  );
  // Delete old object
  await minioClient.removeObject(BUCKET_NAME, oldName);
  console.log(`[MinIO] Renamed: ${oldName} -> ${newName}`);
};

/**
 * Create a "folder" by placing an empty marker object
 * MinIO doesn't have real folders, but this simulates it
 * @param {string} folderName
 */
const createFolder = async (folderName) => {
  await init();
  const marker = `${folderName}/.keep`;
  await minioClient.putObject(BUCKET_NAME, marker, Buffer.from(''), 0);
  console.log(`[MinIO] Created folder marker: ${marker}`);
};

/**
 * Check if a "folder" has any objects
 * @param {string} folderName
 * @returns {Promise<boolean>}
 */
const folderExists = async (folderName) => {
  await init();
  const stream = minioClient.listObjects(BUCKET_NAME, `${folderName}/`, false);
  return new Promise((resolve, reject) => {
    let found = false;
    stream.on('data', () => {
      found = true;
      stream.destroy();
    });
    stream.on('end', () => resolve(found));
    stream.on('error', reject);
  });
};

module.exports = {
  putObject,
  getObject,
  getPresignedGetUrl,
  objectExists,
  removeObject,
  removeObjectsByPrefix,
  listFolders,
  listObjects,
  renameObject,
  createFolder,
  folderExists,
};
