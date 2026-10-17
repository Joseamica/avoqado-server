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
