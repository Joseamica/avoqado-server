/**
 * 🔴 Encargo 04edc5 (hz:8024bc1c:D41, founder «C»): la MISMA cortesía se guarda de dos formas según la pantalla, y la meta de
 * comisión «monto por categoría» (`CATEGORY_AMOUNT`) tiene que dar lo mismo con las dos.
 *
 *   · Mostrador / «Cobrar»: el renglón regalado queda a precio LLENO (`total` = $20) con `isCortesia`.
 *   · Mesas: el renglón regalado queda en $0.
 *
 * La meta sumaba `OrderItem.total`: en Mostrador el regalo contaba $20 para el bono y en Mesas $0. Lo regalado no es venta:
 * los renglones en cortesía no suman (como los reportes, `salesGiveaways.ts`). Lo demás no cambia.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../../../src/utils/prismaClient'
import { getStaffMilestoneProgress } from '../../../../../src/services/dashboard/commission/commission-milestone.service'

const db = prisma as unknown as Record<string, any>

const meta = (targetType: string, extra: Record<string, unknown> = {}) => ({
  id: 'm1',
  name: 'Meta bebidas',
  targetType,
  targetValue: new Prisma.Decimal(100),
  period: 'MONTHLY',
  productId: null,
  categoryId: 'cat-bebidas',
  achievements: [],
  ...extra,
})

beforeEach(() => {
  db.commissionMilestone = { findMany: jest.fn() }
  ;(prisma.venue.findUnique as jest.Mock).mockResolvedValue({ timezone: 'America/Mexico_City' })
})

describe('meta por categoría: lo regalado no suma (encargo 04edc5)', () => {
  it('🔴 CATEGORY_AMOUNT suma sólo los renglones que NO son cortesía', async () => {
    db.commissionMilestone.findMany.mockResolvedValue([meta('CATEGORY_AMOUNT')])
    ;(prisma.orderItem.aggregate as jest.Mock).mockResolvedValue({ _sum: { total: new Prisma.Decimal(55) } })

    const [progreso] = await getStaffMilestoneProgress('staff-1', 'venue-1')

    expect(progreso.currentValue).toBe(55)
    const { where } = (prisma.orderItem.aggregate as jest.Mock).mock.calls[0][0]
    expect(where.isCortesia).toBe(false)
    // Regresión: el resto del filtro no cambia (la categoría, el negocio, quién vendió y las canceladas fuera).
    expect(where.product).toEqual({ categoryId: 'cat-bebidas' })
    expect(where.order.venueId).toBe('venue-1')
    expect(where.order.status).toEqual({ not: 'CANCELLED' })
  })

  it('regresión: CATEGORY_QUANTITY (piezas) sigue contando también las regaladas', async () => {
    db.commissionMilestone.findMany.mockResolvedValue([meta('CATEGORY_QUANTITY')])
    ;(prisma.orderItem.aggregate as jest.Mock).mockResolvedValue({ _sum: { quantity: 3 } })

    const [progreso] = await getStaffMilestoneProgress('staff-1', 'venue-1')

    expect(progreso.currentValue).toBe(3)
    const { where } = (prisma.orderItem.aggregate as jest.Mock).mock.calls[0][0]
    expect(where.isCortesia).toBeUndefined()
  })
})
