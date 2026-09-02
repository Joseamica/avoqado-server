import { createHmac, randomBytes } from 'node:crypto'
import type { Request } from 'express'

const INTERNAL_COMMERCIAL_LIMITER_KEY_SEPARATOR = Buffer.from('avoqado.commercial.public-rate-limit-key@1\0', 'utf8')
export const COMMERCIAL_LIMITER_KEY_SEPARATOR = Buffer.from(INTERNAL_COMMERCIAL_LIMITER_KEY_SEPARATOR)

const PROCESS_HMAC_KEY = randomBytes(32)
const FAIL_SAFE_ADDRESS = 'commercial-address-unavailable'

export interface CommercialLimiterKeyResolverDependencies {
  processHmacKey: Uint8Array
}

export type CommercialLimiterKeyResolver = (request: Request) => string

function copyKey(value: Uint8Array): Buffer {
  const key = Buffer.from(value)
  if (key.length !== 32) throw new Error('COMMERCIAL_LIMITER_HMAC_KEY_INVALID')
  return key
}

export function createCommercialLimiterKeyResolver(
  dependencies: CommercialLimiterKeyResolverDependencies = { processHmacKey: PROCESS_HMAC_KEY },
): CommercialLimiterKeyResolver {
  const key = copyKey(dependencies.processHmacKey)
  return request => {
    const expressAddress = typeof request.ip === 'string' && request.ip.trim().length > 0 ? request.ip.trim() : undefined
    const socketAddress =
      typeof request.socket?.remoteAddress === 'string' && request.socket.remoteAddress.trim().length > 0
        ? request.socket.remoteAddress.trim()
        : undefined
    const resolvedAddress = expressAddress ?? socketAddress ?? FAIL_SAFE_ADDRESS
    return createHmac('sha256', key).update(INTERNAL_COMMERCIAL_LIMITER_KEY_SEPARATOR).update(resolvedAddress, 'utf8').digest('hex')
  }
}

export const commercialLimiterKeyResolver = createCommercialLimiterKeyResolver()
