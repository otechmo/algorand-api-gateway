import { loadConfig } from './config.js'
import { ConfigurationError } from './errors.js'
import { createGatewayServer } from './server.js'

let server

try {
  const config = loadConfig()
  server = createGatewayServer(config)

  server.listen(config.server.port, config.server.host, () => {
    const scheme = config.server.tlsCertFile ? 'https' : 'http'
    console.log(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'info',
        message: 'algorand-api-gateway started',
        address: `${scheme}://${config.server.host}:${config.server.port}`,
      }),
    )
  })

  process.on('SIGTERM', shutdown)
  process.on('SIGINT', shutdown)
} catch (error) {
  if (error instanceof ConfigurationError) {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: 'error',
        message: error.message,
      }),
    )
    process.exit(78)
  }

  throw error
}

function shutdown() {
  if (!server) {
    process.exit(0)
  }

  server.close((error) => {
    if (error) {
      console.error(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          level: 'error',
          message: 'shutdown failed',
          error: error.message,
        }),
      )
      process.exit(1)
    }

    process.exit(0)
  })
}
