/**
 * IVA por producto, plan 7 (D2): las apps muestran el IVA del producto en lectura con `ivaTratamiento`. Hoy viaja porque
 * `listProducts` usa `include` (todas las columnas). Esta prueba impide que un `select` futuro lo tire en silencio.
 */
import prisma from '@/utils/prismaClient'
import { listProducts } from '@/controllers/mobile/product.mobile.controller'

const prismaMock = prisma as any

it('control — GET /mobile/venues/:venueId/products manda ivaTratamiento en cada producto', async () => {
  prismaMock.product.findMany.mockResolvedValue([
    { id: 'p1', name: 'GRN TURISMO 2 KG', ivaTratamiento: 'IVA_0', trackInventory: false, inventory: null, recipe: null },
  ])
  const res: any = { json: jest.fn() }
  await listProducts({ params: { venueId: 'v1' } } as any, res, jest.fn())
  const args = prismaMock.product.findMany.mock.calls[0][0]
  // Con `select` habría que pedir ivaTratamiento a mano; con `include` viene solo.
  expect(args.select === undefined || args.select.ivaTratamiento === true).toBe(true)
  expect(res.json.mock.calls[0][0].data[0].ivaTratamiento).toBe('IVA_0')
})
