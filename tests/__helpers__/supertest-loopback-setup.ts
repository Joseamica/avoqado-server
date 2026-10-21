import type { Server } from 'http'

// Supertest binds an unspecified server to IPv6 but always connects via IPv4.
// On this Mac those families can belong to different servers on the same port.
// Keep its request lifecycle; select the address family of the supplied server.
jest.mock('supertest', () => {
  const request = jest.requireActual('supertest') as typeof import('supertest')
  const prototype = request.Test.prototype as unknown as {
    serverAddress(server: Server, path: string): string
  }
  const original = prototype.serverAddress
  prototype.serverAddress = function (server, path) {
    const url = original.call(this, server, path)
    const address = server.address()
    if (address && typeof address !== 'string' && address.family === 'IPv6') {
      const host = address.address === '::' ? '::1' : address.address
      return url.replace('://127.0.0.1:', `://[${host}]:`)
    }
    return url
  }
  return request
})
