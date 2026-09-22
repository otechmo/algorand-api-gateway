import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const expectedPaths = [
  '/health',
  '/ready',
  '/v1/network/status',
  '/v1/network/params',
  '/v1/audit/evidence',
  '/v1/accounts/{address}',
  '/v1/accounts/{address}/assets/{assetId}',
  '/v1/accounts/{address}/transactions',
  '/v1/assets/{assetId}',
  '/v1/assets/{assetId}/transactions',
  '/v1/blocks/{round}',
  '/v1/transactions/{txId}',
  '/v1/transactions/pending/{txId}',
  '/v1/transactions',
  '/v1/transactions/simulate',
]

test('OpenAPI document advertises every gateway route', () => {
  const openapi = fs.readFileSync('openapi.yaml', 'utf8')
  for (const path of expectedPaths) {
    assert.match(openapi, new RegExp(`^  ${escapeRegex(path)}:`, 'm'), `${path} is missing from openapi.yaml`)
  }
})

test('OpenAPI security schemes include bearer and X-API-Key auth', () => {
  const openapi = fs.readFileSync('openapi.yaml', 'utf8')
  assert.match(openapi, /bearerAuth:/)
  assert.match(openapi, /apiKeyAuth:/)
  assert.match(openapi, /name: X-API-Key/)
})

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
