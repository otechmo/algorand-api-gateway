import { HttpError } from './errors.js'

const RETRYABLE_STATUSES = new Set([429, 502, 503, 504])

export class UpstreamClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.config = config
    this.fetch = fetchImpl
    this.networkCache = null
  }

  async request(service, options) {
    const serviceConfig = this.getServiceConfig(service)
    const retrySafe = options.retrySafe ?? (options.method === undefined || options.method === 'GET')
    const maxAttempts = retrySafe ? this.config.upstream.retryAttempts + 1 : 1
    let lastError

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await this.fetchOnce(service, serviceConfig, options)
        if (response.status >= 200 && response.status < 300) {
          return response
        }

        if (attempt < maxAttempts && RETRYABLE_STATUSES.has(response.status)) {
          await delay(backoffMs(attempt))
          continue
        }

        throw upstreamHttpError(service, response)
      } catch (error) {
        lastError = error

        if (error instanceof HttpError) {
          throw error
        }

        if (attempt < maxAttempts) {
          await delay(backoffMs(attempt))
          continue
        }
      }
    }

    throw new HttpError(504, 'upstream_timeout', `${service} did not respond in time.`, {
      cause: lastError,
      details: { service },
    })
  }

  async verifyNetwork(options = {}) {
    if (!this.config.network.enforceMainnet) {
      return {
        verified: false,
        reason: 'disabled',
      }
    }

    if (!options.force && this.networkCache && Date.now() < this.networkCache.expiresAt) {
      return this.networkCache.value
    }

    const response = await this.request('algod', {
      method: 'GET',
      path: '/v2/transactions/params',
      requestId: options.requestId,
      retrySafe: true,
    })

    const genesisId = response.data['genesis-id'] || response.data.genesisID
    const genesisHash = response.data['genesis-hash'] || response.data.genesisHash
    const expectedGenesisId = this.config.network.expectedGenesisId
    const expectedGenesisHash = this.config.network.expectedGenesisHash

    if (genesisId !== expectedGenesisId || genesisHash !== expectedGenesisHash) {
      throw new HttpError(503, 'network_mismatch', 'Configured algod endpoint is not Algorand MainNet.', {
        details: {
          expectedGenesisId,
          expectedGenesisHash,
          actualGenesisId: genesisId,
          actualGenesisHash: genesisHash,
        },
      })
    }

    const value = {
      verified: true,
      genesisId,
      genesisHash,
    }

    this.networkCache = {
      value,
      expiresAt: Date.now() + this.config.network.verifyTtlMs,
    }

    return value
  }

  async checkReadiness(requestId) {
    const checks = {}
    let ready = true

    try {
      const status = await this.request('algod', {
        method: 'GET',
        path: '/v2/status',
        requestId,
        retrySafe: true,
      })
      checks.algod = {
        ok: true,
        lastRound: status.data['last-round'],
      }
    } catch (error) {
      ready = false
      checks.algod = readinessFailure(error)
    }

    try {
      const network = await this.verifyNetwork({ requestId, force: true })
      checks.network = {
        ok: true,
        ...network,
      }
    } catch (error) {
      ready = false
      checks.network = readinessFailure(error)
    }

    if (this.config.upstream.indexer.url) {
      try {
        await this.request('indexer', {
          method: 'GET',
          path: '/health',
          requestId,
          retrySafe: true,
        })
        checks.indexer = {
          ok: true,
        }
      } catch (error) {
        checks.indexer = readinessFailure(error)
        if (this.config.upstream.requireIndexer) {
          ready = false
        }
      }
    } else {
      checks.indexer = {
        ok: false,
        code: 'not_configured',
      }

      if (this.config.upstream.requireIndexer) {
        ready = false
      }
    }

    return {
      ready,
      checks,
    }
  }

  getServiceConfig(service) {
    if (service === 'algod') {
      return this.config.upstream.algod
    }

    if (service === 'indexer') {
      if (!this.config.upstream.indexer.url) {
        throw new HttpError(503, 'indexer_not_configured', 'Indexer is not configured.')
      }

      return this.config.upstream.indexer
    }

    throw new HttpError(500, 'internal_error', 'Unknown upstream service.', { expose: false })
  }

  async fetchOnce(service, serviceConfig, options) {
    const url = joinUrl(serviceConfig.url, options.path)

    if (options.query) {
      for (const [key, value] of options.query.entries()) {
        url.searchParams.append(key, value)
      }
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.upstream.timeoutMs)
    const headers = {
      Accept: 'application/json',
      'X-Request-ID': options.requestId || '',
    }

    if (serviceConfig.token) {
      headers[serviceConfig.tokenHeader] = serviceConfig.token
    }

    if (options.contentType) {
      headers['Content-Type'] = options.contentType
    }

    try {
      const response = await this.fetch(url, {
        method: options.method || 'GET',
        headers,
        body: options.body,
        signal: controller.signal,
      })

      const body = Buffer.from(await response.arrayBuffer())
      const contentType = response.headers.get('content-type') || ''

      return {
        status: response.status,
        headers: response.headers,
        contentType,
        data: parseUpstreamBody(body, contentType),
      }
    } finally {
      clearTimeout(timeout)
    }
  }
}

function parseUpstreamBody(body, contentType) {
  if (body.length === 0) {
    return null
  }

  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(body.toString('utf8'))
    } catch {
      return {
        rawBodyBase64: body.toString('base64'),
      }
    }
  }

  return {
    rawBodyBase64: body.toString('base64'),
    contentType,
  }
}

function upstreamHttpError(service, response) {
  const message = response.data?.message || response.data?.error || `${service} returned HTTP ${response.status}.`
  const statusCode = response.status >= 500 ? 502 : response.status

  return new HttpError(statusCode, `${service}_error`, message, {
    details: {
      service,
      upstreamStatus: response.status,
    },
  })
}

function readinessFailure(error) {
  if (error instanceof HttpError) {
    return {
      ok: false,
      code: error.code,
      message: error.message,
    }
  }

  return {
    ok: false,
    code: 'unknown_error',
  }
}

function joinUrl(baseUrl, path) {
  const url = new URL(baseUrl)
  const basePath = url.pathname.replace(/\/+$/, '')
  const suffix = path.replace(/^\/+/, '')
  url.pathname = `${basePath}/${suffix}`
  url.search = ''
  return url
}

function backoffMs(attempt) {
  return Math.min(1000, 100 * 2 ** (attempt - 1))
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
