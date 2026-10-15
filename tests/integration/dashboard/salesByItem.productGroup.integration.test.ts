/**
 * Reportes por familia (variantes, tarea 13) contra Postgres REAL: un mock de `$queryRaw` devolvería lo que se le diga y no
 * probaría que el JOIN al padre no multiplica renglones ni mueve un centavo.
 *
 * TEST_DATABASE_URL=… npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/dashboard/salesByItem.productGroup.integration.test.ts
 */
import prisma from '@/utils/prismaClient'
import { createProductWithVariants } from '@/services/product-variants/productGroup.service'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { getChartData } from '@/services/dashboard/generalStats.dashboard.service'
import { rankTopProducts, type BestSellingProduct } from '@/mcp/tools/sales'
import { crearNegocio, NegocioDePrueba } from '../product-variants/fixtures'

jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: () => null } }))

// 18:00 UTC = 12:00 en Ciudad de México: el mismo día local con TZ=UTC (producción) o TZ=America/Mexico_City.
const DAY = new Date('2025-03-11T18:00:00.000Z')
const FROM_ISO = '2025-03-09T00:00:00.000Z'
const TO_ISO = '2025-03-12T23:59:59.999Z'
const cents = (n: number): number => Math.round(n * 100)

describe('reportes por familia (padre actual, desglose por variante)', () => {
  let n: NegocioDePrueba
  let groupId: string
  let tallaS: string
  let tallaM: string
  let gorra: string

  beforeAll(async () => {
    n = await crearNegocio('rpt-familia')
    const familia = await createProductWithVariants(
      n.venueId,
      {
        name: 'Playera',
        categoryId: n.categoryId,
        options: [{ name: 'Talla', values: ['S', 'M'] }],
        variants: [
          { values: ['S'], price: 299.1 },
          { values: ['M'], price: 329.45 },
        ],
      },
      n.actor,
    )
    groupId = familia.groupId
    ;[tallaS, tallaM] = familia.productIds
    gorra = (
      await prisma.product.create({
        data: { venueId: n.venueId, categoryId: n.categoryId, sku: `GORRA-${Date.now()}`, name: 'Gorra', price: 150 } as any,
      })
    ).id

    const line = (productId: string, productName: string, quantity: number, unitPrice: number, discountAmount: number) => ({
      productId,
      productName,
      quantity,
      unitPrice,
      discountAmount,
      taxAmount: 0,
      total: Math.round((unitPrice * quantity - discountAmount) * 100) / 100,
    })
    const order = (num: string, items: ReturnType<typeof line>[]) => {
      const total = items.reduce((s, i) => s + i.total, 0)
      return prisma.order.create({
        data: {
          venueId: n.venueId,
          orderNumber: `FAM-${num}-${Date.now()}`,
          createdAt: DAY,
          subtotal: total,
          taxAmount: 0,
          total,
          status: 'COMPLETED',
          paymentStatus: 'PAID',
          items: { create: items },
        },
      })
    }
    await order('1', [
      line(tallaS, 'Playera · S', 3, 299.1, 12.34),
      line(tallaM, 'Playera · M', 1, 329.45, 0),
      line(gorra, 'Gorra', 2, 150, 0.01),
    ])
    await order('2', [line(tallaM, 'Playera · M', 3, 329.45, 5.55)])

    // El dueño renombra la familia después de vender: el reporte usa el nombre de HOY; el renglón conserva el de la venta.
    await prisma.productGroup.update({ where: { id: groupId }, data: { name: 'Playera Premium' } })
  })

  afterAll(async () => {
    if (!n?.venueId) return
    await prisma.orderItem.deleteMany({ where: { order: { venueId: n.venueId } } })
    await prisma.order.deleteMany({ where: { venueId: n.venueId } })
    await n.limpiar()
  })

  it('cada variante trae su padre ACTUAL; el suelto no tiene padre y no desaparece', async () => {
    const r = await getSalesByItem(n.venueId, { startDate: FROM_ISO, endDate: TO_ISO })
    expect(r.items).toHaveLength(3)
    const byId = new Map(r.items.map(i => [i.productId, i]))
    expect(byId.get(tallaS)).toMatchObject({ productName: 'Playera · S', productGroupId: groupId, productGroupName: 'Playera Premium' })
    expect(byId.get(tallaM)).toMatchObject({ productName: 'Playera · M', productGroupId: groupId, productGroupName: 'Playera Premium' })
    expect(byId.get(gorra)).toMatchObject({ productName: 'Gorra', productGroupId: null, productGroupName: null })
  })

  it('🔴 dinero: lo que suma la familia cuadra al centavo con sus tallas, y agrupar no mueve el total', async () => {
    const r = await getSalesByItem(n.venueId, { startDate: FROM_ISO, endDate: TO_ISO })
    const familia = r.items.filter(i => i.productGroupId === groupId)
    const sum = (rows: typeof r.items, k: 'grossSales' | 'discounts' | 'netSales') => rows.reduce((s, i) => s + cents(i[k]), 0)

    // S: 3 × 299.10 = 897.30 − 12.34 → 884.96 · M: 4 × 329.45 = 1,317.80 − 5.55 → 1,312.25
    expect(familia.map(i => [i.productName, cents(i.grossSales), cents(i.discounts), cents(i.netSales)]).sort()).toEqual([
      ['Playera · M', 131780, 555, 131225],
      ['Playera · S', 89730, 1234, 88496],
    ])
    expect(sum(familia, 'grossSales')).toBe(221510)
    expect(sum(familia, 'discounts')).toBe(1789)
    expect(sum(familia, 'netSales')).toBe(219721)
    expect(familia.reduce((s, i) => s + i.unitsSold, 0)).toBe(7)

    // El total del reporte es la suma de sus renglones (familia + gorra 299.99), igual que agrupado por categoría.
    expect(cents(r.totals.netSales)).toBe(219721 + 29999)
    expect(cents(r.totals.netSales)).toBe(sum(r.items, 'netSales'))
    const porCategoria = await getSalesByItem(n.venueId, { startDate: FROM_ISO, endDate: TO_ISO, groupBy: 'category' })
    expect(porCategoria.items.every(i => i.productGroupId === null && i.productGroupName === null)).toBe(true)
    expect([cents(porCategoria.totals.grossSales), cents(porCategoria.totals.discounts), cents(porCategoria.totals.netSales)]).toEqual([
      cents(r.totals.grossSales),
      cents(r.totals.discounts),
      cents(r.totals.netSales),
    ])
    expect(porCategoria.totals.unitsSold).toBe(r.totals.unitsSold)
  })

  it('más vendidos: la gráfica trae el padre para agrupar; top_products (certificado) sigue por talla', async () => {
    const { products } = (await getChartData(n.venueId, 'best-selling-products', { fromDate: FROM_ISO, toDate: TO_ISO })) as {
      products: BestSellingProduct[]
    }
    expect(products).toHaveLength(3) // la gráfica del dashboard sigue por variante, con su padre para agrupar
    expect(products.filter(p => p.productGroupId === groupId).map(p => p.productGroupName)).toEqual(['Playera Premium', 'Playera Premium'])
    // `top_products` está en el catálogo certificado del MCP: su salida no cambia (nombre del catálogo, un renglón por talla).
    expect(rankTopProducts(products)).toEqual([
      { name: 'Playera · M', unitsSold: 4, unitPrice: 329.45, type: 'REGULAR' },
      { name: 'Playera · S', unitsSold: 3, unitPrice: 299.1, type: 'REGULAR' },
      { name: 'Gorra', unitsSold: 2, unitPrice: 150, type: 'FOOD' }, // el default de un producto creado sin tipo
    ])
  })
})
