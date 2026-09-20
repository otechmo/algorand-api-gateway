import assert from 'node:assert/strict'
import test from 'node:test'

import { canonicalize, hashCanonicalJson, hashOrderedHashes, sha256Hex } from '../src/audit-hash.js'

test('canonicalizes object keys deterministically for audit hashing', () => {
  const left = {
    reference: 'INST-1',
    amount: '100.00',
    nested: {
      z: true,
      a: null,
    },
  }
  const right = {
    nested: {
      a: null,
      z: true,
    },
    amount: '100.00',
    reference: 'INST-1',
  }

  assert.equal(canonicalize(left), canonicalize(right))
  assert.equal(hashCanonicalJson(left), hashCanonicalJson(right))
})

test('hashes ordered child hashes into dataset hashes', () => {
  const first = sha256Hex('settlement-1')
  const second = sha256Hex('settlement-2')

  assert.equal(hashOrderedHashes([first, second]), hashOrderedHashes([first, second]))
  assert.notEqual(hashOrderedHashes([first, second]), hashOrderedHashes([second, first]))
})

test('rejects unsafe audit hash inputs', () => {
  assert.throws(() => canonicalize(Number.NaN), /non-finite/)
  assert.throws(() => canonicalize(undefined), /Cannot canonicalize/)
  assert.throws(() => canonicalize(new Date()), /plain objects/)
  assert.throws(() => hashOrderedHashes(['not-a-hash']), /SHA-256/)
})
