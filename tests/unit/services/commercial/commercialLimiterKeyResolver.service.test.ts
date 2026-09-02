import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { Request } from 'express'
import {
  COMMERCIAL_LIMITER_KEY_SEPARATOR,
  createCommercialLimiterKeyResolver,
} from '@/services/commercial/commercialLimiterKeyResolver.service'

const KEY = Buffer.alloc(32, 7)

function expected(value: string): string {
  return createHmac('sha256', KEY).update(COMMERCIAL_LIMITER_KEY_SEPARATOR).update(value).digest('hex')
}

function request(input: { ip?: string; remoteAddress?: string; headers?: Record<string, string> }): Request {
  return {
    ip: input.ip,
    socket: { remoteAddress: input.remoteAddress },
    headers: input.headers ?? {},
  } as unknown as Request
}

describe('commercial limiter key resolver', () => {
  it('prefers Express-resolved request IP and protects it with a keyed digest', () => {
    const resolve = createCommercialLimiterKeyResolver({ processHmacKey: KEY })

    expect(resolve(request({ ip: '203.0.113.8', remoteAddress: '10.0.0.8' }))).toBe(expected('203.0.113.8'))
    expect(resolve(request({ ip: '203.0.113.8' }))).not.toContain('203.0.113.8')
  })

  it('falls back to the socket address and then one fail-safe bucket', () => {
    const resolve = createCommercialLimiterKeyResolver({ processHmacKey: KEY })

    expect(resolve(request({ remoteAddress: '10.0.0.9' }))).toBe(expected('10.0.0.9'))
    expect(resolve(request({}))).toBe(expected('commercial-address-unavailable'))
  })

  it('does not let attacker forwarding metadata split the fail-safe bucket when resolved addresses are absent', () => {
    const resolve = createCommercialLimiterKeyResolver({ processHmacKey: KEY })
    const left = resolve(request({ headers: { 'cf-connecting-ip': '198.51.100.1', 'x-forwarded-for': '198.51.100.2' } }))
    const right = resolve(request({ headers: { 'cf-connecting-ip': '203.0.113.1', 'x-forwarded-for': '203.0.113.2' } }))

    expect(left).toBe(expected('commercial-address-unavailable'))
    expect(right).toBe(left)
  })

  it('keeps raw forwarding-header inspection out of both production modules', () => {
    for (const relativePath of [
      'src/services/commercial/commercialLimiterKeyResolver.service.ts',
      'src/middlewares/commercial-public-rate-limit.middleware.ts',
    ]) {
      const text = fs.readFileSync(path.resolve(process.cwd(), relativePath), 'utf8').toLowerCase()
      expect(text).not.toContain('cf-connecting-ip')
      expect(text).not.toContain('x-forwarded-for')
    }
  })
})
