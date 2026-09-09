/**
 * tricache — Zero-Dependency AWS SigV4 Snapshot Adapter
 *
 * Provides a lightweight (~150 LOC) AWS SigV4 request signer built purely on the
 * standard Web Crypto API (crypto.subtle) and global fetch.
 *
 * Allows stateless container pods (Kubernetes, AWS ECS, GCP Cloud Run) and Edge workers
 * to persist and hydrate L1 snapshots directly to/from AWS S3, Cloudflare R2, MinIO,
 * or custom S3-compatible object storage WITHOUT pulling in the 30MB @aws-sdk/client-s3.
 */

import type { IRemoteSnapshotAdapter } from './remote-snapshot';

export interface SigV4SnapshotAdapterOptions {
  /** S3 or Cloudflare R2 bucket name */
  bucket: string;
  /** Object key / filename for the snapshot (e.g. 'production-l1.snap') */
  key: string;
  /** AWS Region. Default: 'us-east-1' (use 'auto' for Cloudflare R2) */
  region?: string;
  /** Custom endpoint URL (e.g. 'https://<account_id>.r2.cloudflarestorage.com' or 'http://127.0.0.1:9000') */
  endpoint?: string;
  /** AWS Access Key ID. Defaults to process.env.AWS_ACCESS_KEY_ID */
  accessKeyId?: string;
  /** AWS Secret Access Key. Defaults to process.env.AWS_SECRET_ACCESS_KEY */
  secretAccessKey?: string;
  /** Optional AWS Session Token (for temporary IAM/STS credentials). Defaults to process.env.AWS_SESSION_TOKEN */
  sessionToken?: string;
  /** Force path-style URLs (e.g. https://endpoint/bucket/key). Default: true if endpoint is specified, false for AWS S3 */
  forcePathStyle?: boolean;
  /** Custom fetch implementation (defaults to globalThis.fetch) */
  fetch?: typeof globalThis.fetch;
}

const EMPTY_STRING_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

async function sha256Hex(data: ArrayBuffer | Uint8Array | string): Promise<string> {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256', buf as ArrayBuffer);
  return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmac(key: CryptoKey | ArrayBuffer | Uint8Array, data: string): Promise<ArrayBuffer> {
  let cryptoKey: CryptoKey;
  if (key instanceof CryptoKey) {
    cryptoKey = key;
  } else {
    const rawBuf: ArrayBuffer = key instanceof Uint8Array
      ? (key.buffer.slice(key.byteOffset, key.byteOffset + key.byteLength) as ArrayBuffer)
      : (key as ArrayBuffer);
    cryptoKey = await crypto.subtle.importKey(
      'raw',
      rawBuf,
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
  }
  return await crypto.subtle.sign('HMAC', cryptoKey, new TextEncoder().encode(data));
}

function encodeRfc3986(str: string): string {
  return encodeURIComponent(str).replace(/[!'()*]/g, c => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function encodePath(path: string): string {
  return path.split('/').map(encodeRfc3986).join('/');
}

export class SigV4SnapshotAdapter implements IRemoteSnapshotAdapter {
  private readonly bucket: string;
  private readonly key: string;
  private readonly region: string;
  private readonly endpoint?: string;
  private readonly accessKeyId: string;
  private readonly secretAccessKey: string;
  private readonly sessionToken?: string;
  private readonly forcePathStyle: boolean;
  private readonly fetchImpl: typeof globalThis.fetch;

  constructor(options: SigV4SnapshotAdapterOptions) {
    this.bucket = options.bucket;
    this.key = options.key.replace(/^\/+/, '');
    this.region = options.region ?? (options.endpoint?.includes('r2.cloudflarestorage.com') ? 'auto' : 'us-east-1');
    this.endpoint = options.endpoint;

    const accessKey = options.accessKeyId ?? (typeof process !== 'undefined' ? process.env?.AWS_ACCESS_KEY_ID : undefined);
    const secretKey = options.secretAccessKey ?? (typeof process !== 'undefined' ? process.env?.AWS_SECRET_ACCESS_KEY : undefined);
    const token = options.sessionToken ?? (typeof process !== 'undefined' ? process.env?.AWS_SESSION_TOKEN : undefined);

    if (!accessKey || !secretKey) {
      throw new Error(
        'SigV4SnapshotAdapter: AWS credentials missing. Provide accessKeyId and secretAccessKey or set AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY.',
      );
    }

    this.accessKeyId = accessKey;
    this.secretAccessKey = secretKey;
    this.sessionToken = token;
    this.forcePathStyle = options.forcePathStyle ?? Boolean(options.endpoint);
    this.fetchImpl = options.fetch ?? globalThis.fetch;
  }

  private _resolveTarget(): { url: URL; canonicalUri: string; host: string } {
    const encodedKey = encodePath(this.key);

    if (this.endpoint) {
      const base = new URL(this.endpoint);
      const basePath = base.pathname.replace(/\/+$/, '');
      if (this.forcePathStyle) {
        const canonicalUri = `${basePath}/${encodeRfc3986(this.bucket)}/${encodedKey}`;
        const url = new URL(canonicalUri, base.origin);
        return { url, canonicalUri, host: url.host };
      } else {
        const host = `${this.bucket}.${base.host}`;
        const canonicalUri = `${basePath}/${encodedKey}`;
        const url = new URL(canonicalUri, `${base.protocol}//${host}`);
        return { url, canonicalUri, host };
      }
    }

    if (this.forcePathStyle) {
      const host = this.region === 'us-east-1' ? 's3.amazonaws.com' : `s3.${this.region}.amazonaws.com`;
      const canonicalUri = `/${encodeRfc3986(this.bucket)}/${encodedKey}`;
      const url = new URL(`https://${host}${canonicalUri}`);
      return { url, canonicalUri, host };
    }

    const host = this.region === 'us-east-1'
      ? `${this.bucket}.s3.amazonaws.com`
      : `${this.bucket}.s3.${this.region}.amazonaws.com`;
    const canonicalUri = `/${encodedKey}`;
    const url = new URL(`https://${host}${canonicalUri}`);
    return { url, canonicalUri, host };
  }

  private async _buildHeaders(method: string, body?: Uint8Array): Promise<{ headers: Record<string, string>; url: URL }> {
    const { url, canonicalUri, host } = this._resolveTarget();
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const service = 's3';

    const payloadHash = body ? await sha256Hex(body) : EMPTY_STRING_SHA256;

    const headersToSign: Record<string, string> = {
      host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
    };

    if (this.sessionToken) {
      headersToSign['x-amz-security-token'] = this.sessionToken;
    }

    if (body) {
      headersToSign['content-type'] = 'application/octet-stream';
    }

    const sortedHeaderKeys = Object.keys(headersToSign).sort();
    const canonicalHeaders = sortedHeaderKeys.map(k => `${k}:${headersToSign[k]}\n`).join('');
    const signedHeaders = sortedHeaderKeys.join(';');

    const canonicalRequest = [
      method,
      canonicalUri,
      '', // canonical query string
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const credentialScope = `${dateStamp}/${this.region}/${service}/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      credentialScope,
      await sha256Hex(canonicalRequest),
    ].join('\n');

    // Chained HMAC key derivation
    const kDate = await hmac(new TextEncoder().encode(`AWS4${this.secretAccessKey}`), dateStamp);
    const kRegion = await hmac(kDate, this.region);
    const kService = await hmac(kRegion, service);
    const kSigning = await hmac(kService, 'aws4_request');

    const signatureBytes = await hmac(kSigning, stringToSign);
    const signature = Array.from(new Uint8Array(signatureBytes)).map(b => b.toString(16).padStart(2, '0')).join('');

    const authHeader = `AWS4-HMAC-SHA256 Credential=${this.accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

    const finalHeaders: Record<string, string> = {
      ...headersToSign,
      Authorization: authHeader,
    };

    return { headers: finalHeaders, url };
  }

  async get(): Promise<Buffer | null> {
    const { headers, url } = await this._buildHeaders('GET');

    const res = await this.fetchImpl(url.toString(), {
      method: 'GET',
      headers,
    });

    if (res.status === 404) return null;
    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`SigV4SnapshotAdapter: GET ${url.pathname} failed with status ${res.status} ${res.statusText}: ${errBody}`);
    }

    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
  }

  async put(data: Buffer): Promise<void> {
    const { headers, url } = await this._buildHeaders('PUT', data);

    const res = await this.fetchImpl(url.toString(), {
      method: 'PUT',
      headers,
      body: data as unknown as BodyInit,
    });

    if (!res.ok) {
      const errBody = await res.text().catch(() => '');
      throw new Error(`SigV4SnapshotAdapter: PUT ${url.pathname} failed with status ${res.status} ${res.statusText}: ${errBody}`);
    }
  }
}

/**
 * Creates a zero-dependency AWS SigV4 snapshot adapter for AWS S3, Cloudflare R2, MinIO, or custom gateways.
 */
export function createSigV4SnapshotAdapter(options: SigV4SnapshotAdapterOptions): IRemoteSnapshotAdapter {
  return new SigV4SnapshotAdapter(options);
}

/**
 * Ergonomic alias for AWS S3 snapshot storage.
 */
export function createS3SnapshotAdapter(options: SigV4SnapshotAdapterOptions): IRemoteSnapshotAdapter {
  return createSigV4SnapshotAdapter(options);
}

/**
 * Ergonomic alias for Cloudflare R2 snapshot storage using SigV4 REST credentials.
 */
export function createR2SnapshotAdapter(
  options: Omit<SigV4SnapshotAdapterOptions, 'region'> & { region?: string; accountId?: string },
): IRemoteSnapshotAdapter {
  const endpoint = options.endpoint ?? (options.accountId ? `https://${options.accountId}.r2.cloudflarestorage.com` : undefined);
  return createSigV4SnapshotAdapter({
    ...options,
    endpoint,
    region: options.region ?? 'auto',
  });
}
