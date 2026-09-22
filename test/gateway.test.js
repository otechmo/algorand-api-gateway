import assert from 'node:assert/strict'
import test from 'node:test'

import { decodeAlgorandAddress } from '../src/algorand-address.js'
import { MAINNET_GENESIS_HASH } from '../src/config.js'
import { createFixture, VALID_ADDRESS, VALID_TX_ID } from './fixtures.js'

const RECEIVER_WALLET = 'XPPH747EGEDWQG45MP6VHKXKWGY5LZ6MTCXKR57RXO7QUI6XOBZFOKZPXU'

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

test('allows ALGO payments and ASA transfers to the configured receiver wallet for submissions', async () => {
  const fixture = await createFixture({
    configOverrides: {
      submission: {
        receiverWallet: RECEIVER_WALLET,
      },
    },
  })
  try {
    const algoPayment = signedTransactionBytes({
      type: 'pay',
      amt: 1000000,
      rcv: decodeAlgorandAddress(RECEIVER_WALLET),
    })
    const algoResponse = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
      },
      body: algoPayment,
    })

    assert.equal(algoResponse.status, 202)

    const asaTransfer = signedTransactionBytes({
      type: 'axfer',
      xaid: 31566704,
      aamt: 1000000,
      arcv: decodeAlgorandAddress(RECEIVER_WALLET),
    })

    const asaResponse = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
      },
      body: asaTransfer,
    })

    assert.equal(asaResponse.status, 202)
    assert.equal(fixture.state.submissions, 2)
  } finally {
    await fixture.close()
  }
})

test('rejects unsupported or misdirected transaction submissions before algod broadcast', async () => {
  const fixture = await createFixture({
    configOverrides: {
      submission: {
        receiverWallet: RECEIVER_WALLET,
      },
    },
  })
  try {
    const cases = [
      signedTransactionBytes({
        type: 'pay',
        amt: 1000000,
        rcv: decodeAlgorandAddress(VALID_ADDRESS),
      }),
      signedTransactionBytes({
        type: 'pay',
        amt: 0,
        rcv: decodeAlgorandAddress(RECEIVER_WALLET),
      }),
      signedTransactionBytes({
        type: 'pay',
        amt: 1000000,
        rcv: decodeAlgorandAddress(RECEIVER_WALLET),
        close: decodeAlgorandAddress(RECEIVER_WALLET),
      }),
      signedTransactionBytes({
        type: 'axfer',
        xaid: 31566704,
        aamt: 1000000,
        arcv: decodeAlgorandAddress(VALID_ADDRESS),
      }),
      signedTransactionBytes({
        type: 'axfer',
        xaid: 31566704,
        aamt: 0,
        arcv: decodeAlgorandAddress(RECEIVER_WALLET),
      }),
      signedTransactionBytes({
        type: 'axfer',
        xaid: 31566704,
        aamt: 1000000,
        arcv: decodeAlgorandAddress(RECEIVER_WALLET),
        asnd: decodeAlgorandAddress(VALID_ADDRESS),
      }),
      signedTransactionBytes({
        type: 'axfer',
        xaid: 31566704,
        aamt: 1000000,
        arcv: decodeAlgorandAddress(RECEIVER_WALLET),
        aclose: decodeAlgorandAddress(RECEIVER_WALLET),
      }),
      signedTransactionBytes({
        type: 'axfer',
        xaid: 31566704,
        aamt: 1000000,
        arcv: decodeAlgorandAddress(RECEIVER_WALLET),
        rekey: decodeAlgorandAddress(VALID_ADDRESS),
      }),
      signedTransactionBytes({
        type: 'appl',
        apan: 0,
      }),
    ]

    for (const body of cases) {
      const response = await fixture.fetch('/v1/transactions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-binary',
        },
        body,
      })
      const payload = await response.json()

      assert.equal(response.status, 403)
      assert.equal(payload.error.code, 'transaction_policy_violation')
    }

    assert.equal(fixture.state.submissions, 0)
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

test('returns bank self-service audit evidence as a downloadable JSON file', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.fetch(`/v1/audit/evidence?wallet=${VALID_ADDRESS}&limit=1`)
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-disposition'), /algorand-mainnet-audit-evidence-/)

    const body = await response.json()
    assert.equal(body.data.audit.title, 'FULL AUDIT EVIDENCE - ALGORAND MAINNET API GATEWAY')
    assert.equal(body.data.connectionStatus.status, 'CONNECTED')
    assert.equal(body.data.connectionStatus.mainnetVerified, true)
    assert.equal(body.data.walletEvidence.address, VALID_ADDRESS)
    assert.equal(body.data.walletEvidence.transactionSearch.transactions.length, 1)
    assert.match(body.data.audit.evidenceHash, /^[a-f0-9]{64}$/)
    assert.match(body.data.audit.reportText, /ALGORAND GATEWAY CONNECTION STATUS/)
    assert.equal(body.data.settlementReconciliationRequirements.requiredFromBankSystems.includes('pacs.008.001.08 file or JSON'), true)

    const indexerRequest = fixture.state.indexerRequests.find((request) => {
      return request.pathname === `/v2/accounts/${VALID_ADDRESS}/transactions`
    })
    assert.equal(indexerRequest.searchParams.get('limit'), '1')
  } finally {
    await fixture.close()
  }
})

function signedTransactionBytes(txn) {
  return encodeMsgpack({
    sig: Buffer.alloc(64, 1),
    txn,
  })
}

function encodeMsgpack(value) {
  if (Buffer.isBuffer(value)) {
    return encodeBinary(value)
  }

  if (typeof value === 'string') {
    return encodeString(value)
  }

  if (typeof value === 'number') {
    return encodeUnsigned(BigInt(value))
  }

  if (typeof value === 'bigint') {
    return encodeUnsigned(value)
  }

  if (Array.isArray(value)) {
    return Buffer.concat([encodeArrayHeader(value.length), ...value.map(encodeMsgpack)])
  }

  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter((entry) => entry[1] !== undefined)
    const encoded = [encodeMapHeader(entries.length)]

    for (const [key, item] of entries) {
      encoded.push(encodeString(key), encodeMsgpack(item))
    }

    return Buffer.concat(encoded)
  }

  throw new Error('Unsupported test MessagePack value.')
}

function encodeString(value) {
  const bytes = Buffer.from(value)
  if (bytes.length <= 31) {
    return Buffer.concat([Buffer.from([0xa0 | bytes.length]), bytes])
  }

  return Buffer.concat([Buffer.from([0xd9, bytes.length]), bytes])
}

function encodeBinary(value) {
  if (value.length <= 0xff) {
    return Buffer.concat([Buffer.from([0xc4, value.length]), value])
  }

  const header = Buffer.alloc(3)
  header[0] = 0xc5
  header.writeUInt16BE(value.length, 1)
  return Buffer.concat([header, value])
}

function encodeUnsigned(value) {
  if (value < 0n) {
    throw new Error('Unsigned test integer cannot be negative.')
  }

  if (value <= 0x7fn) {
    return Buffer.from([Number(value)])
  }

  if (value <= 0xffn) {
    return Buffer.from([0xcc, Number(value)])
  }

  if (value <= 0xffffn) {
    const output = Buffer.alloc(3)
    output[0] = 0xcd
    output.writeUInt16BE(Number(value), 1)
    return output
  }

  if (value <= 0xffffffffn) {
    const output = Buffer.alloc(5)
    output[0] = 0xce
    output.writeUInt32BE(Number(value), 1)
    return output
  }

  const output = Buffer.alloc(9)
  output[0] = 0xcf
  output.writeBigUInt64BE(value, 1)
  return output
}

function encodeArrayHeader(length) {
  if (length <= 15) {
    return Buffer.from([0x90 | length])
  }

  const output = Buffer.alloc(3)
  output[0] = 0xdc
  output.writeUInt16BE(length, 1)
  return output
}

function encodeMapHeader(length) {
  if (length <= 15) {
    return Buffer.from([0x80 | length])
  }

  const output = Buffer.alloc(3)
  output[0] = 0xde
  output.writeUInt16BE(length, 1)
  return output
}
