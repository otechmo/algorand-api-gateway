import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { MAINNET_GENESIS_HASH, MAINNET_GENESIS_ID } from '../src/config.js'
import { createGatewayServer } from '../src/server.js'
import { closeServer, createFixture, defaultConfig, listen, sendJson } from './fixtures.js'

test('performs a real mTLS handshake with generated CA, server, and client cert fixtures', async (t) => {
  const certs = generateMtlsCertificates(t)
  if (!certs) {
    return
  }

  const upstream = http.createServer((req, res) => {
    if (req.url === '/v2/status') {
      sendJson(res, 200, { 'last-round': 123 })
      return
    }

    sendJson(res, 404, { message: 'not found' })
  })
  const upstreamUrl = await listen(upstream)
  const config = defaultConfig(upstreamUrl, null)
  config.server.tlsCertFile = certs.serverCert
  config.server.tlsKeyFile = certs.serverKey
  config.server.mtlsCaFile = certs.caCert
  config.server.mtlsRequired = true
  config.auth.allowUnauthenticated = true
  config.upstream.indexer.url = null
  config.upstream.requireIndexer = false

  const gateway = createGatewayServer(config, { logger: { log() {}, error() {} } })
  const gatewayUrl = await listenHttps(gateway)

  try {
    const success = await httpsJson(`${gatewayUrl}/health`, {
      ca: fs.readFileSync(certs.caCert),
      cert: fs.readFileSync(certs.clientCert),
      key: fs.readFileSync(certs.clientKey),
    })
    assert.equal(success.statusCode, 200)
    assert.equal(success.body.status, 'ok')

    await assert.rejects(() =>
      httpsJson(`${gatewayUrl}/health`, {
        ca: fs.readFileSync(certs.caCert),
      }),
    )
  } finally {
    await closeServer(gateway)
    await closeServer(upstream)
  }
})

test('handles a production-like local read load without request failures', async () => {
  const fixture = await createFixture()
  try {
    const startedAt = Date.now()
    const responses = await Promise.all(Array.from({ length: 75 }, () => fixture.fetch('/v1/network/status')))
    const durationMs = Date.now() - startedAt

    assert.equal(responses.every((response) => response.status === 200), true)
    assert.ok(durationMs < 5000, `load smoke took ${durationMs}ms`)
  } finally {
    await fixture.close()
  }
})

test('recovers read-only gateway requests after a transient upstream failure', async () => {
  let statusCalls = 0
  const fixture = await createFixture({
    configOverrides: {
      upstream: {
        retryAttempts: 1,
      },
    },
    algodHandler(_req, res, request) {
      if (request.method === 'GET' && request.pathname === '/v2/status') {
        statusCalls += 1
        if (statusCalls === 1) {
          sendJson(res, 503, { message: 'temporary failover event' })
          return true
        }
      }

      return false
    },
  })

  try {
    const response = await fixture.fetch('/v1/network/status')
    assert.equal(response.status, 200)
    assert.equal(statusCalls, 2)
  } finally {
    await fixture.close()
  }
})

test('emits SIEM-ingestible structured audit logs without leaking secrets', async () => {
  const entries = []
  const logger = {
    log(line) {
      entries.push(JSON.parse(line))
    },
    error(line) {
      entries.push(JSON.parse(line))
    },
  }
  const fixture = await createFixture({ logger })

  try {
    const response = await fixture.fetch('/v1/network/status', {
      headers: {
        'X-API-Key': 'bank-secret',
        'X-Request-ID': 'siem-test-1',
      },
    })
    assert.equal(response.status, 200)

    const entry = entries.find((item) => item.requestId === 'siem-test-1')
    assert.equal(entry.method, 'GET')
    assert.equal(entry.path, '/v1/network/status')
    assert.equal(entry.statusCode, 200)
    assert.equal(typeof entry.durationMs, 'number')
    assert.equal(typeof entry.principal, 'string')

    const serialized = JSON.stringify(entry)
    assert.equal(serialized.includes('bank-secret'), false)
    assert.equal(serialized.includes('authorization'), false)
    assert.equal(serialized.includes('X-API-Key'), false)
  } finally {
    await fixture.close()
  }
})

test('container image builds and serves health when Docker certification test is enabled', { skip: process.env.ALGORAND_GATEWAY_RUN_CONTAINER_TEST !== 'true' }, async (t) => {
  const dockerInfo = spawnSync('docker', ['info'], { encoding: 'utf8' })
  if (dockerInfo.status !== 0) {
    t.skip(`Docker daemon is unavailable: ${dockerInfo.stderr || dockerInfo.stdout}`)
    return
  }

  const image = 'algorand-api-gateway:test'
  const build = spawnSync('docker', ['build', '-t', image, '.'], { encoding: 'utf8' })
  assert.equal(build.status, 0, build.stderr || build.stdout)

  const run = spawnSync(
    'docker',
    [
      'run',
      '-d',
      '-p',
      '127.0.0.1::8443',
      '-e',
      'ALGOD_URL=http://127.0.0.1:1',
      '-e',
      'BANK_API_KEYS=container-secret',
      image,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(run.status, 0, run.stderr || run.stdout)
  const containerId = run.stdout.trim()

  try {
    const port = spawnSync('docker', ['port', containerId, '8443/tcp'], { encoding: 'utf8' })
    assert.equal(port.status, 0, port.stderr || port.stdout)
    const match = port.stdout.match(/:(\d+)/)
    assert.ok(match, `Unable to parse docker port output: ${port.stdout}`)

    await waitForContainerHealth(`http://127.0.0.1:${match[1]}/health`)
  } finally {
    spawnSync('docker', ['rm', '-f', containerId], { encoding: 'utf8' })
  }
})

function generateMtlsCertificates(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'algo-gateway-mtls-'))
  t.after(() => fs.rmSync(tempDir, { recursive: true, force: true }))

  const script = String.raw`
import datetime
import ipaddress
import pathlib
import sys
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID

out = pathlib.Path(sys.argv[1])

def key():
    return rsa.generate_private_key(public_exponent=65537, key_size=2048)

def write(path, data):
    path.write_bytes(data)

def cert_name(name):
    return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, name)])

def pem_key(k):
    return k.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.TraditionalOpenSSL, serialization.NoEncryption())

ca_key = key()
ca_subject = cert_name("gateway-test-ca")
now = datetime.datetime.now(datetime.timezone.utc)
ca_cert = (
    x509.CertificateBuilder()
    .subject_name(ca_subject)
    .issuer_name(ca_subject)
    .public_key(ca_key.public_key())
    .serial_number(x509.random_serial_number())
    .not_valid_before(now - datetime.timedelta(days=1))
    .not_valid_after(now + datetime.timedelta(days=30))
    .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
    .sign(ca_key, hashes.SHA256())
)

def leaf(common_name, usage, alt_names=None):
    leaf_key = key()
    builder = (
        x509.CertificateBuilder()
        .subject_name(cert_name(common_name))
        .issuer_name(ca_subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now - datetime.timedelta(days=1))
        .not_valid_after(now + datetime.timedelta(days=30))
        .add_extension(x509.BasicConstraints(ca=False, path_length=None), critical=True)
        .add_extension(x509.ExtendedKeyUsage([usage]), critical=False)
    )
    if alt_names:
        builder = builder.add_extension(x509.SubjectAlternativeName(alt_names), critical=False)
    return leaf_key, builder.sign(ca_key, hashes.SHA256())

server_key, server_cert = leaf("localhost", ExtendedKeyUsageOID.SERVER_AUTH, [
    x509.DNSName("localhost"),
    x509.IPAddress(ipaddress.ip_address("127.0.0.1")),
])
client_key, client_cert = leaf("bank-client", ExtendedKeyUsageOID.CLIENT_AUTH)

write(out / "ca.crt", ca_cert.public_bytes(serialization.Encoding.PEM))
write(out / "server.key", pem_key(server_key))
write(out / "server.crt", server_cert.public_bytes(serialization.Encoding.PEM))
write(out / "client.key", pem_key(client_key))
write(out / "client.crt", client_cert.public_bytes(serialization.Encoding.PEM))
`

  const generated = spawnSync('python', ['-c', script, tempDir], { encoding: 'utf8' })
  if (generated.status !== 0) {
    t.skip(`Python cryptography certificate generation unavailable: ${generated.stderr || generated.stdout}`)
    return null
  }

  return {
    caCert: path.join(tempDir, 'ca.crt'),
    serverKey: path.join(tempDir, 'server.key'),
    serverCert: path.join(tempDir, 'server.crt'),
    clientKey: path.join(tempDir, 'client.key'),
    clientCert: path.join(tempDir, 'client.crt'),
  }
}

function listenHttps(server) {
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(`https://127.0.0.1:${address.port}`)
    })
  })
}

function httpsJson(url, options) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { ...options, method: 'GET' }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8')
        resolve({
          statusCode: res.statusCode,
          body: body ? JSON.parse(body) : null,
        })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

async function waitForContainerHealth(url) {
  const deadline = Date.now() + 15000
  let lastError

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.status === 200) {
        const body = await response.json()
        assert.equal(body.status, 'ok')
        return
      }
    } catch (error) {
      lastError = error
    }

    await new Promise((resolve) => setTimeout(resolve, 500))
  }

  throw lastError || new Error('Container health check timed out.')
}
