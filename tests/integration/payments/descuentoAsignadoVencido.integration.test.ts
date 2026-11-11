/**
 * hz:dcc49fe5:D3 (10-nov-2026): un descuento ASIGNADO a una clienta sólo se ofrece y se aplica en caja si están vigentes su
 * asignación Y el catálogo, si el catálogo no se agotó y si ella no llegó a su tope. Contra PostgreSQL real, por las puertas de
 * caja de hoy: la lista de la TPV, «aplicar predefinido» y el lote automático. Promesa:
 * `docs/audit/2026-11-10-descuento-asignado-vencido/promesa.md` (workspace).
 */
import { randomUUID } from 'crypto'
import { fromZonedTime } from 'date-fns-tz'
import prisma from '@/utils/prismaClient'
import { getCustomerDiscounts, applyAutomaticDiscounts } from '@/services/dashboard/discountEngine.service'
import { getAvailableDiscounts, applyPredefinedDiscount } from '@/services/tpv/discount.tpv.service'

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const database = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!['localhost', '127.0.0.1'].includes(database.hostname) || !/^\/avoqado_[a-z0-9_]+_test/.test(database.pathname)) {
  throw new Error('Esta suite exige una base local aislada (avoqado_<x>_test…), nunca av-db-25.')
}

const venueId = `desc-asignado-${randomUUID()}`
const ZONA = 'America/Mexico_City'
let staffVenueId: string, productId: string, customerId: string
const ids: Record<string, string> = {}

const nuevaOrden = (extra: Record<string, unknown> = {}) =>
  prisma.order.create({
    data: {
      venueId,
      customerId,
      orderNumber: randomUUID(),
      subtotal: 100,
      taxAmount: 0,
      total: 100,
      remainingBalance: 100,
      items: { create: { productId, productName: 'Café', quantity: 1, unitPrice: 100, total: 100, taxAmount: 0 } },
      ...extra,
    },
  })

/** Un descuento del catálogo asignado a la clienta. Todos se acumulan, para que cada caso se lea solo. */
async function asignado(clave: string, catalogo: Record<string, unknown>, asignacion: Record<string, unknown> = {}) {
  const d = await prisma.discount.create({
    data: { venueId, name: clave, type: 'PERCENTAGE', value: 10, scope: 'ORDER', active: true, isStackable: true, ...catalogo },
  })
  await prisma.customerDiscount.create({ data: { customerId, discountId: d.id, ...asignacion } })
  ids[clave] = d.id
}

/** Un uso anterior de ella: una orden suya con ese descuento aplicado (por default cobrada, con una sola fila). */
async function usoAnterior(clave: string, { filas = 1, anulada = false } = {}) {
  const o = await nuevaOrden(
    anulada
      ? { status: 'CANCELLED', discountAmount: 10 }
      : { paymentStatus: 'PAID', status: 'COMPLETED', total: 90, remainingBalance: 0, discountAmount: 10 },
  )
  for (let i = 0; i < filas; i++) {
    await prisma.orderDiscount.create({
      data: { orderId: o.id, discountId: ids[clave], type: 'PERCENTAGE', name: clave, value: 10, amount: 10 / filas },
    })
  }
}

const hace = (min: number) => new Date(Date.now() - min * 60_000)

beforeAll(async () => {
  await prisma.organization.create({ data: { id: venueId, name: venueId, email: `${venueId}@test.example`, phone: '5500000000' } })
  await prisma.venue.create({ data: { id: venueId, organizationId: venueId, name: venueId, slug: venueId, timezone: ZONA } })
  const staffId = (await prisma.staff.create({ data: { email: `${venueId}@staff.test`, firstName: 'Caja', lastName: 'Asignado' } })).id
  staffVenueId = (await prisma.staffVenue.create({ data: { venueId, staffId, role: 'MANAGER' } })).id
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Café', slug: `cafe-${venueId}` } })
  productId = (await prisma.product.create({ data: { venueId, categoryId: categoria.id, name: 'Café', sku: 'ASIG-CAFE', price: 100 } })).id
  customerId = (await prisma.customer.create({ data: { venueId, firstName: 'Ana', phone: `55${Math.floor(Math.random() * 1e8)}` } })).id

  // (1) el catálogo venció; la asignación no trae fechas
  await asignado('VENCIDO_EN_CATALOGO', { validUntil: hace(60) })
  // (1) el catálogo todavía no empieza
  await asignado('AUN_NO_EMPIEZA', { validFrom: new Date(Date.now() + 60 * 60_000) })
  // (2) el catálogo se agotó entre todas las clientas
  await asignado('AGOTADO', { maxTotalUses: 1, currentUses: 1 })
  // (3) el catálogo permite 1 por clienta, la asignación no trae tope, y ella ya lo usó
  await asignado('TOPE_DEL_CATALOGO', { maxUsesPerCustomer: 1 })
  await usoAnterior('TOPE_DEL_CATALOGO')
  // el tope propio de la asignación (su contador `usageCount` no lo sube nadie): ella ya lo usó 1 vez
  await asignado('TOPE_DE_LA_ASIGNACION', {}, { maxUses: 1 })
  await usoAnterior('TOPE_DE_LA_ASIGNACION')
  // la asignación (no el catálogo) venció: ya se excluía; que siga así
  await asignado('ASIGNACION_VENCIDA', {}, { validUntil: hace(60) })
  // vigente, con topes que no alcanza: se ofrece y se aplica
  await asignado('VIGENTE', { maxTotalUses: 10, currentUses: 1, maxUsesPerCustomer: 5 })
  await usoAnterior('VIGENTE')
  // la asignación lo extiende a 3 aunque el catálogo diga 1: manda la asignación (el esquema la llama «override»)
  await asignado('ASIGNACION_DA_MAS', { maxUsesPerCustomer: 1 }, { maxUses: 3 })
  await usoAnterior('ASIGNACION_DA_MAS')
  // un descuento de artículo deja una fila por renglón: una venta con dos renglones es UN uso, como `currentUses`
  await asignado('UNA_VENTA_DOS_RENGLONES', { maxUsesPerCustomer: 2 })
  await usoAnterior('UNA_VENTA_DOS_RENGLONES', { filas: 2 })
  // anular sin cobrar no gasta (como el cupón)
  await asignado('ANULADA_NO_GASTA', { maxUsesPerCustomer: 1 })
  await usoAnterior('ANULADA_NO_GASTA', { anulada: true })
})

afterAll(async () => {
  const ordenes = (await prisma.order.findMany({ where: { venueId }, select: { id: true }, take: 200 })).map(o => o.id)
  await prisma.orderDiscount.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.orderItem.deleteMany({ where: { orderId: { in: ordenes } } })
  await prisma.order.deleteMany({ where: { id: { in: ordenes } } })
  await prisma.customerDiscount.deleteMany({ where: { customerId } })
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.customer.deleteMany({ where: { venueId } })
  await prisma.discount.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.staffVenue.deleteMany({ where: { venueId } })
  await prisma.staff.deleteMany({ where: { email: `${venueId}@staff.test` } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: venueId } })
})

/** Fuera por el CATÁLOGO: tampoco se puede elegir a mano (el catálogo ya no es elegible para nadie, o no para ella). */
const FUERA_DEL_CATALOGO = ['VENCIDO_EN_CATALOGO', 'AUN_NO_EMPIEZA', 'AGOTADO', 'TOPE_DEL_CATALOGO']
/**
 * Fuera sólo por la ASIGNACIÓN: ya no se le aplica solo, pero su catálogo sigue siendo un descuento elegible para cualquier
 * cuenta (la lista de la TPV y «aplicar predefinido» lo muestran por `getEligibleDiscounts`, como a cualquier otra clienta).
 */
const FUERA_DE_LA_ASIGNACION = ['TOPE_DE_LA_ASIGNACION', 'ASIGNACION_VENCIDA']
const DENTRO = ['VIGENTE', 'ASIGNACION_DA_MAS', 'UNA_VENTA_DOS_RENGLONES', 'ANULADA_NO_GASTA']
const nombres = (lista: Array<{ name: string }>) => lista.map(d => d.name).sort()

describe('el lector de los descuentos asignados (motor)', () => {
  it('sólo devuelve los vigentes en la asignación Y en el catálogo, no agotados y bajo su tope', async () => {
    const lista = nombres(await getCustomerDiscounts(venueId, customerId))
    for (const n of [...FUERA_DEL_CATALOGO, ...FUERA_DE_LA_ASIGNACION]) expect(lista).not.toContain(n)
    expect(lista).toEqual([...DENTRO].sort())
  })

  it('la vigencia se compara por instante: a las 23:30 del negocio sigue vigente el «hasta hoy»; a las 00:30 ya no', async () => {
    const hastaHoy = fromZonedTime('2026-11-10T23:59:59.999', ZONA)
    await asignado('HASTA_EL_10', { validUntil: hastaHoy })
    const soloFechas = ['nextTick', 'setImmediate', 'clearImmediate', 'setInterval', 'clearInterval', 'setTimeout', 'clearTimeout']
    try {
      // 23:30 en México es el día 11 en UTC: comparar por día de UTC lo daría por vencido.
      jest.useFakeTimers({
        doNotFake: [...soloFechas, 'queueMicrotask', 'hrtime', 'performance'] as any,
        now: fromZonedTime('2026-11-10T23:30:00', ZONA),
      })
      expect(nombres(await getCustomerDiscounts(venueId, customerId))).toContain('HASTA_EL_10')
      jest.setSystemTime(fromZonedTime('2026-11-11T00:30:00', ZONA))
      expect(nombres(await getCustomerDiscounts(venueId, customerId))).not.toContain('HASTA_EL_10')
    } finally {
      jest.useRealTimers()
      await prisma.customerDiscount.deleteMany({ where: { discountId: ids.HASTA_EL_10 } })
      await prisma.discount.delete({ where: { id: ids.HASTA_EL_10 } })
    }
  })
})

describe('TPV: la lista de descuentos de la cuenta', () => {
  it('no ofrece el vencido, el agotado ni el que ya llegó a su tope; sí el vigente', async () => {
    const orden = await nuevaOrden()
    const lista = nombres(await getAvailableDiscounts(venueId, orden.id))
    for (const n of FUERA_DEL_CATALOGO) expect(lista).not.toContain(n)
    for (const n of DENTRO) expect(lista).toContain(n)
  })
})

describe('TPV: aplicar un descuento elegido de la lista', () => {
  it.each(FUERA_DEL_CATALOGO)('%s no se aplica y la cuenta queda igual', async clave => {
    const orden = await nuevaOrden()
    await expect(applyPredefinedDiscount(venueId, orden.id, ids[clave], staffVenueId)).rejects.toMatchObject({
      statusCode: 400,
      message: 'This discount cannot be applied to this order',
    })
    expect(await prisma.orderDiscount.count({ where: { orderId: orden.id } })).toBe(0)
    expect(Number((await prisma.order.findUniqueOrThrow({ where: { id: orden.id } })).total)).toBe(100)
  })

  it('el vigente sí se aplica', async () => {
    const orden = await nuevaOrden()
    const r = await applyPredefinedDiscount(venueId, orden.id, ids.VIGENTE, staffVenueId)
    expect(r).toMatchObject({ success: true, amount: 10 })
  })
})

describe('motor automático (lote de la cuenta)', () => {
  it('sólo aplica los vigentes', async () => {
    const orden = await nuevaOrden()
    const r = await applyAutomaticDiscounts(orden.id, staffVenueId, venueId)
    expect(r.applied.map(d => d.name).sort()).toEqual([...DENTRO].sort())
  })
})
