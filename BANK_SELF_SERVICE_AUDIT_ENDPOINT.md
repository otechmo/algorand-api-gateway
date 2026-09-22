# Bank Self-Service Audit Evidence Endpoint

This endpoint is for the bank to call directly and save the response as its own audit evidence file.

## Clean Bank URL

```text
https://algorand-api-gateway.vercel.app/v2/<BANK_API_KEY>/audit/evidence
```

If `AUDIT_RECEIVER_WALLET` is configured on the gateway, the bank does not need to provide a wallet query parameter.

For a specific wallet, the bank can call:

```text
https://algorand-api-gateway.vercel.app/v2/<BANK_API_KEY>/audit/evidence?wallet=<ALGORAND_ADDRESS>&limit=10
```

## What The Bank Receives

The response is JSON and includes a `Content-Disposition` header with a suggested filename:

```text
algorand-mainnet-audit-evidence-YYYY-MM-DD.json
```

The JSON includes:

- audit ID, generated timestamp, request ID, and evidence hash
- gateway endpoint metadata without returning the raw API key
- Algorand MainNet connection status
- MainNet genesis ID and genesis hash
- latest observed Algorand round
- suggested fee and minimum fee
- algod and indexer readiness checks
- receiver wallet account evidence
- receiver wallet transaction history from indexer
- sample transaction ID and confirmed round
- bank-side settlement records still required, such as UETR, pacs.008, Nostro debit, HMAC, and body hash
- a human-readable text report field the bank can copy into its internal report template

## Example Bank Flow

1. Bank calls the URL.
2. Bank saves the JSON response as the evidence file.
3. Bank adds its own settlement data:
   - UETR
   - pacs.008.001.08 file
   - Nostro debit record
   - payment amount and reference
   - HMAC and body hash
4. Bank generates its internal PDF or compliance report from the JSON.

## Important Security Note

The URL-key style is simple and Alchemy-like, but headers are still more secure for production because URLs can appear in infrastructure logs.

For final bank production:

- rotate the current API key
- send the fresh key through a secure bank-approved channel
- store only `BANK_API_KEY_HASHES` on the gateway
- configure `AUDIT_RECEIVER_WALLET`
- configure bank IP allowlisting when the bank provides egress ranges
