/**
 * «Ventas por artículo» — la columna «Dentro de paquete» (founder «B», 20-nov-2026, Flautas Coyoacán).
 *
 * Un extra ligado a un platillo del menú (`Modifier.linkedProductId`, p. ej. la flauta de papa dentro del paquete) NO es una
 * venta suelta de ese platillo. Sus unidades salen APARTE, en `unitsInsidePackages`, y `totalUnits` = sueltas + dentro de paquete.
 *
 * 🔴 Lo que este test protege: ningún número que ya existía se mueve (unidades, artículos, dinero, totales). Sólo unidades, nunca
 * dinero: el precio del extra ya va dentro del producto principal. La liga que se lee es la ACTUAL (retroactiva), aceptado.
 */
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const VENUE = 'venue-1'
const RANGE = { startDate: '2026-11-01T06:00:00.000Z', endDate: '2026-11-21T05:59:59.999Z' }

/** Un renglón del query principal (agrupado por producto). */
const itemRow = (over: Record<string, unknown> = {}) => ({
  productId: 'prod-flauta-papa',
  product_name: 'Flauta de papa',
  product_sku: 'FL-PAPA',
  category_name: 'Flautas',
  channel: null,
  payment_method: null,
  source: null,
  terminal_id: null,
  product_group_id: null,
  product_group_name: null,
  items_sold: 4,
  units_sold: 6,
  gross_sales: 180,
  discounts: 10,
  ...over,
})

/** Un renglón del query de «Dentro de paquete» (agrupado por el platillo ligado). */
const dentroRow = (over: Record<string, unknown> = {}) => ({
  productId: 'prod-flauta-papa',
  product_name: 'Flauta de papa',
  product_sku: 'FL-PAPA',
  category_name: 'Flautas',
  product_group_id: null,
  product_group_name: null,
  units_inside: 15,
  ...over,
})

const sqlDe = (pista: string) =>
  ((prismaMock.$queryRawUnsafe as jest.Mock).mock.calls.map(c => String(c[0])) as string[]).find(s => s.includes(pista))!

beforeEach(() => {
  prismaMock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
})

/** Orden de las consultas con `groupBy = 'none'`: artículos, promociones, dentro de paquete. */
function responder(articulos: unknown[], dentro: unknown[]) {
  ;(prismaMock.$queryRawUnsafe as jest.Mock)
    .mockResolvedValueOnce(articulos) // query principal
    .mockResolvedValueOnce([]) // promociones
    .mockResolvedValueOnce(dentro) // dentro de paquete
}

describe('sales-by-item — «Dentro de paquete»', () => {
  it('suma las unidades dentro de paquete al renglón del platillo SIN mover ningún número existente', async () => {
    responder([itemRow()], [dentroRow()])

    const report = await getSalesByItem(VENUE, { ...RANGE })
    const row = report.items[0]

    expect(row.unitsInsidePackages).toBe(15)
    expect(row.totalUnits).toBe(21) // 6 sueltas + 15 dentro de paquete
    // Lo de siempre, idéntico:
    expect(row).toMatchObject({ itemsSold: 4, unitsSold: 6, grossSales: 180, discounts: 10, netSales: 170 })
    expect(report.totals).toMatchObject({ itemsSold: 4, unitsSold: 6, grossSales: 180, discounts: 10, netSales: 170 })
    expect(report.totals.unitsInsidePackages).toBe(15)
    expect(report.totals.totalUnits).toBe(21)
  })

  it('un platillo que SÓLO se vendió dentro de paquetes aparece con 0 sueltas y $0', async () => {
    responder(
      [
        itemRow({
          productId: 'prod-paquete',
          product_name: 'Paquete 3 flautas',
          units_sold: 5,
          items_sold: 5,
          gross_sales: 500,
          discounts: 0,
        }),
      ],
      [dentroRow()],
    )

    const report = await getSalesByItem(VENUE, { ...RANGE })

    expect(report.items).toHaveLength(2)
    const paquete = report.items[0]
    expect(paquete).toMatchObject({ productName: 'Paquete 3 flautas', unitsSold: 5, unitsInsidePackages: 0, totalUnits: 5 })
    const flauta = report.items[1]
    expect(flauta).toMatchObject({
      productId: 'prod-flauta-papa',
      productName: 'Flauta de papa',
      productSku: 'FL-PAPA',
      categoryName: 'Flautas',
      unit: 'c/u',
      itemsSold: 0,
      unitsSold: 0,
      grossSales: 0,
      discounts: 0,
      netSales: 0,
      unitsInsidePackages: 15,
      totalUnits: 15,
    })
    // El dinero de los totales sigue siendo sólo el del paquete: el extra no suma pesos.
    expect(report.totals).toMatchObject({
      itemsSold: 5,
      unitsSold: 5,
      grossSales: 500,
      netSales: 500,
      unitsInsidePackages: 15,
      totalUnits: 20,
    })
  })

  it('un platillo con dos renglones (lo renombraron) recibe lo de paquete UNA vez, en el primero', async () => {
    responder(
      [itemRow(), itemRow({ product_name: 'Flauta papa (viejo)', units_sold: 2, items_sold: 2, gross_sales: 60, discounts: 0 })],
      [dentroRow()],
    )

    const [nuevo, viejo] = (await getSalesByItem(VENUE, { ...RANGE })).items

    expect(nuevo.unitsInsidePackages).toBe(15)
    expect(viejo.unitsInsidePackages).toBe(0)
    expect(viejo.totalUnits).toBe(2)
  })

  it('una línea sin Product (POS externo) no se lleva lo de paquete de nadie', async () => {
    responder([itemRow({ productId: null, product_name: 'Flauta de papa' })], [dentroRow()])

    const items = (await getSalesByItem(VENUE, { ...RANGE })).items

    expect(items[0]).toMatchObject({ productId: null, unitsInsidePackages: 0, totalUnits: 6 })
    expect(items[1]).toMatchObject({ productId: 'prod-flauta-papa', unitsSold: 0, unitsInsidePackages: 15 })
  })

  it('el platillo ligado trae su familia (para que la tabla lo junte con sus variantes)', async () => {
    responder([], [dentroRow({ product_group_id: 'fam-1', product_group_name: 'Flautas' })])

    const [row] = (await getSalesByItem(VENUE, { ...RANGE })).items

    expect(row).toMatchObject({ productGroupId: 'fam-1', productGroupName: 'Flautas', unitsInsidePackages: 15 })
  })

  it('el SQL: renglón × extra, sólo extras ligados, platillo del MISMO negocio, con tope y los MISMOS filtros de órdenes', async () => {
    responder([itemRow()], [])

    await getSalesByItem(VENUE, { ...RANGE, startHour: '12:00', endHour: '16:00' })

    const articulos = sqlDe('units_sold')
    const dentro = sqlDe('units_inside')
    expect(dentro).toContain('SUM(oi.quantity * oim.quantity)')
    expect(dentro).toContain('FROM "OrderItemModifier" oim')
    expect(dentro).toContain('m."linkedProductId" IS NOT NULL')
    expect(dentro).toContain('lp."venueId" = o."venueId"')
    expect(dentro).toMatch(/LIMIT \d+/)
    // Ni un peso: este query no lee precios.
    expect(dentro).not.toMatch(/price|unitPrice|discountAmount/)
    // Los mismos filtros de órdenes que las unidades sueltas, letra por letra.
    const filtros = [
      'o."venueId" = $1',
      `o.status NOT IN ('CANCELLED')`,
      `o."paymentStatus" NOT IN ('REFUNDED')`,
      'oi."removedAt" IS NULL',
      `COALESCE(o."clientCreatedAt", o."createdAt") >= ($2 AT TIME ZONE 'UTC')`,
      `COALESCE(o."clientCreatedAt", o."createdAt") <= ($3 AT TIME ZONE 'UTC')`,
      '>= 12',
      '<= 16',
    ]
    for (const f of filtros) {
      expect(articulos).toContain(f)
      expect(dentro).toContain(f)
    }
    const call = (prismaMock.$queryRawUnsafe as jest.Mock).mock.calls.find(c => String(c[0]).includes('units_inside'))!
    expect(call.slice(1)).toEqual([VENUE, new Date(RANGE.startDate), new Date(RANGE.endDate)])
  })

  it('agrupando por categoría NO se consulta ni se agregan campos (sólo tiene sentido por producto)', async () => {
    ;(prismaMock.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([itemRow({ productId: null, product_name: 'Flautas' })])

    const report = await getSalesByItem(VENUE, { ...RANGE, groupBy: 'category' })

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1)
    expect(report.items[0].unitsInsidePackages).toBeUndefined()
    expect(report.totals.unitsInsidePackages).toBeUndefined()
  })

  it('sin extras ligados: cada renglón dice 0 dentro de paquete y el total = sueltas', async () => {
    responder([itemRow()], [])

    const report = await getSalesByItem(VENUE, { ...RANGE })

    expect(report.items).toHaveLength(1)
    expect(report.items[0]).toMatchObject({ unitsSold: 6, unitsInsidePackages: 0, totalUnits: 6 })
    expect(report.totals).toMatchObject({ unitsSold: 6, unitsInsidePackages: 0, totalUnits: 6 })
  })
})
