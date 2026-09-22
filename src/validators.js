import { normalizeAlgorandAddress } from './algorand-address.js'
import { HttpError } from './errors.js'

const UINT64_MAX = (2n ** 64n) - 1n
const TX_TYPES = new Set(['pay', 'keyreg', 'acfg', 'axfer', 'afrz', 'appl', 'stpf', 'hb'])

export function assertAlgorandAddress(value) {
  try {
    return normalizeAlgorandAddress(value)
  } catch {
    throw new HttpError(400, 'validation_error', 'Invalid Algorand address checksum.')
  }
}

export function assertTransactionId(value) {
  const txId = String(value || '').toUpperCase()
  if (!/^[A-Z2-7]{52}$/.test(txId)) {
    throw new HttpError(400, 'validation_error', 'Invalid Algorand transaction ID.')
  }

  return txId
}

export function assertUInt64(value, fieldName) {
  const text = String(value || '')
  if (!/^(0|[1-9]\d*)$/.test(text)) {
    throw new HttpError(400, 'validation_error', `${fieldName} must be an unsigned integer.`)
  }

  const parsed = BigInt(text)
  if (parsed > UINT64_MAX) {
    throw new HttpError(400, 'validation_error', `${fieldName} exceeds uint64 range.`)
  }

  return text
}

export function sanitizeQuery(searchParams, schema, config) {
  const output = new URLSearchParams()

  for (const [key, value] of searchParams.entries()) {
    const sanitizer = schema[key]
    if (!sanitizer) {
      throw new HttpError(400, 'validation_error', `Unsupported query parameter: ${key}.`)
    }

    output.append(key, sanitizer(value, config))
  }

  return output
}

export function withDefaultLimit(query, config) {
  if (!query.has('limit')) {
    query.set('limit', String(config.pagination.defaultPageLimit))
  }

  return query
}

export const commonQuery = {
  limit(value, config) {
    return boundedInteger(value, 'limit', 1, config.pagination.maxPageLimit)
  },
  next(value) {
    return boundedToken(value, 'next', 2048)
  },
}

export const indexerTransactionQuery = {
  ...commonQuery,
  'min-round': (value) => assertUInt64(value, 'min-round'),
  'max-round': (value) => assertUInt64(value, 'max-round'),
  round: (value) => assertUInt64(value, 'round'),
  'asset-id': (value) => assertUInt64(value, 'asset-id'),
  'application-id': (value) => assertUInt64(value, 'application-id'),
  'currency-greater-than': (value) => assertUInt64(value, 'currency-greater-than'),
  'currency-less-than': (value) => assertUInt64(value, 'currency-less-than'),
  'tx-type': (value) => {
    if (!TX_TYPES.has(value)) {
      throw new HttpError(400, 'validation_error', 'Unsupported transaction type.')
    }

    return value
  },
  'after-time': sanitizeIsoDate,
  'before-time': sanitizeIsoDate,
  'rekey-to': assertAlgorandAddress,
}

export const accountInfoQuery = {
  exclude(value) {
    if (!/^[A-Za-z,-]{1,128}$/.test(value)) {
      throw new HttpError(400, 'validation_error', 'Invalid exclude query value.')
    }

    return value
  },
}

export const blockQuery = {
  format(value) {
    if (value !== 'json') {
      throw new HttpError(400, 'validation_error', 'Only JSON block responses are supported.')
    }

    return value
  },
}

export function validateIdempotencyKey(value) {
  if (!value) {
    return null
  }

  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(value)) {
    throw new HttpError(400, 'validation_error', 'Invalid Idempotency-Key header.')
  }

  return value
}

function boundedInteger(value, name, min, max) {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, 'validation_error', `${name} must be an integer.`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new HttpError(400, 'validation_error', `${name} must be between ${min} and ${max}.`)
  }

  return String(parsed)
}

function boundedToken(value, name, maxLength) {
  if (value.length > maxLength || !/^[A-Za-z0-9+/=_-]+$/.test(value)) {
    throw new HttpError(400, 'validation_error', `${name} is invalid.`)
  }

  return value
}

function sanitizeIsoDate(value) {
  if (value.length > 64 || Number.isNaN(Date.parse(value))) {
    throw new HttpError(400, 'validation_error', 'Invalid date query value.')
  }

  return value
}
