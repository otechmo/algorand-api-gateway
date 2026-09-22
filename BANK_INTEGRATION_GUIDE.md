# Bank Integration Guide: Algorand MainNet Support

## Executive Summary

This service provides the bank with a secure, private HTTPS API for Algorand MainNet access. It is the Algorand equivalent of integrating with an Ethereum RPC provider endpoint such as Alchemy, but the bank does not connect directly to a public Algorand provider.

The bank integrates only with our endpoint:

```text
https://<your-bank-facing-domain>
```

Behind that endpoint, we operate the gateway and connect it to approved Algorand MainNet `algod` and `indexer` infrastructure.

## Support Position

We support Algorand MainNet connectivity for bank backend systems in a non-custodial model.

Supported:

- Algorand MainNet network status and transaction parameters.
- ALGO account balance and account state lookup.
- Algorand Standard Asset, or ASA, lookup and account asset holdings.
- Historical transaction search through indexer-backed routes.
- Pending and confirmed transaction status lookup.
- Submission of already-signed ALGO payment and ASA transfer transactions or transaction groups into the configured receiver wallet.
- Transaction simulation for pre-submit checks.
- Bank-grade transport and access controls.

Not supported by this gateway:

- Custody of bank or customer private keys.
- Transaction signing.
- KMD exposure.
- Direct bank access to public Algorand node providers.
- Arbitrary unaudited proxying of every upstream node API.

## Target Architecture

```text
Bank backend
  -> HTTPS / optional mTLS
  -> API key authentication
  -> optional IP allowlist
  -> Algorand API Gateway
  -> private or approved Algorand MainNet algod/indexer
```

The gateway exposes a curated `/v1` API. This keeps the bank contract stable even if upstream Algorand node infrastructure changes.

## MainNet Assurance

Before serving readiness checks and before forwarding transaction submissions, the gateway validates that the configured `algod` endpoint is Algorand MainNet.

Expected MainNet identifiers:

```text
genesis-id: mainnet-v1.0
genesis-hash: wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
```

If the configured upstream is not MainNet, readiness fails and transaction submission is blocked.

## Bank Authentication And Transport

Recommended production controls:

- TLS 1.2+ or TLS 1.3 only.
- Mutual TLS where the bank can provide client certificates.
- `Authorization: Bearer <bank-api-key>` or `X-API-Key: <bank-api-key>`.
- Store API keys as SHA-256 hashes in gateway configuration.
- Bank egress IP allowlisting.
- JSON audit logs exported to SIEM.
- Alerts on failed authentication, forbidden IPs, rate limiting, upstream errors, and MainNet mismatch.

## API Summary

| Capability | Method | Path |
| --- | --- | --- |
| Liveness | `GET` | `/health` |
| Upstream readiness | `GET` | `/ready` |
| MainNet node status | `GET` | `/v1/network/status` |
| Transaction parameters | `GET` | `/v1/network/params` |
| Account state | `GET` | `/v1/accounts/{address}` |
| Account asset holding | `GET` | `/v1/accounts/{address}/assets/{assetId}` |
| Account transaction history | `GET` | `/v1/accounts/{address}/transactions` |
| Asset information | `GET` | `/v1/assets/{assetId}` |
| Asset transaction history | `GET` | `/v1/assets/{assetId}/transactions` |
| Block lookup | `GET` | `/v1/blocks/{round}` |
| Confirmed transaction lookup | `GET` | `/v1/transactions/{txId}` |
| Pending transaction lookup | `GET` | `/v1/transactions/pending/{txId}` |
| Submit signed transaction | `POST` | `/v1/transactions` |
| Simulate transaction | `POST` | `/v1/transactions/simulate` |

The full machine-readable contract is in `openapi.yaml`.

## Institutional Audit Pack Support

The bank can receive an Algorand audit pack in the same evidence style as the existing Alchemy/Ethereum audit report. The Algorand report should use gateway data for MainNet connection status, transaction submission, transaction confirmation, account/asset evidence, request IDs, and latency. The bank settlement layer should add UETR, pacs.008, HMAC signatures, Nostro debits, and final dataset hashes.

Supporting files:

- [`AUDIT_REPORT_MODEL.md`](./AUDIT_REPORT_MODEL.md) maps the Alchemy audit sections to Algorand MainNet equivalents.
- [`examples/algorand-full-audit-report.template.md`](./examples/algorand-full-audit-report.template.md) is a bank-facing report template.
- [`examples/audit-report.schema.json`](./examples/audit-report.schema.json) defines the structured data needed to populate the report.

## Ethereum RPC To Algorand Gateway Mapping

| Ethereum-style need | Algorand gateway equivalent |
| --- | --- |
| Chain status / latest block | `GET /v1/network/status` |
| Gas parameters | `GET /v1/network/params` for suggested fee and valid rounds |
| Native balance | `GET /v1/accounts/{address}` |
| ERC-20 metadata / balance | `GET /v1/assets/{assetId}` and `/v1/accounts/{address}/assets/{assetId}` |
| Get transaction receipt | `GET /v1/transactions/{txId}` or `/v1/transactions/pending/{txId}` |
| Send raw transaction | `POST /v1/transactions` |
| Historical account activity | `GET /v1/accounts/{address}/transactions` |

Algorand is not JSON-RPC in the same way as Ethereum. Bank systems should integrate with these REST endpoints rather than sending Ethereum-style RPC method names.

## Transaction Submission Model

The bank remains responsible for transaction construction, approval, and signing.

The gateway accepts:

- raw signed transaction bytes using `Content-Type: application/x-binary`; or
- JSON with a base64 signed transaction payload.

Example:

```bash
curl -X POST "https://<your-bank-facing-domain>/v1/transactions" \
  -H "Authorization: Bearer $BANK_API_KEY" \
  -H "Content-Type: application/x-binary" \
  -H "Idempotency-Key: payment-2026-09-20-0001" \
  --data-binary @signed.txn
```

Use `Idempotency-Key` for bank-side retries. The gateway does not automatically retry transaction submissions because a network timeout after forwarding a transaction can produce an ambiguous client result.

For production receiver protection, transaction submission is configured with:

```text
SUBMISSION_RECEIVER_WALLET=XPPH747EGEDWQG45MP6VHKXKWGY5LZ6MTCXKR57RXO7QUI6XOBZFOKZPXU
```

When this policy is active, every submitted signed transaction must satisfy all of these checks before the gateway forwards it to algod:

- transaction type is ALGO payment, `pay`, or ASA transfer, `axfer`
- ALGO payment receiver field, `rcv`, is `XPPH747EGEDWQG45MP6VHKXKWGY5LZ6MTCXKR57RXO7QUI6XOBZFOKZPXU`
- ASA transfer receiver field, `arcv`, is `XPPH747EGEDWQG45MP6VHKXKWGY5LZ6MTCXKR57RXO7QUI6XOBZFOKZPXU`
- ALGO amount, `amt`, or ASA amount, `aamt`, is greater than zero
- optional `SUBMISSION_ALLOWED_ASSET_IDS` allowlist matches the transaction `xaid`, if configured
- no ASA clawback field, `asnd`
- no ALGO close-out field, `close`
- no ASA close-out field, `aclose`
- no rekey field

The gateway rejects application calls, asset configuration/freeze transactions, wrong-receiver ALGO or ASA transfers, zero-amount payments/transfers, clawbacks, close-outs, and rekeys with `403 transaction_policy_violation`. Rejected transactions are not broadcast to Algorand.

## Response Contract

Success:

```json
{
  "data": {},
  "meta": {
    "requestId": "uuid",
    "network": "algorand-mainnet",
    "service": "algod"
  }
}
```

Error:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid Algorand address.",
    "requestId": "uuid"
  }
}
```

Every response includes `X-Request-ID`. The bank may send `X-Request-ID` for correlation.

## Onboarding Requirements From Bank

The bank should provide:

- Production and UAT egress IP ranges.
- mTLS client certificate details, if mTLS is required.
- Expected request volume and burst profile.
- Operational contacts and escalation windows.
- Required environments: UAT, pre-production, production.
- Confirmation whether their system submits raw signed bytes or base64 JSON.

We provide:

- Bank-facing base URL per environment.
- API key or key rotation process.
- OpenAPI specification.
- Rate limits and maximum request body size.
- UAT validation plan.
- Support and incident escalation process.

## UAT Validation Plan

1. Bank calls `GET /health`.
2. Bank calls `GET /ready`.
3. Bank calls `GET /v1/network/params` and confirms `mainnet-v1.0`.
4. Bank looks up a known Algorand address through `GET /v1/accounts/{address}`.
5. Bank simulates a transaction through `POST /v1/transactions/simulate`.
6. Bank submits an already-signed low-value transaction through `POST /v1/transactions`.
7. Bank confirms the transaction through pending and confirmed transaction lookup routes.
8. Both teams reconcile audit logs using `X-Request-ID`.

## Operational Controls

Recommended production configuration:

```text
ENFORCE_MAINNET=true
ALLOW_UNAUTHENTICATED=false
READINESS_PUBLIC=false
RATE_LIMIT_ENABLED=true
REQUIRE_INDEXER=true
BANK_API_KEY_HASHES=sha256:<bank-key-hash>
SUBMISSION_RECEIVER_WALLET=XPPH747EGEDWQG45MP6VHKXKWGY5LZ6MTCXKR57RXO7QUI6XOBZFOKZPXU
IP_ALLOWLIST=<bank-egress-cidrs>
```

For mTLS at the Node process:

```text
TLS_CERT_FILE=/etc/tls/server.crt
TLS_KEY_FILE=/etc/tls/server.key
MTLS_REQUIRED=true
MTLS_CA_FILE=/etc/tls/bank-ca.crt
```

Alternatively, TLS and mTLS can terminate at a private load balancer or reverse proxy, with the gateway running behind it on a private network.

## Bank-Facing Statement

Our Algorand MainNet support provides the bank with a controlled API endpoint for reading Algorand network/account/asset data and submitting bank-signed ALGO payments and ASA transfers into the configured receiver wallet. The solution is non-custodial, does not expose private keys or signing services, and prevents direct bank dependency on public Algorand node providers. Access is protected through HTTPS, optional mTLS, API key authentication, IP allowlisting, rate limits, structured audit logging, receiver-wallet transaction policy enforcement, and MainNet verification.
