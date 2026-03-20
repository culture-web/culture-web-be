const Minio = require('minio');
const fs = require('fs');
const url = require('url');

// Load environment variables with validation
const { MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY, MINIO_BUCKET } =
  process.env;

const MINIO_PORT = Number(process.env.MINIO_PORT || 9000);
const MINIO_USE_SSL = process.env.MINIO_USE_SSL === 'true';
const MINIO_PUBLIC_ENDPOINT = String(
  process.env.MINIO_PUBLIC_ENDPOINT || '',
).trim();
const MINIO_PUBLIC_PORT = Number(
  process.env.MINIO_PUBLIC_PORT || MINIO_PORT || 9000,
);
const MINIO_PUBLIC_USE_SSL =
  String(process.env.MINIO_PUBLIC_USE_SSL || '')
    .trim()
    .toLowerCase() === 'true';
const isRunningInDocker = fs.existsSync('/.dockerenv');
const normalizedEndpoint = String(MINIO_ENDPOINT || '').trim();
const shouldUseMinioServiceName =
  isRunningInDocker &&
  (!normalizedEndpoint ||
    normalizedEndpoint === 'localhost' ||
    normalizedEndpoint === '127.0.0.1');
const resolvedMinioEndpoint = shouldUseMinioServiceName
  ? 'minio'
  : normalizedEndpoint || 'minio';

// Validate required credentials (skip in test environment)
if (process.env.NODE_ENV !== 'test') {
  if (!MINIO_ENDPOINT || !MINIO_ACCESS_KEY || !MINIO_SECRET_KEY) {
    throw new Error(
      'Missing required MINIO environment variables. Please set: MINIO_ENDPOINT, MINIO_ACCESS_KEY, MINIO_SECRET_KEY',
    );
  }
}

const minioClient = new Minio.Client({
  endPoint: resolvedMinioEndpoint,
  port: MINIO_PORT,
  useSSL: MINIO_USE_SSL,
  accessKey: MINIO_ACCESS_KEY || '',
  secretKey: MINIO_SECRET_KEY || '',
});

if (shouldUseMinioServiceName) {
  console.warn(
    '[MinIO] MINIO_ENDPOINT was localhost/empty in Docker; using service endpoint "minio" instead.',
  );
}

const parseEndpointHost = (endpoint) => {
  if (!endpoint) return '';
  if (endpoint.includes('://')) {
    try {
      return (new url.URL(endpoint).hostname || '').trim();
    } catch (error) {
      console.warn(
        '[MinIO] Failed to parse MINIO_PUBLIC_ENDPOINT URL, using raw value:',
        error?.message || error,
      );
      return endpoint;
    }
  }
  return endpoint;
};

const resolvedPublicEndpoint = parseEndpointHost(MINIO_PUBLIC_ENDPOINT);

const presignClient = resolvedPublicEndpoint
  ? new Minio.Client({
      endPoint: resolvedPublicEndpoint,
      port: MINIO_PUBLIC_PORT,
      useSSL: MINIO_PUBLIC_USE_SSL,
      accessKey: MINIO_ACCESS_KEY || '',
      secretKey: MINIO_SECRET_KEY || '',
    })
  : minioClient;

if (resolvedPublicEndpoint) {
  console.info(
    `[MinIO] Presigned URLs will use public endpoint ${resolvedPublicEndpoint}:${MINIO_PUBLIC_PORT} (ssl=${MINIO_PUBLIC_USE_SSL})`,
  );
} else {
  console.info(
    `[MinIO] Presigned URLs will use internal endpoint ${resolvedMinioEndpoint}:${MINIO_PORT} (ssl=${MINIO_USE_SSL})`,
  );
}

const BUCKET_NAME = MINIO_BUCKET || 'knowledge-base';

/**
 * Ensure the bucket exists, create it if not
 */
const ensureBucket = async () => {
  const exists = await minioClient.bucketExists(BUCKET_NAME);
  if (!exists) {
    await minioClient.makeBucket(BUCKET_NAME);
    console.log(`[MinIO] Bucket "${BUCKET_NAME}" created`);
  }
};

module.exports = {
  minioClient,
  presignClient,
  BUCKET_NAME,
  ensureBucket,
};
