import assert from 'node:assert/strict'
import test from 'node:test'

import { MAINNET_GENESIS_HASH, MAINNET_GENESIS_ID } from '../src/config.js'
import { HttpError } from '../src/errors.js'
import { UpstreamClient } from '../src/upstream.js'
import { defaultConfig } from './fixtures.js'

test('sends upstream token headers and request IDs', async () => {
  const calls = []
  const config = defaultConfig()
  config.upstream.algod = {
    url: 'https://algod.example/base',
    token: 'node-token',
    tokenHeader: 'X-Algo-API-Token',
  }
  const client = new UpstreamClient(config, async (url, init) => {
    calls.push({ url, init })
    return jsonResponse({ ok: true })
  })

  await client.request('algod', {
    method: 'GET',
    path: '/v2/status',
    requestId: 'req-1',
  })

  assert.equal(String(calls[0].url), 'https://algod.example/base/v2/status')
  assert.equal(calls[0].init.headers['X-Algo-API-Token'], 'node-token')
  assert.equal(calls[0].init.headers['X-Request-ID'], 'req-1')
})

test('retries safe requests on retryable upstream statuses', async () => {
  let calls = 0
  const config = defaultConfig()
  config.upstream.retryAttempts = 1
  const client = new UpstreamClient(config, async () => {
    calls += 1
    if (calls === 1) {
      return jsonResponse({ message: 'busy' }, 503)
    }

    return jsonResponse({ ok: true }, 200)
  })

  const response = await client.request('algod', {
    method: 'GET',
    path: '/v2/status',
  })

  assert.equal(response.data.ok, true)
  assert.equal(calls, 2)
})

test('does not retry mutating transaction submissions', async () => {
  let calls = 0
  const config = defaultConfig()
  config.upstream.retryAttempts = 2
  const client = new UpstreamClient(config, async () => {
    calls += 1
    return jsonResponse({ message: 'busy' }, 503)
  })

  await assert.rejects(
    () =>
      client.request('algod', {
        method: 'POST',
        path: '/v2/transactions',
        body: Buffer.from([1]),
        retrySafe: false,
      }),
    (error) => error instanceof HttpError && error.statusCode === 502,
  )
  assert.equal(calls, 1)
})

test('times out unresponsive upstream requests', async () => {
  const config = defaultConfig()
  config.upstream.timeoutMs = 10
  config.upstream.retryAttempts = 0
  const client = new UpstreamClient(config, async (_url, init) => {
    await new Promise((resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true })
      setTimeout(resolve, 1000)
    })
    return jsonResponse({ ok: true })
  })

  await assert.rejects(
    () =>
      client.request('algod', {
        method: 'GET',
        path: '/v2/status',
      }),
    (error) => error instanceof HttpError && error.statusCode === 504,
  )
})

test('caches MainNet verification within the configured TTL', async () => {
  let calls = 0
  const config = defaultConfig()
  config.network.verifyTtlMs = 60000
  const client = new UpstreamClient(config, async () => {
    calls += 1
    return jsonResponse({
      'genesis-id': MAINNET_GENESIS_ID,
      'genesis-hash': MAINNET_GENESIS_HASH,
    })
  })

  await client.verifyNetwork()
  await client.verifyNetwork()
  assert.equal(calls, 1)
})

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}
