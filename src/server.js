import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'

import { createGatewayHandler } from './gateway.js'

export function createGatewayServer(config, deps = {}) {
  const handler = createGatewayHandler(config, deps)
  const tlsOptions = createTlsOptions(config)
  const server = tlsOptions ? https.createServer(tlsOptions, handler) : http.createServer(handler)

  server.requestTimeout = config.server.requestTimeoutMs
  server.headersTimeout = config.server.headersTimeoutMs
  server.keepAliveTimeout = 5000

  return server
}

function createTlsOptions(config) {
  if (!config.server.tlsCertFile && !config.server.tlsKeyFile) {
    return null
  }

  const options = {
    cert: fs.readFileSync(config.server.tlsCertFile),
    key: fs.readFileSync(config.server.tlsKeyFile),
  }

  if (config.server.mtlsCaFile) {
    options.ca = fs.readFileSync(config.server.mtlsCaFile)
    options.requestCert = true
    options.rejectUnauthorized = config.server.mtlsRequired
  }

  return options
}
