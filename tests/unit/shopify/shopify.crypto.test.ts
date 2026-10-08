import crypto from 'crypto'
import {
  decryptShopifyToken,
  encryptShopifyToken,
  isValidShopDomain,
  readIntentId,
  signIntentId,
  toGid,
  verifyOAuthQueryHmac,
  verifyWebhookHmac,
} from '@/services/commerce-channels/shopify/shopify.crypto'

describe('shopify.crypto', () => {
  const secret = 'secreto-de-prueba'
  beforeAll(() => {
    process.env.OAUTH_STATE_SECRET = 'estado-de-prueba'
    process.env.SHOPIFY_TOKEN_KEY = 'b'.repeat(64)
  })

  it('acepta la firma base64 del cuerpo crudo y rechaza la alterada', () => {
    const body = Buffer.from('{"available":4}')
    const firma = crypto.createHmac('sha256', secret).update(body).digest('base64')
    expect(verifyWebhookHmac(body, firma, secret)).toBe(true)
    expect(verifyWebhookHmac(Buffer.from('{"available":5}'), firma, secret)).toBe(false)
    expect(verifyWebhookHmac(body, undefined, secret)).toBe(false)
    expect(verifyWebhookHmac(body, 'corta', secret)).toBe(false)
  })

  it('verifica el hmac del callback OAuth (hex de los parámetros ordenados, sin hmac)', () => {
    const q: Record<string, string> = { code: 'abc', shop: 'tienda.myshopify.com', state: 'x.y', timestamp: '1700000000' }
    const msg = Object.keys(q)
      .sort()
      .map(k => `${k}=${q[k]}`)
      .join('&')
    const hmac = crypto.createHmac('sha256', secret).update(msg).digest('hex')
    expect(verifyOAuthQueryHmac({ ...q, hmac }, secret)).toBe(true)
    expect(verifyOAuthQueryHmac({ ...q, code: 'otro', hmac }, secret)).toBe(false)
  })

  it('valida el dominio de la tienda', () => {
    expect(isValidShopDomain('mi-tienda.myshopify.com')).toBe(true)
    expect(isValidShopDomain('evil.com')).toBe(false)
    expect(isValidShopDomain('x.myshopify.com.evil.com')).toBe(false)
    expect(isValidShopDomain('-x.myshopify.com')).toBe(false)
  })

  it('firma y lee el id del intent; rechaza uno manipulado', () => {
    const s = signIntentId('cint123')
    expect(readIntentId(s)).toBe('cint123')
    expect(readIntentId(s.replace('cint123', 'cint999'))).toBeNull()
    expect(readIntentId('basura')).toBeNull()
  })

  it('cifra y descifra el token; el cifrado no lleva el token en claro', () => {
    const blob = encryptShopifyToken('shpat_secreto')
    expect(Buffer.from(blob).toString('utf8')).not.toContain('shpat_secreto')
    expect(decryptShopifyToken(blob)).toBe('shpat_secreto')
  })

  it('arma gids', () => {
    expect(toGid('InventoryItem', 42)).toBe('gid://shopify/InventoryItem/42')
  })
})
