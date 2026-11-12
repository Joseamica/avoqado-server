/**
 * Descuento del cliente (fase 1): los dos esquemas que `validateRequest` usa para REEMPLAZAR `req.body`. Lo que no declaran, Zod
 * lo borra antes de llegar al controlador (Codex r2 A y B). Se prueban con el `.parse` real.
 */
import { createPermissionOverrideSchema } from '@/schemas/mobile/permissionOverride.mobile.schema'
import { createOrderWithItemsSchema } from '@/schemas/tpv.schema'

const VENUE = 'cvenue000000000000000000001'
const CLIENTE = 'ccliente0000000000000000001'
const DESCUENTO = 'cdescuento00000000000000001'

const emision = (operationKey?: string) =>
  createPermissionOverrideSchema.safeParse({
    params: { venueId: VENUE },
    body: { pin: '1234', permission: 'discounts:apply', ...(operationKey !== undefined ? { operationKey } : {}) },
  })

describe('createPermissionOverrideSchema — operationKey', () => {
  it('descuento-cliente:<cuid>:<cuid> pasa y se conserva', () => {
    const r = emision(`descuento-cliente:${CLIENTE}:${DESCUENTO}`)
    expect(r.success).toBe(true)
    expect(r.success && r.data.body.operationKey).toBe(`descuento-cliente:${CLIENTE}:${DESCUENTO}`)
  })

  it('pay-out:… sigue pasando (retiro de caja)', () => {
    expect(emision('pay-out:loc-1:500000').success).toBe(true)
  })

  it('sin llave sigue pasando', () => {
    expect(emision().success).toBe(true)
  })

  it.each([
    'descuento-cliente:x',
    `descuento-cliente:${CLIENTE}`,
    `descuento-cliente:${CLIENTE}:${DESCUENTO}:extra`,
    `descuento-cliente: ${CLIENTE}:${DESCUENTO}`,
    `descuento-cliente:${CLIENTE} :${DESCUENTO}`,
    `descuento-cliente:${CLIENTE}:no-es-cuid`,
    `cortesia:${CLIENTE}:${DESCUENTO}`,
    `Descuento-cliente:${CLIENTE}:${DESCUENTO}`,
  ])('%s ⇒ falla', llave => {
    expect(emision(llave).success).toBe(false)
  })
})

describe('createOrderWithItemsSchema — autorizacionDelDescuento', () => {
  const cuerpo = (o: Record<string, any> = {}) => ({
    items: [{ name: 'Importe', quantity: 1, unitPrice: 100 }],
    staffId: 'cstaff00000000000000000001',
    customerId: CLIENTE,
    orderDiscountId: DESCUENTO,
    discount: 10,
    taxAmount: 0,
    subtotal: 100,
    total: 90,
    ...o,
  })

  it('con autorizacionDelDescuento la conserva tras parse', () => {
    const token = 'token-de-prueba-del-gerente'
    const r = createOrderWithItemsSchema.parse({ params: { venueId: VENUE }, body: cuerpo({ autorizacionDelDescuento: token }) })
    expect(r.body.autorizacionDelDescuento).toBe(token)
  })

  it('sin ella, igual que hoy (no aparece el campo)', () => {
    const r = createOrderWithItemsSchema.parse({ params: { venueId: VENUE }, body: cuerpo() })
    expect('autorizacionDelDescuento' in r.body).toBe(false)
    expect(r.body).toMatchObject({ orderDiscountId: DESCUENTO, discount: 10, total: 90 })
  })

  it('null también se acepta', () => {
    const r = createOrderWithItemsSchema.parse({ params: { venueId: VENUE }, body: cuerpo({ autorizacionDelDescuento: null }) })
    expect(r.body.autorizacionDelDescuento).toBeNull()
  })
})
