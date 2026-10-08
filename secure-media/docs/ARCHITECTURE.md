# Architecture

## Overview

```
Browser ──upload──► S3 source bucket ──► Lambda ──► MediaConvert ──► S3 output bucket (private)
   │                                                                        │
   │ 1. ask for access                                                      ▼
   ▼                                                               CloudFront (signed cookies)
Your API ── checks canWatch ── signs cookies ─────────────────────────────► │
   │                                                                        │
   └──────────────── Shaka Player fetches playlist + segments ◄─────────────┘
```

## Local Development Stand-ins

| Production component | Local stand-in | How |
|---|---|---|
| S3 | SeaweedFS (Docker) | `S3_ENDPOINT=http://localhost:8333` |
| MediaConvert | `dev/encode.sh` | FFmpeg → HLS → output bucket |
| CloudFront | `dev/fake-cdn/server.mjs` | Verifies CF-style signed cookies, serves from SeaweedFS |
| ACM / custom domain | mkcert | `local.myapp.test`, `cdn.myapp.test` |

The same `@secure-media/server` and `@secure-media/client` code runs in both environments. Only env values change.

## Packages

### `@secure-media/server`

Exports `createMediaRouter(options)` — an Express Router with two routes:

| Route | Purpose |
|---|---|
| `POST /` | Create DB record, return pre-signed S3 PUT URL |
| `GET /:id/playback` | Access-check, readiness probe, issue 3 CloudFront signed cookies |

**Key design decisions:**
- Cookies are scoped with `Path=/<prefix>/<id>` so concurrent videos don't overwrite each other's cookies.
- CloudFront custom policy (not canned) for wildcard resource `https://cdn/<prefix>/*`.
- `s3Endpoint` + `forcePathStyle` automatically enabled when the option is set — clean local/prod toggle.
- `prefix` and `manifest` are config *functions*, not strings, because the real AWS MediaConvert output layout (folder/filename) is only known after a test upload.

### `@secure-media/client`

| Export | Purpose |
|---|---|
| `mountPlayer(videoEl, mediaId, opts)` | Core player logic — polls, loads Shaka, refreshes cookies, retries on 403 |
| `uploadVideo(file, opts)` | Create record + XHR PUT to S3 |
| `SecureVideo` | React wrapper with processing/error/ready UI states |

**Cookie refresh:** at 80% of remaining lifetime the client silently calls `/playback` again. This re-runs `canWatch` — so revoking a user takes effect within one cookie lifetime (default 10 min).

**403 recovery:** Shaka emits `BAD_HTTP_STATUS` on a failed segment fetch. The client refreshes once, then calls `player.retryStreaming()`. If refresh also fails, the error state is shown.

## Data Flow

### Upload
1. Browser → `POST /api/media` → server creates DB record (status: `uploading`), returns `{id, uploadUrl}`.
2. Browser → S3 source bucket via pre-signed PUT URL (15 min TTL).
3. S3 event triggers MediaConvert (or `encode.sh` locally) → writes HLS to output bucket.

### Playback
1. Browser (Shaka/SecureVideo) → `GET /api/media/:id/playback` with session cookie.
2. Server: `canWatch` check → `HEAD` the manifest in the output bucket.
   - Not found → `202 {status:'processing'}` → client polls every 4s.
   - Found → mark DB `ready`, sign CloudFront cookies, return `{status:'ready', manifestUrl, expiresAt}`.
3. Browser receives cookies; Shaka fetches `manifestUrl` (goes to CDN).
4. CDN (CloudFront or fake-cdn) verifies cookies on every request for playlist + segments.
5. Client schedules cookie refresh at 80% of TTL. If `canWatch` starts returning false, refresh fails and playback ends within one TTL.

## Security Properties

| Property | Mechanism |
|---|---|
| Output bucket never public | S3 bucket policy — only CloudFront OAC reads it |
| No direct segment URLs | Cookies required; signed with RSA private key never sent to browser |
| Per-video cookie scope | `Path=/<prefix>/<id>` — limits blast radius if cookies leak |
| Cookie expiry short | Default 10 min; refreshed via API which re-checks `canWatch` |
| Revocation | Refresh fails → playback ends within one TTL |
| Private key never logged | Read from env/Secrets Manager; not included in any log call |

## Known Limits

- Without DRM, a logged-in viewer can screen-record or rip the HLS stream.
- Mitigation: viewer-ID watermark (Phase 5) and grant logging.
- The AWS "Video on Demand on AWS Foundation" template is sample code — review its IAM and bucket policies before production.
- Test iPhone Safari early: native HLS (used when Shaka falls back) sends cookies differently. Keep the app and CDN on the same parent domain (`.myapp.com`) to ensure cookies are sent cross-subdomain.
