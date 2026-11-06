/**
 * D1 (IQ, 5-nov-2026): la lista de Ventas del POS no manda un cobro que no se cobró.
 *
 * La venta duplicada de IQ del 26-oct se anuló el 29-oct (pago → FAILED), y la tableta la seguía pintando como «$15,300 Tarjeta
 * de crédito» junto a la buena, porque la consulta sólo quitaba los PENDING. Las apps no leen `status` en la lista: lo que el
 * servidor manda, lo enseñan como venta. La consulta y el conteo (la paginación) usan el mismo filtro.
 */
import prisma from '@/utils/prismaClient'
import { getTransactions } from '@/services/mobile/transaction.mobile.service'

jest.mock('@/services/dashboard/refund.dashboard.service', () => ({ listRefundsForPayment: jest.fn() }))

const prismaMock = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.$transaction.mockResolvedValue([[], 0])
})

const filtroDeEstado = (llamada: any) => llamada[0].where.status

describe('getTransactions · cobros que no se cobraron (D1)', () => {
  it('🔴 la consulta deja fuera los FAILED además de los PENDING', async () => {
    await getTransactions('venue_1', 1, 20)
    expect(filtroDeEstado(prismaMock.payment.findMany.mock.calls[0])).toEqual({ notIn: ['PENDING', 'FAILED'] })
  })

  it('🔴 el total de la paginación cuenta con el mismo filtro que la lista', async () => {
    await getTransactions('venue_1', 1, 20)
    expect(filtroDeEstado(prismaMock.payment.count.mock.calls[0])).toEqual({ notIn: ['PENDING', 'FAILED'] })
  })

  it('🔴 con filtro de método y búsqueda también se quedan fuera', async () => {
    await getTransactions('venue_1', 1, 20, { method: 'CREDIT_CARD' as any, search: '15300' })
    const where = prismaMock.payment.findMany.mock.calls[0][0].where
    expect(where.status).toEqual({ notIn: ['PENDING', 'FAILED'] })
    expect(where.method).toBe('CREDIT_CARD')
    expect(where.OR).toBeDefined()
  })

  // Regresión: lo demás de la consulta no cambia.
  it('sigue acotada al negocio y a la página pedida, de la más nueva a la más vieja', async () => {
    await getTransactions('venue_1', 2, 20)
    const args = prismaMock.payment.findMany.mock.calls[0][0]
    expect(args.where.venueId).toBe('venue_1')
    expect(args.skip).toBe(20)
    expect(args.take).toBe(20)
    expect(args.orderBy).toEqual({ createdAt: 'desc' })
  })

  it('un reembolso (REFUNDED) sigue saliendo en la lista: el filtro no lo excluye', async () => {
    await getTransactions('venue_1', 1, 20)
    const { notIn } = filtroDeEstado(prismaMock.payment.findMany.mock.calls[0])
    expect(notIn).not.toContain('REFUNDED')
    expect(notIn).not.toContain('COMPLETED')
  })
})
