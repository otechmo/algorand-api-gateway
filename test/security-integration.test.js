import assert from 'node:assert/strict'
import test from 'node:test'

import { createFixture, VALID_ADDRESS } from './fixtures.js'

test('allows configured CORS preflight without authentication', async () => {
  const fixture = await createFixture({
    configOverrides: {
      security: {
        corsAllowedOrigins: ['https://bank.example'],
      },
    },
  })
  try {
    const response = await fixture.rawFetch('/v1/network/status', {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://bank.example',
      },
    })
    assert.equal(response.status, 204)
    assert.equal(response.headers.get('access-control-allow-origin'), 'https://bank.example')
  } finally {
    await fixture.close()
  }
})

test('rejects clients outside the IP allowlist', async () => {
  const fixture = await createFixture({
    configOverrides: {
      server: {
        trustProxy: true,
      },
      security: {
        ipAllowlist: ['203.0.113.0/24'],
      },
    },
  })
  try {
    const response = await fixture.fetch('/v1/network/status', {
      headers: {
        'X-Forwarded-For': '198.51.100.10',
      },
    })
    assert.equal(response.status, 403)
  } finally {
    await fixture.close()
  }
})

test('allows clients inside the IP allowlist', async () => {
  const fixture = await createFixture({
    configOverrides: {
      server: {
        trustProxy: true,
      },
      security: {
        ipAllowlist: ['203.0.113.0/24'],
      },
    },
  })
  try {
    const response = await fixture.fetch('/v1/network/status', {
      headers: {
        'X-Forwarded-For': '203.0.113.42',
      },
    })
    assert.equal(response.status, 200)
  } finally {
    await fixture.close()
  }
})

test('rate limits authenticated clients by principal and IP', async () => {
  const fixture = await createFixture({
    configOverrides: {
      rateLimit: {
        enabled: true,
        burst: 1,
        perMinute: 1,
      },
    },
  })
  try {
    const first = await fixture.fetch('/v1/network/status')
    assert.equal(first.status, 200)

    const second = await fixture.fetch('/v1/network/status')
    assert.equal(second.status, 429)
    assert.equal(second.headers.get('retry-after'), '60')
  } finally {
    await fixture.close()
  }
})

test('rejects oversized request bodies before upstream submission', async () => {
  const fixture = await createFixture({
    configOverrides: {
      security: {
        maxBodyBytes: 4,
      },
    },
  })
  try {
    const response = await fixture.fetch('/v1/transactions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-binary',
      },
      body: Buffer.from([1, 2, 3, 4, 5]),
    })
    assert.equal(response.status, 413)
    assert.equal(fixture.state.submissions, 0)
  } finally {
    await fixture.close()
  }
})

test('rejects unsupported methods and malformed route values', async () => {
  const fixture = await createFixture()
  try {
    const wrongMethod = await fixture.fetch('/v1/network/status', { method: 'POST' })
    assert.equal(wrongMethod.status, 405)

    const badAddress = await fixture.fetch('/v1/accounts/not-an-address')
    assert.equal(badAddress.status, 400)

    const unsupportedQuery = await fixture.fetch(`/v1/accounts/${VALID_ADDRESS}/transactions?limit=1001`)
    assert.equal(unsupportedQuery.status, 400)

    const conflictingAsset = await fixture.fetch('/v1/assets/31566704/transactions?asset-id=1')
    assert.equal(conflictingAsset.status, 400)
  } finally {
    await fixture.close()
  }
})

test('health remains local and unauthenticated', async () => {
  const fixture = await createFixture()
  try {
    const response = await fixture.rawFetch('/health')
    assert.equal(response.status, 200)
    assert.equal(fixture.state.algodRequests.length, 0)
    assert.equal(fixture.state.indexerRequests.length, 0)
  } finally {
    await fixture.close()
  }
})
