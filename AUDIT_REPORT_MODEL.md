# Algorand Institutional Audit Report Model

This model is based on the structure of `projects/ALCHEMY_FULL_AUDIT_2026-09-17.pdf`. The source PDF is an Ethereum/Alchemy institutional settlement audit pack. The Algorand equivalent should preserve the same bank-facing evidence style while replacing Ethereum-specific concepts with Algorand MainNet concepts.

Important: this document is a support model and template. It must be populated from real production logs, indexer confirmations, pacs.008 files, settlement records, and bank treasury/Nostro records. Do not generate final audit reports with placeholder or simulated values.

## What The Alchemy Audit Contains

The PDF follows this structure:

| PDF section | Purpose |
| --- | --- |
| Header | Audit ID, master hash, generated timestamp, auditor, classification |
| Alchemy RPC connection status | Ethereum MainNet connectivity, current block, gas, latency, endpoint, error count |
| Master wallets on-chain | Operational wallets and token balances |
| Settlement volume summary | Count, total volume, settlement method, ISO 20022 format, webhook format |
| Complete settlement ledger | One evidence record per settlement with UETR, amount, token, block, transaction hash, calldata, status, HMAC/body hashes, response time |
| pacs.008 JSON files | Generated ISO 20022 files and file hashes |
| Nostro debit records | Internal bank debit records reconciled against settlements |
| SWIFT / institutional details | BIC, license, LEI, address, operator, platform, gateway |
| Cryptographic audit verification | Dataset hashes and compliance checks |
| Certification footer | Audit hash, date, electronically generated verification statement |

## Algorand Equivalent

| Alchemy / Ethereum field | Algorand MainNet equivalent |
| --- | --- |
| `Alchemy RPC Connection Status` | `Algorand Gateway Connection Status` |
| `Ethereum Mainnet (ID: 1)` | `Algorand MainNet genesis-id: mainnet-v1.0` |
| Current block number | Current Algorand round |
| Gas price | Suggested fee / min fee in microAlgos |
| Alchemy RPC endpoint | Bank-facing gateway URL plus masked upstream algod/indexer IDs |
| ERC-20 token contract | ASA asset ID and asset metadata |
| ERC-20 calldata | Signed Algorand transaction bytes hash, decoded payment/asset-transfer fields, or note hash |
| Ethereum TX hash | Algorand transaction ID |
| Chain nonce | Algorand first-valid, last-valid, lease, and group ID where applicable |
| Webhook `ADDRESS_ACTIVITY` | Indexer-backed account or asset transaction evidence |
| `eth_call` preflight | `/v1/transactions/simulate` result |
| Gas used / gas price | Fee in microAlgos |
| Block number | Confirmed round |
| `eth_sendRawTransaction` | `POST /v1/transactions` to algod `/v2/transactions` |

## Gateway Evidence Already Supported

The gateway can provide the following audit inputs:

- MainNet readiness and genesis verification through `/ready` and `/v1/network/params`.
- Current node status through `/v1/network/status`.
- Current account and ASA holdings through `/v1/accounts/{address}` and `/v1/accounts/{address}/assets/{assetId}`.
- Confirmed transaction lookup through `/v1/transactions/{txId}`.
- Pending transaction lookup through `/v1/transactions/pending/{txId}`.
- Account and asset transaction history through indexer-backed transaction routes.
- Transaction simulation through `/v1/transactions/simulate`.
- Signed transaction submission through `POST /v1/transactions`.
- Request correlation using `X-Request-ID`.
- Structured audit logs containing request ID, method, path, status, duration, principal, and IP.
- Idempotent submission replay protection through `Idempotency-Key`.

## Evidence Required From The Settlement System

These records are outside the gateway and must be supplied by the bank settlement/orchestration layer:

- Payment reference, UETR, debtor/creditor account names, source BIC, and settlement amount.
- ISO 20022 `pacs.008.001.08` JSON/XML generation.
- HMAC-SHA256 signature over each settlement payload.
- Body hash and byte count for every outbound settlement instruction.
- Nostro debit record and debit hash.
- Reconciliation status between settlement instruction, transaction ID, confirmed round, and Nostro debit.
- Final dataset hashes and master audit hash.
- Report generation timestamp, auditor identity, institution/license/LEI details, and operator metadata.

## Recommended Algorand Audit Sections

### Header

```text
FULL AUDIT REPORT - ALGORAND MAINNET INSTITUTIONAL SETTLEMENT SYSTEM
<platform name> - <gateway operator> - Algorand MainNet
Issuing Bank: <bank legal name> - SWIFT: <BIC> - License: <license>

AUDIT ID:          AUD-YYYYMMDD-XXXXXXXX
AUDIT MASTER HASH: <sha256 over canonical audit dataset>
GENERATED:         <ISO-8601 timestamp>
AUDITOR:           AUTOMATED CRYPTOGRAPHIC SYSTEM AUDIT
CLASSIFICATION:    CONFIDENTIAL - INSTITUTIONAL USE ONLY
```

### 1. Algorand Gateway Connection Status

```text
Status:              CONNECTED
Network:             Algorand MainNet
Genesis ID:          mainnet-v1.0
Genesis Hash:        wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=
Current Round:       <last-round>
Suggested Fee:       <fee> microAlgos
Min Fee:             <min-fee> microAlgos
Latency:             <gateway-to-upstream latency ms>
Total Connections:   <count>
Errors:              <count>
Gateway Endpoint:    https://<bank-facing-domain>
Algod Upstream:      <masked upstream identifier>
Indexer Upstream:    <masked upstream identifier>
Last Connected:      <ISO-8601 timestamp>
```

### 2. Master Wallets On-Chain

```text
Treasury Wallet:      <Algorand address>
Operational Wallet:   <Algorand address>
Settlement Wallet:    <Algorand address>
ASA Asset:            <asset name / unit name>
ASA Asset ID:         <asset id>
ALGO Balance:         <microAlgos / ALGO>
ASA Balance:          <amount in asset units>
Opt-In Status:        VERIFIED
```

### 3. Settlement Volume Summary

```text
Total Settlements:    <count>
Total Volume:         <asset unit> <amount>
Settlement Method:    CLRG - ALGORAND_MAINNET_GATEWAY
ISO 20022 Format:     pacs.008.001.08
Evidence Format:      INDEXER_ACCOUNT_ACTIVITY - ALGORAND_MAINNET
pacs.008 Files:       <count>
Nostro Debits:        <count>
Source Institution:   <bank legal name> (<BIC>)
Destination Wallet:   <Algorand address>
```

### 4. Complete Settlement Ledger

Each settlement should include:

```text
SETTLEMENT #<n> OF <total>
Reference:            <bank reference>
UETR:                 <UETR UUID>
Amount:               <amount> <asset unit>
Source Account:       <source account name>
Source BIC:           <BIC>
Destination Wallet:   <Algorand address>
Asset:                <ALGO or ASA name>
Asset ID:             <ASA ID or 0 for ALGO>
Confirmed Round:      <round>
Algorand TX ID:       <transaction id>
Group ID:             <group id, if grouped>
Sender:               <Algorand sender address>
Receiver:             <Algorand receiver address>
Fee:                  <microAlgos>
First Valid:          <round>
Last Valid:           <round>
Note Hash:            <sha256 of note field, if used>
Simulation Status:    <PASS / FAIL / NOT_RUN>
Submission Status:    <SUBMITTED / PENDING / CONFIRMED / FAILED>
Indexer Evidence:     <confirmed transaction lookup request ID>
pacs.008 Format:      pacs.008.001.08
pacs.008 Method:      CLRG
pacs.008 Clearing:    ALGORAND_MAINNET_GATEWAY
HMAC-SHA256 Sig:      <hmac of settlement payload>
Body Hash:            <sha256 of canonical request body>
Body Bytes:           <byte count>
Signed At:            <ISO-8601 timestamp from signer/orchestrator>
Response Time:        <gateway response time ms>
Timestamp:            <gateway received timestamp>
Settlement Hash:      <sha256 canonical settlement record>
```

### 5. pacs.008 Files Generated

```text
Total: <count>
<reference>_pacs008.json
  FILE HASH: <sha256>
```

### 6. Nostro Debit Records

```text
[<n>] <reference>
  DEBIT:      <amount> <asset unit>
  Source:     <source account name>
  UETR:       <UETR UUID>
  DEBIT HASH: <sha256 canonical debit record>

TOTAL DEBITED: <amount>
```

### 7. SWIFT / Institutional Details

```text
Institution:          <bank legal name>
SWIFT/BIC:            <BIC>
License:              <license id>
LEI:                  <LEI>
Address:              <registered address>
Alliance:             <SWIFT alliance details>
Operator:             <operator DN or service account>
Platform:             <platform name>
Gateway:              Algorand API Gateway
Bank Endpoint:        https://<bank-facing-domain>
```

Do not print live API keys, upstream node tokens, or private provider credentials in the final audit report. The source PDF includes a public-looking provider key in the audit body; for Algorand reports, secrets should be replaced with stable key IDs or masked fingerprints.

### 8. Cryptographic Audit Verification

```text
AUDIT ID:              <audit id>
MASTER AUDIT HASH:     <sha256 over canonical audit dataset>

DATASET INTEGRITY HASHES:
Settlement Hash:       <sha256>
Nostro Debits Hash:    <sha256>
pacs.008 Queue Hash:   <sha256>
Gateway Logs Hash:     <sha256>
Connection Hash:       <sha256>

COMPLIANCE VERIFICATION:
[OK] ISO 20022 pacs.008.001.08 - Present
[OK] Algorand MainNet genesis-id/hash - Verified
[OK] Algorand signed transaction submission - Verified
[OK] Algorand indexer transaction evidence - Verified
[OK] SWIFT MT103 equivalent fields - Present
[OK] HMAC-SHA256 signatures - All settlements signed
[OK] ASA transfer fields - Decoded and reconciled
[OK] Nostro debit records - Matched to settlements
```

### Certification Footer

```text
VERIFIED AND CERTIFIED
<platform name> - <gateway operator>
<bank legal name> - <BIC> - <license> - <LEI>
AUDIT: <audit id>
HASH:  <master audit hash>
DATE:  <generated timestamp>
ELECTRONICALLY GENERATED - CRYPTOGRAPHICALLY VERIFIED - IMMUTABLE RECORD
```

## Report Generation Rules

- Canonicalize JSON before hashing. Use deterministic key ordering and UTF-8 bytes.
- Hash every settlement record independently.
- Hash every pacs.008 file independently.
- Hash every Nostro debit independently.
- Derive dataset hashes from ordered child hashes.
- Derive the master audit hash from the report header, dataset hashes, connection evidence, and certification metadata.
- Include `X-Request-ID` from gateway responses in the internal evidence dataset.
- Never include raw bank API keys, upstream node tokens, private keys, mnemonic material, or unmasked provider secrets.
- Treat pending and confirmed transaction evidence separately. A submitted transaction is not final settlement evidence until confirmed by indexer or algod block lookup.

## Implementation Note

The current gateway supports the blockchain evidence layer. A full report like the source PDF also needs a settlement records database and report generator. The clean production split is:

```text
Bank settlement system
  -> builds pacs.008 and signs settlement payloads
  -> submits signed Algorand transactions through the gateway
  -> stores UETR, request IDs, tx IDs, and Nostro debits
  -> confirms transactions through gateway/indexer
  -> generates the final audit PDF using this model
```
