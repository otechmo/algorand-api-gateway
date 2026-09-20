import { HttpError, isHttpError } from './errors.js'

export async function readRequestBody(req, maxBytes) {
  const chunks = []
  let total = 0

  for await (const chunk of req) {
    total += chunk.length
    if (total > maxBytes) {
      throw new HttpError(413, 'payload_too_large', 'Request body is too large.')
    }

    chunks.push(chunk)
  }

  return Buffer.concat(chunks)
}

export function sendJson(res, statusCode, payload, headers = {}) {
  if (res.writableEnded) {
    return
  }

  const body = Buffer.from(JSON.stringify(payload))
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    ...headers,
  })
  res.end(body)
}

export function sendNoContent(res, headers = {}) {
  if (res.writableEnded) {
    return
  }

  res.writeHead(204, headers)
  res.end()
}

export function sendError(res, error, requestId) {
  const statusCode = isHttpError(error) ? error.statusCode : 500
  const code = isHttpError(error) ? error.code : 'internal_error'
  const message = isHttpError(error) && error.expose ? error.message : 'Internal server error.'
  const payload = {
    error: {
      code,
      message,
      requestId,
    },
  }

  if (isHttpError(error) && error.expose && error.details) {
    payload.error.details = error.details
  }

  const headers = {}
  if (isHttpError(error) && error.retryAfterSeconds) {
    headers['Retry-After'] = String(error.retryAfterSeconds)
  }

  sendJson(res, statusCode, payload, headers)
}

export function successEnvelope(ctx, data, meta = {}) {
  return {
    data,
    meta: {
      requestId: ctx.requestId,
      network: 'algorand-mainnet',
      ...meta,
    },
  }
}

export function parseJsonBuffer(buffer) {
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body must be valid JSON.')
  }
}
