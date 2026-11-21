import {
  S3Client,
  PutObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadBucketCommand,
} from '@aws-sdk/client-s3';
import dotenv from 'dotenv';

dotenv.config();

export const R2_CONFIG = {
  accountId: process.env.R2_ACCOUNT_ID || '3a2b3ab1c65156ba7ec98dd7d34c4bda',
  endpoint:
    process.env.R2_ENDPOINT ||
    'https://3a2b3ab1c65156ba7ec98dd7d34c4bda.r2.cloudflarestorage.com',
  publicUrl:
    process.env.R2_PUBLIC_URL ||
    'https://pub-0d49bd72f6914abbbae9957be8a60ecc.r2.dev',
  bucketName: process.env.R2_BUCKET_NAME || 'id-storage',
  accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
  secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
};

// Standard R2 Storage Folders
export const R2_FOLDERS = {
  PROFILE_PICTURES: 'profile-pictures',
  DOCUMENTS: 'documents',
} as const;

export type R2FolderType = typeof R2_FOLDERS[keyof typeof R2_FOLDERS];

// Initialize S3 Client targeting Cloudflare R2
export const r2Client = new S3Client({
  region: 'auto',
  endpoint: R2_CONFIG.endpoint,
  credentials: {
    accessKeyId: R2_CONFIG.accessKeyId,
    secretAccessKey: R2_CONFIG.secretAccessKey,
  },
});

export interface UploadResult {
  key: string;
  url: string;
  size: number;
  contentType: string;
  bucket: string;
  folder: string;
}

/**
 * Ensure standard R2 folders exist by placing .keep placeholder keys
 */
export const createR2Folders = async (): Promise<{ created: string[]; errors: string[] }> => {
  const folders = [R2_FOLDERS.PROFILE_PICTURES, R2_FOLDERS.DOCUMENTS];
  const created: string[] = [];
  const errors: string[] = [];

  for (const folder of folders) {
    const key = `${folder}/.keep`;

    if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
      created.push(folder);
      continue;
    }

    try {
      const command = new PutObjectCommand({
        Bucket: R2_CONFIG.bucketName,
        Key: key,
        Body: Buffer.from(''),
        ContentType: 'application/x-directory',
      });
      await r2Client.send(command);
      created.push(folder);
      console.log(`📁 Cloudflare R2 folder verified: ${folder}/`);
    } catch (err) {
      errors.push(`${folder}: ${(err as Error).message}`);
    }
  }

  return { created, errors };
};

/**
 * Upload a file buffer directly to Cloudflare R2 storage within a designated folder
 */
export const uploadToR2 = async (
  fileBuffer: Buffer,
  fileName: string,
  contentType: string,
  folder: R2FolderType | string = R2_FOLDERS.DOCUMENTS
): Promise<UploadResult> => {
  // Sanitize filename and create unique key
  const sanitizedName = fileName.replace(/[^a-zA-Z0-9.-]/g, '_');
  const timestamp = Date.now();
  const randomStr = Math.random().toString(36).substring(2, 8);
  const key = `${folder}/${timestamp}-${randomStr}-${sanitizedName}`;

  if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
    console.warn(
      `⚠️ R2 credentials not fully active. Simulated R2 public URL generated for folder: ${folder}`
    );
    const mockUrl = `${R2_CONFIG.publicUrl.replace(/\/$/, '')}/${key}`;
    return {
      key,
      url: mockUrl,
      size: fileBuffer.length,
      contentType,
      bucket: R2_CONFIG.bucketName,
      folder,
    };
  }

  const command = new PutObjectCommand({
    Bucket: R2_CONFIG.bucketName,
    Key: key,
    Body: fileBuffer,
    ContentType: contentType,
  });

  await r2Client.send(command);

  const url = `${R2_CONFIG.publicUrl.replace(/\/$/, '')}/${key}`;

  return {
    key,
    url,
    size: fileBuffer.length,
    contentType,
    bucket: R2_CONFIG.bucketName,
    folder,
  };
};

/**
 * Upload specifically to the profile-pictures folder
 */
export const uploadProfilePicture = async (
  fileBuffer: Buffer,
  fileName: string,
  contentType: string
): Promise<UploadResult> => {
  return uploadToR2(fileBuffer, fileName, contentType, R2_FOLDERS.PROFILE_PICTURES);
};

/**
 * Upload specifically to the documents folder
 */
export const uploadDocument = async (
  fileBuffer: Buffer,
  fileName: string,
  contentType: string
): Promise<UploadResult> => {
  return uploadToR2(fileBuffer, fileName, contentType, R2_FOLDERS.DOCUMENTS);
};

/**
 * Delete an object from Cloudflare R2 storage
 */
export const deleteFromR2 = async (key: string): Promise<boolean> => {
  if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
    return true;
  }

  try {
    const command = new DeleteObjectCommand({
      Bucket: R2_CONFIG.bucketName,
      Key: key,
    });
    await r2Client.send(command);
    return true;
  } catch (err) {
    console.error('Error deleting from R2:', err);
    return false;
  }
};

/**
 * List objects in the Cloudflare R2 bucket (optionally filtered by folder)
 */
export const listR2Files = async (prefix: string = '') => {
  if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
    return [];
  }

  const command = new ListObjectsV2Command({
    Bucket: R2_CONFIG.bucketName,
    Prefix: prefix,
  });

  const response = await r2Client.send(command);
  return (
    response.Contents?.filter((item) => item.Key && !item.Key.endsWith('/.keep')).map((item) => ({
      key: item.Key,
      size: item.Size,
      lastModified: item.LastModified,
      url: `${R2_CONFIG.publicUrl.replace(/\/$/, '')}/${item.Key}`,
      folder: item.Key?.split('/')[0] || 'root',
    })) || []
  );
};

/**
 * Check connectivity to Cloudflare R2 bucket
 */
export const checkR2Connection = async (): Promise<boolean> => {
  if (!R2_CONFIG.accessKeyId || !R2_CONFIG.secretAccessKey) {
    return false;
  }

  try {
    const command = new HeadBucketCommand({ Bucket: R2_CONFIG.bucketName });
    await r2Client.send(command);
    return true;
  } catch {
    return false;
  }
};
