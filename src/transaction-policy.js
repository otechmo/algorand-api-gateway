import { encodeAlgorandAddress } from './algorand-address.js'
import { HttpError } from './errors.js'

const MAX_MSGPACK_DEPTH = 64
const MAX_MSGPACK_COLLECTION_LENGTH = 100000

export function enforceSubmissionPolicy(body, config) {
  const policy = config.submission || {}
  const receiverWallet = policy.receiverWallet || policy.asaReceiverWallet
  if (!receiverWallet) {
    return
  }

  const signedTransactions = decodeSignedTransactions(body)
  if (signedTransactions.length === 0) {
    throw new HttpError(400, 'validation_error', 'Signed transaction payload is empty.')
  }

  for (const signedTransaction of signedTransactions) {
    enforceTransactionToReceiver(signedTransaction, { ...policy, receiverWallet })
  }
}

export function decodeSignedTransactions(body) {
  if (!Buffer.isBuffer(body) || body.length === 0) {
    throw new HttpError(400, 'validation_error', 'Signed transaction body is required.')
  }

  const values = []
  let offset = 0

  while (offset < body.length) {
    const decoded = decodeMsgpackValue(body, offset, 0)
    values.push(decoded.value)
    offset = decoded.offset
  }

  return values.flatMap((value) => (Array.isArray(value) ? value : [value]))
}

function enforceTransactionToReceiver(signedTransaction, policy) {
  if (!isPlainObject(signedTransaction) || !isPlainObject(signedTransaction.txn)) {
    throw new HttpError(400, 'validation_error', 'Signed transaction payload must contain a txn object.')
  }

  const txn = signedTransaction.txn

  if (txn.type === 'pay') {
    enforceAlgoPaymentToReceiver(txn, policy)
    return
  }

  if (txn.type === 'axfer') {
    enforceAsaTransferToReceiver(txn, policy)
    return
  }

  throw policyViolation('Only ALGO payments or ASA transfers to the configured receiver wallet are allowed.')
}

function enforceAlgoPaymentToReceiver(txn, policy) {
  if (!Buffer.isBuffer(txn.rcv) || txn.rcv.length !== 32) {
    throw new HttpError(400, 'validation_error', 'ALGO payment receiver is missing or invalid.')
  }

  const receiver = encodeAlgorandAddress(txn.rcv)
  if (receiver !== policy.receiverWallet) {
    throw policyViolation(`ALGO payment receiver must be ${policy.receiverWallet}.`)
  }

  const amount = uintToBigInt(txn.amt, 'ALGO payment amount')
  if (amount <= 0n) {
    throw policyViolation('ALGO payment amount must be greater than zero.')
  }

  if (txn.close !== undefined) {
    throw policyViolation('ALGO close-out payments are not allowed.')
  }

  if (txn.rekey !== undefined) {
    throw policyViolation('Rekey transactions are not allowed.')
  }
}

function enforceAsaTransferToReceiver(txn, policy) {
  if (!Buffer.isBuffer(txn.arcv) || txn.arcv.length !== 32) {
    throw new HttpError(400, 'validation_error', 'ASA transfer receiver is missing or invalid.')
  }

  const receiver = encodeAlgorandAddress(txn.arcv)
  if (receiver !== policy.receiverWallet) {
    throw policyViolation(`ASA receiver must be ${policy.receiverWallet}.`)
  }

  const assetId = uintToString(txn.xaid, 'ASA transfer asset ID')
  if (policy.allowedAssetIds?.length && !policy.allowedAssetIds.includes(assetId)) {
    throw policyViolation('ASA asset ID is not allowed for this gateway.')
  }

  const amount = uintToBigInt(txn.aamt, 'ASA transfer amount')
  if (amount <= 0n) {
    throw policyViolation('ASA transfer amount must be greater than zero.')
  }

  if (txn.asnd !== undefined) {
    throw policyViolation('ASA clawback transactions are not allowed.')
  }

  if (txn.aclose !== undefined) {
    throw policyViolation('ASA close-out transactions are not allowed.')
  }

  if (txn.rekey !== undefined) {
    throw policyViolation('Rekey transactions are not allowed.')
  }
}

function policyViolation(message) {
  return new HttpError(403, 'transaction_policy_violation', message)
}

function uintToString(value, fieldName) {
  return uintToBigInt(value, fieldName).toString()
}

function uintToBigInt(value, fieldName) {
  if (typeof value === 'bigint') {
    if (value < 0n) {
      throw new HttpError(400, 'validation_error', `${fieldName} must be an unsigned integer.`)
    }

    return value
  }

  if (Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value)
  }

  throw new HttpError(400, 'validation_error', `${fieldName} must be an unsigned integer.`)
}

function decodeMsgpackValue(buffer, offset, depth) {
  if (depth > MAX_MSGPACK_DEPTH) {
    throw new HttpError(400, 'validation_error', 'Signed transaction payload is too deeply nested.')
  }

  if (offset >= buffer.length) {
    throw new HttpError(400, 'validation_error', 'Unexpected end of signed transaction payload.')
  }

  const marker = buffer[offset]
  const next = offset + 1

  if (marker <= 0x7f) {
    return { value: marker, offset: next }
  }

  if (marker >= 0x80 && marker <= 0x8f) {
    return decodeMap(buffer, next, marker & 0x0f, depth + 1)
  }

  if (marker >= 0x90 && marker <= 0x9f) {
    return decodeArray(buffer, next, marker & 0x0f, depth + 1)
  }

  if (marker >= 0xa0 && marker <= 0xbf) {
    return decodeString(buffer, next, marker & 0x1f)
  }

  if (marker >= 0xe0) {
    return { value: marker - 0x100, offset: next }
  }

  switch (marker) {
    case 0xc0:
      return { value: null, offset: next }
    case 0xc2:
      return { value: false, offset: next }
    case 0xc3:
      return { value: true, offset: next }
    case 0xc4:
      return decodeBinary(buffer, offset + 2, readUInt8(buffer, next))
    case 0xc5:
      return decodeBinary(buffer, offset + 3, readUInt16(buffer, next))
    case 0xc6:
      return decodeBinary(buffer, offset + 5, readUInt32(buffer, next))
    case 0xcc:
      return { value: readUInt8(buffer, next), offset: offset + 2 }
    case 0xcd:
      return { value: readUInt16(buffer, next), offset: offset + 3 }
    case 0xce:
      return { value: readUInt32(buffer, next), offset: offset + 5 }
    case 0xcf:
      return { value: readUInt64(buffer, next), offset: offset + 9 }
    case 0xd0:
      return { value: readInt8(buffer, next), offset: offset + 2 }
    case 0xd1:
      return { value: readInt16(buffer, next), offset: offset + 3 }
    case 0xd2:
      return { value: readInt32(buffer, next), offset: offset + 5 }
    case 0xd3:
      return { value: readInt64(buffer, next), offset: offset + 9 }
    case 0xd9:
      return decodeString(buffer, offset + 2, readUInt8(buffer, next))
    case 0xda:
      return decodeString(buffer, offset + 3, readUInt16(buffer, next))
    case 0xdb:
      return decodeString(buffer, offset + 5, readUInt32(buffer, next))
    case 0xdc:
      return decodeArray(buffer, offset + 3, readUInt16(buffer, next), depth + 1)
    case 0xdd:
      return decodeArray(buffer, offset + 5, readUInt32(buffer, next), depth + 1)
    case 0xde:
      return decodeMap(buffer, offset + 3, readUInt16(buffer, next), depth + 1)
    case 0xdf:
      return decodeMap(buffer, offset + 5, readUInt32(buffer, next), depth + 1)
    default:
      throw new HttpError(400, 'validation_error', 'Unsupported signed transaction encoding.')
  }
}

function decodeArray(buffer, offset, length, depth) {
  assertCollectionLength(length)
  const value = []
  let current = offset

  for (let index = 0; index < length; index += 1) {
    const decoded = decodeMsgpackValue(buffer, current, depth)
    value.push(decoded.value)
    current = decoded.offset
  }

  return { value, offset: current }
}

function decodeMap(buffer, offset, length, depth) {
  assertCollectionLength(length)
  const value = Object.create(null)
  let current = offset

  for (let index = 0; index < length; index += 1) {
    const key = decodeMsgpackValue(buffer, current, depth)
    current = key.offset
    const item = decodeMsgpackValue(buffer, current, depth)
    current = item.offset

    if (typeof key.value === 'string') {
      value[key.value] = item.value
    }
  }

  return { value, offset: current }
}

function decodeString(buffer, offset, length) {
  assertAvailable(buffer, offset, length)
  return {
    value: buffer.toString('utf8', offset, offset + length),
    offset: offset + length,
  }
}

function decodeBinary(buffer, offset, length) {
  assertAvailable(buffer, offset, length)
  return {
    value: buffer.subarray(offset, offset + length),
    offset: offset + length,
  }
}

function readUInt8(buffer, offset) {
  assertAvailable(buffer, offset, 1)
  return buffer.readUInt8(offset)
}

function readUInt16(buffer, offset) {
  assertAvailable(buffer, offset, 2)
  return buffer.readUInt16BE(offset)
}

function readUInt32(buffer, offset) {
  assertAvailable(buffer, offset, 4)
  return buffer.readUInt32BE(offset)
}

function readUInt64(buffer, offset) {
  assertAvailable(buffer, offset, 8)
  const value = buffer.readBigUInt64BE(offset)
  return value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value
}

function readInt8(buffer, offset) {
  assertAvailable(buffer, offset, 1)
  return buffer.readInt8(offset)
}

function readInt16(buffer, offset) {
  assertAvailable(buffer, offset, 2)
  return buffer.readInt16BE(offset)
}

function readInt32(buffer, offset) {
  assertAvailable(buffer, offset, 4)
  return buffer.readInt32BE(offset)
}

function readInt64(buffer, offset) {
  assertAvailable(buffer, offset, 8)
  const value = buffer.readBigInt64BE(offset)
  if (value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)) {
    return Number(value)
  }

  return value
}

function assertAvailable(buffer, offset, length) {
  if (offset + length > buffer.length) {
    throw new HttpError(400, 'validation_error', 'Unexpected end of signed transaction payload.')
  }
}

function assertCollectionLength(length) {
  if (length > MAX_MSGPACK_COLLECTION_LENGTH) {
    throw new HttpError(400, 'validation_error', 'Signed transaction payload is too large.')
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value)
}
