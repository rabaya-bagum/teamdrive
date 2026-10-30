const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
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

const head = (Key) => s3.send(new HeadObjectCommand({ Bucket, Key }));
const remove = (Key) => s3.send(new DeleteObjectCommand({ Bucket, Key }));

module.exports = { uploadUrl, downloadUrl, head, remove };
