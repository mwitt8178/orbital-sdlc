# Round 8-06 — S3 + CloudFront for UI + Replay Blobs

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Low · Estimate: M

## Depends on
8-01 (DNS + cert)

## Why
Static UI from S3 + CloudFront. Replay blobs to S3 with SSE-KMS. Round 6 #7's `replay/store.ts` abstraction gets an S3 driver.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/static-ui.ts` | NEW | UI bucket + CloudFront distribution |
| `infra/lib/constructs/replay-bucket.ts` | NEW | Replay blob bucket |
| `packages/orchestrator/src/replay/store-s3.ts` | NEW | `S3Store` driver |
| `packages/orchestrator/src/replay/store.ts` | extend | Factory selects S3 or filesystem driver based on env |
| `.github/workflows/ui-deploy.yml` | NEW (or extend existing) | Build + S3 sync + CloudFront invalidation on `main` push |

## UI bucket + CloudFront

**UI bucket:**
- Name: `orbital-ui-${env}-${account}`
- Public access blocked
- Encryption: SSE-S3 (default; UI assets aren't sensitive)
- Bucket policy: only allows access from CloudFront via OAC (Origin Access Control)
- Versioning enabled (rollback capability)

**CloudFront distribution:**
- Custom domain: `${envConfig.domain}` (e.g., `mwitt.orbital.team.dev`)
- Origin: UI bucket via OAC
- Cache behaviors:
  - `/index.html`: no cache, always revalidate
  - `/assets/*` (Vite-hashed): cache 1 year, immutable
  - `/api/*`: NOT served by CloudFront — direct to API Gateway
- HTTP → HTTPS redirect
- HTTP/2 + HTTP/3 enabled
- Minimum TLS version: 1.2
- Custom error responses: 404/403 → return `/index.html` (SPA routing)
- WAF: same WAF as API Gateway (Round 8-08)

**Deploy pipeline (.github/workflows/ui-deploy.yml):**
```yaml
on:
  push:
    branches: [main]
    paths: ['packages/ui/**']

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npm ci && npm run -w packages/ui build
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ secrets.UI_DEPLOY_ROLE_ARN }}
          aws-region: us-east-1
      - run: aws s3 sync packages/ui/dist/ s3://orbital-ui-mwitt-${{ secrets.AWS_ACCOUNT }} --delete
      - run: aws cloudfront create-invalidation --distribution-id ${{ secrets.CF_DIST_ID }} --paths "/index.html"
```

GitHub OIDC role for AWS auth — no long-lived AWS credentials in GitHub.

## Replay bucket

**Bucket:**
- Name: `orbital-replays-${env}-${account}`
- Public access blocked
- Encryption: SSE-KMS using per-tenant CMK (CMK from 8-07)
- Versioning enabled (forensic recovery)
- Lifecycle:
  - Hot: STANDARD for 30 days
  - Warm: STANDARD_IA for 60 more days (90 days total)
  - Cold: GLACIER_IR after 90 days
  - Delete after 7 years (configurable per env via context)
- Object Lock: governance mode for prod (compliance-grade WORM)

## S3Store driver
```typescript
export class S3Store implements ReplayStore {
  constructor(
    private s3: S3Client,
    private bucket: string,
    private kmsKeyArnFor: (tenantId: string) => Promise<string>,
  ) {}

  async write(captureId: string, tenantId: string, body: Buffer): Promise<{ uri: string; sha256: string }> {
    const sha256 = createHash('sha256').update(body).digest('hex')
    const key = `${tenantId}/${captureId}.bin`
    const kmsKeyArn = await this.kmsKeyArnFor(tenantId)
    await this.s3.putObject({
      Bucket: this.bucket,
      Key: key,
      Body: body,
      ServerSideEncryption: 'aws:kms',
      SSEKMSKeyId: kmsKeyArn,
      Metadata: { sha256 },
    })
    return { uri: `s3://${this.bucket}/${key}`, sha256 }
  }

  async read(uri: string, expectedSha256: string): Promise<Buffer> {
    const { Bucket, Key } = parseS3Uri(uri)
    const obj = await this.s3.getObject({ Bucket, Key })
    const body = await streamToBuffer(obj.Body)
    const actual = createHash('sha256').update(body).digest('hex')
    if (actual !== expectedSha256) throw new Error('REPLAY_BLOB_CORRUPT')
    return body
  }
}
```

## Driver factory
```typescript
// replay/store.ts
export function createReplayStore(env: Env): ReplayStore {
  if (env.ORBITAL_DEPLOY_TARGET === 'aws') {
    return new S3Store(/* ... */)
  }
  return new FileSystemStore(/* ... */)
}
```

## Acceptance criteria
1. UI deploy workflow runs successfully on a `main` push; CloudFront invalidation completes.
2. `https://mwitt.orbital.team.dev` returns the UI; SPA routes (`/backlog`, `/agents`) all serve `index.html`.
3. Replay capture writes a blob to S3; encryption-at-rest verified via S3 metadata (`x-amz-server-side-encryption: aws:kms`).
4. Replay read verifies SHA-256; corrupt blob (manually edited) is rejected.
5. Lifecycle rules apply (verified via S3 inventory).
6. CloudFront cache-control headers correct: 1y immutable for hashed assets, no-cache for index.html.

## Hard-stop checks
```
grep -E "S3Store" packages/orchestrator/src/replay/store-s3.ts packages/orchestrator/src/replay/store.ts
grep -E "OriginAccessControl|OAC" infra/lib/constructs/static-ui.ts
grep -E "SSEKMSKeyId" packages/orchestrator/src/replay/store-s3.ts
ls .github/workflows/ui-deploy.yml
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]`
