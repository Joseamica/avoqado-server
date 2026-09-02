import { createHash } from 'node:crypto'

const ACQUISITION_CONTEXT_HASH_DOMAIN_V3 = Buffer.from('avoqado.commercial.acquisition-context@3\0', 'ascii')
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u

export function hashCommercialAcquisitionContextTokenV3(token: string): string {
  if (typeof token !== 'string' || !TOKEN_PATTERN.test(token)) {
    throw new Error('COMMERCIAL_ACQUISITION_CONTEXT_V3_TOKEN_INVALID')
  }
  const bytes = Buffer.from(token, 'base64url')
  if (bytes.length !== 32 || bytes.toString('base64url') !== token) {
    throw new Error('COMMERCIAL_ACQUISITION_CONTEXT_V3_TOKEN_INVALID')
  }
  return createHash('sha256').update(Buffer.concat([ACQUISITION_CONTEXT_HASH_DOMAIN_V3, bytes])).digest('hex')
}
