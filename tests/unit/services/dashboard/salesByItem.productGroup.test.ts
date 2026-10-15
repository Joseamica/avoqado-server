import { prismaMock } from '@tests/__helpers__/setup'
import { getSalesByItem } from '@/services/dashboard/sales-by-item.dashboard.service'

beforeEach(() => {
  prismaMock.$queryRawUnsafe = jest.fn().mockResolvedValue([])
})

it('la consulta une el padre actual y cada renglón trae productGroupId/productGroupName', async () => {
  ;(prismaMock.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
    {
      productId: 'p1',
      product_name: 'Playera · M',
      product_sku: 'S1',
      category_name: 'Ropa',
      product_group_id: 'g1',
      product_group_name: 'Playera',
      items_sold: 2,
      units_sold: 2,
      gross_sales: 600,
      discounts: 0,
    },
  ])
  const r = await getSalesByItem('v1', { startDate: '2026-10-01', endDate: '2026-10-14' })
  const sql = (prismaMock.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string
  expect(sql).toMatch(/LEFT JOIN "ProductGroup" pg ON pg\.id = p\."productGroupId"/)
  expect(JSON.stringify(r.items)).toMatch(/"productGroupName":"Playera"/)
  expect(r.items[0]).toMatchObject({ productGroupId: 'g1', productGroupName: 'Playera', productName: 'Playera · M' })
})

it('el padre se filtra por el mismo negocio de la orden', async () => {
  await getSalesByItem('v1', { startDate: '2026-10-01', endDate: '2026-10-14' })
  const sql = (prismaMock.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string
  expect(sql).toMatch(/LEFT JOIN "ProductGroup" pg ON pg\.id = p\."productGroupId" AND pg\."venueId" = o\."venueId"/)
})

it('un producto suelto trae padre null; agrupado por categoría no inventa padre', async () => {
  ;(prismaMock.$queryRawUnsafe as jest.Mock).mockResolvedValueOnce([
    {
      productId: 'p2',
      product_name: 'Gorra',
      product_sku: null,
      category_name: 'Ropa',
      items_sold: 1,
      units_sold: 1,
      gross_sales: 150,
      discounts: 0,
    },
  ])
  const suelto = await getSalesByItem('v1', { startDate: '2026-10-01', endDate: '2026-10-14' })
  expect(suelto.items[0]).toMatchObject({ productGroupId: null, productGroupName: null })
  ;(prismaMock.$queryRawUnsafe as jest.Mock).mockClear()
  await getSalesByItem('v1', { startDate: '2026-10-01', endDate: '2026-10-14', groupBy: 'category' })
  const sql = (prismaMock.$queryRawUnsafe as jest.Mock).mock.calls[0][0] as string
  expect(sql).toMatch(/NULL as product_group_id/)
  expect(sql).toMatch(/NULL as product_group_name/)
})
