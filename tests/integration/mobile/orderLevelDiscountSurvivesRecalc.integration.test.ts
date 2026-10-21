/**
 * 🔴 DINERO, contra PostgreSQL real: el descuento de CUENTA que el cajero puso al crear
 * la venta tiene que sobrevivir a los recálculos posteriores de la orden.
 *
 * Mismo defecto que `tests/unit/services/mobile/orderLevelDiscountSurvivesRecalc.test.ts`,
 * pero sin dobles: `createOrderWithItems` guardaba el descuento de cuenta SÓLO en la
 * cabecera, y `recalculateOrderTotals` la reconstruye desde las filas `OrderDiscount`
 * en cuanto existe una — el premio de la cartilla al crear la venta, u otro descuento
 * después —, así que el descuento de cuenta desaparecía de la orden guardada.
 *
 * No mide `Order.total`: su relación con la propina se conserva como hoy por camino
 * (decisión del founder, 2026-09-27, de no tocarla todavía). Mide el descuento guardado y
 * si la cuenta cierra cuando el cliente paga lo que el negocio quiso cobrarle
 * (`computeOrderBalance`, el cálculo del cobro).
 *
 * Arreglado en el bloque B2 (1-oct): el descuento de cuenta es su propia fila `OrderDiscount`.
 * El defecto se reprodujo en rojo el 2026-09-27 contra `av-db-25-orderdisc` (descuento
 * guardado 30 en vez de 50, y 10 en vez de 30); las dos pruebas 🔴 iban con `it.failing` y B2
 * las volteó a `it`.
 */
import prisma from '@/utils/prismaClient'
import { applyOrderDiscount, createOrderWithItems } from '@/services/mobile/order.mobile.service'
import { computeOrderBalance } from '@/services/shared/orderBalance'

jest.mock('@/services/wallet/notifyPassUpdated.service', () => ({
  notifyCustomerPassUpdated: jest.fn().mockResolvedValue({ notified: 0 }),
}))

const sufijo = `desc-cuenta-${Date.now()}`
let orgId: string
let venueId: string
let staffId: string
let clienteId: string
let descuento10Id: string
const premios: string[] = []

/** Un premio de $30 PENDIENTE, en su propia cartilla (el premio es único por cartilla). */
async function premioDe30(ciclo: number): Promise<string> {
  const cartilla = await prisma.stampCard.create({
    data: { customerId: clienteId, venueId, cycle: ciclo, stampsRequired: 5, stampsEarned: 5, completedAt: new Date() },
    select: { id: true },
  })
  const premio = await prisma.stampReward.create({
    data: {
      stampCardId: cartilla.id,
      customerId: clienteId,
      venueId,
      rewardType: 'FIXED_AMOUNT',
      rewardValue: 30,
      rewardLabel: '$30 de premio',
    },
    select: { id: true },
  })
  premios.push(premio.id)
  return premio.id
}

/** Una venta de $100 en una sola línea «Otro importe», con propina de $5. */
const venta = (extra: Record<string, unknown> = {}) =>
  ({
    staffId,
    items: [{ name: 'Otro importe', quantity: 1, unitPrice: 10000 }],
    tip: 500,
    orderType: 'TAKEOUT',
    source: 'AVOQADO_ANDROID',
    ...extra,
  }) as any

async function ordenGuardada(id: string) {
  return prisma.order.findUniqueOrThrow({
    where: { id },
    // P12: el saldo lee también el contrato, el impuesto y el estado (la regla del IVA que va aparte).
    select: { subtotal: true, discountAmount: true, serviceChargeAmount: true, contratoDePrecio: true, taxAmount: true, status: true },
  })
}

/** ¿La cuenta queda PAGADA si el cliente paga `mercancia` + `propina` (pesos)? */
function cierraCon(orden: Awaited<ReturnType<typeof ordenGuardada>>, mercancia: number, propina: number) {
  return computeOrderBalance(orden, [{ amount: mercancia, tipAmount: propina, type: 'REGULAR' }])
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${sufijo}`, email: `${sufijo}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: `Café ${sufijo}`, slug: sufijo }, select: { id: true } })).id
  staffId = (
    await prisma.staff.create({
      data: { email: `cajero-${sufijo}@example.test`, firstName: 'Caja', lastName: 'Prueba' },
      select: { id: true },
    })
  ).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: 'CASHIER' } })
  clienteId = (await prisma.customer.create({ data: { venueId, firstName: 'Ana', lastName: 'López' }, select: { id: true } })).id
  descuento10Id = (
    await prisma.discount.create({
      data: { venueId, name: '10% cliente frecuente', type: 'PERCENTAGE', value: 10, scope: 'ORDER' },
      select: { id: true },
    })
  ).id
})

afterAll(async () => {
  if (!orgId) return
  const ordenes = await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 100 })
  const ids = ordenes.map(o => o.id)
  await prisma.stampReward.updateMany({ where: { id: { in: premios } }, data: { orderDiscountId: null } })
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.orderCustomer.deleteMany({ where: { orderId: { in: ids } } })
  await prisma.order.deleteMany({ where: { id: { in: ids } } })
  await prisma.stampReward.deleteMany({ where: { id: { in: premios } } })
  await prisma.stampCard.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

// Cada escenario va en DOS pruebas: una normal que exige que el escenario de verdad ocurrió
// (si la base o la venta se rompen, truena en rojo) y la 🔴 que sólo lee su resultado.
// Medido el 2026-09-27, cuando iban con `it.failing`: una columna nueva de otra sesión, sin
// migrar en esta base, las hizo «pasar» porque la venta tronaba antes de llegar al descuento.
describe('el descuento de CUENTA sobrevive a los recálculos (PostgreSQL real)', () => {
  describe('premio de la cartilla canjeado al crear la venta', () => {
    let ordenId: string

    it('la venta nace con el descuento de cuenta y el premio aplicado', async () => {
      const premio = await premioDe30(1)
      const creada = await createOrderWithItems(venueId, venta({ discount: 2000, customerId: clienteId, stampRewardId: premio }))

      expect((creada as any).stampReward).toEqual(expect.objectContaining({ applied: true, discountAmount: 30 }))
      ordenId = creada.id
    })

    it('🔴 el premio NO borra el descuento de cuenta', async () => {
      // $100 − $20 de descuento de cuenta − $30 de premio = $50 de mercancía (+ $5 de propina aparte).
      const orden = await ordenGuardada(ordenId)
      expect(Number(orden.discountAmount)).toBe(50)
      const saldo = cierraCon(orden, 50, 5)
      expect(saldo.remainingBalance.toNumber()).toBe(0)
      expect(saldo.isFullyPaid).toBe(true)
    })
  })

  describe('otro descuento aplicado después', () => {
    let ordenId: string

    it('el segundo descuento se aplica sobre la venta con descuento de cuenta', async () => {
      const creada = await createOrderWithItems(venueId, venta({ discount: 2000 }))
      const aplicado = await applyOrderDiscount(venueId, creada.id, descuento10Id, staffId)

      expect(aplicado.amount).toBe(10)
      ordenId = creada.id
    })

    it('🔴 el segundo descuento NO borra el descuento de cuenta', async () => {
      // $100 − $20 de cuenta − 10% ($10, sobre la mercancía) = $70 de mercancía.
      const orden = await ordenGuardada(ordenId)
      expect(Number(orden.discountAmount)).toBe(30)
      const saldo = cierraCon(orden, 70, 5)
      expect(saldo.remainingBalance.toNumber()).toBe(0)
      expect(saldo.isFullyPaid).toBe(true)
    })
  })

  // ── Regresión: lo que hoy funciona tiene que seguir igual ────────────────────
  it('sin descuento de cuenta, el premio baja la cuenta como hoy', async () => {
    const premio = await premioDe30(2)
    const creada = await createOrderWithItems(venueId, venta({ customerId: clienteId, stampRewardId: premio }))

    const orden = await ordenGuardada(creada.id)
    expect(Number(orden.discountAmount)).toBe(30)
    expect(cierraCon(orden, 70, 5).isFullyPaid).toBe(true)
  })

  it('la fila de cuenta guarda su reparto exacto (PostgreSQL real)', async () => {
    const creada = await createOrderWithItems(venueId, venta({ discount: 2000 }))
    const [fila] = await prisma.orderDiscount.findMany({ where: { orderId: creada.id } })
    const [renglon] = await prisma.orderItem.findMany({ where: { orderId: creada.id } })
    expect(fila).toMatchObject({ type: 'FIXED_AMOUNT', name: 'Descuento de la cuenta' })
    expect(fila.reparto).toEqual({ v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { [renglon.id]: 2000 } })
  })

  it('sin nada más que el descuento de cuenta, la venta nace como hoy', async () => {
    const creada = await createOrderWithItems(venueId, venta({ discount: 2000 }))

    const orden = await ordenGuardada(creada.id)
    expect(Number(orden.discountAmount)).toBe(20)
    expect(cierraCon(orden, 80, 5).isFullyPaid).toBe(true)
  })
})
