import assert from 'node:assert/strict'
import test from 'node:test'

import { assertAlgorandAddress, assertTransactionId, assertUInt64 } from '../src/validators.js'

test('validates Algorand MainNet addresses with checksum', () => {
  assert.equal(
    assertAlgorandAddress('Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA'),
    'Y76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA',
  )
})

test('rejects addresses with invalid checksum', () => {
  assert.throws(
    () => assertAlgorandAddress('A76M3MSY6DKBRHBL7C3NNDXGS5IIMQVQVUAB6MP4XEMMGVF2QWNPL226CA'),
    /checksum/,
  )
})

test('validates transaction IDs and uint64 values', () => {
  assert.equal(assertTransactionId('A'.repeat(52)), 'A'.repeat(52))
  assert.equal(assertUInt64('18446744073709551615', 'assetId'), '18446744073709551615')
  assert.throws(() => assertUInt64('18446744073709551616', 'assetId'), /uint64/)
})
