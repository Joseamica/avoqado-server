/**
 * Mix de productos — la marca "dentro de «Combo X»".
 *
 * Decisión del founder (2026-08-18): este reporte sigue el modelo SQUARE (desglosa
 * los COMPONENTES: "The Item Sales report shows the individual items from combos
 * sold") y el reporte de promociones sigue el de FUDO/TOAST (el combo como
 * renglón). Se dan las DOS vistas sin switch, y esta marca es lo que evita que se
 * lean como contabilidad doble.
 *
 * 🔴 Lo que este test protege es que la marca sea SÓLO una etiqueta: si tocara un
 * importe, sumar los dos reportes daría de más y nadie lo notaría — exactamente el
 * riesgo que la decisión de "dos vistas" quería evitar.
 */

import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'
import { prismaMock } from '@tests/__helpers__/setup'

const VENUE = 'venue-1'
const RANGE = { startDate: '2026-08-01T06:00:00.000Z', endDate: '2026-08-19T05:59:59.999Z' }

/** Un renglón del query principal (agrupado por producto). */
const itemRow = (over: Record<string, unknown> = {}) => ({
  productId: 'prod-refresco',
  product_name: 'Refresco',
  product_sku: 'REF-1',
  category_name: 'Bebidas',
  channel: null,
  payment_method: null,
  source: null,
  terminal_id: null,
  items_sold: 10,
  units_sold: 30,
  gross_sales: 900,
  discounts: 120,
  ...over,
})

beforeEach(() => {
  prismaMock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
})

describe('sales-by-item — atribución a promociones', () => {
  it('marca el renglón con el nombre del combo SIN mover un solo importe', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([itemRow()]) // query principal
      .mockResolvedValueOnce([
        // atribución
        { productId: 'prod-refresco', product_name: 'Refresco', promotion_name: 'Combo Café + 2 Medialunas', units_sold: 12, net_sales: 240 },
      ])

    const report = await getSalesByItem(VENUE, { ...RANGE })

    const row = report.items[0]
    expect(row.promotionName).toBe('Combo Café + 2 Medialunas')
    expect(row.promotions).toEqual([{ name: 'Combo Café + 2 Medialunas', unitsSold: 12, netSales: 240 }])

    // El dinero es EXACTAMENTE el del query principal: la marca no suma ni resta.
    expect(row.grossSales).toBe(900)
    expect(row.discounts).toBe(120)
    expect(row.netSales).toBe(780)
    expect(row.unitsSold).toBe(30) // 30 en total, de las cuales 12 salieron en el combo
    expect(report.totals).toMatchObject({ grossSales: 900, discounts: 120, netSales: 780, unitsSold: 30 })
  })

  it('un producto vendido en VARIAS promociones no inventa un nombre único', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([itemRow()]).mockResolvedValueOnce([
      { productId: 'prod-refresco', product_name: 'Refresco', promotion_name: 'Combo Café', units_sold: 8, net_sales: 160 },
      { productId: 'prod-refresco', product_name: 'Refresco', promotion_name: '2x1 Refrescos', units_sold: 4, net_sales: 40 },
    ])

    const row = (await getSalesByItem(VENUE, { ...RANGE })).items[0]

    expect(row.promotionName).toBeNull() // la UI dice "en 2 promociones", no elige una
    expect(row.promotions).toHaveLength(2)
  })

  it('un producto que nunca se vendió en promoción no carga los campos (aditivo puro)', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([itemRow()]).mockResolvedValueOnce([])

    const row = (await getSalesByItem(VENUE, { ...RANGE })).items[0]

    expect(row.promotions).toBeUndefined()
    expect(row.promotionName).toBeUndefined()
  })

  it('la llave de merge usa id Y nombre: una línea sin Product no roba la marca de otra', async () => {
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        itemRow(),
        itemRow({ productId: null, product_name: 'Agua de sabor', product_sku: null, items_sold: 2, units_sold: 2, gross_sales: 40, discounts: 0 }),
      ])
      .mockResolvedValueOnce([
        { productId: null, product_name: 'Agua de sabor', promotion_name: 'Comida corrida', units_sold: 2, net_sales: 30 },
      ])

    const [refresco, agua] = (await getSalesByItem(VENUE, { ...RANGE })).items

    expect(refresco.promotions).toBeUndefined() // no hereda la marca del renglón sin id
    expect(agua.promotionName).toBe('Comida corrida')
  })

  it('agrupando por canal NO se consulta la atribución (ahí no le pertenece a ningún renglón)', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValueOnce([itemRow({ channel: 'POS' })])

    await getSalesByItem(VENUE, { ...RANGE, groupBy: 'channel' })

    expect(prismaMock.$queryRawUnsafe).toHaveBeenCalledTimes(1)
  })
})
