import crypto from 'node:crypto'

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export class AlgorandAddressError extends Error {
  constructor(message = 'Invalid Algorand address.') {
    super(message)
    this.name = 'AlgorandAddressError'
  }
}

export function normalizeAlgorandAddress(value) {
  const address = String(value || '').toUpperCase()
  decodeAlgorandAddress(address)
  return address
}

export function decodeAlgorandAddress(value) {
  const address = String(value || '').toUpperCase()

  if (!/^[A-Z2-7]{58}$/.test(address)) {
    throw new AlgorandAddressError()
  }

  const decoded = decodeBase32NoPadding(address)
  if (decoded.length !== 36) {
    throw new AlgorandAddressError()
  }

  const publicKey = decoded.subarray(0, 32)
  const checksum = decoded.subarray(32)
  const expected = crypto.createHash('sha512-256').update(publicKey).digest().subarray(28)

  if (!crypto.timingSafeEqual(checksum, expected)) {
    throw new AlgorandAddressError()
  }

  return publicKey
}

export function encodeAlgorandAddress(publicKey) {
  if (!Buffer.isBuffer(publicKey) || publicKey.length !== 32) {
    throw new AlgorandAddressError('Algorand public key must be 32 bytes.')
  }

  const checksum = crypto.createHash('sha512-256').update(publicKey).digest().subarray(28)
  return encodeBase32NoPadding(Buffer.concat([publicKey, checksum]))
}

function decodeBase32NoPadding(value) {
  let bits = 0
  let accumulator = 0
  const bytes = []

  for (const char of value) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) {
      throw new AlgorandAddressError('Invalid base32 value.')
    }

    accumulator = (accumulator << 5) | index
    bits += 5

    if (bits >= 8) {
      bytes.push((accumulator >> (bits - 8)) & 0xff)
      bits -= 8
    }
  }

  return Buffer.from(bytes)
}

function encodeBase32NoPadding(bytes) {
  let bits = 0
  let accumulator = 0
  let output = ''

  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte
    bits += 8

    while (bits >= 5) {
      output += BASE32_ALPHABET[(accumulator >> (bits - 5)) & 0x1f]
      bits -= 5
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(accumulator << (5 - bits)) & 0x1f]
  }

  return output
}
