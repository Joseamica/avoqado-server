/**
 * «Ventas por artículo» — «Dentro de paquete» (founder «B», 20-nov-2026, Flautas Coyoacán) contra Postgres REAL: un mock de
 * `$queryRawUnsafe` devolvería lo que se le diga y no probaría que el SQL existe, que filtra las MISMAS órdenes que las unidades
 * sueltas, ni que no mueve un solo número de los de siempre.
 *
 * Corre en la nube (base desechable propia): ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects=integration
 *   --runTestsByPath tests/integration/dashboard/salesByItem.dentroDePaquete.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

// 18:00 UTC = 12:00 en Ciudad de México: el mismo día local con TZ=UTC (producción) o TZ=America/Mexico_City.
const DAY = new Date('2025-03-11T18:00:00.000Z')
const FUERA = new Date('2025-02-01T18:00:00.000Z')
const RANGO = { startDate: '2025-03-09T00:00:00.000Z', endDate: '2025-03-12T23:59:59.999Z' }
const cents = (n: number): number => Math.round(n * 100)

describe('Ventas por artículo — «Dentro de paquete» con Postgres real', () => {
  let n: NegocioDePrueba
  let paquete: string
  let papa: string
  let pollo: string
  let extraPapa: string
  let extraPollo: string
  let extraSuelto: string

  beforeAll(async () => {
    n = await crearNegocio('dentro-paquete')
    const producto = (name: string, price: number) =>
      prisma.product
        .create({ data: { venueId: n.venueId, categoryId: n.categoryId, sku: `${name}-${Date.now()}`, name, price } as any })
        .then(p => p.id)
    paquete = await producto('Paquete 3 flautas', 100)
    papa = await producto('Flauta de papa', 30)
    pollo = await producto('Flauta de pollo', 30) // sólo se vende dentro del paquete

    const grupo = await prisma.modifierGroup.create({ data: { venueId: n.venueId, name: 'Elige tus flautas' } })
    const extra = (name: string, linkedProductId: string | null) =>
      prisma.modifier.create({ data: { groupId: grupo.id, name, price: 0, linkedProductId } }).then(m => m.id)
    extraPapa = await extra('Papa', papa)
    extraPollo = await extra('Pollo', pollo)
    extraSuelto = await extra('Salsa verde', null) // un extra sin liga no cuenta en ningún platillo

    let folio = 0
    const orden = async (
      over: { createdAt?: Date; status?: string; paymentStatus?: string },
      items: Array<{
        productId: string
        name: string
        quantity: number
        unitPrice: number
        removed?: boolean
        mods?: Array<[string, number]>
      }>,
    ) => {
      const total = items.reduce((s, i) => s + i.quantity * i.unitPrice, 0)
      const o = await prisma.order.create({
        data: {
          venueId: n.venueId,
          orderNumber: `PAQ-${++folio}-${Date.now()}`,
          createdAt: over.createdAt ?? DAY,
          subtotal: total,
          taxAmount: 0,
          total,
          status: (over.status ?? 'COMPLETED') as any,
          paymentStatus: (over.paymentStatus ?? 'PAID') as any,
        },
      })
      for (const i of items) {
        await prisma.orderItem.create({
          data: {
            orderId: o.id,
            productId: i.productId,
            productName: i.name,
            quantity: i.quantity,
            unitPrice: i.unitPrice,
            discountAmount: 0,
            taxAmount: 0,
            total: i.quantity * i.unitPrice,
            ...(i.removed ? { removedAt: DAY } : {}),
            modifiers: { create: (i.mods ?? []).map(([modifierId, quantity]) => ({ modifierId, quantity, price: 0, name: 'x' })) },
          } as any,
        })
      }
    }

    // Cuenta: 2 paquetes, cada uno con 2 de papa + 1 de pollo (+ salsa, que no cuenta) → papa 4, pollo 2. Y 3 flautas de papa sueltas.
    await orden({}, [
      {
        productId: paquete,
        name: 'Paquete 3 flautas',
        quantity: 2,
        unitPrice: 100,
        mods: [
          [extraPapa, 2],
          [extraPollo, 1],
          [extraSuelto, 1],
        ],
      },
      { productId: papa, name: 'Flauta de papa', quantity: 3, unitPrice: 30 },
    ])
    // NO cuentan, igual que las unidades sueltas: cancelada, reembolsada, fuera del rango y renglón quitado.
    await orden({ status: 'CANCELLED' }, [
      { productId: paquete, name: 'Paquete 3 flautas', quantity: 1, unitPrice: 100, mods: [[extraPapa, 3]] },
    ])
    await orden({ paymentStatus: 'REFUNDED' }, [
      { productId: paquete, name: 'Paquete 3 flautas', quantity: 1, unitPrice: 100, mods: [[extraPapa, 3]] },
    ])
    await orden({ createdAt: FUERA }, [
      { productId: paquete, name: 'Paquete 3 flautas', quantity: 1, unitPrice: 100, mods: [[extraPapa, 3]] },
    ])
    await orden({}, [{ productId: paquete, name: 'Paquete 3 flautas', quantity: 1, unitPrice: 100, removed: true, mods: [[extraPapa, 3]] }])
  })

  afterAll(async () => {
    if (!n?.venueId) return
    await prisma.orderItem.deleteMany({ where: { order: { venueId: n.venueId } } }) // sus extras se van en cascada
    await prisma.order.deleteMany({ where: { venueId: n.venueId } })
    await n.limpiar()
  })

  it('suma renglón × extra sólo de extras ligados y de las órdenes que el reporte ya cuenta', async () => {
    const r = await getSalesByItem(n.venueId, RANGO)
    const porId = new Map(r.items.map(i => [i.productId, i]))

    expect(porId.get(papa)).toMatchObject({ unitsSold: 3, unitsInsidePackages: 4, totalUnits: 7 })
    expect(porId.get(paquete)).toMatchObject({ unitsSold: 2, unitsInsidePackages: 0, totalUnits: 2 })
    // Sólo dentro de paquetes: aparece con 0 sueltas y $0, con su categoría.
    expect(porId.get(pollo)).toMatchObject({
      productName: 'Flauta de pollo',
      itemsSold: 0,
      unitsSold: 0,
      grossSales: 0,
      netSales: 0,
      unitsInsidePackages: 2,
      totalUnits: 2,
      categoryName: expect.any(String),
    })
    expect(r.totals).toMatchObject({ unitsSold: 5, unitsInsidePackages: 6, totalUnits: 11 })
  })

  it('🔴 no mueve ningún número de los de siempre: el dinero y las unidades cuadran igual que por categoría', async () => {
    const r = await getSalesByItem(n.venueId, RANGO)
    const porCategoria = await getSalesByItem(n.venueId, { ...RANGO, groupBy: 'category' })

    // 2 × $100 + 3 × $30 = $290; la flauta de pollo no trae dinero.
    expect(cents(r.totals.grossSales)).toBe(29000)
    expect(cents(r.totals.netSales)).toBe(29000)
    expect([cents(porCategoria.totals.grossSales), cents(porCategoria.totals.netSales), porCategoria.totals.unitsSold]).toEqual([
      cents(r.totals.grossSales),
      cents(r.totals.netSales),
      r.totals.unitsSold,
    ])
    expect(r.totals.itemsSold).toBe(porCategoria.totals.itemsSold)
    // Por categoría no se agrega nada.
    expect(porCategoria.totals.unitsInsidePackages).toBeUndefined()
    expect(porCategoria.items.every(i => i.unitsInsidePackages === undefined)).toBe(true)
  })

  it('el filtro de horas aplica igual: fuera del horario no cuenta lo de paquete', async () => {
    // La venta fue a las 12:00 de Ciudad de México; de 15:00 a 16:00 no hay nada.
    const r = await getSalesByItem(n.venueId, { ...RANGO, timezone: 'America/Mexico_City', startHour: '15:00', endHour: '16:00' })
    expect(r.items).toHaveLength(0)
    expect(r.totals).toMatchObject({ unitsSold: 0, unitsInsidePackages: 0, totalUnits: 0 })
  })

  it('la liga es la ACTUAL (retroactiva, aceptado): desligar hoy saca lo de paquete del pasado', async () => {
    await prisma.modifier.update({ where: { id: extraPollo }, data: { linkedProductId: null } })
    try {
      const r = await getSalesByItem(n.venueId, RANGO)
      expect(r.items.find(i => i.productId === pollo)).toBeUndefined()
      expect(r.totals).toMatchObject({ unitsSold: 5, unitsInsidePackages: 4, totalUnits: 9 })
    } finally {
      await prisma.modifier.update({ where: { id: extraPollo }, data: { linkedProductId: pollo } })
    }
  })
})
