import {
  accountInfoQuery,
  assertAlgorandAddress,
  assertTransactionId,
  assertUInt64,
  blockQuery,
  commonQuery,
  indexerTransactionQuery,
  sanitizeQuery,
  validateIdempotencyKey,
  withDefaultLimit,
} from './validators.js'
import { hashCanonicalJson } from './audit-hash.js'
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
      stripInternalRouteParams(url)
      normalizePathApiKeyRoute(url, req)

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

  if (segments[1] === 'audit' && segments[2] === 'evidence' && segments.length === 3) {
    await routeAuditEvidence(req, res, url, ctx, config, upstream)
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

async function routeAuditEvidence(req, res, url, ctx, config, upstream) {
  assertMethod(req, 'GET')
  const options = parseAuditEvidenceOptions(url, config)
  const capturedAt = new Date().toISOString()
  const startedAt = Date.now()

  const readiness = await upstream.checkReadiness(ctx.requestId)
  const status = await upstream.request('algod', {
    method: 'GET',
    path: '/v2/status',
    requestId: ctx.requestId,
    retrySafe: true,
  })
  const params = await upstream.request('algod', {
    method: 'GET',
    path: '/v2/transactions/params',
    requestId: ctx.requestId,
    retrySafe: true,
  })
  const network = await upstream.verifyNetwork({ requestId: ctx.requestId })
  const account = await upstream.request('algod', {
    method: 'GET',
    path: `/v2/accounts/${options.wallet}`,
    requestId: ctx.requestId,
    retrySafe: true,
  })
  const transactionQuery = new URLSearchParams()
  transactionQuery.set('limit', options.limit)
  const transactions = await upstream.request('indexer', {
    method: 'GET',
    path: `/v2/accounts/${options.wallet}/transactions`,
    query: transactionQuery,
    requestId: ctx.requestId,
    retrySafe: true,
  })

  const evidence = buildAuditEvidence({
    capturedAt,
    ctx,
    config,
    wallet: options.wallet,
    readiness,
    status: status.data,
    params: params.data,
    network,
    account: account.data,
    transactions: transactions.data,
    latencyMs: Date.now() - startedAt,
  })
  evidence.audit.evidenceHash = hashCanonicalJson(evidence)
  evidence.audit.reportText = buildAuditReportText(evidence)

  sendJson(res, 200, successEnvelope(ctx, evidence, { service: 'gateway', evidenceType: 'audit-evidence' }), {
    'Content-Disposition': `attachment; filename="${auditEvidenceFilename(capturedAt)}"`,
  })
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

function parseAuditEvidenceOptions(url, config) {
  const supported = new Set(['wallet', 'limit'])
  for (const key of url.searchParams.keys()) {
    if (!supported.has(key)) {
      throw new HttpError(400, 'validation_error', `Unsupported query parameter: ${key}.`)
    }
  }

  const wallet = assertAlgorandAddress(url.searchParams.get('wallet') || config.audit.receiverWallet)
  const limit = url.searchParams.has('limit')
    ? commonQuery.limit(url.searchParams.get('limit'), config)
    : String(Math.min(10, config.pagination.maxPageLimit))

  return {
    wallet,
    limit,
  }
}

function buildAuditEvidence({ capturedAt, ctx, config, wallet, readiness, status, params, network, account, transactions, latencyMs }) {
  const auditId = `ALG-${capturedAt.slice(0, 10).replace(/-/g, '')}-${ctx.requestId.replace(/-/g, '').slice(0, 8).toUpperCase()}`
  const publicBaseUrl = config.service.publicBaseUrl || null
  const txList = Array.isArray(transactions?.transactions) ? transactions.transactions : []
  const sampleTransaction = txList[0] || null

  return {
    audit: {
      title: 'FULL AUDIT EVIDENCE - ALGORAND MAINNET API GATEWAY',
      auditId,
      classification: 'CONFIDENTIAL - INSTITUTIONAL USE ONLY',
      generatedAt: capturedAt,
      auditor: 'AUTOMATED CRYPTOGRAPHIC SYSTEM AUDIT',
      requestId: ctx.requestId,
      evidenceHash: null,
      reportText: null,
    },
    gateway: {
      service: config.service.name,
      environment: config.service.env,
      publicBaseUrl,
      bankEndpointTemplate: publicBaseUrl ? `${publicBaseUrl}/v2/<BANK_API_KEY>/audit/evidence` : '/v2/<BANK_API_KEY>/audit/evidence',
      keyDisclosure: 'API key is authenticated but not returned in this evidence payload.',
    },
    connectionStatus: {
      status: readiness.ready ? 'CONNECTED' : 'DEGRADED',
      network: 'Algorand MainNet',
      genesisId: network.genesisId,
      genesisHash: network.genesisHash,
      currentRound: status?.['last-round'] ?? null,
      suggestedFeeMicroAlgos: params?.fee ?? null,
      minFeeMicroAlgos: params?.['min-fee'] ?? null,
      latencyMs,
      algodOk: readiness.checks.algod?.ok === true,
      indexerOk: readiness.checks.indexer?.ok === true,
      mainnetVerified: network.verified === true,
      readinessChecks: readiness.checks,
      errors: readiness.ready ? 0 : 1,
    },
    walletEvidence: {
      address: wallet,
      account,
      transactionSearch: {
        limit: Number(transactions?.transactions?.length ?? 0),
        currentRound: transactions?.['current-round'] ?? null,
        nextToken: transactions?.['next-token'] ?? null,
        transactions: txList,
      },
      sampleTransaction: sampleTransaction
        ? {
            id: sampleTransaction.id,
            type: sampleTransaction['tx-type'],
            confirmedRound: sampleTransaction['confirmed-round'],
            sender: sampleTransaction.sender,
            roundTime: sampleTransaction['round-time'],
          }
        : null,
    },
    bankFileInstructions: {
      recommendedFilename: auditEvidenceFilename(capturedAt),
      contentType: 'application/json',
      saveInstruction: 'Save this response body as the evidence JSON file for the bank audit pack.',
      canGeneratePdf: true,
      pdfInstruction: 'The bank can render this JSON into its internal PDF or compliance report template.',
    },
    settlementReconciliationRequirements: {
      providedByGateway: [
        'MainNet connection status',
        'Genesis verification',
        'Current round and transaction parameters',
        'Receiver wallet account evidence',
        'Indexer-backed transaction history',
        'Request ID for SIEM correlation',
      ],
      requiredFromBankSystems: [
        'Payment reference',
        'UETR',
        'pacs.008.001.08 file or JSON',
        'Nostro debit record',
        'Settlement amount and currency or asset ID',
        'HMAC signature and body hash',
        'Final reconciliation status',
      ],
    },
  }
}

function buildAuditReportText(evidence) {
  const sample = evidence.walletEvidence.sampleTransaction
  return [
    '===============================================================================',
    ' FULL AUDIT EVIDENCE - ALGORAND MAINNET API GATEWAY',
    '===============================================================================',
    ` AUDIT ID: ${evidence.audit.auditId}`,
    ` EVIDENCE HASH: ${evidence.audit.evidenceHash}`,
    ` GENERATED: ${evidence.audit.generatedAt}`,
    ` CLASSIFICATION: ${evidence.audit.classification}`,
    '===============================================================================',
    ' [1] ALGORAND GATEWAY CONNECTION STATUS',
    '-------------------------------------------------------------------------------',
    ` Status: ${evidence.connectionStatus.status}`,
    ` Network: ${evidence.connectionStatus.network}`,
    ` Current Round: ${evidence.connectionStatus.currentRound}`,
    ` Genesis ID: ${evidence.connectionStatus.genesisId}`,
    ` Genesis Hash: ${evidence.connectionStatus.genesisHash}`,
    ` Suggested Fee: ${evidence.connectionStatus.suggestedFeeMicroAlgos} microAlgos`,
    ` Min Fee: ${evidence.connectionStatus.minFeeMicroAlgos} microAlgos`,
    ` Latency: ${evidence.connectionStatus.latencyMs}ms`,
    ` Errors: ${evidence.connectionStatus.errors}`,
    ` Gateway Endpoint: ${evidence.gateway.bankEndpointTemplate}`,
    ' [2] RECEIVER WALLET ON-CHAIN EVIDENCE',
    '-------------------------------------------------------------------------------',
    ` Wallet: ${evidence.walletEvidence.address}`,
    ` Transaction Evidence Count: ${evidence.walletEvidence.transactionSearch.limit}`,
    sample ? ` Sample Transaction ID: ${sample.id}` : ' Sample Transaction ID: none',
    sample ? ` Sample Confirmed Round: ${sample.confirmedRound}` : ' Sample Confirmed Round: none',
    ' [3] BANK SETTLEMENT FILE REQUIREMENTS',
    '-------------------------------------------------------------------------------',
    ' Bank should add UETR, pacs.008, Nostro debit, amount, HMAC, body hash, and final reconciliation status.',
    '===============================================================================',
  ].join('\n')
}

function auditEvidenceFilename(capturedAt) {
  return `algorand-mainnet-audit-evidence-${capturedAt.slice(0, 10)}.json`
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

function stripInternalRouteParams(url) {
  url.searchParams.delete('gatewayPath')
}

function normalizePathApiKeyRoute(url, req) {
  const segments = url.pathname.split('/').filter(Boolean)
  if (segments[0] !== 'v2' || !segments[1]) {
    return
  }

  req.pathApiKey = decodeRouteSegment(segments[1])

  const route = segments.slice(2).join('/')
  if (!route || route === 'status') {
    url.pathname = '/v1/network/status'
    return
  }

  if (route === 'params') {
    url.pathname = '/v1/network/params'
    return
  }

  if (route === 'ready') {
    url.pathname = '/ready'
    return
  }

  if (route === 'health') {
    url.pathname = '/health'
    return
  }

  url.pathname = route.startsWith('v1/') ? `/${route}` : `/v1/${route}`
}

function decodeRouteSegment(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new HttpError(400, 'validation_error', 'Invalid API key path segment.')
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
    return redactPathApiKey(url.pathname)
  } catch {
    return '/'
  }
}

function redactPathApiKey(pathname) {
  const segments = pathname.split('/').filter(Boolean)
  if (segments[0] === 'v2' && segments[1]) {
    segments[1] = '[REDACTED]'
    return `/${segments.join('/')}`
  }

  return pathname
}

function isStrictBase64(value) {
  const compact = value.replace(/\s/g, '')
  return compact.length % 4 !== 1 && /^[A-Za-z0-9+/]*={0,2}$/.test(compact)
}
