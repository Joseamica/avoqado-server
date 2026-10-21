/**
 * Rutas del POS de tarjetas de regalo (índice, tabla de rutas): permiso EXACTO, plan sólo al vender (R9), límite de
 * intentos sólo en la consulta, límite de intentos FALLIDOS sólo en cobrar (nota 1 del coordinador: el oráculo de códigos) y
 * propiedad de mesa de CAJA en cobrar y regresar. Introspección ESTÁTICA del router real
 * (molde: mobile.creditPacks.routes.permissions.test.ts), sin supertest ni base.
 */
import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { giftCardLookupRateLimiters, giftCardPayFailureRateLimiters } from '@/middlewares/gift-card-lookup-rate-limit.middleware'
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

  it.each([StaffRole.MANAGER, StaffRole.ADMIN, StaffRole.OWNER])('%s pasa las ocho', role => {
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
