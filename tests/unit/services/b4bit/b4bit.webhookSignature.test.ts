/**
 * 🔴 SEGURIDAD — el webhook de cripto (b4bit) tiene que EXIGIR la firma.
 *
 * ── El agujero ──────────────────────────────────────────────────────────────
 * El handler verificaba la firma dentro de un `if (signature && nonce)`: **omitir
 * los dos headers se saltaba la verificación entera**. Y aun mandándolos, un venue
 * sin `b4bitSecretKey` caía en un `return true` de `verifyWebhookSignature`.
 *
 * Con cualquiera de las dos puertas, un tercero que conociera el `reference` (el
 * id de nuestro `Payment`) podía mandar `{"status":"CO"}` y dejar el cobro
 * COMPLETED y la cuenta PAGADA sin que llegara un centavo de cripto.
 *
 * ── Lo que estos tests fijan ────────────────────────────────────────────────
 * 1. Sin headers de firma → 401 y `processWebhook` NUNCA corre.
 * 2. Sin secreto del venue → 503 (en producción y, fuera de ella, salvo que se
 *    prenda el flag explícito `B4BIT_ALLOW_UNSIGNED_WEBHOOKS`).
 * 3. Firma inválida o nonce viejo → 401 (antes: 200 y "seguimos").
 * 4. La firma se calcula sobre los BYTES CRUDOS. b4bit serializa con `requests`
 *    de Python (espacio tras `,` y `:`), así que re-serializar con
 *    `JSON.stringify` produce OTRO HMAC y jamás validaría.
 * 5. El algoritmo no se movió: el vector oficial de la doc de b4bit sigue dando
 *    la misma firma.
 * 6. La válvula de despliegue `B4BIT_STRICT_WEBHOOK_AUTH=false` vuelve al
 *    comportamiento viejo pero dejando un `logger.error` greppable.
 */

// ── Mocks ────────────────────────────────────────────────────────────────────
// El servicio arrastra sockets, recibos y el guard de ventas al importarse; nada
// de eso está bajo prueba. `processWebhook` se mockea para poder afirmar que un
// webhook rechazado NO llega a tocar dinero.

jest.mock('@/utils/prismaClient', () => {
  const client: any = {
    payment: { findUnique: jest.fn() },
    venueCryptoConfig: { findUnique: jest.fn(), update: jest.fn() },
  }
  return { __esModule: true, default: client }
})

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/communication/sockets/managers/socketManager', () => ({
  socketManager: { broadcastToVenue: jest.fn() },
}))

jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  generateDigitalReceipt: jest.fn().mockResolvedValue({ accessKey: 'recibo-test' }),
  generateReceiptUrl: jest.fn().mockReturnValue('https://recibo.test/abc'),
}))

jest.mock('@/services/venueSalesGuard', () => ({
  assertVenueSalesEnabled: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

const mockProcessWebhook = jest.fn()
jest.mock('@/services/b4bit/b4bit.service', () => {
  const actual = jest.requireActual('@/services/b4bit/b4bit.service')
  return { __esModule: true, ...actual, processWebhook: (...args: any[]) => mockProcessWebhook(...args) }
})

import crypto from 'crypto'
import type { Request, Response } from 'express'

import logger from '@/config/logger'
import { handleB4BitWebhook } from '@/controllers/tpv/b4bit-webhook.tpv.controller'
import { verifyWebhookSignature } from '@/services/b4bit/b4bit.service'
import { completeCryptoSetup } from '@/services/dashboard/cryptoConfig.dashboard.service'
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as unknown as {
  payment: { findUnique: jest.Mock }
  venueCryptoConfig: { findUnique: jest.Mock; update: jest.Mock }
}
const mockLogger = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock }

// ── Fixtures ─────────────────────────────────────────────────────────────────

const VENUE_ID = 'cvenue0000000000000000001'
const PAYMENT_ID = 'cpay000000000000000000001'
/** Secreto de venue con la forma real: hex de 64 (32 bytes). */
const VENUE_SECRET = 'a'.repeat(64)

/** Cuerpo con el formato REAL de b4bit: `requests` de Python deja espacios. */
const b4bitBody = (status = 'CO') => `{"identifier": "b4bit-uuid-1", "reference": "${PAYMENT_ID}", "status": "${status}"}`

/** Firma como la calcula b4bit: hex(HMAC_SHA256(secret_bytes, nonce + body)). */
const sign = (nonce: string, body: string, secretHex = VENUE_SECRET) =>
  crypto
    .createHmac('sha256', Buffer.from(secretHex, 'hex'))
    .update(nonce + body)
    .digest('hex')

const freshNonce = () => String(Math.floor(Date.now() / 1000))

function mkReq(opts: { body?: unknown; headers?: Record<string, string> }): Request {
  return { headers: opts.headers ?? {}, body: opts.body } as unknown as Request
}

function mkRes(): Response & { __status?: number; __body?: any } {
  const res: any = {}
  res.status = (n: number) => {
    res.__status = n
    return res
  }
  res.json = (b: unknown) => {
    res.__body = b
    return res
  }
  return res
}

/** El venue existe y tiene secreto cargado. */
function venueWithSecret(secret: string | null = VENUE_SECRET) {
  mockPrisma.payment.findUnique.mockResolvedValue({ venueId: VENUE_ID })
  mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ b4bitSecretKey: secret })
}

/** ¿Se emitió un `logger.error` cuyo mensaje contenga `needle`? */
const errorLogged = (needle: string) => mockLogger.error.mock.calls.some((c: any[]) => String(c[0]).includes(needle))
const warnLogged = (needle: string) => mockLogger.warn.mock.calls.some((c: any[]) => String(c[0]).includes(needle))

const ORIGINAL_ENV = { ...process.env }

beforeEach(() => {
  jest.clearAllMocks()
  process.env = { ...ORIGINAL_ENV }
  delete process.env.B4BIT_WEBHOOK_SECRET
  delete process.env.B4BIT_ALLOW_UNSIGNED_WEBHOOKS
  delete process.env.B4BIT_STRICT_WEBHOOK_AUTH
  mockProcessWebhook.mockResolvedValue({ success: true, action: 'CONFIRMED', message: 'ok', paymentId: PAYMENT_ID })
})

afterAll(() => {
  process.env = ORIGINAL_ENV
})

describe('webhook b4bit — autenticación de la firma', () => {
  it('🔴 SIN headers de firma: responde 401 y NUNCA llama a processWebhook', async () => {
    venueWithSecret()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(b4bitBody()), headers: {} }), res)

    expect(res.__status).toBe(401)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
    expect(warnLogged('[B4Bit webhook]')).toBe(true)
  })

  it('🔴 venue SIN secret en PRODUCCIÓN: responde 503, no procesa y grita en el log', async () => {
    process.env.NODE_ENV = 'production'
    mockPrisma.payment.findUnique.mockResolvedValue({ venueId: VENUE_ID })
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ b4bitSecretKey: null })

    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body) } }), res)

    expect(res.__status).toBe(503)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
    expect(errorLogged('🚨 [B4Bit webhook] SIN SECRET — webhook RECHAZADO')).toBe(true)
  })

  it('🔴 pago inexistente (no se puede resolver el secreto): 503 y no procesa', async () => {
    process.env.NODE_ENV = 'production'
    mockPrisma.payment.findUnique.mockResolvedValue(null)
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue(null)

    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body) } }), res)

    expect(res.__status).toBe(503)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
  })

  it('🔴 firma inválida: responde 401, loguea warn y no procesa', async () => {
    venueWithSecret()
    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': 'f'.repeat(64) } }), res)

    expect(res.__status).toBe(401)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
    expect(warnLogged('[B4Bit webhook]')).toBe(true)
  })

  it('firma válida sobre los BYTES CRUDOS (cuerpo con espacios estilo b4bit): procesa', async () => {
    venueWithSecret()
    // 🔑 Los dientes: este cuerpo lleva espacios tras `,` y `:` como el de b4bit.
    // Si el handler re-serializara con `JSON.stringify`, el HMAC cambiaría y esto
    // devolvería 401.
    const body = '{"identifier": "b4bit-uuid-1", "reference": "' + PAYMENT_ID + '", "status": "CO", "fiat_amount": 100.0}'
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body) } }), res)

    expect(res.__status).toBe(200)
    expect(mockProcessWebhook).toHaveBeenCalledTimes(1)
    expect(mockProcessWebhook.mock.calls[0][0]).toMatchObject({ identifier: 'b4bit-uuid-1', reference: PAYMENT_ID, status: 'CO' })
  })

  it('🔴 nonce con 60 s de antigüedad: 401 (la doc de b4bit exige rechazarlo)', async () => {
    venueWithSecret()
    const body = b4bitBody()
    const staleNonce = String(Math.floor(Date.now() / 1000) - 60)
    const res = mkRes()

    await handleB4BitWebhook(
      mkReq({ body: Buffer.from(body), headers: { 'x-nonce': staleNonce, 'x-signature': sign(staleNonce, body) } }),
      res,
    )

    expect(res.__status).toBe(401)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
  })

  it('nonce dentro de la tolerancia (5 s): sí procesa', async () => {
    venueWithSecret()
    const body = b4bitBody()
    const nonce = String(Math.floor(Date.now() / 1000) - 5)
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body) } }), res)

    expect(res.__status).toBe(200)
    expect(mockProcessWebhook).toHaveBeenCalledTimes(1)
  })

  it('🔴 body no-Buffer (Content-Type raro): 400 y no procesa', async () => {
    venueWithSecret()
    const payload = { identifier: 'b4bit-uuid-1', reference: PAYMENT_ID, status: 'CO' }
    const nonce = freshNonce()
    const res = mkRes()

    // Sin `Buffer` no hay bytes originales: el HMAC no se puede reconstruir.
    // `JSON.stringify` NO sirve — b4bit manda espacios que se perderían.
    await handleB4BitWebhook(
      mkReq({ body: payload, headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, JSON.stringify(payload)) } }),
      res,
    )

    expect(res.__status).toBe(400)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
  })
})

describe('webhook b4bit — flags de entorno', () => {
  it('fuera de producción SIN el flag: sigue rechazando con 503', async () => {
    process.env.NODE_ENV = 'development'
    mockPrisma.payment.findUnique.mockResolvedValue({ venueId: VENUE_ID })
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ b4bitSecretKey: null })

    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body) } }), res)

    expect(res.__status).toBe(503)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
  })

  it('B4BIT_ALLOW_UNSIGNED_WEBHOOKS=true fuera de producción: procesa con warn', async () => {
    process.env.NODE_ENV = 'development'
    process.env.B4BIT_ALLOW_UNSIGNED_WEBHOOKS = 'true'
    mockPrisma.payment.findUnique.mockResolvedValue({ venueId: VENUE_ID })
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ b4bitSecretKey: null })

    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': 'no-importa' } }), res)

    expect(res.__status).toBe(200)
    expect(mockProcessWebhook).toHaveBeenCalledTimes(1)
    expect(warnLogged('B4BIT_ALLOW_UNSIGNED_WEBHOOKS')).toBe(true)
  })

  it('🔴 en PRODUCCIÓN el flag de desarrollo NO abre la puerta', async () => {
    process.env.NODE_ENV = 'production'
    process.env.B4BIT_ALLOW_UNSIGNED_WEBHOOKS = 'true'
    mockPrisma.payment.findUnique.mockResolvedValue({ venueId: VENUE_ID })
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ b4bitSecretKey: null })

    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body) } }), res)

    expect(res.__status).toBe(503)
    expect(mockProcessWebhook).not.toHaveBeenCalled()
  })

  it('🔴 al caer al secreto LEGADO de entorno lo dice en el log (greppable)', async () => {
    // `B4BIT_WEBHOOK_SECRET` es un único secreto global, previo al secreto por
    // venue. Sigue funcionando —no se cambia el comportamiento— pero TAPA la
    // alerta `🚨 SIN SECRET`: un venue sin `b4bitSecretKey` verifica contra la
    // llave equivocada y responde 401 (pérdida silenciosa: B4Bit no reintenta).
    // Al menos tiene que quedar visible en el log quién está en esa situación.
    const LEGACY_SECRET = 'b'.repeat(64)
    process.env.B4BIT_WEBHOOK_SECRET = LEGACY_SECRET
    mockPrisma.payment.findUnique.mockResolvedValue({ venueId: VENUE_ID })
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ b4bitSecretKey: null })

    const body = b4bitBody()
    const nonce = freshNonce()
    const res = mkRes()

    await handleB4BitWebhook(
      mkReq({ body: Buffer.from(body), headers: { 'x-nonce': nonce, 'x-signature': sign(nonce, body, LEGACY_SECRET) } }),
      res,
    )

    // El comportamiento NO cambia: con el legado válido, se procesa.
    expect(res.__status).toBe(200)
    expect(mockProcessWebhook).toHaveBeenCalledTimes(1)
    expect(warnLogged('usando secreto legado de entorno')).toBe(true)
  })

  it('VÁLVULA B4BIT_STRICT_WEBHOOK_AUTH=false: procesa como antes, pero deja rastro greppable', async () => {
    process.env.B4BIT_STRICT_WEBHOOK_AUTH = 'false'
    venueWithSecret()
    const res = mkRes()

    await handleB4BitWebhook(mkReq({ body: Buffer.from(b4bitBody()), headers: {} }), res)

    expect(res.__status).toBe(200)
    expect(mockProcessWebhook).toHaveBeenCalledTimes(1)
    expect(errorLogged('🚨 [B4Bit webhook] HABRÍA RECHAZADO')).toBe(true)
  })
})

describe('verifyWebhookSignature — el algoritmo', () => {
  // Vector publicado por b4bit (https://docs.b4bit.com/pay/api/webhook-test-vectors/).
  // Verificado el 2026-08-17 contra esta implementación: si alguien cambia el
  // orden `nonce + body`, el hex→bytes del secreto o el digest, esto truena.
  const DOC_SECRET = '02d4b921007cad413e79731dd02b3267cd43a14d150a0ae6a1c651942122bb62'
  const DOC_NONCE = '1645634942'
  const DOC_BODY =
    '{"fiat_amount": 100.0, "fiat_currency": "USD", "status": "AC", "crypto_amount": 1.21461894, "unconfirmed_amount": 8.0, "confirmed_amount": 0.0, "currency": "DASH", "identifier": "1040095a-737d-41a2-a2e1-d031d19ec8cd"}'
  const DOC_SIGNATURE = '395a6c0294f0896fcc0e5827e926e12308f4fdca5c18da69d3af6879e5c80e2d'

  it('el VECTOR OFICIAL de la doc de b4bit sigue validando', () => {
    expect(verifyWebhookSignature(DOC_NONCE, DOC_BODY, DOC_SIGNATURE, DOC_SECRET)).toBe(true)
  })

  it('el mismo vector con el cuerpo RE-SERIALIZADO (sin espacios) NO valida', () => {
    // Es exactamente lo que hacía el fallback `JSON.stringify(req.body)`.
    const reserialized = JSON.stringify(JSON.parse(DOC_BODY))
    expect(verifyWebhookSignature(DOC_NONCE, reserialized, DOC_SIGNATURE, DOC_SECRET)).toBe(false)
  })

  it('🔴 SIN secreto devuelve false (antes devolvía true y aceptaba cualquier cosa)', () => {
    expect(verifyWebhookSignature(DOC_NONCE, DOC_BODY, DOC_SIGNATURE, null)).toBe(false)
    expect(verifyWebhookSignature(DOC_NONCE, DOC_BODY, DOC_SIGNATURE, '')).toBe(false)
  })

  it('comparación en tiempo constante: una firma de otra longitud devuelve false sin lanzar', () => {
    // `crypto.timingSafeEqual` REVIENTA si los buffers miden distinto: sin la
    // guarda de longitud, una firma corta tumbaría el handler con un 500.
    expect(() => verifyWebhookSignature(DOC_NONCE, DOC_BODY, 'abc', DOC_SECRET)).not.toThrow()
    expect(verifyWebhookSignature(DOC_NONCE, DOC_BODY, 'abc', DOC_SECRET)).toBe(false)
  })
})

describe('cryptoConfig — el secreto se valida como hex de 64 al guardar', () => {
  beforeEach(() => {
    mockPrisma.venueCryptoConfig.findUnique.mockResolvedValue({ id: 'ccfg', venueId: VENUE_ID, status: 'PENDING_SETUP' })
    // Si la validación dejara pasar el secreto malo, saldríamos a la red real.
    global.fetch = jest.fn().mockRejectedValue(new Error('no debió llamarse a B4Bit')) as any
  })

  it('🔴 rechaza un secreto que NO es hex de 64 (Buffer.from(x,"hex") trunca en silencio)', async () => {
    // `Buffer.from('zz…','hex')` no falla: corta al primer carácter no-hex y deja
    // una llave equivocada → TODAS las firmas de ese venue fallarían, y b4bit no
    // reintenta. Mejor rechazarlo al pegarlo.
    await expect(completeCryptoSetup(VENUE_ID, 'device-1', 'no-es-hexadecimal')).rejects.toThrow(/hexadecimal|64/i)
    expect(mockPrisma.venueCryptoConfig.update).not.toHaveBeenCalled()
  })

  it('🔴 rechaza un hex de longitud equivocada (32 en vez de 64)', async () => {
    await expect(completeCryptoSetup(VENUE_ID, 'device-1', 'a'.repeat(32))).rejects.toThrow(/hexadecimal|64/i)
    expect(mockPrisma.venueCryptoConfig.update).not.toHaveBeenCalled()
  })

  it('acepta un secreto hex de 64 (el formato real de b4bit)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, text: async () => '' }) as any
    mockPrisma.venueCryptoConfig.update.mockResolvedValue({
      id: 'ccfg',
      venueId: VENUE_ID,
      b4bitDeviceId: 'device-1',
      b4bitDeviceName: 'Avoqado - Test',
      b4bitSecretKey: VENUE_SECRET,
      status: 'ACTIVE',
      createdAt: new Date(),
      updatedAt: new Date(),
    })

    await expect(completeCryptoSetup(VENUE_ID, 'device-1', VENUE_SECRET)).resolves.toMatchObject({ hasSecretKey: true })
    expect(mockPrisma.venueCryptoConfig.update).toHaveBeenCalledTimes(1)
  })
})
