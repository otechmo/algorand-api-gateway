import crypto from 'node:crypto'

import { HttpError } from './errors.js'

export function getRequestId(req) {
  const header = firstHeader(req, 'x-request-id')
  if (header && /^[A-Za-z0-9._:-]{1,128}$/.test(header)) {
    return header
  }

  return crypto.randomUUID()
}

export function getClientIp(req, trustProxy) {
  if (trustProxy) {
    const forwarded = firstHeader(req, 'x-forwarded-for')
    if (forwarded) {
      return normalizeIp(forwarded.split(',')[0].trim())
    }
  }

  return normalizeIp(req.socket.remoteAddress || '')
}

export function enforceIpAllowlist(ip, rules) {
  if (!rules.length) {
    return
  }

  if (!rules.some((rule) => matchesIpRule(ip, rule))) {
    throw new HttpError(403, 'ip_not_allowed', 'Client IP is not allowed.')
  }
}

export function authenticateRequest(req, config) {
  if (config.auth.allowUnauthenticated) {
    return {
      id: 'anonymous',
      authenticated: false,
    }
  }

  const apiKey = extractApiKey(req)
  if (!apiKey) {
    throw new HttpError(401, 'authentication_required', 'Missing API key.')
  }

  const presentedHash = crypto.createHash('sha256').update(apiKey).digest()
  const matched = config.auth.apiKeyHashes.some((allowedHash) => {
    return allowedHash.length === presentedHash.length && crypto.timingSafeEqual(allowedHash, presentedHash)
  })

  if (!matched) {
    throw new HttpError(401, 'authentication_failed', 'Invalid API key.')
  }

  return {
    id: `bank-${presentedHash.toString('hex').slice(0, 16)}`,
    authenticated: true,
  }
}

export function applySecurityHeaders(res, config) {
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('X-Frame-Options', 'DENY')
  res.setHeader('Referrer-Policy', 'no-referrer')
  res.setHeader('Cache-Control', 'no-store')

  if (config.server.tlsCertFile || config.service.publicBaseUrl?.startsWith('https://')) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
  }
}

export function applyCors(req, res, config) {
  const origin = firstHeader(req, 'origin')
  if (!origin || !config.security.corsAllowedOrigins.length) {
    return false
  }

  if (!config.security.corsAllowedOrigins.includes(origin)) {
    return false
  }

  res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Vary', 'Origin')
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type,idempotency-key,x-api-key,x-request-id')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Max-Age', '300')

  return true
}

export function firstHeader(req, name) {
  const value = req.headers[name]
  if (Array.isArray(value)) {
    return value[0]
  }

  return value
}

function extractApiKey(req) {
  const explicit = firstHeader(req, 'x-api-key')
  if (explicit) {
    return explicit
  }

  const authorization = firstHeader(req, 'authorization')
  if (!authorization) {
    return null
  }

  const match = authorization.match(/^Bearer\s+(.+)$/i)
  return match ? match[1].trim() : null
}

function matchesIpRule(ip, rule) {
  const normalizedRule = normalizeIp(rule)
  if (!normalizedRule.includes('/')) {
    return ip === normalizedRule
  }

  const [network, prefixText] = normalizedRule.split('/')
  const prefix = Number(prefixText)
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return false
  }

  const ipInt = ipv4ToInt(ip)
  const networkInt = ipv4ToInt(network)
  if (ipInt === null || networkInt === null) {
    return false
  }

  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0
  return (ipInt & mask) === (networkInt & mask)
}

function ipv4ToInt(value) {
  const parts = value.split('.')
  if (parts.length !== 4) {
    return null
  }

  let result = 0
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null
    }

    const octet = Number(part)
    if (octet < 0 || octet > 255) {
      return null
    }

    result = ((result << 8) | octet) >>> 0
  }

  return result
}

function normalizeIp(value) {
  if (value.startsWith('::ffff:')) {
    return value.slice('::ffff:'.length)
  }

  if (value === '::1') {
    return '127.0.0.1'
  }

  return value
}
