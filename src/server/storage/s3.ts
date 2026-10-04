import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadBucketCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import { config } from '../config.js';

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, Backblaze B2, Hetzner
 * Object Storage, MinIO, SeaweedFS, Garage …). Files are never served directly
 * from the bucket: the application streams them after an authorisation check,
 * so the bucket can (and should) be private.
 *
 * Key layout (all under S3_KEY_PREFIX):
 *   originals/<ownerId>/<attachmentId>     the uploaded file, byte-for-byte
 *   derived/<ownerId>/<attachmentId>/...   thumbnails and previews
 */

let client: S3Client | undefined;

export function s3(): S3Client {
  if (!client) {
    const c = config();
    client = new S3Client({
      region: c.S3_REGION,
      endpoint: c.S3_ENDPOINT,
      forcePathStyle: c.S3_FORCE_PATH_STYLE,
      credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY },
      // Some S3-compatible services reject the newer default checksum headers.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }
  return client;
}

const bucket = () => config().S3_BUCKET;
const prefixed = (key: string) => `${config().S3_KEY_PREFIX}${key}`;

export function originalKey(ownerId: string, attachmentId: string): string {
  return `originals/${ownerId}/${attachmentId}`;
}

export function derivedKey(ownerId: string, attachmentId: string, name: string): string {
  if (!/^[a-z0-9._-]+$/.test(name)) throw new Error('invalid derivative name');
  return `derived/${ownerId}/${attachmentId}/${name}`;
}

export async function ensureBucket(): Promise<void> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket() }));
  } catch (err) {
    if (!config().S3_CREATE_BUCKET) {
      throw new Error(
        `S3 bucket "${bucket()}" is not reachable (${(err as Error).name}). Check S3_ENDPOINT, S3_BUCKET and credentials.`,
        { cause: err },
      );
    }
    await s3().send(new CreateBucketCommand({ Bucket: bucket() }));
  }
}

export async function putFile(key: string, filePath: string, contentType: string): Promise<void> {
  const upload = new Upload({
    client: s3(),
    params: {
      Bucket: bucket(),
      Key: prefixed(key),
      Body: createReadStream(filePath),
      ContentType: contentType,
      ServerSideEncryption: undefined,
    },
    queueSize: 2,
  });
  await upload.done();
}

export async function putBuffer(key: string, body: Buffer, contentType: string): Promise<void> {
  const upload = new Upload({
    client: s3(),
    params: { Bucket: bucket(), Key: prefixed(key), Body: body, ContentType: contentType },
  });
  await upload.done();
}

export async function getObjectStream(key: string, range?: string): Promise<{
  body: Readable;
  contentLength?: number;
  contentRange?: string;
}> {
  const res = await s3().send(new GetObjectCommand({ Bucket: bucket(), Key: prefixed(key), Range: range }));
  return {
    body: res.Body as Readable,
    contentLength: res.ContentLength,
    contentRange: res.ContentRange,
  };
}

export async function getObjectBuffer(key: string): Promise<Buffer> {
  const { body } = await getObjectStream(key);
  const chunks: Buffer[] = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

export async function objectExists(key: string): Promise<boolean> {
  try {
    await s3().send(new HeadObjectCommand({ Bucket: bucket(), Key: prefixed(key) }));
    return true;
  } catch {
    return false;
  }
}

export async function deleteObject(key: string): Promise<void> {
  await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: prefixed(key) }));
}

export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;
  do {
    const res = await s3().send(
      new ListObjectsV2Command({ Bucket: bucket(), Prefix: prefixed(prefix), ContinuationToken: token }),
    );
    for (const obj of res.Contents ?? []) {
      if (obj.Key) {
        await s3().send(new DeleteObjectCommand({ Bucket: bucket(), Key: obj.Key }));
        deleted++;
      }
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return deleted;
}

export async function storageHealthy(): Promise<boolean> {
  try {
    await s3().send(new HeadBucketCommand({ Bucket: bucket() }));
    return true;
  } catch {
    return false;
  }
}
