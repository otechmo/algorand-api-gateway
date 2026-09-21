import { loadConfig } from './config.js'
import { ConfigurationError } from './errors.js'
import { createGatewayHandler } from './gateway.js'

export function createFetchHandler(config, deps = {}) {
  const gatewayHandler = createGatewayHandler(config, deps)

  return async function fetchHandler(request) {
    const req = new FetchBackedRequest(request)
    const res = new FetchBackedResponse()

    await gatewayHandler(req, res)
    return res.toResponse(request.method)
  }
}

export function createLazyProductionFetchHandler() {
  let handler
  let startupError

  return async function productionFetchHandler(request) {
    if (!handler && !startupError) {
      try {
        handler = createFetchHandler(loadConfig())
      } catch (error) {
        startupError = error
      }
    }

    if (startupError) {
      const message =
        startupError instanceof ConfigurationError ? startupError.message : 'Gateway configuration failed.'
      return Response.json(
        {
          error: {
            code: 'configuration_error',
            message,
          },
        },
        { status: 500 },
      )
    }

    return handler(request)
  }
}

class FetchBackedRequest {
  constructor(request) {
    const url = new URL(request.url)
    this.headers = headersToNodeObject(request.headers)
    this.method = request.method
    this.url = gatewayUrlFromRequestUrl(url, this.headers)
    this.socket = {
      remoteAddress: clientIpFromHeaders(this.headers),
    }
    this.request = request
    this.bodyBuffer = null
  }

  async *[Symbol.asyncIterator]() {
    if (this.bodyBuffer === null) {
      this.bodyBuffer = Buffer.from(await this.request.arrayBuffer())
    }

    if (this.bodyBuffer.length > 0) {
      yield this.bodyBuffer
    }
  }
}

class FetchBackedResponse {
  constructor() {
    this.statusCode = 200
    this.headers = new Headers()
    this.body = Buffer.alloc(0)
    this.writableEnded = false
  }

  setHeader(name, value) {
    this.headers.set(name, headerValueToString(value))
  }

  writeHead(statusCode, headers = {}) {
    this.statusCode = statusCode

    for (const [name, value] of Object.entries(headers)) {
      this.setHeader(name, value)
    }
  }

  end(body = '') {
    if (this.writableEnded) {
      return
    }

    this.body = Buffer.isBuffer(body) ? body : Buffer.from(String(body))
    this.writableEnded = true
  }

  toResponse(method) {
    return new Response(method === 'HEAD' ? null : this.body, {
      status: this.statusCode,
      headers: this.headers,
    })
  }
}

function gatewayUrlFromRequestUrl(url, headers = {}) {
  const gatewayPath = getCapturedGatewayPath(url, headers)
  if (gatewayPath) {
    const normalizedPath = gatewayPath.startsWith('/') ? gatewayPath : `/${gatewayPath}`
    return `${normalizedPath}${externalSearch(url.searchParams)}`
  }

  return `${url.pathname}${url.search}`
}

function externalSearch(searchParams) {
  const external = new URLSearchParams()

  for (const [key, value] of searchParams.entries()) {
    if (!isInternalRouteParam(key)) {
      external.append(key, value)
    }
  }

  const value = external.toString()
  return value ? `?${value}` : ''
}

function isInternalRouteParam(key) {
  return ['gatewaypath', 'path'].includes(key.toLowerCase())
}

function getCapturedGatewayPath(url, headers) {
  for (const key of ['gatewayPath', 'path']) {
    const value = url.searchParams.get(key)
    if (isCapturedPath(value)) {
      return value
    }
  }

  const routeMatches = headers['x-now-route-matches']
  if (routeMatches) {
    const params = new URLSearchParams(routeMatches)
    for (const key of ['gatewayPath', 'path']) {
      const value = params.get(key)
      if (isCapturedPath(value)) {
        return value
      }
    }
  }

  return null
}

function isCapturedPath(value) {
  return Boolean(value && value !== ':path*' && value !== '/:path*')
}

function headersToNodeObject(headers) {
  const output = {}
  for (const [name, value] of headers.entries()) {
    output[name.toLowerCase()] = value
  }

  return output
}

function clientIpFromHeaders(headers) {
  const forwarded = headers['x-forwarded-for']
  if (forwarded) {
    return forwarded.split(',')[0].trim()
  }

  return headers['x-real-ip'] || '0.0.0.0'
}

function headerValueToString(value) {
  if (Array.isArray(value)) {
    return value.join(', ')
  }

  return String(value)
}
