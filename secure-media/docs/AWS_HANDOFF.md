# AWS Handoff Checklist

Complete this checklist before switching the app to production AWS.
At the end you'll have **8 values** to paste back into your `.env`.

---

## Step 1 — Deploy the VOD Foundation template

- [ ] Open the AWS Console → CloudFormation → Create stack.
- [ ] Use the "Video on Demand on AWS" template URL (search AWS Solutions Library for "Video on Demand on AWS Foundation").
- [ ] Parameters to set:
  - `AdminEmail` — your email for SNS alerts.
  - Keep defaults for everything else on first deploy.
- [ ] Wait for stack status `CREATE_COMPLETE`.
- [ ] Note the two S3 bucket names from the **Outputs** tab:
  - `SOURCE_BUCKET` = the source/ingest bucket
  - `DEST_BUCKET`   = the destination/output bucket

## Step 2 — Edit MediaConvert job settings (quality ladder)

- [ ] In the CloudFormation stack outputs, find the MediaConvert job template ARN.
- [ ] Open MediaConvert → Job templates → find the template.
- [ ] Edit output groups to match this quality ladder:

| Name | Resolution | Video bitrate | Audio bitrate |
|------|-----------|---------------|---------------|
| 360p | 640×360 | 800 kbps | 96 kbps |
| 720p | 1280×720 | 2800 kbps | 128 kbps |
| 1080p | 1920×1080 | 5000 kbps | 192 kbps |

- [ ] Ensure the output type is HLS with a master playlist named `master.m3u8`.
- [ ] Save the template.
- [ ] **Record the exact output folder pattern and master playlist key** by uploading one test MP4 and checking what MediaConvert writes to the output bucket. The path will look something like:

  ```
  <some-prefix>/<job-id>/HLS/master.m3u8
  ```

  You will need this for the `prefix` and `manifest` config functions.

## Step 3 — Lock down the output bucket

- [ ] Go to S3 → your output bucket → **Block all public access** (confirm all four checkboxes are checked).
- [ ] **Remove** any bucket policy granting public read.
- [ ] The only reader will be CloudFront via Origin Access Control (OAC) — set in Step 4.

## Step 4 — CloudFront distribution

- [ ] CloudFront → Create distribution.
- [ ] Origin:
  - Origin domain: your output S3 bucket.
  - Origin access: **Origin access control (OAC)** → Create new OAC (signing behavior: Sign requests).
  - Copy the generated bucket policy statement and add it to your output bucket policy.
- [ ] Default cache behavior:
  - Viewer protocol policy: **Redirect HTTP to HTTPS**.
  - Allowed methods: GET, HEAD.
  - Cache policy: `CachingOptimized`.
  - **Restrict viewer access**: Yes → Trusted key groups (add the key group from Step 5).
- [ ] Settings:
  - Alternate domain names (CNAMEs): `cdn.<yourdomain.com>`
  - Custom SSL certificate: select the ACM cert from Step 5b.
- [ ] Create distribution. Note the **CloudFront distribution domain** (e.g. `d1234abcd.cloudfront.net`).

## Step 5 — TLS cert + DNS + key pair

### 5a — ACM certificate
- [ ] Open ACM **in us-east-1** (required for CloudFront).
- [ ] Request a public certificate for `cdn.<yourdomain.com>`.
- [ ] Validate via DNS (add the CNAME record ACM gives you).
- [ ] Wait for status **Issued**.

### 5b — DNS for CDN subdomain
- [ ] In your DNS provider, create a CNAME:
  - Name: `cdn.<yourdomain.com>`
  - Value: the CloudFront distribution domain from Step 4.

### 5c — CloudFront RSA key pair
- [ ] CloudFront → Key management → Public keys → Add public key.
- [ ] Generate a 2048-bit RSA key pair locally:
  ```bash
  openssl genrsa -out cf-private.pem 2048
  openssl rsa -pubout -in cf-private.pem -out cf-public.pem
  ```
- [ ] Paste the contents of `cf-public.pem` into the CloudFront public key form.
- [ ] Note the **Key pair ID** assigned by CloudFront.
- [ ] CloudFront → Key groups → Create key group → add the key above.
- [ ] Go back to your distribution → edit the behavior → set the key group under "Restrict viewer access".

## Step 6 — CORS response-headers policy

- [ ] CloudFront → Policies → Response headers → Create policy.
- [ ] Add CORS headers:
  - `Access-Control-Allow-Origin`: **your exact app origin** (e.g. `https://myapp.com`). Do NOT use `*`.
  - `Access-Control-Allow-Credentials`: `true`
  - `Access-Control-Allow-Methods`: `GET, HEAD`
  - `Access-Control-Allow-Headers`: `Range`
- [ ] Attach the policy to your CloudFront distribution's cache behavior.

## Step 7 — Backend IAM

Create an IAM policy and attach it to the role/user your backend runs as:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "SourceUpload",
      "Effect": "Allow",
      "Action": ["s3:PutObject"],
      "Resource": "arn:aws:s3:::YOUR_SOURCE_BUCKET/*"
    },
    {
      "Sid": "DestRead",
      "Effect": "Allow",
      "Action": ["s3:GetObject", "s3:ListBucket"],
      "Resource": [
        "arn:aws:s3:::YOUR_DEST_BUCKET",
        "arn:aws:s3:::YOUR_DEST_BUCKET/*"
      ]
    }
  ]
}
```

- [ ] Replace `YOUR_SOURCE_BUCKET` and `YOUR_DEST_BUCKET`.
- [ ] Apply to your EC2 instance profile, ECS task role, or Lambda execution role.

## Step 8 — Store the private key in Secrets Manager

- [ ] AWS Secrets Manager → Store a new secret → Other type of secret.
- [ ] Key: `CF_PRIVATE_KEY`, Value: paste the PEM contents of `cf-private.pem`.
- [ ] Name the secret (e.g. `secure-media/cf-private-key`).
- [ ] In your backend, read it at startup: `secretsmanager:GetSecretValue`.
- [ ] **Delete** `cf-private.pem` from your local machine (keep a backup in a secure vault).

---

## ✅ Record these 8 values and return them

Once all steps above are complete, paste these 8 values back (replacing the local dev ones):

```
AWS_REGION=
SOURCE_BUCKET=
DEST_BUCKET=
CDN_DOMAIN=cdn.<yourdomain.com>
COOKIE_DOMAIN=.<yourdomain.com>
CF_KEY_PAIR_ID=<key pair ID from Step 5c>
CF_PRIVATE_KEY=<PEM contents, or use Secrets Manager reference>
# From your test upload in Step 2 — the EXACT output folder and manifest path
# e.g. prefix = (id) => `output/${id}/HLS`
#      manifest = (id) => `output/${id}/HLS/master.m3u8`
MEDIA_PREFIX_PATTERN=<output folder pattern>
MEDIA_MANIFEST_PATTERN=<master playlist path pattern>
```

> **Important:** Remove `S3_ENDPOINT` from your production env. The AWS SDK will auto-discover the real S3 endpoint.

---

## Security review before go-live

- [ ] Output bucket has zero public access.
- [ ] CloudFront OAC bucket policy is the **only** statement granting GetObject on the output bucket.
- [ ] IAM policy grants only the minimum actions listed above — no `s3:*` or `*`.
- [ ] `CF_PRIVATE_KEY` is in Secrets Manager and **not** in any code or git history.
- [ ] CloudFront viewer access restriction is set to the key group (not "Trusted signers — self").
- [ ] CORS response-headers policy uses your exact app origin, not `*`.
- [ ] Review the VOD Foundation template's Lambda execution role — remove any excess permissions.
