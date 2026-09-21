import assert from 'node:assert/strict'
import test from 'node:test'

import { MAINNET_GENESIS_HASH } from '../src/config.js'
import { createFixture, VALID_ADDRESS, VALID_TX_ID } from './fixtures.js'

test('requires authentication for v1 routes', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.rawFetch('/v1/network/status')
    assert.equal(response.status, 401)
  } finally {
    await fixture.close()
  }
})

test('proxies allowlisted algod and indexer routes', async () => {
  const fixture = await createFixture()
  try {
    const statusResponse = await fixture.fetch('/v1/network/status')
    assert.equal(statusResponse.status, 200)
    const status = await statusResponse.json()
    assert.equal(status.data['last-round'], 123)

    const accountResponse = await fixture.fetch(`/v1/accounts/${VALID_ADDRESS}`)
    assert.equal(accountResponse.status, 200)
    const account = await accountResponse.json()
    assert.equal(account.data.address, VALID_ADDRESS)

    const assetResponse = await fixture.fetch('/v1/assets/31566704')
    assert.equal(assetResponse.status, 200)
    const asset = await assetResponse.json()
    assert.equal(asset.data.params['unit-name'], 'USDC')

    const transactionResponse = await fixture.fetch(`/v1/transactions/${VALID_TX_ID}`)
    assert.equal(transactionResponse.status, 200)
    const transaction = await transactionResponse.json()
    assert.equal(transaction.data.transaction.id, VALID_TX_ID)
  } finally {
    await fixture.close()
  }
})

test('adds default pagination to indexer transaction searches', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.fetch(`/v1/accounts/${VALID_ADDRESS}/transactions`)
    assert.equal(response.status, 200)

    const indexerRequest = fixture.state.indexerRequests.find((request) => {
      return request.pathname === `/v2/accounts/${VALID_ADDRESS}/transactions`
    })
    assert.equal(indexerRequest.searchParams.get('limit'), '100')
  } finally {
    await fixture.close()
  }
})

test('strips Vercel gatewayPath route capture from client query validation', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.fetch(
      `/v1/accounts/${VALID_ADDRESS}/transactions?limit=1&gatewayPath=v1/accounts/${VALID_ADDRESS}/transactions`,
    )
    assert.equal(response.status, 200)

    const indexerRequest = fixture.state.indexerRequests.find((request) => {
      return request.pathname === `/v2/accounts/${VALID_ADDRESS}/transactions`
    })
    assert.equal(indexerRequest.searchParams.get('limit'), '1')
    assert.equal(indexerRequest.searchParams.has('gatewayPath'), false)
  } finally {
    await fixture.close()
  }
})

test('proxies pending transactions, account asset holdings, blocks, and asset transaction searches', async () => {
  const fixture = await createFixture()
  try {
    const pending = await fixture.fetch(`/v1/transactions/pending/${VALID_TX_ID}`)
    assert.equal(pending.status, 200)

    const holding = await fixture.fetch(`/v1/accounts/${VALID_ADDRESS}/assets/31566704`)
    assert.equal(holding.status, 200)

    const block = await fixture.fetch('/v1/blocks/123')
    assert.equal(block.status, 200)

    const assetTransactions = await fixture.fetch('/v1/assets/31566704/transactions?limit=2')
    assert.equal(assetTransactions.status, 200)

    const indexerRequest = fixture.state.indexerRequests.find((request) => request.pathname === '/v2/transactions')
    assert.equal(indexerRequest.searchParams.get('asset-id'), '31566704')
    assert.equal(indexerRequest.searchParams.get('limit'), '2')
  } finally {
    await fixture.close()
  }
})

test('verifies MainNet before accepting transaction submissions and replays idempotent responses', async () => {
  const fixture = await createFixture()
  try {
    const body = Buffer.from([0x82, 0xa3, 0x74, 0x78, 0x6e])
    const first = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
        'Idempotency-Key': 'submit-1',
      },
      body,
    })
    assert.equal(first.status, 202)
    assert.equal(fixture.state.submissions, 1)

    const second = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
        'Idempotency-Key': 'submit-1',
      },
      body,
    })
    assert.equal(second.status, 202)
    assert.equal(second.headers.get('idempotent-replayed'), 'true')
    assert.equal(fixture.state.submissions, 1)
  } finally {
    await fixture.close()
  }
})

test('rejects idempotency key reuse with a different payload', async () => {
  const fixture = await createFixture()
  try {
    const first = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
        'Idempotency-Key': 'submit-2',
      },
      body: Buffer.from([1, 2, 3]),
    })
    assert.equal(first.status, 202)

    const second = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
        'Idempotency-Key': 'submit-2',
      },
      body: Buffer.from([9, 9, 9]),
    })
    assert.equal(second.status, 409)
    assert.equal(fixture.state.submissions, 1)
  } finally {
    await fixture.close()
  }
})

test('rejects malformed base64 transaction payloads', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        signedTransaction: 'not-valid-base64!!!',
      }),
    })
    assert.equal(response.status, 400)
    assert.equal(fixture.state.submissions, 0)
  } finally {
    await fixture.close()
  }
})

test('simulates transactions through algod after MainNet verification', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.fetch('/v1/transactions/simulate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ txnGroups: [] }),
    })
    assert.equal(response.status, 200)
    assert.equal(fixture.state.simulations, 1)
  } finally {
    await fixture.close()
  }
})

test('fails readiness when algod is not MainNet', async () => {
  const fixture = await createFixture({
    genesisId: 'testnet-v1.0',
    genesisHash: 'SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
  })
  try {
    const response = await fixture.fetch('/ready')
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.checks.network.code, 'network_mismatch')
  } finally {
    await fixture.close()
  }
})

test('returns MainNet params with network verification metadata', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.fetch('/v1/network/params')
    assert.equal(response.status, 200)
    const body = await response.json()
    assert.equal(body.data['genesis-hash'], MAINNET_GENESIS_HASH)
    assert.equal(body.meta.networkVerified, true)
  } finally {
    await fixture.close()
  }
})
