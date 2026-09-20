import assert from 'node:assert/strict'
import test from 'node:test'

import { reconcileSettlementAudit } from '../src/settlement-reconciliation.js'
import { VALID_ADDRESS, VALID_TX_ID } from './fixtures.js'

test('reconciles confirmed Algorand settlement, pacs.008, and Nostro debit records', () => {
  const result = reconcileSettlementAudit(sampleAuditDataset())

  assert.equal(result.settlementCount, 2)
  assert.equal(result.totalAmount, '223.45')
  assert.match(result.datasetHashes.settlementsHash, /^[a-f0-9]{64}$/)
  assert.match(result.datasetHashes.nostroDebitsHash, /^[a-f0-9]{64}$/)
  assert.match(result.datasetHashes.pacs008QueueHash, /^[a-f0-9]{64}$/)
  assert.match(result.masterHash, /^[a-f0-9]{64}$/)
})

test('rejects settlement audit datasets with Nostro mismatches', () => {
  const dataset = sampleAuditDataset()
  dataset.nostroDebits[0].amount = '999.00'

  assert.throws(() => reconcileSettlementAudit(dataset), /amount mismatch/)
})

test('rejects settlement audit datasets without confirmed on-chain evidence', () => {
  const dataset = sampleAuditDataset()
  dataset.settlements[0].status = 'PENDING'

  assert.throws(() => reconcileSettlementAudit(dataset), /not confirmed/)
})

function sampleAuditDataset() {
  return {
    audit: {
      id: 'AUD-20260920-ALGOTEST',
      generatedAt: '2026-09-20T00:00:00.000Z',
    },
    connection: {
      network: 'Algorand MainNet',
      genesisId: 'mainnet-v1.0',
      genesisHash: 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
      currentRound: 123,
    },
    institution: {
      name: 'Example Bank',
      bic: 'EXAMPLEXXX',
    },
    settlements: [
      settlement('INST-20260920-0001', '100.00', VALID_TX_ID),
      settlement('INST-20260920-0002', '123.45', 'B'.repeat(52)),
    ],
    pacs008Files: [
      { fileName: 'INST-20260920-0001_pacs008.json', fileHash: 'a'.repeat(64) },
      { fileName: 'INST-20260920-0002_pacs008.json', fileHash: 'b'.repeat(64) },
    ],
    nostroDebits: [
      debit('INST-20260920-0001', '100.00'),
      debit('INST-20260920-0002', '123.45'),
    ],
  }
}

function settlement(reference, amount, transactionId) {
  return {
    reference,
    uetr: `${reference}-uetr`,
    amount,
    asset: 'USDC',
    assetId: 31566704,
    destinationAddress: VALID_ADDRESS,
    transactionId,
    confirmedRound: 123,
    status: 'CONFIRMED',
  }
}

function debit(reference, amount) {
  return {
    reference,
    uetr: `${reference}-uetr`,
    amount,
    source: 'Example Bank Nostro',
    debitHash: 'c'.repeat(64),
  }
}
