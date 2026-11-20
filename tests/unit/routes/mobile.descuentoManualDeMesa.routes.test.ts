/**
 * Encargo 7133e3 (hz:0555ee15:D2): «Descuento manual» en MESAS pide el MISMO permiso que el de MOSTRADOR, el de la TPV y la cola sin
 * red (`discounts:apply`), y valida la forma ANTES del permiso (un cuerpo inválido no le pide el PIN al gerente).
 */
import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import tpvRouter from '@/routes/tpv.routes'
import { authenticateTokenMiddleware } from '@/middlewares/authenticateToken.middleware'
import { hasPermission } from '@/lib/permissions'
import { requiredPermissionForIntent } from '@/services/mobile/sync.mobile.service'
import { manualOrderDiscountSchema } from '@/schemas/mobile/manualOrderDiscount.mobile.schema'

const RUTA = '/venues/:venueId/orders/:orderId/discounts/manual'

function capas(router: any, method: string, path: string): any[] | undefined {
  for (const layer of router.stack ?? []) {
    if (!layer.route || layer.route.path !== path) continue
    const routeLayers: any[] = layer.route.stack ?? []
    if (routeLayers.some(rl => rl.method === method)) return routeLayers.map(rl => rl.handle)
  }
  return undefined
}
const permisoDe = (handlers: any[] | undefined) => handlers?.find(h => typeof h?.requiredPermission === 'string')?.requiredPermission

const LLAVE = '6f1c2a3b-4d5e-4f60-8a71-9b0c1d2e3f40'
const cuerpo = (body: Record<string, unknown>) => ({ params: { venueId: 'v', orderId: 'o' }, body })

describe('7133e3 · POST /mobile/.../orders/:orderId/discounts/manual', () => {
  it('existe, exige sesión y `discounts:apply` (igual que la TPV y la cola sin red)', () => {
    const handlers = capas(mobileRouter, 'post', RUTA)
    expect(handlers).toBeDefined()
    expect(handlers).toContain(authenticateTokenMiddleware)
    expect(permisoDe(handlers)).toBe('discounts:apply')
    expect(permisoDe(capas(tpvRouter, 'post', RUTA))).toBe('discounts:apply')
    expect(requiredPermissionForIntent('APPLY_DISCOUNT' as any)).toBe('discounts:apply')
  })

  it('de fábrica: mesero y cajero lo traen (no cambia lo que puede cada quien en MOSTRADOR)', () => {
    for (const role of [StaffRole.WAITER, StaffRole.CASHIER, StaffRole.MANAGER, StaffRole.OWNER])
      expect(hasPermission(role, null, 'discounts:apply')).toBe(true)
  })

  it('regresión: el descuento del catálogo de la mesa sigue con su ruta y su permiso', () => {
    expect(permisoDe(capas(mobileRouter, 'post', '/venues/:venueId/orders/:orderId/discounts'))).toBe('orders:update')
  })

  it('la forma: % o fijo, mayor a cero, % hasta 100 y llave uuid obligatoria; mensajes en español', () => {
    expect(manualOrderDiscountSchema.safeParse(cuerpo({ type: 'PERCENTAGE', value: 10, llave: LLAVE })).success).toBe(true)
    expect(manualOrderDiscountSchema.safeParse(cuerpo({ type: 'FIXED_AMOUNT', value: 25.5, name: 'Amigo', llave: LLAVE })).success).toBe(
      true,
    )
    // En el aparato (19-nov): el POS manda `null` en lo que no trae; eso no es un 400.
    expect(
      manualOrderDiscountSchema.safeParse(
        cuerpo({ type: 'PERCENTAGE', value: 10, name: null, llave: LLAVE, reason: null, reasonComment: null }),
      ).success,
    ).toBe(true)
    const malos = [
      { type: 'PERCENTAGE', value: 101, llave: LLAVE },
      { type: 'PERCENTAGE', value: 0, llave: LLAVE },
      { type: 'FIXED_AMOUNT', value: -1, llave: LLAVE },
      { type: 'COMP', value: 1, llave: LLAVE },
      { type: 'PERCENTAGE', value: 10 },
      { type: 'PERCENTAGE', value: 10, llave: 'no-es-uuid' },
    ]
    for (const b of malos) {
      const r = manualOrderDiscountSchema.safeParse(cuerpo(b))
      expect(r.success).toBe(false)
      if (!r.success) expect(r.error.issues[0].message).not.toMatch(/^(Expected|Invalid|Number must|String must|Required)/)
    }
  })
})
