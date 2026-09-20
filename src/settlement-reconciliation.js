import { hashCanonicalJson, hashOrderedHashes } from './audit-hash.js'

export function reconcileSettlementAudit({ audit, connection, institution, settlements, pacs008Files, nostroDebits }) {
  assertArray(settlements, 'settlements')
  assertArray(pacs008Files, 'pacs008Files')
  assertArray(nostroDebits, 'nostroDebits')

  const debitByReference = new Map(nostroDebits.map((debit) => [debit.reference, debit]))
  const pacsByReference = new Map(pacs008Files.map((file) => [referenceFromPacsFile(file.fileName), file]))

  const settlementHashes = settlements.map((settlement) => {
    const debit = debitByReference.get(settlement.reference)
    if (!debit) {
      throw new Error(`Missing Nostro debit for settlement ${settlement.reference}.`)
    }

    if (debit.uetr !== settlement.uetr) {
      throw new Error(`Nostro debit UETR mismatch for settlement ${settlement.reference}.`)
    }

    if (debit.amount !== settlement.amount) {
      throw new Error(`Nostro debit amount mismatch for settlement ${settlement.reference}.`)
    }

    if (!pacsByReference.has(settlement.reference)) {
      throw new Error(`Missing pacs.008 file for settlement ${settlement.reference}.`)
    }

    if (settlement.status !== 'CONFIRMED') {
      throw new Error(`Settlement ${settlement.reference} is not confirmed.`)
    }

    if (!settlement.transactionId || !settlement.confirmedRound) {
      throw new Error(`Settlement ${settlement.reference} is missing on-chain confirmation evidence.`)
    }

    return hashCanonicalJson(settlement)
  })

  const debitHashes = nostroDebits.map((debit) => hashCanonicalJson(debit))
  const pacsHashes = pacs008Files.map((file) => hashCanonicalJson(file))
  const connectionHash = hashCanonicalJson(connection)
  const institutionHash = hashCanonicalJson(institution)
  const datasetHashes = {
    settlementsHash: hashOrderedHashes(settlementHashes),
    nostroDebitsHash: hashOrderedHashes(debitHashes),
    pacs008QueueHash: hashOrderedHashes(pacsHashes),
    connectionHash,
    institutionHash,
  }
  const totalAmount = sumDecimalStrings(settlements.map((settlement) => settlement.amount))
  const masterHash = hashCanonicalJson({
    audit,
    datasetHashes,
    settlementCount: settlements.length,
    totalAmount,
  })

  return {
    settlementCount: settlements.length,
    totalAmount,
    datasetHashes,
    masterHash,
  }
}

function assertArray(value, name) {
  if (!Array.isArray(value)) {
    throw new TypeError(`${name} must be an array.`)
  }
}

function referenceFromPacsFile(fileName) {
  const match = String(fileName).match(/^(.*)_pacs008\.(json|xml)$/)
  return match ? match[1] : fileName
}

function sumDecimalStrings(values) {
  let cents = 0n

  for (const value of values) {
    const match = String(value).match(/^(\d+)(?:\.(\d{1,2}))?$/)
    if (!match) {
      throw new Error(`Invalid decimal amount: ${value}.`)
    }

    cents += BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0'))
  }

  const whole = cents / 100n
  const fractional = String(cents % 100n).padStart(2, '0')
  return `${whole}.${fractional}`
}
