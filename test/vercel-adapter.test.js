import assert from 'node:assert/strict'
import test from 'node:test'

import { createFetchHandler } from '../src/vercel-adapter.js'
import { defaultConfig } from './fixtures.js'

test('Vercel adapter serves gateway routes through fetch Request and Response objects', async () => {
  const handler = createFetchHandler(defaultConfig(), { logger: silentLogger })
  const response = await handler(new Request('https://gateway.example/api/gateway?gatewayPath=/health'))

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.status, 'ok')
})

test('Vercel adapter preserves rewritten gateway path and query parameters', async () => {
  const upstream = {
    async request(service, options) {
      assert.equal(service, 'indexer')
      assert.equal(options.path, '/v2/accounts/Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA/transactions')
      assert.equal(options.query.get('limit'), '10')
      return { data: { transactions: [] } }
    },
  }
  const handler = createFetchHandler(defaultConfig(), { upstream, logger: silentLogger })
  const response = await handler(
    new Request(
      'https://gateway.example/api/gateway?path=v1/accounts/Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA/transactions&limit=10',
      {
        headers: {
          Authorization: 'Bearer bank-secret',
        },
      },
    ),
  )

  assert.equal(response.status, 200)
})

test('Vercel adapter restores captured route matches from Vercel header', async () => {
  const handler = createFetchHandler(defaultConfig(), { logger: silentLogger })
  const response = await handler(
    new Request('https://gateway.example/api/gateway', {
      headers: {
        'x-now-route-matches': 'path=health',
      },
    }),
  )

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.status, 'ok')
})

test('Vercel adapter strips internal route params when preserving external query parameters', async () => {
  const upstream = {
    async request(service, options) {
      assert.equal(service, 'indexer')
      assert.equal(options.query.get('limit'), '1')
      assert.equal(options.query.has('gatewayPath'), false)
      return { data: { transactions: [] } }
    },
  }
  const handler = createFetchHandler(defaultConfig(), { upstream, logger: silentLogger })
  const response = await handler(
    new Request(
      'https://gateway.example/api/gateway?gatewayPath=v1/accounts/Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA/transactions&limit=1',
      {
        headers: {
          Authorization: 'Bearer bank-secret',
          'x-now-route-matches':
            'gatewayPath=v1%2Faccounts%2FY76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA%2Ftransactions',
        },
      },
    ),
  )

  assert.equal(response.status, 200)
})

const silentLogger = {
  log() {},
  error() {},
}
