import crypto from 'crypto'
import logger from '@/config/logger'
import {
  decryptShopifyToken,
  encryptShopifyToken,
  formaDeFirmaOAuth,
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

  // L1 (preflight-C §6d): Shopify documenta la unión DECODIFICADA, pero su biblioteca oficial firma los valores
  // CODIFICADOS (`URLSearchParams`, `+` → `%20`). El `host` del piloto termina en `==`: con una sola forma, el primer
  // callback real devolvería FIRMA. Los mensajes van escritos a mano para no depender de la implementación.
  describe('callback OAuth: las dos formas de la firma (L1)', () => {
    const hmacDe = (msg: string, s = secret) => crypto.createHmac('sha256', s).update(msg).digest('hex')
    const HOST = 'YWRtaW4uc2hvcGlmeS5jb20vc3RvcmUvYXZvcWFkby1wcnVlYmEtc3luYw==' // base64 de admin.shopify.com/store/avoqado-prueba-sync
    const base = { code: 'c1', host: HOST, shop: 'avoqado-prueba-sync.myshopify.com', state: 'cint1.f1rma', timestamp: '1700000000' }
    const CODIFICADA = `code=c1&host=${HOST.replace(/=/g, '%3D')}&shop=avoqado-prueba-sync.myshopify.com&state=cint1.f1rma&timestamp=1700000000`
    const DECODIFICADA = `code=c1&host=${HOST}&shop=avoqado-prueba-sync.myshopify.com&state=cint1.f1rma&timestamp=1700000000`

    it('el vector documentado de Shopify (secreto «hush») verifica', () => {
      const q = {
        code: '0907a61c0c8d55e99db179b68161bc00',
        hmac: '700e2dadb827fcc8609e9d5ce208b2e9cdaab9df07390d2cbca10d7c328fc4bf',
        shop: 'some-shop.myshopify.com',
        state: '0.6784241404160823',
        timestamp: '1337178173',
      }
      expect(verifyOAuthQueryHmac(q, 'hush')).toBe(true)
      expect(formaDeFirmaOAuth({ ...q, shop: 'otra.myshopify.com' }, 'hush')).toBeNull()
    })

    it('🔴 host terminado en == firmado en la forma OFICIAL (codificada) ⇒ pasa, y dice cuál', () => {
      const q = { ...base, hmac: hmacDe(CODIFICADA) }
      expect(formaDeFirmaOAuth(q, secret)).toBe('codificada')
      expect(verifyOAuthQueryHmac(q, secret)).toBe(true)
    })

    it('el mismo host firmado en la forma decodificada (la del ejemplo de la doc) ⇒ también pasa', () => {
      expect(formaDeFirmaOAuth({ ...base, hmac: hmacDe(DECODIFICADA) }, secret)).toBe('decodificada')
    })

    it('valores con «/» y «+»: cada forma verifica la suya', () => {
      const q = { ...base, host: 'Pj4+Pz8/' }
      const cod = 'code=c1&host=Pj4%2BPz8%2F&shop=avoqado-prueba-sync.myshopify.com&state=cint1.f1rma&timestamp=1700000000'
      const dec = 'code=c1&host=Pj4+Pz8/&shop=avoqado-prueba-sync.myshopify.com&state=cint1.f1rma&timestamp=1700000000'
      expect(formaDeFirmaOAuth({ ...q, hmac: hmacDe(cod) }, secret)).toBe('codificada')
      expect(formaDeFirmaOAuth({ ...q, hmac: hmacDe(dec) }, secret)).toBe('decodificada')
    })

    it('un espacio va como %20 en la forma oficial (no como «+»)', () => {
      const q = { ...base, state: 'a b' }
      const cod = CODIFICADA.replace('state=cint1.f1rma', 'state=a%20b')
      expect(formaDeFirmaOAuth({ ...q, hmac: hmacDe(cod) }, secret)).toBe('codificada')
      expect(formaDeFirmaOAuth({ ...q, hmac: hmacDe(cod.replace('a%20b', 'a+b')) }, secret)).toBeNull()
    })

    it('un valor alterado falla en las DOS formas', () => {
      for (const msg of [CODIFICADA, DECODIFICADA]) {
        expect(formaDeFirmaOAuth({ ...base, shop: 'otra.myshopify.com', hmac: hmacDe(msg) }, secret)).toBeNull()
        expect(formaDeFirmaOAuth({ ...base, host: `${HOST}x`, hmac: hmacDe(msg) }, secret)).toBeNull()
      }
    })

    it('otro secreto falla en las DOS formas', () => {
      for (const msg of [CODIFICADA, DECODIFICADA])
        expect(formaDeFirmaOAuth({ ...base, hmac: hmacDe(msg, 'otro-secreto') }, secret)).toBeNull()
    })

    it('un parámetro repetido (arreglo) se rechaza aunque la firma cuadre con su unión', () => {
      const q = { ...base, shop: ['a.myshopify.com', 'b.myshopify.com'] } as unknown as Record<string, string>
      const msg = 'code=c1&host=' + HOST + '&shop=a.myshopify.com,b.myshopify.com&state=cint1.f1rma&timestamp=1700000000'
      expect(formaDeFirmaOAuth({ ...q, hmac: hmacDe(msg) }, secret)).toBeNull()
    })

    it('`signature` queda fuera del mensaje, como antes', () => {
      expect(formaDeFirmaOAuth({ ...base, signature: 'legado', hmac: hmacDe(CODIFICADA) }, secret)).toBe('codificada')
    })

    it('registra la forma que pegó, nunca el hmac ni el secreto', () => {
      const hmac = hmacDe(CODIFICADA)
      ;(logger.info as jest.Mock).mockClear()
      verifyOAuthQueryHmac({ ...base, hmac }, secret)
      const lineas = JSON.stringify((logger.info as jest.Mock).mock.calls)
      expect(lineas).toContain('codificada')
      expect(lineas).not.toContain(hmac)
      expect(lineas).not.toContain(secret)
    })
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
