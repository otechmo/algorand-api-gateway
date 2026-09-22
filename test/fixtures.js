import http from 'node:http'

import { MAINNET_GENESIS_HASH, MAINNET_GENESIS_ID, sha256Buffer } from '../src/config.js'
import { createGatewayServer } from '../src/server.js'

export const VALID_ADDRESS = 'Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA'
export const VALID_TX_ID = 'A'.repeat(52)
export const VALID_GROUP_ID = 'B'.repeat(52)

export async function createFixture(options = {}) {
  const state = {
    submissions: 0,
    simulations: 0,
    algodRequests: [],
    indexerRequests: [],
  }

  const algod = http.createServer(async (req, res) => {
    const request = await recordRequest(req)
    state.algodRequests.push(request)

    if (options.algodHandler) {
      const handled = await options.algodHandler(req, res, request, state)
      if (handled) {
        return
      }
    }

    if (req.method === 'GET' && request.pathname === '/v2/status') {
      sendJson(res, 200, { 'last-round': 123 })
      return
    }

    if (req.method === 'GET' && request.pathname === '/v2/transactions/params') {
      sendJson(res, 200, {
        fee: 1000,
        'min-fee': 1000,
        'genesis-id': options.genesisId || MAINNET_GENESIS_ID,
        'genesis-hash': options.genesisHash || MAINNET_GENESIS_HASH,
        'last-round': 123,
      })
      return
    }

    if (req.method === 'GET' && request.pathname === `/v2/accounts/${VALID_ADDRESS}`) {
      sendJson(res, 200, { address: VALID_ADDRESS, amount: 1000 })
      return
    }

    if (req.method === 'GET' && request.pathname === `/v2/accounts/${VALID_ADDRESS}/assets/31566704`) {
      sendJson(res, 200, { 'asset-holding': { 'asset-id': 31566704, amount: 2500000 } })
      return
    }

    if (req.method === 'GET' && request.pathname === '/v2/assets/31566704') {
      sendJson(res, 200, { index: 31566704, params: { name: 'USDC', 'unit-name': 'USDC', decimals: 6 } })
      return
    }

    if (req.method === 'GET' && request.pathname === '/v2/blocks/123') {
      sendJson(res, 200, { block: { rnd: 123 } })
      return
    }

    if (req.method === 'GET' && request.pathname === `/v2/transactions/pending/${VALID_TX_ID}`) {
      sendJson(res, 200, { txid: VALID_TX_ID, 'pool-error': '' })
      return
    }

    if (req.method === 'POST' && request.pathname === '/v2/transactions') {
      state.submissions += 1
      sendJson(res, 200, { txId: VALID_TX_ID })
      return
    }

    if (req.method === 'POST' && request.pathname === '/v2/transactions/simulate') {
      state.simulations += 1
      sendJson(res, 200, { version: 2, 'txn-groups': [] })
      return
    }

    sendJson(res, 404, { message: 'not found' })
  })

  const indexer = http.createServer(async (req, res) => {
    const request = await recordRequest(req)
    state.indexerRequests.push(request)

    if (options.indexerHandler) {
      const handled = await options.indexerHandler(req, res, request, state)
      if (handled) {
        return
      }
    }

    if (req.method === 'GET' && request.pathname === '/health') {
      sendJson(res, 200, { dbAvailable: true })
      return
    }

    if (req.method === 'GET' && request.pathname === `/v2/transactions/${VALID_TX_ID}`) {
      sendJson(res, 200, { transaction: { id: VALID_TX_ID, 'confirmed-round': 123 } })
      return
    }

    if (req.method === 'GET' && request.pathname === `/v2/accounts/${VALID_ADDRESS}/transactions`) {
      sendJson(res, 200, { transactions: [{ id: VALID_TX_ID }], 'next-token': 'next-page' })
      return
    }

    if (req.method === 'GET' && request.pathname === '/v2/transactions') {
      sendJson(res, 200, { transactions: [{ id: VALID_TX_ID, 'asset-transfer-transaction': { 'asset-id': 31566704 } }] })
      return
    }

    sendJson(res, 404, { message: 'not found' })
  })

  const algodUrl = await listen(algod)
  const indexerUrl = await listen(indexer)
  const config = mergeConfig(defaultConfig(algodUrl, indexerUrl), options.configOverrides || {})
  const gateway = createGatewayServer(config, { logger: options.logger || silentLogger })
  const gatewayUrl = await listen(gateway)

  return {
    state,
    config,
    gatewayUrl,
    algodUrl,
    indexerUrl,
    fetch(path, init = {}) {
      return fetch(`${gatewayUrl}${path}`, {
        ...init,
        headers: {
          Authorization: 'Bearer bank-secret',
          ...(init.headers || {}),
        },
      })
    },
    rawFetch(path, init = {}) {
      return fetch(`${gatewayUrl}${path}`, init)
    },
    async close() {
      await closeServer(gateway)
      await closeServer(algod)
      await closeServer(indexer)
    },
  }
}

export function defaultConfig(algodUrl = 'http://127.0.0.1:1', indexerUrl = 'http://127.0.0.1:2') {
  return {
    service: {
      name: 'test-gateway',
      env: 'test',
      publicBaseUrl: null,
    },
    server: {
      host: '127.0.0.1',
      port: 0,
      trustProxy: false,
      tlsCertFile: null,
      tlsKeyFile: null,
      mtlsRequired: false,
      mtlsCaFile: null,
      requestTimeoutMs: 30000,
      headersTimeoutMs: 10000,
    },
    upstream: {
      algod: {
        url: algodUrl,
        token: '',
        tokenHeader: 'X-Algo-API-Token',
      },
      indexer: {
        url: indexerUrl,
        token: '',
        tokenHeader: 'X-Indexer-API-Token',
      },
      requireIndexer: true,
      timeoutMs: 1000,
      retryAttempts: 0,
    },
    network: {
      enforceMainnet: true,
      expectedGenesisId: MAINNET_GENESIS_ID,
      expectedGenesisHash: MAINNET_GENESIS_HASH,
      verifyTtlMs: 1000,
    },
    audit: {
      receiverWallet: null,
    },
    submission: {
      receiverWallet: null,
      allowedAssetIds: [],
    },
    auth: {
      apiKeyHashes: [sha256Buffer('bank-secret')],
      allowUnauthenticated: false,
      readinessPublic: false,
    },
    security: {
      ipAllowlist: [],
      corsAllowedOrigins: [],
      maxBodyBytes: 1024 * 1024,
    },
    rateLimit: {
      enabled: false,
      perMinute: 600,
      burst: 120,
    },
    idempotency: {
      ttlMs: 60000,
    },
    pagination: {
      defaultPageLimit: 100,
      maxPageLimit: 1000,
    },
  }
}

export function sendJson(res, statusCode, payload, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': body.length,
    ...headers,
  })
  res.end(body)
}

export function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`http://127.0.0.1:${address.port}`)
    })
  })
}

export function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error)
      } else {
        resolve()
      }
    })
  })
}

export const silentLogger = {
  log() {},
  error() {},
}

async function recordRequest(req) {
  const url = new URL(req.url || '/', 'http://mock.local')
  const body = await readBody(req)
  return {
    method: req.method,
    pathname: url.pathname,
    search: url.search,
    searchParams: url.searchParams,
    headers: req.headers,
    body,
  }
}

async function readBody(req) {
  const chunks = []
  for await (const chunk of req) {
    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

function mergeConfig(base, overrides) {
  const output = structuredClone(base)
  deepAssign(output, overrides)
  return output
}

function deepAssign(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)) {
      target[key] = target[key] || {}
      deepAssign(target[key], value)
    } else {
      target[key] = value
    }
  }

  return target
}
