# Contributing to TriCache

Thank you for your interest in contributing to **TriCache**! 🎉 We welcome contributions of all kinds: bug fixes, performance optimizations, new framework adapters, documentation improvements, and architectural ideas.

---

## Code of Conduct

This project and everyone participating in it is governed by the [TriCache Code of Conduct](CODE_OF_CONDUCT.md). By participating, you are expected to uphold this code.

---

## Getting Started

### Prerequisites

- **Node.js**: `>= 22.13.0` (active LTS or current)
- **pnpm**: `>= 9.0.0` (version pinned with `packageManager: pnpm@11.22.0`)
- **Git**
- Optional: **Redis / Valkey** running locally or in Docker on port `6379` (unit tests run standalone mock/memory cache; live integration tests automatically connect if available).

### Fork & Clone

1. Fork the repository on GitHub: [https://github.com/Kareem411/TriCache](https://github.com/Kareem411/TriCache)
2. Clone your fork locally:
   ```bash
   git clone https://github.com/<your-username>/TriCache.git
   cd TriCache
   ```
3. Set the upstream remote:
   ```bash
   git remote add upstream https://github.com/Kareem411/TriCache.git
   ```
4. Install dependencies:
   ```bash
   pnpm install
   ```

---

## Development Workflow

### Useful Commands

| Command | Description |
|---|---|
| `pnpm test` | Run the full Vitest test suite once |
| `pnpm test:watch` | Run Vitest in interactive watch mode |
| `pnpm lint` | Run Oxlint fast static analysis |
| `pnpm typecheck` | TypeScript type-check source files |
| `pnpm typecheck:all` | TypeScript type-check source AND test files |
| `pnpm build` | Build ESM, CJS, and type declarations with `tsup` |
| `pnpm bench` | Run microbenchmarks (L1/L2/SWR throughput & latency) |

### Running Tests

All tests must pass before opening a pull request:
```bash
pnpm test
```

To run a specific test file:
```bash
pnpm vitest run tests/l1-memory.test.ts
```

### Running Benchmarks

If your changes touch a performance-critical path (L1 cache get/set, eviction policies, Count-Min Sketch, Bloom filter, serialization, or disk tier):
```bash
pnpm bench
```
Please include before and after benchmark numbers in your pull request description.

---

## Codebase Architecture

```text
tricache/
├── src/
│   ├── index.ts                # Main library export
│   ├── cache-service.ts        # CacheService multi-tier orchestrator
│   ├── smart-memory-cache.ts   # L1 in-memory engine (LFU/LRU/CMS)
│   ├── disk-tier.ts            # L1.5 NVMe disk spill layer
│   ├── encryption.ts           # AES-256-GCM, AES-128, XOR encryption
│   ├── serialize-worker.ts     # Off-thread serialization worker
│   ├── types.ts                # TypeScript interfaces and options
│   ├── wasm/                   # Inlined WASM Bloom filter
│   ├── next/                   # Next.js App Router & API cache adapter
│   ├── nestjs/                 # NestJS CacheModule & interceptors
│   ├── prisma/                 # Prisma client caching extension
│   ├── drizzle/                # Drizzle ORM query caching helper
│   └── http/                   # HTTP reverse-proxy / fetch caching
├── tests/                      # Vitest unit & integration test suites
├── bench/                      # Microbenchmark suites
├── bin/                        # CLI binaries
└── .github/                    # CI/CD workflows and issue/PR templates
```

---

## Contribution Guidelines

### 1. Branch Naming
Create a topic branch from `main`:
- `feat/add-fastify-adapter`
- `fix/disk-spill-leak`
- `perf/optimize-hasher`
- `docs/clarify-swr-config`

### 2. Commit Message Convention
We follow the [Conventional Commits](https://www.conventionalcommits.org/) specification:
- `feat:` A new feature or adapter
- `fix:` A bug fix
- `perf:` Performance improvements
- `docs:` Documentation only changes
- `test:` Adding or refactoring tests
- `refactor:` Code change that neither fixes a bug nor adds a feature
- `chore:` Tooling, dependency, or workflow changes

### 3. Dependencies
TriCache maintains zero heavy runtime dependencies (only `ioredis` and `msgpackr`). Avoid adding new external runtime dependencies without prior discussion via an issue.

### 4. Verification Checklist Before Submitting a PR
- [ ] Code formatted and clean
- [ ] Oxlint passes (`pnpm lint`)
- [ ] Type check passes (`pnpm typecheck:all`)
- [ ] All tests pass (`pnpm test`)
- [ ] New unit tests added covering your changes
- [ ] Documentation updated if public API changes

---

## Submitting a Pull Request

1. Push your branch to your fork:
   ```bash
   git push origin feat/your-feature-name
   ```
2. Open a Pull Request on GitHub against `main`.
3. Fill out the PR template with a summary of the changes and any issue numbers it resolves.
4. The CI pipeline will automatically run linting, type-checking, and cross-platform tests (Ubuntu, macOS, Windows on Node.js 22 & 24).
5. Maintainers will review your PR and provide feedback.

---

## Reporting Issues & Security

- **Bug Reports & Feature Requests**: Use the [GitHub Issue Templates](https://github.com/Kareem411/TriCache/issues/new/choose).
- **Security Vulnerabilities**: Please review our [Security Policy](SECURITY.md) and report vulnerabilities confidentially via GitHub Security Advisories.
