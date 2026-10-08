import { createServer, type Server } from 'http'
import request from 'supertest'

let ipv6: Server
let ipv4: Server
let port: number

beforeAll(async () => {
  ipv6 = createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ owner: 'ipv6' }))
  })
  await new Promise<void>(resolve => ipv6.listen({ port: 0, host: '::', ipv6Only: true }, resolve))
  port = (ipv6.address() as { port: number }).port

  // Same port, different address family: the old client reaches this decoy.
  ipv4 = createServer((_req, res) => {
    res.statusCode = 501
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ owner: 'ipv4' }))
  })
  await new Promise<void>((resolve, reject) => {
    ipv4.once('error', reject)
    ipv4.listen(port, '127.0.0.1', resolve)
  })
})

afterAll(async () => {
  await Promise.all(
    [ipv6, ipv4].filter(Boolean).map(
      server =>
        new Promise<void>(resolve => {
          server.closeAllConnections()
          server.close(() => resolve())
        }),
    ),
  )
})

it('connects to the supplied IPv6 server even when IPv4 owns the same port', async () => {
  const response = await request(ipv6).get('/ownership')
  expect(response.status).toBe(200)
  expect(response.body).toEqual({ owner: 'ipv6' })
})

it('preserves explicitly supplied IPv4 servers and URLs', async () => {
  for (const target of [ipv4, `http://127.0.0.1:${port}`]) {
    const response = await request(target).get('/ownership')
    expect(response.status).toBe(501)
    expect(response.body).toEqual({ owner: 'ipv4' })
  }
})

it('preserves the automatic server creation and teardown for request(app)', async () => {
  const app = createServer((_req, res) => res.end('owned'))
  const response = await request(app).get('/ownership')
  expect(response.status).toBe(200)
  expect(response.text).toBe('owned')
  expect(app.address()).toBeNull()
})

it('connects to an explicitly bound IPv6 loopback address', async () => {
  const app = createServer((_req, res) => res.end('ipv6-loopback'))
  await new Promise<void>(resolve => app.listen(0, '::1', resolve))
  try {
    const response = await request(app).get('/ownership')
    expect(response.status).toBe(200)
    expect(response.text).toBe('ipv6-loopback')
  } finally {
    app.closeAllConnections()
    await new Promise<void>(resolve => app.close(() => resolve()))
  }
})
