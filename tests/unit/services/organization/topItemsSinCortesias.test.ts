/**
 * 🔴 Encargo 04edc5 (hz:8024bc1c:D41, founder «C»): el top de productos de la organización tiene que dar lo mismo con las dos
 * formas de guardar la cortesía. En Mostrador/«Cobrar» el renglón regalado queda a precio LLENO (`total` = $20); en Mesas, en $0.
 * El ingreso sumaba `total`: el mismo regalo valía $20 en una pantalla y $0 en la otra. Ahora el ingreso no cuenta lo regalado
 * (como los reportes, `salesGiveaways.ts`); las piezas sí (se entregaron).
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../../src/utils/prismaClient'
import { getTopItems } from '../../../../src/services/organization/organization.service'

const groupBy = prisma.orderItem.groupBy as jest.Mock

beforeEach(() => {
  ;(prisma.organization.findUnique as jest.Mock).mockResolvedValue({ id: 'org-1' })
  ;(prisma.venue.findMany as jest.Mock).mockResolvedValue([{ id: 'v1' }])
  ;(prisma.product.findMany as jest.Mock).mockResolvedValue([
    { id: 'p-agua', name: 'Agua', category: { name: 'Bebidas' } },
    { id: 'p-cafe', name: 'Café', category: { name: 'Cafés' } },
  ])
})

describe('top de productos de la organización: lo regalado no es ingreso (encargo 04edc5)', () => {
  it('🔴 el ingreso sale de los renglones que NO son cortesía; las piezas, de todos', async () => {
    groupBy.mockImplementation(async (args: any) =>
      args.where?.isCortesia === false
        ? // Sin las cortesías: Agua sólo vendió 1 ($20); el Café, $60.
          [
            { productId: 'p-agua', _sum: { total: new Prisma.Decimal(20) } },
            { productId: 'p-cafe', _sum: { total: new Prisma.Decimal(60) } },
          ]
        : // Todas las piezas: 3 aguas (2 regaladas en Mostrador, a precio lleno) y 2 cafés.
          [
            { productId: 'p-agua', _sum: { quantity: 3, total: new Prisma.Decimal(60) } },
            { productId: 'p-cafe', _sum: { quantity: 2, total: new Prisma.Decimal(60) } },
          ],
    )

    const top = await getTopItems('org-1')

    expect(top.map(t => [t.productName, t.quantitySold, t.totalRevenue])).toEqual([
      ['Agua', 3, 20],
      ['Café', 2, 60],
    ])
    // El ingreso se pide sólo para los productos del top (acotado), sin cortesías.
    const ingresos = groupBy.mock.calls.map(c => c[0]).find(a => a.where?.isCortesia === false)
    expect(ingresos.where.OR).toEqual([{ productId: { in: ['p-agua', 'p-cafe'] } }])
  })

  it('🔴 Codex p2 #1: el renglón libre («Otro importe») regalado tampoco es ingreso', async () => {
    groupBy.mockImplementation(async (args: any) =>
      args.where?.isCortesia === false
        ? [{ productId: null, _sum: { total: new Prisma.Decimal(0) } }]
        : [{ productId: null, _sum: { quantity: 1, total: new Prisma.Decimal(50) } }],
    )

    const top = await getTopItems('org-1')

    expect(top.map(t => [t.productId, t.quantitySold, t.totalRevenue])).toEqual([['deleted', 1, 0]])
    const ingresos = groupBy.mock.calls.map(c => c[0]).find(a => a.where?.isCortesia === false)
    expect(ingresos.where.OR).toEqual([{ productId: null }])
  })

  it('el servidor topa el límite a 100 (Codex p2 #5)', async () => {
    groupBy.mockResolvedValue([])
    await getTopItems('org-1', undefined, 100000)
    expect(groupBy.mock.calls[0][0].take).toBe(100)
  })
})
