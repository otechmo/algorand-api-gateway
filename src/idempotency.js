import crypto from 'node:crypto'

import { HttpError } from './errors.js'

export class IdempotencyCache {
  constructor(config) {
    this.ttlMs = config.idempotency.ttlMs
    this.entries = new Map()
  }

  get(scope, key, body) {
    if (!key) {
      return null
    }

    const cacheKey = `${scope}:${key}`
    const entry = this.entries.get(cacheKey)
    if (!entry) {
      return null
    }

    if (Date.now() > entry.expiresAt) {
      this.entries.delete(cacheKey)
      return null
    }

    const fingerprint = fingerprintBody(body)
    if (entry.fingerprint !== fingerprint) {
      throw new HttpError(409, 'idempotency_conflict', 'Idempotency-Key was already used with a different payload.')
    }

    return entry.response
  }

  set(scope, key, body, response) {
    if (!key) {
      return
    }

    this.entries.set(`${scope}:${key}`, {
      fingerprint: fingerprintBody(body),
      response,
      expiresAt: Date.now() + this.ttlMs,
    })

    if (this.entries.size > 10000) {
      this.cleanup()
    }
  }

  cleanup(now = Date.now()) {
    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        this.entries.delete(key)
      }
    }
  }
}

function fingerprintBody(body) {
  return crypto.createHash('sha256').update(body).digest('hex')
}
