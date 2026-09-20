import {
  accountInfoQuery,
  assertAlgorandAddress,
  assertTransactionId,
  assertUInt64,
  blockQuery,
  indexerTransactionQuery,
  sanitizeQuery,
  validateIdempotencyKey,
  withDefaultLimit,
} from './validators.js'
import { HttpError } from './errors.js'
import { IdempotencyCache } from './idempotency.js'
import { TokenBucketLimiter } from './rate-limit.js'
import { UpstreamClient } from './upstream.js'
import {
  parseJsonBuffer,
  readRequestBody,
  sendError,
  sendJson,
  sendNoContent,
  successEnvelope,
} from './http-utils.js'
import {
  applyCors,
  applySecurityHeaders,
  authenticateRequest,
  enforceIpAllowlist,
  firstHeader,
  getClientIp,
  getRequestId,
} from './security.js'

export function createGatewayHandler(config, deps = {}) {
  const upstream = deps.upstream || new UpstreamClient(config, deps.fetch)
  const limiter = deps.limiter || new TokenBucketLimiter(config)
  const idempotency = deps.idempotency || new IdempotencyCache(config)
  const logger = deps.logger || console

  return async function gatewayHandler(req, res) {
    const startedAt = Date.now()
    const requestId = getRequestId(req)
    let ctx = {
      requestId,
      principal: { id: 'unknown', authenticated: false },
      ip: 'unknown',
    }

    applySecurityHeaders(res, config)
    res.setHeader('X-Request-ID', requestId)
    const corsApplied = applyCors(req, res, config)

    if (req.method === 'OPTIONS' && corsApplied) {
      sendNoContent(res)
      auditLog(logger, req, res, ctx, startedAt)
      return
    }

    try {
      const url = new URL(req.url || '/', 'http://gateway.local')

      if (url.pathname === '/health') {
        sendJson(res, 200, {
          status: 'ok',
          service: config.service.name,
          timestamp: new Date().toISOString(),
        })
        return
      }

      ctx.ip = getClientIp(req, config.server.trustProxy)
      enforceIpAllowlist(ctx.ip, config.security.ipAllowlist)

      if (url.pathname !== '/ready' || !config.auth.readinessPublic) {
        ctx.principal = authenticateRequest(req, config)
      } else {
        ctx.principal = { id: 'readiness', authenticated: false }
      }

      limiter.check(`${ctx.principal.id}:${ctx.ip}`)

      await routeRequest(req, res, url, ctx, config, upstream, idempotency)
    } catch (error) {
      sendError(res, error, requestId)
    } finally {
      auditLog(logger, req, res, ctx, startedAt)
    }
  }
}

async function routeRequest(req, res, url, ctx, config, upstream, idempotency) {
  const segments = pathSegments(url.pathname)

  if (url.pathname === '/ready') {
    assertMethod(req, 'GET')
    const readiness = await upstream.checkReadiness(ctx.requestId)
    sendJson(res, readiness.ready ? 200 : 503, {
      status: readiness.ready ? 'ready' : 'not_ready',
      checks: readiness.checks,
      meta: {
        requestId: ctx.requestId,
        network: 'algorand-mainnet',
      },
    })
    return
  }

  if (segments[0] !== 'v1') {
    throw new HttpError(404, 'not_found', 'Route not found.')
  }

  if (segments[1] === 'network' && segments[2] === 'status' && segments.length === 3) {
    assertMethod(req, 'GET')
    await proxyJson(res, ctx, upstream, 'algod', '/v2/status')
    return
  }

  if (segments[1] === 'network' && segments[2] === 'params' && segments.length === 3) {
    assertMethod(req, 'GET')
    const params = await upstream.request('algod', {
      method: 'GET',
      path: '/v2/transactions/params',
      requestId: ctx.requestId,
      retrySafe: true,
    })
    const network = await upstream.verifyNetwork({ requestId: ctx.requestId })
    sendJson(res, 200, successEnvelope(ctx, params.data, { service: 'algod', networkVerified: network.verified }))
    return
  }

  if (segments[1] === 'accounts') {
    await routeAccounts(req, res, url, segments, ctx, config, upstream)
    return
  }

  if (segments[1] === 'assets') {
    await routeAssets(req, res, url, segments, ctx, config, upstream)
    return
  }

  if (segments[1] === 'blocks' && segments.length === 3) {
    assertMethod(req, 'GET')
    const round = assertUInt64(segments[2], 'round')
    const query = sanitizeQuery(url.searchParams, blockQuery, config)
    await proxyJson(res, ctx, upstream, 'algod', `/v2/blocks/${round}`, query)
    return
  }

  if (segments[1] === 'transactions') {
    await routeTransactions(req, res, url, segments, ctx, config, upstream, idempotency)
    return
  }

  throw new HttpError(404, 'not_found', 'Route not found.')
}

async function routeAccounts(req, res, url, segments, ctx, config, upstream) {
  if (segments.length < 3) {
    throw new HttpError(404, 'not_found', 'Route not found.')
  }

  const address = assertAlgorandAddress(segments[2])

  if (segments.length === 3) {
    assertMethod(req, 'GET')
    const query = sanitizeQuery(url.searchParams, accountInfoQuery, config)
    await proxyJson(res, ctx, upstream, 'algod', `/v2/accounts/${address}`, query)
    return
  }

  if (segments[3] === 'assets' && segments.length === 5) {
    assertMethod(req, 'GET')
    const assetId = assertUInt64(segments[4], 'assetId')
    rejectQuery(url)
    await proxyJson(res, ctx, upstream, 'algod', `/v2/accounts/${address}/assets/${assetId}`)
    return
  }

  if (segments[3] === 'transactions' && segments.length === 4) {
    assertMethod(req, 'GET')
    const query = withDefaultLimit(sanitizeQuery(url.searchParams, indexerTransactionQuery, config), config)
    await proxyJson(res, ctx, upstream, 'indexer', `/v2/accounts/${address}/transactions`, query)
    return
  }

  throw new HttpError(404, 'not_found', 'Route not found.')
}

async function routeAssets(req, res, url, segments, ctx, config, upstream) {
  if (segments.length < 3) {
    throw new HttpError(404, 'not_found', 'Route not found.')
  }

  const assetId = assertUInt64(segments[2], 'assetId')

  if (segments.length === 3) {
    assertMethod(req, 'GET')
    rejectQuery(url)
    await proxyJson(res, ctx, upstream, 'algod', `/v2/assets/${assetId}`)
    return
  }

  if (segments[3] === 'transactions' && segments.length === 4) {
    assertMethod(req, 'GET')
    const query = withDefaultLimit(sanitizeQuery(url.searchParams, indexerTransactionQuery, config), config)
    if (query.has('asset-id')) {
      throw new HttpError(400, 'validation_error', 'asset-id is taken from the route path.')
    }
    query.set('asset-id', assetId)
    await proxyJson(res, ctx, upstream, 'indexer', '/v2/transactions', query)
    return
  }

  throw new HttpError(404, 'not_found', 'Route not found.')
}

async function routeTransactions(req, res, url, segments, ctx, config, upstream, idempotency) {
  if (segments[2] === 'pending' && segments.length === 4) {
    assertMethod(req, 'GET')
    const txId = assertTransactionId(segments[3])
    rejectQuery(url)
    await proxyJson(res, ctx, upstream, 'algod', `/v2/transactions/pending/${txId}`)
    return
  }

  if (segments[2] === 'simulate' && segments.length === 3) {
    assertMethod(req, 'POST')
    await submitSimulation(req, res, ctx, config, upstream)
    return
  }

  if (segments.length === 2) {
    assertMethod(req, 'POST')
    await submitTransaction(req, res, ctx, config, upstream, idempotency)
    return
  }

  if (segments.length === 3) {
    assertMethod(req, 'GET')
    const txId = assertTransactionId(segments[2])
    rejectQuery(url)
    await proxyJson(res, ctx, upstream, 'indexer', `/v2/transactions/${txId}`)
    return
  }

  throw new HttpError(404, 'not_found', 'Route not found.')
}

async function submitTransaction(req, res, ctx, config, upstream, idempotency) {
  const body = await readSignedTransactionBody(req, config)
  const idempotencyKey = validateIdempotencyKey(firstHeader(req, 'idempotency-key'))
  const replayed = idempotency.get(ctx.principal.id, idempotencyKey, body)

  if (replayed) {
    sendJson(res, replayed.statusCode, replayed.payload, { 'Idempotent-Replayed': 'true' })
    return
  }

  await upstream.verifyNetwork({ requestId: ctx.requestId })

  const upstreamResponse = await upstream.request('algod', {
    method: 'POST',
    path: '/v2/transactions',
    requestId: ctx.requestId,
    contentType: 'application/x-binary',
    body,
    retrySafe: false,
  })

  const payload = successEnvelope(ctx, upstreamResponse.data, { service: 'algod', submitted: true })
  const cached = { statusCode: 202, payload }
  idempotency.set(ctx.principal.id, idempotencyKey, body, cached)
  sendJson(res, 202, payload)
}

async function submitSimulation(req, res, ctx, config, upstream) {
  const contentType = firstHeader(req, 'content-type') || ''
  if (!contentType.includes('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'Simulation requests must use application/json.')
  }

  const body = await readRequestBody(req, config.security.maxBodyBytes)
  parseJsonBuffer(body)
  await upstream.verifyNetwork({ requestId: ctx.requestId })

  const upstreamResponse = await upstream.request('algod', {
    method: 'POST',
    path: '/v2/transactions/simulate',
    requestId: ctx.requestId,
    contentType: 'application/json',
    body,
    retrySafe: false,
  })

  sendJson(res, 200, successEnvelope(ctx, upstreamResponse.data, { service: 'algod' }))
}

async function readSignedTransactionBody(req, config) {
  const contentType = firstHeader(req, 'content-type') || 'application/octet-stream'
  const body = await readRequestBody(req, config.security.maxBodyBytes)

  if (contentType.includes('application/json')) {
    const parsed = parseJsonBuffer(body)
    const encoding = parsed.encoding || 'base64'
    const signedTransaction = parsed.signedTransaction || parsed.signedTransactionBase64

    if (encoding !== 'base64' || typeof signedTransaction !== 'string' || signedTransaction.length === 0) {
      throw new HttpError(400, 'validation_error', 'signedTransaction must be a base64 string.')
    }

    if (!isStrictBase64(signedTransaction)) {
      throw new HttpError(400, 'validation_error', 'signedTransaction must be valid base64.')
    }

    const decoded = Buffer.from(signedTransaction, 'base64')
    if (decoded.length === 0 || decoded.length > config.security.maxBodyBytes) {
      throw new HttpError(400, 'validation_error', 'signedTransaction payload is invalid.')
    }

    return decoded
  }

  if (body.length === 0) {
    throw new HttpError(400, 'validation_error', 'Signed transaction body is required.')
  }

  return body
}

async function proxyJson(res, ctx, upstream, service, path, query = new URLSearchParams()) {
  const upstreamResponse = await upstream.request(service, {
    method: 'GET',
    path,
    query,
    requestId: ctx.requestId,
    retrySafe: true,
  })

  sendJson(res, 200, successEnvelope(ctx, upstreamResponse.data, { service }))
}

function pathSegments(pathname) {
  try {
    return pathname.split('/').filter(Boolean).map((segment) => decodeURIComponent(segment))
  } catch {
    throw new HttpError(400, 'validation_error', 'Invalid URL path.')
  }
}

function assertMethod(req, expected) {
  if (req.method !== expected) {
    throw new HttpError(405, 'method_not_allowed', `Use ${expected} for this route.`)
  }
}

function rejectQuery(url) {
  if ([...url.searchParams.keys()].length > 0) {
    throw new HttpError(400, 'validation_error', 'Query parameters are not supported for this route.')
  }
}

function auditLog(logger, req, res, ctx, startedAt) {
  const level = res.statusCode >= 500 ? 'error' : 'log'
  logger[level](
    JSON.stringify({
      timestamp: new Date().toISOString(),
      requestId: ctx.requestId,
      method: req.method,
      path: safePath(req.url || '/'),
      statusCode: res.statusCode,
      durationMs: Date.now() - startedAt,
      principal: ctx.principal.id,
      ip: ctx.ip,
    }),
  )
}

function safePath(value) {
  try {
    const url = new URL(value, 'http://gateway.local')
    return url.pathname
  } catch {
    return '/'
  }
}

function isStrictBase64(value) {
  const compact = value.replace(/\s/g, '')
  return compact.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact)
}
