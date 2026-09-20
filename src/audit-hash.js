import crypto from 'node:crypto'

export function canonicalize(value) {
  if (value === null) {
    return 'null'
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }

  if (typeof value === 'object' && value !== undefined) {
    const prototype = Object.getPrototypeOf(value)
    if (prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('Can only canonicalize JSON-compatible plain objects.')
    }

    const entries = Object.entries(value)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`)
    return `{${entries.join(',')}}`
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('Cannot canonicalize non-finite numbers.')
    }

    return JSON.stringify(value)
  }

  if (typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }

  throw new TypeError(`Cannot canonicalize ${typeof value}.`)
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex')
}

export function hashCanonicalJson(value) {
  return sha256Hex(canonicalize(value))
}

export function hashOrderedHashes(hashes) {
  for (const hash of hashes) {
    if (!/^[a-f0-9]{64}$/.test(hash)) {
      throw new TypeError('Expected lowercase SHA-256 hex hashes.')
    }
  }

  return sha256Hex(hashes.join('\n'))
}
