# Security Policy

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security vulnerabilities.**

Report security issues privately via [GitHub Security Advisories](https://github.com/Kareem411/TriCache/security/advisories/new). This lets us triage and patch before public disclosure.

Include as much detail as possible:
- A description of the vulnerability and its potential impact
- Steps to reproduce or a minimal proof-of-concept
- Any suggested mitigations

We aim to respond within **72 hours** and to release a patch within **7 days** for confirmed critical issues.

## Encryption

tricache supports AES-256-GCM (default), AES-128-GCM, AES-128-CTR, and XOR (non-cryptographic, dev-only) for at-rest encryption of L2 (Redis) values, disk spill files, and cold-start snapshots.

**Key generation:**
```bash
# AES-256-GCM (recommended, 32 bytes)
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"

# AES-128-GCM / AES-128-CTR (16 bytes)
node -e "console.log(require('crypto').randomBytes(16).toString('base64'))"
```

Store the key in `CACHE_ENCRYPTION_KEY` environment variable — never hardcode it in source.

**Invalid key handling (fail-open vs fail-closed):** By default, a *malformed* key (wrong length for the selected mode, or empty) logs an error and continues **without** at-rest encryption — plaintext at rest, clearly flagged in the log. Deployments where that downgrade is unacceptable (PCI/HIPAA-style bars) can set:

```ts
new CacheService({ encryptionKey, strictKeyValidation: true })
```

With `strictKeyValidation: true`, an invalid or empty key throws at construction instead of silently disabling encryption. A key that is simply *not configured* never throws in either mode — tricache runs unencrypted by design when no key is supplied.

**Key rotation:** Plaintext values are read transparently during rotation. Deploy the new key, then run a cache warm-up pass to re-encrypt. There is no dual-key overlap window needed.
