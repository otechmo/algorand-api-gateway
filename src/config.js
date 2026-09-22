import crypto from 'node:crypto'

import { normalizeAlgorandAddress } from './algorand-address.js'
import { ConfigurationError } from './errors.js'
import { assertUInt64 } from './validators.js'

export const MAINNET_GENESIS_ID = 'mainnet-v1.0'
export const MAINNET_GENESIS_HASH = 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='

export function sha256Buffer(value) {
  return crypto.createHash('sha256').update(value).digest()
}

export function loadConfig(env = process.env) {
  const allowUnauthenticated = parseBoolean(env.ALLOW_UNAUTHENTICATED, false)
  const apiKeyHashes = parseApiKeyHashes(env)

  if (apiKeyHashes.length === 0 && !allowUnauthenticated) {
    throw new ConfigurationError('BANK_API_KEY_HASHES is required unless ALLOW_UNAUTHENTICATED=true.')
  }

  const requireIndexer = parseBoolean(env.REQUIRE_INDEXER, false)
  const indexerUrl = normalizeOptionalUrl(env.INDEXER_URL, 'INDEXER_URL')

  if (requireIndexer && !indexerUrl) {
    throw new ConfigurationError('INDEXER_URL is required when REQUIRE_INDEXER=true.')
  }

  const tlsCertFile = emptyToNull(env.TLS_CERT_FILE)
  const tlsKeyFile = emptyToNull(env.TLS_KEY_FILE)
  const requireTls = parseBoolean(env.REQUIRE_TLS, false)
  const mtlsRequired = parseBoolean(env.MTLS_REQUIRED, false)
  const mtlsCaFile = emptyToNull(env.MTLS_CA_FILE)

  if (requireTls && (!tlsCertFile || !tlsKeyFile)) {
    throw new ConfigurationError('TLS_CERT_FILE and TLS_KEY_FILE are required when REQUIRE_TLS=true.')
  }

  if (mtlsRequired && (!tlsCertFile || !tlsKeyFile || !mtlsCaFile)) {
    throw new ConfigurationError('TLS_CERT_FILE, TLS_KEY_FILE, and MTLS_CA_FILE are required when MTLS_REQUIRED=true.')
  }

  const defaultPageLimit = parseInteger(env.DEFAULT_PAGE_LIMIT, 100, 1, 10000, 'DEFAULT_PAGE_LIMIT')
  const maxPageLimit = parseInteger(env.MAX_PAGE_LIMIT, 1000, defaultPageLimit, 10000, 'MAX_PAGE_LIMIT')
  const submissionAsaReceiverWallet = parseOptionalAlgorandAddress(
    env.SUBMISSION_ASA_RECEIVER_WALLET || env.ASA_TRANSFER_RECEIVER_WALLET,
    'SUBMISSION_ASA_RECEIVER_WALLET',
  )
  const submissionAllowedAssetIds = parseUInt64List(env.SUBMISSION_ALLOWED_ASSET_IDS, 'SUBMISSION_ALLOWED_ASSET_IDS')

  if (submissionAllowedAssetIds.length > 0 && !submissionAsaReceiverWallet) {
    throw new ConfigurationError('SUBMISSION_ASA_RECEIVER_WALLET is required when SUBMISSION_ALLOWED_ASSET_IDS is set.')
  }

  return {
    service: {
      name: 'algorand-api-gateway',
      env: env.NODE_ENV || 'development',
      publicBaseUrl: emptyToNull(env.PUBLIC_BASE_URL),
    },
    server: {
      host: env.HOST || '0.0.0.0',
      port: parseInteger(env.PORT, 8443, 1, 65535, 'PORT'),
      trustProxy: parseBoolean(env.TRUST_PROXY, false),
      tlsCertFile,
      tlsKeyFile,
      mtlsRequired,
      mtlsCaFile,
      requestTimeoutMs: parseInteger(env.REQUEST_TIMEOUT_MS, 30000, 1000, 300000, 'REQUEST_TIMEOUT_MS'),
      headersTimeoutMs: parseInteger(env.HEADERS_TIMEOUT_MS, 10000, 1000, 120000, 'HEADERS_TIMEOUT_MS'),
    },
    upstream: {
      algod: {
        url: normalizeRequiredUrl(env.ALGOD_URL, 'ALGOD_URL'),
        token: env.ALGOD_TOKEN || '',
        tokenHeader: env.ALGOD_TOKEN_HEADER || 'X-Algo-API-Token',
      },
      indexer: {
        url: indexerUrl,
        token: env.INDEXER_TOKEN || '',
        tokenHeader: env.INDEXER_TOKEN_HEADER || 'X-Indexer-API-Token',
      },
      requireIndexer,
      timeoutMs: parseInteger(env.UPSTREAM_TIMEOUT_MS, 8000, 500, 120000, 'UPSTREAM_TIMEOUT_MS'),
      retryAttempts: parseInteger(env.UPSTREAM_RETRY_ATTEMPTS, 2, 0, 5, 'UPSTREAM_RETRY_ATTEMPTS'),
    },
    network: {
      enforceMainnet: parseBoolean(env.ENFORCE_MAINNET, true),
      expectedGenesisId: env.EXPECTED_GENESIS_ID || MAINNET_GENESIS_ID,
      expectedGenesisHash: env.EXPECTED_GENESIS_HASH || MAINNET_GENESIS_HASH,
      verifyTtlMs: parseInteger(env.NETWORK_VERIFY_TTL_MS, 60000, 1000, 3600000, 'NETWORK_VERIFY_TTL_MS'),
    },
    audit: {
      receiverWallet: emptyToNull(env.AUDIT_RECEIVER_WALLET),
    },
    submission: {
      asaReceiverWallet: submissionAsaReceiverWallet,
      allowedAssetIds: submissionAllowedAssetIds,
    },
    auth: {
      apiKeyHashes,
      allowUnauthenticated,
      readinessPublic: parseBoolean(env.READINESS_PUBLIC, false),
    },
    security: {
      ipAllowlist: parseList(env.IP_ALLOWLIST),
      corsAllowedOrigins: parseList(env.CORS_ALLOWED_ORIGINS),
      maxBodyBytes: parseInteger(env.MAX_BODY_BYTES, 1048576, 1024, 10485760, 'MAX_BODY_BYTES'),
    },
    rateLimit: {
      enabled: parseBoolean(env.RATE_LIMIT_ENABLED, true),
      perMinute: parseInteger(env.RATE_LIMIT_PER_MINUTE, 600, 1, 100000, 'RATE_LIMIT_PER_MINUTE'),
      burst: parseInteger(env.RATE_LIMIT_BURST, 120, 1, 100000, 'RATE_LIMIT_BURST'),
    },
    idempotency: {
      ttlMs: parseInteger(env.IDEMPOTENCY_TTL_MS, 86400000, 1000, 604800000, 'IDEMPOTENCY_TTL_MS'),
    },
    pagination: {
      defaultPageLimit,
      maxPageLimit,
    },
  }
}

export function parseApiKeyHashes(env) {
  const hashes = []

  for (const value of parseList(env.BANK_API_KEY_HASHES)) {
    hashes.push(parseHashValue(value))
  }

  for (const value of parseList(env.BANK_API_KEYS)) {
    hashes.push(sha256Buffer(value))
  }

  return hashes
}

function parseHashValue(value) {
  const normalized = value.startsWith('sha256:') ? value.slice('sha256:'.length) : value

  if (/^[a-fA-F0-9]{64}$/.test(normalized)) {
    return Buffer.from(normalized, 'hex')
  }

  const base64 = Buffer.from(normalized, 'base64')
  if (base64.length === 32) {
    return base64
  }

  throw new ConfigurationError('BANK_API_KEY_HASHES must contain sha256 hex or base64 values.')
}

function parseOptionalAlgorandAddress(value, name) {
  if (!value) {
    return null
  }

  try {
    return normalizeAlgorandAddress(value)
  } catch {
    throw new ConfigurationError(`${name} must be a valid Algorand address.`)
  }
}

function parseUInt64List(value, name) {
  return parseList(value).map((item) => {
    try {
      return assertUInt64(item, name)
    } catch {
      throw new ConfigurationError(`${name} must contain comma-separated uint64 asset IDs.`)
    }
  })
}

function parseBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase())
}

function parseInteger(value, defaultValue, min, max, name) {
  if (value === undefined || value === null || value === '') {
    return defaultValue
  }

  if (!/^-?\d+$/.test(String(value).trim())) {
    throw new ConfigurationError(`${name} must be an integer.`)
  }

  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw new ConfigurationError(`${name} must be between ${min} and ${max}.`)
  }

  return parsed
}

function normalizeRequiredUrl(value, name) {
  if (!value) {
    throw new ConfigurationError(`${name} is required.`)
  }

  return normalizeUrl(value, name)
}

function normalizeOptionalUrl(value, name) {
  if (!value) {
    return null
  }

  return normalizeUrl(value, name)
}

function normalizeUrl(value, name) {
  let parsed
  try {
    parsed = new URL(value)
  } catch {
    throw new ConfigurationError(`${name} must be a valid URL.`)
  }

  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new ConfigurationError(`${name} must use http or https.`)
  }

  return parsed.toString().replace(/\/+$/, '')
}

function parseList(value) {
  if (!value) {
    return []
  }

  return String(value)
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
}

function emptyToNull(value) {
  return value === undefined || value === null || value === '' ? null : value
}
