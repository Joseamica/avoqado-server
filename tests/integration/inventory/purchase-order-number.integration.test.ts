import prisma from '@/utils/prismaClient'
import { createPurchaseOrder } from '@/services/dashboard/purchaseOrder.service'
import { createPurchaseOrdersFromSuggestions } from '@/services/dashboard/autoReorder.service'
import { Decimal } from '@prisma/client/runtime/library'

// D6: el consecutivo `PO<fecha>-NNN` es de cada negocio; antes el índice único era de toda la base y el
// segundo negocio del día recibía un 500. La carrera dentro de un negocio la resuelve el candado.
describe('Número de orden de compra por negocio', () => {
  const venueIds: string[] = []
  const orgIds: string[] = []

  async function negocio() {
    const sufijo = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    const org = await prisma.organization.create({
      data: { name: `PO Numero ${sufijo}`, email: `po-numero-${sufijo}@avoqado.test`, phone: '5550000000', type: 'RESTAURANT' },
    })
    orgIds.push(org.id)
    const venue = await prisma.venue.create({
      data: {
        organizationId: org.id,
        name: `PO Numero ${sufijo}`,
        slug: `po-numero-${sufijo}`,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
      },
    })
    venueIds.push(venue.id)
    const supplier = await prisma.supplier.create({ data: { venueId: venue.id, name: `Proveedor ${sufijo}` } })
    const rawMaterial = await prisma.rawMaterial.create({
      data: {
        venueId: venue.id,
        name: `Insumo ${sufijo}`,
        sku: `PO-NUM-${sufijo}`.slice(0, 60),
        category: 'OTHER',
        currentStock: new Decimal(0),
        unit: 'KILOGRAM',
        unitType: 'WEIGHT',
        minimumStock: new Decimal(0),
        reorderPoint: new Decimal(10),
        costPerUnit: new Decimal(5),
        avgCostPerUnit: new Decimal(5),
      },
    })
    return { venueId: venue.id, supplierId: supplier.id, rawMaterialId: rawMaterial.id }
  }

  type Negocio = Awaited<ReturnType<typeof negocio>>

  const crear = (n: Negocio) =>
    createPurchaseOrder(n.venueId, {
      supplierId: n.supplierId,
      orderDate: new Date().toISOString(),
      taxRate: 0.16,
      commissionRate: 0,
      shippingAddressType: 'VENUE',
      items: [{ rawMaterialId: n.rawMaterialId, quantityOrdered: 2, unit: 'KILOGRAM', unitPrice: 10 }],
    })

  const conPrecioDeProveedor = (n: Negocio) =>
    prisma.supplierPricing.create({
      data: {
        supplierId: n.supplierId,
        rawMaterialId: n.rawMaterialId,
        pricePerUnit: new Decimal(10),
        unit: 'KILOGRAM',
        effectiveFrom: new Date(Date.now() - 86_400_000),
      },
    })

  const consecutivo = (numero: string) => numero.split('-')[1]

  afterEach(async () => {
    if (venueIds.length > 0) {
      await prisma.purchaseOrderItem.deleteMany({ where: { purchaseOrder: { venueId: { in: venueIds } } } })
      await prisma.purchaseOrder.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.supplierPricing.deleteMany({ where: { supplier: { venueId: { in: venueIds } } } })
      await prisma.supplier.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.rawMaterial.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.activityLog.deleteMany({ where: { venueId: { in: venueIds } } })
      await prisma.venue.deleteMany({ where: { id: { in: venueIds } } })
    }
    if (orgIds.length > 0) await prisma.organization.deleteMany({ where: { id: { in: orgIds } } })
    venueIds.length = 0
    orgIds.length = 0
  })

  afterAll(async () => {
    await prisma.$disconnect()
  })

  it('🔴 dos negocios el mismo día arrancan cada uno en -001', async () => {
    const [a, b] = [await negocio(), await negocio()]

    const deA = await crear(a)
    const deB = await crear(b)
    const segundaDeB = await crear(b)

    expect(deA.orderNumber).toMatch(/^PO\d{8}-001$/)
    expect(deB.orderNumber).toBe(deA.orderNumber)
    expect(consecutivo(segundaDeB.orderNumber)).toBe('002')
  })

  it('🔴 la reorden automática también numera por negocio', async () => {
    const [a, b] = [await negocio(), await negocio()]
    await crear(a)
    await conPrecioDeProveedor(b)

    const creadas = await createPurchaseOrdersFromSuggestions(b.venueId, [b.rawMaterialId])

    expect(creadas.orders).toHaveLength(1)
    expect(consecutivo(creadas.orders[0].orderNumber)).toBe('001')
  })

  it('🔴 12 órdenes a la vez en un negocio: todas pasan, sin repetidos ni hoyos', async () => {
    const n = await negocio()

    const resultados = await Promise.allSettled(Array.from({ length: 12 }, () => crear(n)))

    expect(resultados.filter(r => r.status === 'rejected')).toEqual([])
    const filas = await prisma.purchaseOrder.findMany({ where: { venueId: n.venueId }, select: { orderNumber: true } })
    expect(filas.map(f => consecutivo(f.orderNumber)).sort()).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(3, '0')))
  })

  it('🔴 el panel y la reorden automática a la vez no se pisan el número', async () => {
    const n = await negocio()
    await conPrecioDeProveedor(n)

    // Una ráfaga: la automática lee más antes de numerar, y una sola de cada una pasa por suerte de tiempos.
    const resultados = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) => (i % 2 ? crear(n) : createPurchaseOrdersFromSuggestions(n.venueId, [n.rawMaterialId]))),
    )

    expect(resultados.filter(r => r.status === 'rejected')).toEqual([])
    const filas = await prisma.purchaseOrder.findMany({ where: { venueId: n.venueId }, select: { orderNumber: true } })
    expect(filas.map(f => consecutivo(f.orderNumber)).sort()).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(3, '0')))
  })

  it('la base permite el mismo número en dos negocios y lo rechaza dentro de uno', async () => {
    const [a, b] = [await negocio(), await negocio()]
    const fila = (n: Negocio) => ({
      venueId: n.venueId,
      supplierId: n.supplierId,
      orderNumber: 'PO-1730000000000', // la forma del POS, con el mismo milisegundo
      orderDate: new Date(),
      subtotal: new Decimal(0),
      total: new Decimal(0),
    })

    await prisma.purchaseOrder.create({ data: fila(a) })
    await expect(prisma.purchaseOrder.create({ data: fila(b) })).resolves.toBeTruthy()
    await expect(prisma.purchaseOrder.create({ data: fila(a) })).rejects.toMatchObject({ code: 'P2002' })
  })
})
