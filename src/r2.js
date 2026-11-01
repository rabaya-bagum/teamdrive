const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: 'auto',
  endpoint: process.env.R2_ENDPOINT || `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  forcePathStyle: !!process.env.R2_ENDPOINT,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const Bucket = process.env.R2_BUCKET;

// Browser uploads straight to R2, so big files never pass through Hostinger.
const uploadUrl = (Key, ContentType) =>
  getSignedUrl(s3, new PutObjectCommand({ Bucket, Key, ContentType }), { expiresIn: 3600 });

const downloadUrl = (Key, filename) =>
  getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket,
      Key,
      ResponseContentDisposition: `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
    }),
    { expiresIn: 300 }
  );

// Inline URL for in-browser previews.
const previewUrl = (Key, ContentType) =>
  getSignedUrl(
    s3,
    new GetObjectCommand({ Bucket, Key, ResponseContentDisposition: 'inline', ResponseContentType: ContentType }),
    { expiresIn: 600 }
  );

const getStream = async (Key) => (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body;
const head = (Key) => s3.send(new HeadObjectCommand({ Bucket, Key }));
const put = (Key, Body, ContentType) => s3.send(new PutObjectCommand({ Bucket, Key, Body, ContentType }));
const remove = (Key) => s3.send(new DeleteObjectCommand({ Bucket, Key }));
async function list(Prefix) {
  const out = []; let ContinuationToken;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket, Prefix, ContinuationToken }));
    out.push(...(r.Contents || []));
    ContinuationToken = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (ContinuationToken);
  return out;
}
// Cheap reachability check for the health endpoint
const ping = () => s3.send(new ListObjectsV2Command({ Bucket, MaxKeys: 1 }));
const getBuffer = async (Key) => Buffer.from(await (await s3.send(new GetObjectCommand({ Bucket, Key }))).Body.transformToByteArray());

module.exports = { uploadUrl, downloadUrl, previewUrl, getStream, getBuffer, head, put, remove, list, ping };
