import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig, sha256Buffer } from '../src/config.js'

const RECEIVER_WALLET = 'XPPH747EGEDWQG45MP6VHKXKWGY5LZ6MTCXKR57RXO7QUI6XOBZFOKZPXU'

test('requires bank API keys unless unauthenticated mode is explicitly enabled', () => {
  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
      }),
    /BANK_API_KEY_HASHES/,
  )
})

test('accepts hashed bank API keys', () => {
  const hash = sha256Buffer('bank-secret').toString('hex')
  const config = loadConfig({
    ALGOD_URL: 'http://algod.local',
    BANK_API_KEY_HASHES: `sha256:${hash}`,
  })

  assert.equal(config.auth.apiKeyHashes.length, 1)
})

test('requires TLS files when REQUIRE_TLS is enabled', () => {
  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
        BANK_API_KEYS: 'bank-secret',
        REQUIRE_TLS: 'true',
      }),
    /TLS_CERT_FILE/,
  )
})

test('requires server certificate, key, and CA when mTLS is required', () => {
  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
        BANK_API_KEYS: 'bank-secret',
        MTLS_REQUIRED: 'true',
        TLS_CERT_FILE: '/tmp/server.crt',
        TLS_KEY_FILE: '/tmp/server.key',
      }),
    /MTLS_CA_FILE/,
  )
})

test('requires an indexer URL when configured as mandatory', () => {
  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
        BANK_API_KEYS: 'bank-secret',
        REQUIRE_INDEXER: 'true',
      }),
    /INDEXER_URL/,
  )
})

test('parses receiver-wallet submission policy', () => {
  const config = loadConfig({
    ALGOD_URL: 'http://algod.local',
    BANK_API_KEYS: 'bank-secret',
    SUBMISSION_RECEIVER_WALLET: RECEIVER_WALLET,
    SUBMISSION_ALLOWED_ASSET_IDS: '31566704,123',
  })

  assert.equal(config.submission.receiverWallet, RECEIVER_WALLET)
  assert.deepEqual(config.submission.allowedAssetIds, ['31566704', '123'])
})

test('keeps backward compatibility with the old ASA receiver wallet env var', () => {
  const config = loadConfig({
    ALGOD_URL: 'http://algod.local',
    BANK_API_KEYS: 'bank-secret',
    SUBMISSION_ASA_RECEIVER_WALLET: RECEIVER_WALLET,
  })

  assert.equal(config.submission.receiverWallet, RECEIVER_WALLET)
})

test('rejects invalid receiver-wallet submission policy configuration', () => {
  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
        BANK_API_KEYS: 'bank-secret',
        SUBMISSION_RECEIVER_WALLET: 'not-an-address',
      }),
    /SUBMISSION_RECEIVER_WALLET/,
  )

  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
        BANK_API_KEYS: 'bank-secret',
        SUBMISSION_ALLOWED_ASSET_IDS: 'not-an-asset-id',
      }),
    /SUBMISSION_ALLOWED_ASSET_IDS/,
  )

  assert.throws(
    () =>
      loadConfig({
        ALGOD_URL: 'http://algod.local',
        BANK_API_KEYS: 'bank-secret',
        SUBMISSION_ALLOWED_ASSET_IDS: '31566704',
      }),
    /SUBMISSION_RECEIVER_WALLET/,
  )
})
