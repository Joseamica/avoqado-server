jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { payment: { count: jest.fn(), findMany: jest.fn() } },
}))
import prisma from '../../../../src/utils/prismaClient'
import * as svc from '../../../../src/services/dashboard/payment.dashboard.service'

const findMany = (prisma as any).payment.findMany as jest.Mock
const count = (prisma as any).payment.count as jest.Mock
const corte = new Date('2026-11-03T18:00:00.000Z')
const filtros = { methods: ['CASH'], startDate: '2026-10-01T06:00:00.000Z', endDate: '2026-11-01T05:59:59.999Z', search: '1234' }

describe('página de cobros para exportes en segundo plano', () => {
  beforeEach(() => jest.clearAllMocks())

  it('where = [el mismo where del listado, corte, keyset], orden estable, tope y select angosto', async () => {
    findMany.mockResolvedValue([])
    const keyset = { OR: [{ createdAt: { lt: corte } }] }
    await svc.fetchPaymentsExportPage('v1', filtros, corte, keyset as any, 500)
    const arg = findMany.mock.calls[0][0]
    expect(arg.where.AND[0]).toEqual(svc.buildPaymentsWhereClause('v1', filtros))
    expect(arg.where.AND[1]).toEqual({ createdAt: { lte: corte } })
    expect(arg.where.AND[2]).toBe(keyset)
    expect(arg.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }])
    expect(arg.take).toBe(500)
    expect(arg.select).toBe(svc.PAYMENTS_EXPORT_SELECT)
    expect(arg.include).toBeUndefined() // no trae la orden ni la fila entera
  })
  it('countPaymentsForExportHasta cuenta con el corte', async () => {
    count.mockResolvedValue(4224)
    expect(await svc.countPaymentsForExportHasta('v1', filtros, corte)).toBe(4224)
    expect(count.mock.calls[0][0].where.AND).toEqual([svc.buildPaymentsWhereClause('v1', filtros), { createdAt: { lte: corte } }])
  })
  it('el GET viejo no cambia: fetchPaymentsForExport sigue con su include y su orden', async () => {
    findMany.mockResolvedValue([])
    await svc.fetchPaymentsForExport('v1', filtros, 10_000)
    const arg = findMany.mock.calls[0][0]
    expect(arg.orderBy).toEqual({ createdAt: 'desc' })
    expect(arg.include.order).toBeDefined()
    expect(arg.take).toBe(10_000)
  })
})
