# Testing Strategy

The gateway test suite is designed to exercise bank-facing behavior without requiring a live Algorand node for normal CI.

## Default Suite

Run:

```bash
npm test
npm run check
```

Coverage areas:

- API key authentication.
- IP allowlisting and trusted proxy handling.
- CORS preflight behavior.
- Token-bucket rate limiting.
- Request body size limits.
- Route, method, query, address, asset ID, round, and transaction ID validation.
- MainNet genesis verification.
- Curated algod/indexer route forwarding.
- Signed transaction submission and idempotency replay/conflict behavior.
- Transaction simulation forwarding.
- Upstream token header forwarding.
- Retry behavior for safe upstream reads.
- No automatic retry for mutating transaction submissions.
- Upstream timeout handling.
- MainNet verification cache behavior.
- TLS/mTLS configuration guardrails.
- OpenAPI route/security drift checks.
- Deterministic audit hashing primitives.

## Optional Real MainNet Smoke Test

The live-network smoke test is skipped by default. Enable it only in an environment with approved Algorand MainNet upstream credentials:

```bash
set ALGORAND_GATEWAY_RUN_MAINNET_SMOKE=true
set ALGOD_URL=https://<approved-mainnet-algod>
set ALGOD_TOKEN=<token-if-required>
npm test
```

The smoke test verifies the configured algod endpoint reports Algorand MainNet genesis identifiers and returns node status. It does not submit transactions.

## Optional Container Deployment Test

The Docker deployment test is skipped by default and requires a running Docker daemon:

```bash
set ALGORAND_GATEWAY_RUN_CONTAINER_TEST=true
node --test --test-name-pattern "container image" test/certification-controls.test.js
```

It builds the Docker image, runs the gateway container with local-only placeholder upstream configuration, calls `/health`, and removes the container. If Docker Desktop or the Docker daemon is unavailable, the test reports an environment skip.

## Remaining Certification Work

These tests are a strong service baseline, but formal bank certification should still add environment-specific checks:

- mTLS handshake tests with the bank certificate chain.
- Load, soak, and failover tests using production-like traffic.
- SIEM/log ingestion validation.
- Disaster recovery and key-rotation drills.
- End-to-end settlement reconciliation tests using real pacs.008 and Nostro debit records.
