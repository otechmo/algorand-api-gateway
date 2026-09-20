import assert from 'node:assert/strict'
import test from 'node:test'

import { loadConfig } from '../src/config.js'
import { UpstreamClient } from '../src/upstream.js'

const shouldRun = process.env.ALGORAND_GATEWAY_RUN_MAINNET_SMOKE === 'true'

test('optional real Algorand MainNet smoke verifies configured upstreams', { skip: !shouldRun }, async () => {
  const config = loadConfig({
    ...process.env,
    BANK_API_KEYS: process.env.BANK_API_KEYS || 'smoke-test-local-only',
    REQUIRE_INDEXER: process.env.REQUIRE_INDEXER || 'false',
  })
  const client = new UpstreamClient(config)
  const network = await client.verifyNetwork({ force: true })
  assert.equal(network.verified, true)

  const status = await client.request('algod', {
    method: 'GET',
    path: '/v2/status',
    retrySafe: true,
  })
  assert.equal(typeof status.data['last-round'], 'number')
})
