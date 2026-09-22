# Algorand API Gateway

Production-oriented bank-facing API gateway for Algorand MainNet. The intended topology is:

`Bank backend -> HTTPS/mTLS/API key/IP allowlist -> this gateway -> your private algod/indexer MainNet nodes`

The gateway exposes a curated `/v1` API instead of a blind public proxy. It never stores private keys, never signs transactions, and does not expose KMD.

## Why This Shape

The official Algorand APIs are split between `algod` for node/network operations and transaction submission, and `indexer` for historical search. This service fronts those APIs with bank integration controls: API key authentication, optional IP allowlisting, optional native TLS/mTLS, request size limits, rate limiting, idempotent transaction submission, structured audit logs, and a MainNet genesis check.

Current reference docs used for the implementation:

- Algorand REST API overview: https://dev.algorand.co/reference/rest-api/overview/
- Algod pending transaction API: https://dev.algorand.co/reference/rest-api/algod/operations/pendingtransactioninformation/
- Indexer overview: https://dev.algorand.co/reference/rest-api/indexer/
- Official network identifiers: https://dev.algorand.co/concepts/protocol/networks/

## API Surface

For a bank/shareable overview of the support model, onboarding flow, Ethereum-to-Algorand mapping, and institutional audit pack support, see [`BANK_INTEGRATION_GUIDE.md`](./BANK_INTEGRATION_GUIDE.md). For the audit report model specifically, see [`AUDIT_REPORT_MODEL.md`](./AUDIT_REPORT_MODEL.md).

All non-health routes require `Authorization: Bearer <bank-api-key>` or `X-API-Key: <bank-api-key>` unless `ALLOW_UNAUTHENTICATED=true`.

The gateway also supports an Alchemy-style key-in-path format for bank systems that prefer a single base URL:

```text
https://algorand-api-gateway.vercel.app/v2/<bank-api-key>/status
https://algorand-api-gateway.vercel.app/v2/<bank-api-key>/params
https://algorand-api-gateway.vercel.app/v2/<bank-api-key>/accounts/{address}/transactions?limit=1
```

`/v2/<bank-api-key>/status` maps to `/v1/network/status`. Any other path after the key maps to the curated `/v1` API, so `/v2/<bank-api-key>/accounts/{address}` maps to `/v1/accounts/{address}`. Headers are still preferred for production because URL paths can appear in platform access logs.

| Method | Path | Upstream |
| --- | --- | --- |
| `GET` | `/health` | local liveness only |
| `GET` | `/ready` | algod status, MainNet params, optional indexer health |
| `GET` | `/v1/network/status` | algod `/v2/status` |
| `GET` | `/v1/network/params` | algod `/v2/transactions/params` |
| `GET` | `/v1/accounts/{address}` | algod account information |
| `GET` | `/v1/accounts/{address}/assets/{assetId}` | algod account asset information |
| `GET` | `/v1/accounts/{address}/transactions` | indexer account transaction search |
| `GET` | `/v1/assets/{assetId}` | algod asset information |
| `GET` | `/v1/assets/{assetId}/transactions` | indexer asset transaction search |
| `GET` | `/v1/blocks/{round}` | algod block lookup, JSON only |
| `GET` | `/v1/transactions/{txId}` | indexer confirmed transaction lookup |
| `GET` | `/v1/transactions/pending/{txId}` | algod pending transaction lookup |
| `POST` | `/v1/transactions` | algod raw signed transaction submission |
| `POST` | `/v1/transactions/simulate` | algod simulation |

Success responses use:

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

Errors use:

```json
{
  "error": {
    "code": "validation_error",
    "message": "Invalid Algorand address.",
    "requestId": "uuid"
  }
}
```

## Transaction Submission

`POST /v1/transactions` accepts either raw bytes:

```bash
curl -X POST "$GATEWAY/v1/transactions" \
  -H "Authorization: Bearer $BANK_API_KEY" \
  -H "Content-Type: application/x-binary" \
  -H "Idempotency-Key: payment-2026-09-20-0001" \
  --data-binary @signed.txn
```

Or JSON with a base64 signed transaction or transaction group:

```json
{
  "signedTransaction": "gqNzaWfEQ...",
  "encoding": "base64"
}
```

The gateway checks that its configured algod node is MainNet before forwarding submissions. It does not retry transaction submission automatically because retrying a mutating submit across a timeout can create ambiguous client behavior. Use `Idempotency-Key` for client retries.

## Run Locally

```bash
cd projects/algorand-api-gateway
cp .env.example .env
```

Set environment variables from `.env.example`, then run:

```bash
npm start
```

This project intentionally has no runtime npm dependencies. It requires Node 20 or newer.

## Deploy To Vercel

This gateway includes a Vercel Function adapter in `api/gateway.js` and `vercel.json`. Vercel terminates HTTPS before requests reach the function, so keep `REQUIRE_TLS=false` and `MTLS_REQUIRED=false` on Vercel. If the bank requires mTLS, terminate mTLS at an enterprise edge, private proxy, or load balancer in front of this service.

Required Vercel environment variables:

- `ALGOD_URL`
- `BANK_API_KEY_HASHES`
- `INDEXER_URL` if `REQUIRE_INDEXER=true`
- `TRUST_PROXY=true`
- `ENFORCE_MAINNET=true`
- any upstream token variables required by your approved algod/indexer endpoints

Deploy with:

```bash
vercel deploy --prod --yes --scope otechmo20-2970s-projects
```

## Production Checklist

- Point `ALGOD_URL` and `INDEXER_URL` at your own MainNet infrastructure or a private approved upstream.
- Keep `ENFORCE_MAINNET=true`.
- Set `BANK_API_KEY_HASHES` instead of raw keys.
- Terminate HTTPS either in this process with `TLS_CERT_FILE` and `TLS_KEY_FILE`, or at a private load balancer/reverse proxy.
- Enable mTLS for bank-to-gateway transport when available.
- Set `IP_ALLOWLIST` to bank egress ranges and set `TRUST_PROXY=true` only behind trusted infrastructure.
- Keep `/health` for liveness and keep `/ready` private unless your orchestrator requires public readiness.
- Export JSON logs to your SIEM and alert on 401, 403, 429, 5xx, `network_mismatch`, and repeated submission failures.
- Use multiple gateway replicas. Idempotency cache is in-memory by default; use sticky routing or add a shared cache before multi-region active/active client retries.

## Tests

```bash
npm test
npm run check
```

See [`TESTING.md`](./TESTING.md) for the expanded bank-grade test coverage and the opt-in real MainNet smoke test.
