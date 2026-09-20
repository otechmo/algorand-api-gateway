import { HttpError } from './errors.js'

export class TokenBucketLimiter {
  constructor(config) {
    this.config = config
    this.buckets = new Map()
  }

  check(key, now = Date.now()) {
    if (!this.config.rateLimit.enabled) {
      return
    }

    const capacity = this.config.rateLimit.burst
    const refillPerMs = this.config.rateLimit.perMinute / 60000
    const current = this.buckets.get(key) || {
      tokens: capacity,
      updatedAt: now,
    }

    const elapsed = Math.max(0, now - current.updatedAt)
    current.tokens = Math.min(capacity, current.tokens + elapsed * refillPerMs)
    current.updatedAt = now

    if (current.tokens < 1) {
      this.buckets.set(key, current)
      const retryAfterSeconds = Math.max(1, Math.ceil((1 - current.tokens) / refillPerMs / 1000))
      throw new HttpError(429, 'rate_limited', 'Rate limit exceeded.', { retryAfterSeconds })
    }

    current.tokens -= 1
    this.buckets.set(key, current)

    if (this.buckets.size > 10000) {
      this.cleanup(now)
    }
  }

  cleanup(now = Date.now()) {
    for (const [key, bucket] of this.buckets.entries()) {
      if (now - bucket.updatedAt > 300000) {
        this.buckets.delete(key)
      }
    }
  }
}
