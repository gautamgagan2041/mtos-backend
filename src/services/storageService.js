// src/services/storageService.js
// ── Unified File Storage Service ─────────────────────────────
// Supports LOCAL disk storage and AWS S3.
// Switch between providers per-tenant via tenant.storageProvider.
// 
// To enable S3: set AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// AWS_REGION, and tenant.s3Bucket in the DB.

const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../utils/logger');

// Lazy-load AWS SDK only if S3 is configured (avoids startup crash if not installed)
let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, getSignedUrl;

function loadAWS() {
  if (!S3Client) {
    try {
      ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3'));
      ({ getSignedUrl } = require('@aws-sdk/s3-request-presigner'));
    } catch {
      throw new Error(
        'AWS SDK not installed. Run: npm install @aws-sdk/client-s3 @aws-sdk/s3-request-presigner'
      );
    }
  }
}

const UPLOAD_BASE = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, '../../uploads');

/**
 * getStorageProvider(tenant) → 'LOCAL' | 'S3'
 */
function getProvider(tenant) {
  if (!tenant) return 'LOCAL';
  return tenant.storageProvider || 'LOCAL';
}

/**
 * buildS3Client(tenant)
 */
function buildS3Client(tenant) {
  loadAWS();
  return new S3Client({
    region: tenant.s3Region || process.env.AWS_REGION || 'ap-south-1',
    credentials: {
      accessKeyId:     process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
  });
}

/**
 * generateKey(folder, originalName) → unique storage key
 */
function generateKey(folder, originalName) {
  const ext = path.extname(originalName).toLowerCase();
  const uid = uuidv4().replace(/-/g, '').slice(0, 16);
  return `${folder}/${uid}${ext}`;
}

/**
 * uploadFile({ tenant, folder, file, originalName, mimeType })
 * → { key, provider, url? }
 * 
 * `file` can be a Buffer or a local temp path string.
 */
async function uploadFile({ tenant, folder, file, originalName, mimeType }) {
  const key = generateKey(folder, originalName);
  const provider = getProvider(tenant);

  if (provider === 'S3') {
    const s3 = buildS3Client(tenant);
    const bucket = tenant.s3Bucket || process.env.AWS_S3_BUCKET;
    if (!bucket) throw new Error('S3 bucket not configured for this tenant');

    const body = Buffer.isBuffer(file) ? file : fs.readFileSync(file);

    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: mimeType || 'application/octet-stream',
      ServerSideEncryption: 'AES256',
      Metadata: {
        originalName,
        tenantId: tenant?.id || 'unknown',
        uploadedAt: new Date().toISOString(),
      },
    }));

    logger.info(`S3 upload: s3://${bucket}/${key}`);
    return { key, provider: 'S3', bucket };

  } else {
    // LOCAL storage
    const dir = path.join(UPLOAD_BASE, folder);
    fs.mkdirSync(dir, { recursive: true });

    const destPath = path.join(dir, path.basename(key));

    if (Buffer.isBuffer(file)) {
      fs.writeFileSync(destPath, file);
    } else {
      fs.copyFileSync(file, destPath);
    }

    logger.info(`Local upload: ${destPath}`);
    return { key, provider: 'LOCAL' };
  }
}

/**
 * getFileUrl({ tenant, key, expiresIn = 3600 })
 * → signed S3 URL or local path for serving
 */
async function getFileUrl({ tenant, key, expiresIn = 3600 }) {
  if (!key) return null;
  const provider = getProvider(tenant);

  if (provider === 'S3') {
    const s3 = buildS3Client(tenant);
    const bucket = tenant.s3Bucket || process.env.AWS_S3_BUCKET;
    const command = new GetObjectCommand({ Bucket: bucket, Key: key });
    return await getSignedUrl(s3, command, { expiresIn });
  }

  // LOCAL — return path for static serving
  return `/uploads/${key}`;
}

/**
 * deleteFile({ tenant, key })
 */
async function deleteFile({ tenant, key }) {
  if (!key) return;
  const provider = getProvider(tenant);

  if (provider === 'S3') {
    const s3 = buildS3Client(tenant);
    const bucket = tenant.s3Bucket || process.env.AWS_S3_BUCKET;
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
    logger.info(`S3 delete: ${key}`);
  } else {
    const fullPath = path.join(UPLOAD_BASE, key);
    if (fs.existsSync(fullPath)) {
      fs.unlinkSync(fullPath);
      logger.info(`Local delete: ${fullPath}`);
    }
  }
}

/**
 * moveFromTemp(tempPath, tenant, folder, originalName, mimeType)
 * Convenience: read a multer temp file and store via appropriate provider
 */
async function moveFromTemp(tempPath, tenant, folder, originalName, mimeType) {
  const result = await uploadFile({ tenant, folder, file: tempPath, originalName, mimeType });
  // Always clean up temp file
  try { fs.unlinkSync(tempPath); } catch {}
  return result;
}

module.exports = { uploadFile, getFileUrl, deleteFile, moveFromTemp, generateKey };
