export class ConfigurationError extends Error {
  constructor(message) {
    super(message)
    this.name = 'ConfigurationError'
  }
}

export class HttpError extends Error {
  constructor(statusCode, code, message, options = {}) {
    super(message, options.cause ? { cause: options.cause } : undefined)
    this.name = 'HttpError'
    this.statusCode = statusCode
    this.code = code
    this.details = options.details
    this.expose = options.expose ?? statusCode < 500
    this.retryAfterSeconds = options.retryAfterSeconds
  }
}

export function isHttpError(error) {
  return error instanceof HttpError && Number.isInteger(error.statusCode)
}
