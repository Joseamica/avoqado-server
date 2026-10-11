/**
 * IVA por producto (plan 3) × limpieza de demos (D2 del 7a, 10-oct): los sellos de un renglón (`OrderItemSelloIva`) y el
 * manifiesto de la global (`CfdiGlobalOrden`) referencian `OrderItem`, `Order` y `Cfdi` con RESTRICT, y el `Cfdi` referencia
 * al venue con RESTRICT. Una demo vencida con renglones facturados tumbaba la transacción entera con P2003
 * (`OrderItemSelloIva_orderItemId_fkey`) y nunca se limpiaba («Cleaned 0 sessions» cada hora).
 *
 * Contra base real: la guardia del DMMF de la prueba unitaria no ve estas tablas (no caen en cascada con el venue).
 */
import { randomUUID } from 'crypto'
import prisma from '@/utils/prismaClient'
import { deleteDisposableDemoSession } from '@/services/cleanup/liveDemoCleanup.service'

const llave = `d2-sellos-${randomUUID()}`
const demo = { org: `${llave}-org-demo`, venue: `${llave}-demo`, staff: `${llave}-staff`, session: `${llave}-session` }
const control = { org: `${llave}-org-control`, venue: `${llave}-control` }

type Facturado = { orderId: string; orderItemId: string; cfdiIds: string[]; selloIds: string[]; manifiestoId: string }

/** Una venta facturada dos veces: individual (sello) y global (manifiesto + sello). */
async function sembrarVentaFacturada(venueId: string): Promise<Facturado> {
  const categoria = await prisma.menuCategory.create({ data: { venueId, name: 'Demo', slug: `${venueId}-cat` } })
  const producto = await prisma.product.create({
    data: { venueId, categoryId: categoria.id, sku: `${venueId}-sku`, name: 'Latte', price: 58, isDemo: true },
  })
  const orden = await prisma.order.create({
    data: { venueId, orderNumber: `${venueId}-1`, subtotal: 58, taxAmount: 0, total: 58 },
  })
  const renglon = await prisma.orderItem.create({
    data: { orderId: orden.id, productId: producto.id, productName: 'Latte', quantity: 1, unitPrice: 58, taxAmount: 0, total: 58 },
  })
  const emisor = await prisma.fiscalEmisor.create({
    data: { venueId, rfc: 'AAA010101AAA', legalName: venueId, regimenFiscal: '601', lugarExpedicion: '01000' },
  })
  const cfdi = (isGlobal: boolean) =>
    prisma.cfdi.create({
      data: {
        venueId,
        fiscalEmisorId: emisor.id,
        status: 'STAMPED',
        flow: isGlobal ? 'GLOBAL_C' : 'AUTOFACTURA_A',
        orderId: isGlobal ? null : orden.id,
        isGlobal,
        receptorRfc: isGlobal ? 'XAXX010101000' : 'EKU9003173C9',
        receptorNombre: isGlobal ? 'PUBLICO EN GENERAL' : 'ESCUELA KEMPER URGATE',
        receptorRegimen: isGlobal ? '616' : '601',
        receptorCp: '01000',
        usoCfdi: isGlobal ? 'S01' : 'G03',
        formaPago: '01',
        metodoPago: 'PUE',
        subtotalCents: 5000,
        taxCents: 800,
        totalCents: 5800,
        protocoloIva: 1,
        attempts: 1,
      },
    })
  const individual = await cfdi(false)
  const global = await cfdi(true)
  const selloIndividual = await prisma.orderItemSelloIva.create({ data: { orderItemId: renglon.id, cfdiId: individual.id, intento: 1 } })
  const selloGlobal = await prisma.orderItemSelloIva.create({ data: { orderItemId: renglon.id, cfdiId: global.id, intento: 1 } })
  const manifiesto = await prisma.cfdiGlobalOrden.create({ data: { cfdiId: global.id, orderId: orden.id, huella: 'h' } })
  return {
    orderId: orden.id,
    orderItemId: renglon.id,
    cfdiIds: [individual.id, global.id],
    selloIds: [selloIndividual.id, selloGlobal.id],
    manifiestoId: manifiesto.id,
  }
}

/** Limpieza de la prueba, acotada a UN venue. */
async function borrarVenue(venueId: string | undefined): Promise<void> {
  if (!venueId) return // sin id, cada deleteMany de abajo vaciaría su tabla entera
  await prisma.orderItemSelloIva.deleteMany({ where: { cfdi: { venueId } } })
  await prisma.cfdiGlobalOrden.deleteMany({ where: { cfdi: { venueId } } })
  await prisma.cfdi.deleteMany({ where: { venueId } })
  await prisma.orderItem.deleteMany({ where: { order: { venueId } } })
  await prisma.order.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { venueId } })
  await prisma.menuCategory.deleteMany({ where: { venueId } })
  await prisma.liveDemoSession.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
}

let demoFacturado: Facturado
let controlFacturado: Facturado

beforeAll(async () => {
  for (const org of [demo.org, control.org]) {
    await prisma.organization.create({ data: { id: org, name: org, email: `${org}@example.test`, phone: '5500000000' } })
  }
  await prisma.staff.create({ data: { id: demo.staff, email: `${demo.staff}@example.test`, firstName: 'Demo', lastName: 'Sellos' } })
  await prisma.venue.create({
    data: { id: demo.venue, organizationId: demo.org, name: 'Demo sellada', slug: demo.venue, status: 'LIVE_DEMO' },
  })
  await prisma.venue.create({ data: { id: control.venue, organizationId: control.org, name: 'Negocio real', slug: control.venue } })
  await prisma.liveDemoSession.create({
    data: {
      id: demo.session,
      sessionId: `${demo.session}-cookie`,
      venueId: demo.venue,
      staffId: demo.staff,
      expiresAt: new Date(Date.now() - 60 * 60 * 1000),
    },
  })
  demoFacturado = await sembrarVentaFacturada(demo.venue)
  controlFacturado = await sembrarVentaFacturada(control.venue)
})

afterAll(async () => {
  await borrarVenue(demo.venue)
  await borrarVenue(control.venue)
  await prisma.staff.deleteMany({ where: { id: demo.staff } })
  await prisma.organization.deleteMany({ where: { id: { in: [demo.org, control.org] } } })
})

describe('D2 · la limpieza de una demo vencida con renglones SELLADOS (IVA por producto)', () => {
  it('🔴 borra la demo entera: sellos, manifiesto de la global, CFDI, renglones, orden y venue', async () => {
    await expect(deleteDisposableDemoSession({ id: demo.session, venueId: demo.venue, staffId: demo.staff })).resolves.toBeGreaterThan(0)

    expect(await prisma.venue.count({ where: { id: demo.venue } })).toBe(0)
    expect(await prisma.liveDemoSession.count({ where: { id: demo.session } })).toBe(0)
    expect(await prisma.orderItemSelloIva.count({ where: { id: { in: demoFacturado.selloIds } } })).toBe(0)
    expect(await prisma.cfdiGlobalOrden.count({ where: { id: demoFacturado.manifiestoId } })).toBe(0)
    expect(await prisma.cfdi.count({ where: { id: { in: demoFacturado.cfdiIds } } })).toBe(0)
    expect(await prisma.orderItem.count({ where: { id: demoFacturado.orderItemId } })).toBe(0)
    expect(await prisma.order.count({ where: { id: demoFacturado.orderId } })).toBe(0)
  })

  it('control — el negocio real con la misma venta facturada queda intacto', async () => {
    expect(await prisma.venue.count({ where: { id: control.venue } })).toBe(1)
    expect(await prisma.orderItemSelloIva.count({ where: { id: { in: controlFacturado.selloIds } } })).toBe(2)
    expect(await prisma.cfdiGlobalOrden.count({ where: { id: controlFacturado.manifiestoId } })).toBe(1)
    expect(await prisma.cfdi.count({ where: { id: { in: controlFacturado.cfdiIds } } })).toBe(2)
    expect(await prisma.orderItem.count({ where: { id: controlFacturado.orderItemId } })).toBe(1)
    expect(await prisma.order.count({ where: { id: controlFacturado.orderId } })).toBe(1)
  })
})
