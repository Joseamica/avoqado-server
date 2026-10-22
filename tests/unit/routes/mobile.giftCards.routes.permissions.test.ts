/**
 * Rutas del POS de tarjetas de regalo (índice, tabla de rutas): permiso EXACTO, plan sólo al vender (R9), límite de
 * intentos sólo en la consulta, límite de intentos FALLIDOS sólo en cobrar (nota 1 del coordinador: el oráculo de códigos) y
 * propiedad de mesa de CAJA en cobrar y regresar. Introspección ESTÁTICA del router real
 * (molde: mobile.creditPacks.routes.permissions.test.ts), sin supertest ni base.
 */
import express from 'express'
import request from 'supertest'
import { StaffRole } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import * as ctrl from '@/controllers/mobile/giftCard.mobile.controller'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import {
  crearLimitadoresDeConsulta,
  giftCardLookupRateLimiters,
  giftCardPayFailureRateLimiters,
  giftCardPhoneRequestRateLimiters,
  giftCardPhoneVerifyRateLimiters,
  giftCardRevealRateLimiters,
} from '@/middlewares/gift-card-lookup-rate-limit.middleware'
import { redactUrlSecrets } from '@/middlewares/requestLogger'
import { hasPermission } from '@/lib/permissions'
import { liberarCancelacionSchema } from '@/schemas/common/giftCard.common.schema'
import { validateRequest } from '@/middlewares/validation'
import { lookupSchema, payGiftCardSchema } from '@/schemas/mobile/giftCard.mobile.schema'
import { generateOpaqueToken } from '@/services/giftCards/giftCardCode'

interface Ruta {
  autenticada: boolean
  permiso?: string
  plan?: string
  limitada: boolean
  limitadaPorFallos: boolean
  propiedad?: string[]
}

function inspeccionar(method: string, path: string): Ruta | undefined {
  for (const layer of (mobileRouter as any).stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const capas: any[] = layer.route.stack ?? []
    if (!capas.some(c => c.method === method)) continue
    const h = capas.map(c => c.handle)
    return {
      autenticada: h.includes(authenticateTokenMiddleware),
      permiso: h.find(x => typeof x?.requiredPermission === 'string')?.requiredPermission,
      plan: h.find(x => typeof x?.featureCode === 'string')?.featureCode,
      limitada: giftCardLookupRateLimiters.every(l => h.includes(l)),
      limitadaPorFallos: giftCardPayFailureRateLimiters.every(l => h.includes(l)),
      propiedad: h.find(x => Array.isArray(x?.ownershipOverridePermissions))?.ownershipOverridePermissions,
    }
  }
  return undefined
}

const VENDER = '/venues/:venueId/gift-cards/orders'
const CONSULTAR = '/venues/:venueId/gift-cards/lookup'
const COBRAR = '/venues/:venueId/orders/:orderId/pay-gift-card'
const REGRESAR = '/venues/:venueId/orders/:orderId/gift-balance-return-and-cancel'
const RUTAS: Array<[string, string, string]> = [
  ['get', '/venues/:venueId/gift-cards/settings', 'giftCards:read'],
  ['post', VENDER, 'giftCards:sell'],
  // A3 (cierre): POST con el código en el CUERPO; en la URL lo escribían sin tapar la bitácora y la base.
  ['post', CONSULTAR, 'giftCards:read'],
  ['post', COBRAR, 'giftCards:redeem'],
  ['get', '/venues/:venueId/gift-cards/payments/:idempotencyKey', 'giftCards:redeem'],
  ['post', REGRESAR, 'giftCards:redeem'],
  ['post', '/venues/:venueId/gift-cards/orders/:orderId/cancel-sale', 'giftCards:manage'],
  ['post', '/venues/:venueId/gift-cards/orders/:orderId/release-cancel', 'giftCards:manage'],
  // 1b S5 (S-2): teléfono + código.
  ['post', '/venues/:venueId/gift-cards/phone/request', 'giftCards:read'],
  ['post', '/venues/:venueId/gift-cards/phone/verify', 'giftCards:read'],
  // 1b S4 (Q16, Q42): el detalle, reenviar, y lo de gerente en sus propias rutas (las que honran el PIN).
  ['get', '/venues/:venueId/gift-cards/orders/:orderId', 'giftCards:read'],
  ['post', '/venues/:venueId/gift-cards/orders/:orderId/reveal', 'giftCards:sell'],
  ['post', '/venues/:venueId/gift-cards/:giftCardId/resend', 'giftCards:sell'],
  ['post', '/venues/:venueId/gift-cards/:giftCardId/change-destination', 'giftCards:manage'],
  ['post', '/venues/:venueId/gift-cards/:giftCardId/reveal', 'giftCards:sell'],
  ['post', '/venues/:venueId/gift-cards/:giftCardId/reveal-manager', 'giftCards:manage'],
]

describe('rutas del POS de tarjetas de regalo', () => {
  it.each(RUTAS)('%s %s existe, autentica y exige %s (string exacto)', (metodo, ruta, permiso) => {
    const r = inspeccionar(metodo, ruta)
    expect(r).toBeDefined()
    expect(r!.autenticada).toBe(true)
    expect(r!.permiso).toBe(permiso)
  })

  it('🔴 sólo VENDER pide el plan (R9): cobrar, consultar, regresar y cancelar siguen al bajar de plan', () => {
    for (const [metodo, ruta] of RUTAS)
      expect({ ruta, plan: inspeccionar(metodo, ruta)!.plan }).toEqual({
        ruta,
        plan: metodo === 'post' && ruta === VENDER ? 'GIFT_CARDS' : undefined,
      })
  })

  it('sólo la consulta por código lleva el límite de intentos por aparato e IP', () => {
    for (const [metodo, ruta] of RUTAS)
      expect({ ruta, limitada: inspeccionar(metodo, ruta)!.limitada }).toEqual({ ruta, limitada: ruta === CONSULTAR })
  })

  it('🔴 nota 1: sólo cobrar con saldo lleva el límite de intentos FALLIDOS (un 404 por código inexistente no es gratis)', () => {
    for (const [metodo, ruta] of RUTAS)
      expect({ ruta, limitadaPorFallos: inspeccionar(metodo, ruta)!.limitadaPorFallos }).toEqual({
        ruta,
        limitadaPorFallos: ruta === COBRAR,
      })
  })

  it('🔴 nota 1: en cobrar, el límite de fallos va justo después del permiso (antes de la propiedad de mesa)', () => {
    const capa = (mobileRouter as any).stack.find(
      (l: any) => l.route?.path === COBRAR && l.route.stack.some((c: any) => c.method === 'post'),
    )
    const h = capa.route.stack.map((c: any) => c.handle)
    const permiso = h.findIndex((x: any) => x?.requiredPermission === 'giftCards:redeem')
    expect(h.slice(permiso + 1, permiso + 1 + giftCardPayFailureRateLimiters.length)).toEqual(giftCardPayFailureRateLimiters)
  })

  it('cobrar con saldo y regresarlo son de CAJA: aceptan tables:pay-any, como /pay', () => {
    for (const ruta of [COBRAR, REGRESAR]) expect(inspeccionar('post', ruta)!.propiedad).toEqual(['tables:manage-all', 'tables:pay-any'])
  })

  it('el cajero de fábrica vende, consulta y cobra, pero no cancela ventas', () => {
    for (const [metodo, ruta, permiso] of RUTAS)
      expect({ ruta, puede: hasPermission(StaffRole.CASHIER, null, inspeccionar(metodo, ruta)!.permiso!) }).toEqual({
        ruta,
        puede: permiso !== 'giftCards:manage',
      })
  })

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s pasa todas', role => {
    for (const [metodo, ruta] of RUTAS) expect(hasPermission(role, null, inspeccionar(metodo, ruta)!.permiso!)).toBe(true)
  })

  it('el mesero no pasa ninguna (el spec sólo se las da al cajero)', () => {
    for (const [metodo, ruta] of RUTAS) expect(hasPermission(StaffRole.WAITER, null, inspeccionar(metodo, ruta)!.permiso!)).toBe(false)
  })

  it('regresión: el cobro en efectivo sigue con payments:create', () => {
    expect(inspeccionar('post', '/venues/:venueId/orders/:orderId/pay')!.permiso).toBe('payments:create')
  })

  it('🔴 A3 (cierre): la consulta ya no existe por GET (el código no viaja en la URL)', () => {
    expect(inspeccionar('get', CONSULTAR)).toBeUndefined()
  })

  it('🔴 el código consultado nunca llega al log de la petición', () => {
    const url = redactUrlSecrets('/api/v1/mobile/venues/v1/gift-cards/lookup?code=K7QZ-ABCD-EFGH-JKMN-P')
    expect(url).not.toContain('K7QZ')
    expect(url).toContain('code=')
  })

  it('🔴 F6: liberar sin `confirmacionNoDevuelto: true` no pasa el esquema (lo incierto se queda bloqueado)', () => {
    const params = { venueId: 'v1', orderId: 'o1' }
    const sin = liberarCancelacionSchema.safeParse({ params, body: { operationKey: 'libera-0001-abc' } })
    expect(sin.success).toBe(false)
    expect(JSON.stringify(sin.error?.issues)).toMatch(/comprobaste que la devolución NO se hizo/)
    expect(
      liberarCancelacionSchema.safeParse({ params, body: { operationKey: 'libera-0001-abc', confirmacionNoDevuelto: true } }).success,
    ).toBe(true)
  })
})

/** 1b S2: la FORMA de consultar y cobrar con la liga (PAGE_TOKEN), con el 400 de `validateRequest` (el que ve la app). */
describe('forma de consultar y cobrar con la liga (1b S2)', () => {
  const LIGA = generateOpaqueToken()
  const CODIGO = 'K7QZ-ABCD-EFGH-JKMN-P'
  async function validar(schema: any, body: unknown, params: Record<string, string>) {
    const req: any = { body, params, query: {} }
    let error: any
    let siguio = false
    await validateRequest(schema)(req, {} as any, (e?: unknown) => {
      siguio = true
      error = e
    })
    return { error, siguio, body: req.body }
  }
  const enNegocio = { venueId: 'v1' }
  const enCuenta = { venueId: 'v1', orderId: 'o1' }
  const cobro = (over: Record<string, unknown> = {}) => ({
    idempotencyKey: 'cobro-0001-abc',
    proof: { kind: 'PAGE_TOKEN', pageToken: LIGA },
    amount: 100,
    ...over,
  })

  it('lookup acepta { code } o { pageToken }', async () => {
    for (const body of [{ code: CODIGO }, { pageToken: LIGA }]) {
      const r = await validar(lookupSchema, body, enNegocio)
      expect({ body, error: r.error }).toEqual({ body, error: undefined })
    }
  })

  it('lookup con { code, pageToken } ⇒ 400 «Manda el código o la liga de la tarjeta (sólo uno)»', async () => {
    const { error } = await validar(lookupSchema, { code: CODIGO, pageToken: LIGA }, enNegocio)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toBe('Error de validación: Manda el código o la liga de la tarjeta (sólo uno)')
  })

  it('lookup sin ninguno de los dos ⇒ el mismo 400', async () => {
    const { error } = await validar(lookupSchema, {}, enNegocio)
    expect(error?.message).toBe('Error de validación: Manda el código o la liga de la tarjeta (sólo uno)')
  })

  it("lookup con { pageToken: 'corto' } ⇒ 400 «La liga de la tarjeta no es válida»", async () => {
    const { error } = await validar(lookupSchema, { pageToken: 'corto' }, enNegocio)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toBe('Error de validación: pageToken: La liga de la tarjeta no es válida')
  })

  it('pay-gift-card acepta proof.kind CODE y PAGE_TOKEN', async () => {
    for (const proof of [
      { kind: 'CODE', code: CODIGO },
      { kind: 'PAGE_TOKEN', pageToken: LIGA },
    ]) {
      const r = await validar(payGiftCardSchema, cobro({ proof }), enCuenta)
      expect({ proof, error: r.error }).toEqual({ proof, error: undefined })
      expect(r.body.proof).toEqual(proof)
    }
  })

  it("pay-gift-card con proof.kind 'WALLET_PASS' ⇒ 400 «Falta cómo se identificó la tarjeta: código, liga o teléfono»", async () => {
    const { error } = await validar(payGiftCardSchema, cobro({ proof: { kind: 'WALLET_PASS', qrToken: 'qr-1' } }), enCuenta)
    expect(error?.statusCode).toBe(400)
    expect(error?.message).toBe('Error de validación: proof.kind: Falta cómo se identificó la tarjeta: código, liga o teléfono')
  })

  it('pay-gift-card con una liga mal formada ⇒ 400 «La liga de la tarjeta no es válida»', async () => {
    const { error } = await validar(payGiftCardSchema, cobro({ proof: { kind: 'PAGE_TOKEN', pageToken: 'corto' } }), enCuenta)
    expect(error?.message).toBe('Error de validación: proof.pageToken: La liga de la tarjeta no es válida')
  })

  it('Q110: iniciadoPor (cuid) e iniciadoPorNombre (≤ 120, recortado) llegan al controller; son opcionales', async () => {
    const r = await validar(payGiftCardSchema, cobro({ iniciadoPor: 'cl9ana0000000000000000000', iniciadoPorNombre: '  Ana  ' }), enCuenta)
    expect(r.error).toBeUndefined()
    expect([r.body.iniciadoPor, r.body.iniciadoPorNombre]).toEqual(['cl9ana0000000000000000000', 'Ana'])
    expect((await validar(payGiftCardSchema, cobro(), enCuenta)).error).toBeUndefined()
  })

  it.each([
    ['iniciadoPor que no es cuid', { iniciadoPor: 'no es un id' }],
    ['iniciadoPorNombre de más de 120', { iniciadoPor: 'cl9ana0000000000000000000', iniciadoPorNombre: 'A'.repeat(121) }],
  ])('Q110: %s ⇒ 400', async (_caso, extra) => {
    const { error } = await validar(payGiftCardSchema, cobro(extra), enCuenta)
    expect(error?.statusCode).toBe(400)
  })
})

/**
 * S2b (Q58, Q61): crear la cuenta de mostrador y cobrar con saldo en UNA transacción. Crear la cuenta es crear una venta
 * (`orders:create`, con los candados de promociones de `POST /orders`) y cobrar con saldo es `giftCards:redeem`; los intentos
 * fallidos gastan el MISMO contador que `pay-gift-card` (un código que no existe es un 404 en las dos rutas).
 */
describe('S2b: pay-new-order', () => {
  const PAGAR_NUEVA = '/venues/:venueId/gift-cards/pay-new-order'
  const capasDe = (metodo: string, ruta: string): any[] => {
    const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.stack.some((c: any) => c.method === metodo))
    return capa ? capa.route.stack.map((c: any) => c.handle) : []
  }

  it('existe, autentica y exige orders:create y DESPUÉS giftCards:redeem (Q61), sin pedir el plan', () => {
    const h = capasDe('post', PAGAR_NUEVA)
    expect(h.includes(authenticateTokenMiddleware)).toBe(true)
    expect(h.filter(x => typeof x?.requiredPermission === 'string').map(x => x.requiredPermission)).toEqual([
      'orders:create',
      'giftCards:redeem',
    ])
    expect(h.some(x => typeof x?.featureCode === 'string')).toBe(false)
  })

  it('lleva los candados de promociones de POST /orders (la MISMA función), después de los permisos', () => {
    const guardia = capasDe('post', '/venues/:venueId/orders').find(x => x?.name === 'checkPromotionGuardsIfPresent')
    expect(guardia).toBeDefined()
    const h = capasDe('post', PAGAR_NUEVA)
    const redeem = h.findIndex(x => x?.requiredPermission === 'giftCards:redeem')
    expect(h.indexOf(guardia)).toBeGreaterThan(redeem)
  })

  it('🔴 en la ruta REAL, mesa/externalId/isOfflineReplay se rechazan en la validación, antes de permisos, límite y controller', async () => {
    const h = capasDe('post', PAGAR_NUEVA)
    const validacion = h[h.indexOf(authenticateTokenMiddleware) + 1]
    const venta = {
      items: [{ name: 'Blusa', quantity: 1, unitPrice: 80000 }],
      idempotencyKey: 'cobro-0001-abc',
      proof: { kind: 'CODE', code: 'K7QZ-ABCD-EFGH-JKMN-P' },
      amount: 300,
    }
    for (const extra of [{ tableId: 'mesa-9' }, { externalId: 'venta-de-la-app' }, { isOfflineReplay: true }]) {
      let error: any
      await validacion({ body: { ...venta, ...extra }, params: { venueId: 'v1' }, query: {} }, {}, (e?: unknown) => (error = e))
      expect({ extra, status: error?.statusCode, code: error?.code }).toEqual({
        extra,
        status: 400,
        code: 'GIFT_CARD_NEW_ORDER_FIELD_NOT_ALLOWED',
      })
    }
    let paso: unknown = 'sin llamar'
    await validacion(
      { body: { ...venta, splitType: 'FULLPAYMENT' }, params: { venueId: 'v1' }, query: {} },
      {},
      (e?: unknown) => (paso = e),
    )
    expect(paso).toBeUndefined()
  })

  it('🔴 lleva la MISMA instancia del límite de fallos que pay-gift-card (un solo contador), y no el de consultas', () => {
    const nueva = capasDe('post', PAGAR_NUEVA)
    const cobro = capasDe('post', '/venues/:venueId/orders/:orderId/pay-gift-card')
    for (const limitador of giftCardPayFailureRateLimiters) {
      expect(nueva).toContain(limitador)
      expect(cobro).toContain(limitador)
    }
    expect(giftCardLookupRateLimiters.some(l => nueva.includes(l))).toBe(false)
  })

  it.each([
    ['pay-new-order', '/venues/v1/gift-cards/pay-new-order'],
    ['pay-gift-card', '/venues/v1/orders/o1/pay-gift-card'],
  ])(
    '🔴 topes de 3: dos fallos en pay-new-order y uno en pay-gift-card desde el mismo aparato ⇒ el cuarto intento (%s) ⇒ 429',
    async (_ruta, cuarto) => {
      // Cada limitador de fallos que monta la ruta REAL se cambia por su gemelo con tope de 3 (misma posición: IP, aparato).
      // Una ruta sin esos limitadores, o con instancias propias, queda sin límite aquí y la prueba truena.
      const deTres = crearLimitadoresDeConsulta(3, 100, { soloFallos: true, prefijo: 'gift-card-pay' })
      const gemelo = new Map(giftCardPayFailureRateLimiters.map((l, i) => [l, deTres[i]]))
      const limitadoresDe = (ruta: string) =>
        capasDe('post', ruta)
          .filter(h => gemelo.has(h))
          .map(h => gemelo.get(h)!)
      const a = express()
      const falla = (_req: express.Request, res: express.Response) => res.status(404).json({ ok: false })
      a.post('/venues/:venueId/gift-cards/pay-new-order', ...limitadoresDe(PAGAR_NUEVA), falla)
      a.post('/venues/:venueId/orders/:orderId/pay-gift-card', ...limitadoresDe('/venues/:venueId/orders/:orderId/pay-gift-card'), falla)
      for (const ruta of [
        '/venues/v1/gift-cards/pay-new-order',
        '/venues/v1/gift-cards/pay-new-order',
        '/venues/v1/orders/o1/pay-gift-card',
      ])
        expect((await request(a).post(ruta).set('X-Device-Id', 'caja-1')).status).toBe(404)
      const r = await request(a).post(cuarto).set('X-Device-Id', 'caja-1')
      expect(r.status).toBe(429)
      expect(r.body.code).toBe('GIFT_CARD_LOOKUP_RATE_LIMITED')
    },
  )
})

/** 1b S4 (S-5): las TRES rutas que muestran el código comparten UN contador (10/min por aparato, 30 por IP en producción). */
describe('S4: el límite de mostrar códigos', () => {
  const REVELAR = [
    '/venues/:venueId/gift-cards/:giftCardId/reveal',
    '/venues/:venueId/gift-cards/:giftCardId/reveal-manager',
    '/venues/:venueId/gift-cards/orders/:orderId/reveal',
  ]
  const capasDe = (metodo: string, ruta: string): any[] => {
    const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.stack.some((c: any) => c.method === metodo))
    return capa ? capa.route.stack.map((c: any) => c.handle) : []
  }

  it('🔴 las tres llevan la MISMA instancia, justo después del permiso; ninguna otra ruta de tarjetas la lleva', () => {
    for (const ruta of REVELAR) {
      const h = capasDe('post', ruta)
      const permiso = h.findIndex(x => typeof x?.requiredPermission === 'string')
      expect({ ruta, limite: h.slice(permiso + 1, permiso + 1 + giftCardRevealRateLimiters.length) }).toEqual({
        ruta,
        limite: giftCardRevealRateLimiters,
      })
    }
    for (const [metodo, ruta] of RUTAS.filter(([, r]) => !REVELAR.includes(r)))
      expect({ ruta, lleva: giftCardRevealRateLimiters.some(l => capasDe(metodo, ruta).includes(l)) }).toEqual({ ruta, lleva: false })
  })

  it('🔴 Q42: mostrar la cuenta con tres tarjetas cuenta UNA vez (tope 3 de prueba: la cuarta petición seguida ⇒ 429)', async () => {
    const deTres = crearLimitadoresDeConsulta(3, 100, { prefijo: 'gift-card-reveal' })
    const gemelo = new Map(giftCardRevealRateLimiters.map((l, i) => [l, deTres[i]]))
    const ruta = '/venues/:venueId/gift-cards/orders/:orderId/reveal'
    const limitadores = capasDe('post', ruta)
      .filter(h => gemelo.has(h))
      .map(h => gemelo.get(h)!)
    expect(limitadores).toHaveLength(2)
    const a = express()
    a.post(ruta, ...limitadores, (_req, res) => res.json({ success: true, data: { tarjetas: [{ id: 'g1' }, { id: 'g2' }, { id: 'g3' }] } }))
    for (let i = 0; i < 3; i++) {
      const r = await request(a).post('/venues/v1/gift-cards/orders/o1/reveal').set('X-Device-Id', 'caja-1')
      expect(r.status).toBe(200)
      expect(r.body.data.tarjetas).toHaveLength(3)
    }
    const cuarta = await request(a).post('/venues/v1/gift-cards/orders/o1/reveal').set('X-Device-Id', 'caja-1')
    expect(cuarta.status).toBe(429)
    expect(cuarta.body.code).toBe('GIFT_CARD_LOOKUP_RATE_LIMITED')
  })

  it('el detalle de la cuenta y el reenvío no piden plan (R9) ni llevan los límites de consultar o cobrar', () => {
    for (const [metodo, ruta] of RUTAS.slice(-6)) {
      const h = capasDe(metodo, ruta)
      expect({ ruta, plan: h.some(x => typeof x?.featureCode === 'string') }).toEqual({ ruta, plan: false })
      expect({ ruta, otros: [...giftCardLookupRateLimiters, ...giftCardPayFailureRateLimiters].some(l => h.includes(l)) }).toEqual({
        ruta,
        otros: false,
      })
    }
  })
})

/**
 * 1b S5 (S-2): teléfono + código. Las dos rutas con `giftCards:read` y sus limitadores propios (por aparato y por IP, en memoria,
 * ventana de 10 min); sin `X-Device-Id` ⇒ 400 desde el controller; un teléfono que no se entiende ⇒ 400 de C5.
 */
describe('S5: teléfono + código', () => {
  const PEDIR = '/venues/:venueId/gift-cards/phone/request'
  const VERIFICAR = '/venues/:venueId/gift-cards/phone/verify'
  const capasDe = (metodo: string, ruta: string): any[] => {
    const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.stack.some((c: any) => c.method === metodo))
    return capa ? capa.route.stack.map((c: any) => c.handle) : []
  }
  const posicionDe = (metodo: string, ruta: string) =>
    (mobileRouter as any).stack.findIndex((l: any) => l.route?.path === ruta && l.route.stack.some((c: any) => c.method === metodo))

  it.each([
    [PEDIR, giftCardPhoneRequestRateLimiters],
    [VERIFICAR, giftCardPhoneVerifyRateLimiters],
  ])('POST %s autentica, exige giftCards:read y lleva SU limitador justo después, sin plan', (ruta, limitadores) => {
    const h = capasDe('post', ruta)
    expect(h.includes(authenticateTokenMiddleware)).toBe(true)
    expect(h.filter(x => typeof x?.requiredPermission === 'string').map(x => x.requiredPermission)).toEqual(['giftCards:read'])
    const permiso = h.findIndex(x => x?.requiredPermission === 'giftCards:read')
    expect(h.slice(permiso + 1, permiso + 1 + limitadores.length)).toEqual(limitadores)
    expect(h.some(x => typeof x?.featureCode === 'string')).toBe(false)
    expect([...giftCardLookupRateLimiters, ...giftCardPayFailureRateLimiters, ...giftCardRevealRateLimiters].some(l => h.includes(l))).toBe(
      false,
    )
  })

  it('pedir y verificar tienen limitadores distintos (no comparten contador), dos cada uno (IP y aparato)', () => {
    expect(giftCardPhoneRequestRateLimiters).toHaveLength(2)
    expect(giftCardPhoneVerifyRateLimiters).toHaveLength(2)
    expect(giftCardPhoneRequestRateLimiters.some(l => giftCardPhoneVerifyRateLimiters.includes(l))).toBe(false)
  })

  it('van ANTES de las rutas de `/:giftCardId` (nada las confunde con un id de tarjeta)', () => {
    for (const ruta of [PEDIR, VERIFICAR]) {
      expect(posicionDe('post', ruta)).toBeGreaterThanOrEqual(0)
      expect(posicionDe('post', ruta)).toBeLessThan(posicionDe('post', '/venues/:venueId/gift-cards/:giftCardId/resend'))
    }
  })

  it.each([
    ['phone/request', 10, 'giftCardPhoneRequestRateLimiters', 'caja-pide'],
    ['phone/verify', 20, 'giftCardPhoneVerifyRateLimiters', 'caja-verifica'],
  ])(
    'en producción, %s: %i cada 10 min por aparato; el siguiente ⇒ 429 GIFT_CARD_PHONE_RATE_LIMITED con retryAfter: 600',
    async (_r, tope, nombre, aparato) => {
      const antes = process.env.NODE_ENV
      process.env.NODE_ENV = 'production'
      let deProduccion: any[] = []
      jest.isolateModules(() => {
        deProduccion = require('@/middlewares/gift-card-lookup-rate-limit.middleware')[nombre]
      })
      process.env.NODE_ENV = antes
      const a = express()
      a.post('/venues/:venueId/gift-cards/phone/x', ...deProduccion, (_req, res) => res.json({ ok: true }))
      for (let i = 0; i < tope; i++)
        expect((await request(a).post('/venues/v1/gift-cards/phone/x').set('X-Device-Id', aparato)).status).toBe(200)
      const r = await request(a).post('/venues/v1/gift-cards/phone/x').set('X-Device-Id', aparato)
      expect(r.status).toBe(429)
      expect(r.body).toEqual({
        success: false,
        code: 'GIFT_CARD_PHONE_RATE_LIMITED',
        message: 'Ya pedimos varios códigos para ese teléfono. Espera unos minutos.',
        retryAfter: 600,
      })
    },
  )

  it.each([
    ['phone/request', 30],
    ['phone/verify', 60],
  ])('en producción, %s frena por IP a los %i aunque cambie el aparato', async (ruta, tope) => {
    const nombre = ruta === 'phone/request' ? 'giftCardPhoneRequestRateLimiters' : 'giftCardPhoneVerifyRateLimiters'
    const antes = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    let deProduccion: any[] = []
    jest.isolateModules(() => {
      deProduccion = require('@/middlewares/gift-card-lookup-rate-limit.middleware')[nombre]
    })
    process.env.NODE_ENV = antes
    const a = express()
    a.post('/venues/:venueId/gift-cards/phone/x', ...deProduccion, (_req, res) => res.json({ ok: true }))
    for (let i = 0; i < tope; i++)
      expect((await request(a).post('/venues/v1/gift-cards/phone/x').set('X-Device-Id', `caja-${i}`)).status).toBe(200)
    const r = await request(a).post('/venues/v1/gift-cards/phone/x').set('X-Device-Id', 'caja-nueva')
    expect(r.status).toBe(429)
    expect(r.body.code).toBe('GIFT_CARD_PHONE_RATE_LIMITED')
  })

  /**
   * La validación de la ruta REAL y luego el controller REAL (con el servicio real: los dos 400 salen antes de tocar la base). Sin
   * `@/app`: su parche de errores asíncronos envuelve las capas y la introspección de arriba dejaría de reconocerlas.
   */
  async function correr(ruta: string, controlador: (req: any, res: any) => Promise<void>, body: unknown, deviceId?: string) {
    const h = capasDe('post', ruta)
    const validacion = h[h.indexOf(authenticateTokenMiddleware) + 1]
    const req: any = {
      body,
      params: { venueId: 'v1' },
      query: {},
      headers: deviceId ? { 'x-device-id': deviceId } : {},
      ip: '10.0.0.1',
      authContext: { userId: 'cstaff00000000000000000a', venueId: 'v1' },
    }
    let error: any
    await validacion(req, {}, (e?: unknown) => (error = e))
    if (error) return error
    const res: any = { json: jest.fn() }
    return controlador(req, res).then(
      () => ({ respondio: res.json.mock.calls[0]?.[0] }),
      e => e,
    )
  }

  it.each([
    ['request', PEDIR, { phone: '+525512345678' }],
    ['verify', VERIFICAR, { phone: '+525512345678', code: '123456' }],
  ])('phone/%s sin X-Device-Id ⇒ 400 GIFT_CARD_DEVICE_ID_REQUIRED, antes de tocar el servicio', async (que, ruta, body) => {
    const e = await correr(ruta, que === 'request' ? ctrl.phoneRequest : ctrl.phoneVerify, body)
    expect({ status: e.statusCode, code: e.code, message: e.message }).toEqual({
      status: 400,
      code: 'GIFT_CARD_DEVICE_ID_REQUIRED',
      message: 'Falta el identificador del aparato (X-Device-Id).',
    })
    expect(prismaMock.otpChallenge.findMany).not.toHaveBeenCalled()
    expect(prismaMock.otpChallenge.findFirst).not.toHaveBeenCalled()
  })

  it.each([
    ['request', PEDIR, { phone: '123' }],
    ['verify', VERIFICAR, { phone: '123', code: '123456' }],
  ])("phone/%s con phone: '123' ⇒ 400 «El teléfono no es válido.» con GIFT_CARD_PHONE_INVALID", async (que, ruta, body) => {
    const e = await correr(ruta, que === 'request' ? ctrl.phoneRequest : ctrl.phoneVerify, body, 'caja-1')
    expect({ status: e.statusCode, code: e.code, message: e.message }).toEqual({
      status: 400,
      code: 'GIFT_CARD_PHONE_INVALID',
      message: 'El teléfono no es válido.',
    })
  })

  /** 33 caracteres que el servicio SÍ entendería (`+525512345678` con espacios en medio): el tope de la orilla es del esquema. */
  const TREINTA_Y_TRES = `+52${' '.repeat(18)}55 1234 5678`
  it.each([
    ['request', 'ausente', PEDIR, {}],
    ['request', 'null', PEDIR, { phone: null }],
    ['request', 'de 33 caracteres', PEDIR, { phone: TREINTA_Y_TRES }],
    ['verify', 'ausente', VERIFICAR, { code: '123456' }],
    ['verify', 'null', VERIFICAR, { phone: null, code: '123456' }],
    ['verify', 'de 33 caracteres', VERIFICAR, { phone: TREINTA_Y_TRES, code: '123456' }],
  ])(
    'm3: phone/%s con el teléfono %s ⇒ el MISMO 400 «El teléfono no es válido.» con GIFT_CARD_PHONE_INVALID',
    async (que, _caso, ruta, body) => {
      expect(TREINTA_Y_TRES).toHaveLength(33)
      const e = await correr(ruta, que === 'request' ? ctrl.phoneRequest : ctrl.phoneVerify, body, 'caja-1')
      expect({ status: e.statusCode, code: e.code, message: e.message }).toEqual({
        status: 400,
        code: 'GIFT_CARD_PHONE_INVALID',
        message: 'El teléfono no es válido.',
      })
      expect(prismaMock.otpChallenge.findMany).not.toHaveBeenCalled()
      expect(prismaMock.otpChallenge.findFirst).not.toHaveBeenCalled()
    },
  )

  it('m3: con 32 caracteres el teléfono pasa el esquema (el tope sigue siendo 32): sin X-Device-Id responde el 400 del aparato', async () => {
    const treintaYDos = `+52${' '.repeat(17)}55 1234 5678`
    expect(treintaYDos).toHaveLength(32)
    const e = await correr(PEDIR, ctrl.phoneRequest, { phone: treintaYDos })
    expect({ status: e.statusCode, code: e.code }).toEqual({ status: 400, code: 'GIFT_CARD_DEVICE_ID_REQUIRED' })
  })

  it('phone/verify con un código que no son 6 números ⇒ 400 «El código son 6 números»', async () => {
    const e = await correr(VERIFICAR, ctrl.phoneVerify, { phone: '+525512345678', code: '12a456' }, 'caja-1')
    expect(e.statusCode).toBe(400)
    expect(e.message).toBe('Error de validación: code: El código son 6 números')
  })

  it('pay-gift-card y pay-new-order aceptan proof PHONE_OTP { proofToken, giftCardId }', async () => {
    const proof = { kind: 'PHONE_OTP', proofToken: 'carga.firma', giftCardId: 'cgift0000000000000000000a' }
    const base = { idempotencyKey: 'cobro-0001-abc', proof, amount: 100 }
    for (const [ruta, params] of [
      ['/venues/:venueId/orders/:orderId/pay-gift-card', { venueId: 'v1', orderId: 'o1' }],
      ['/venues/:venueId/gift-cards/pay-new-order', { venueId: 'v1' }],
    ] as const) {
      const h = capasDe('post', ruta)
      const validacion = h[h.indexOf(authenticateTokenMiddleware) + 1]
      const req: any = { body: { ...base, items: [{ name: 'Blusa', quantity: 1, unitPrice: 10000 }] }, params, query: {} }
      let error: unknown = 'sin llamar'
      await validacion(req, {}, (e?: unknown) => (error = e))
      expect({ ruta, error }).toEqual({ ruta, error: undefined })
      expect(req.body.proof).toEqual(proof)
    }
  })
})
