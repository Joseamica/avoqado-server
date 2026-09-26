import { Prisma } from '@prisma/client'
import prisma from '../../../src/utils/prismaClient'
import { CfdiReconcileJob } from '../../../src/jobs/cfdiReconcile.job'
import { completarArchivos } from '../../../src/services/fiscal/finalizadorCfdi'
import { reconcileStuckCfdi } from '../../../src/services/fiscal/cfdiReconcile.service'
jest.mock('../../../src/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))
jest.mock('../../../src/services/fiscal/cfdi.service', () => ({ tocaRevisarCancelaciones: () => false }))
jest.mock('../../../src/services/fiscal/cfdiReconcile.service', () => ({ reconcileStuckCfdi: jest.fn() }))
jest.mock('../../../src/services/fiscal/finalizadorCfdi', () => ({ completarArchivos: jest.fn() }))
jest.mock('../../../src/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: () => ({ name: 'fake' }) }))
describe('barrido de archivos CFDI', () => {
  beforeEach(() => jest.clearAllMocks())
  it('corre sin STAMPING; selección acotada, orden estable y fallo aislado', async () => {
    const rows = ['a', 'b'].map(id => ({
      id,
      idempotencyKey: id,
      uuid: id,
      facturapiId: id,
      attempts: 1,
      venue: { slug: 'demo' },
      fiscalEmisor: {},
    }))
    ;(prisma.cfdi.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce(rows)
    ;(completarArchivos as jest.Mock).mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('OK')
    const before = Date.now()
    await new CfdiReconcileJob().runNow()
    expect(prisma.cfdi.findMany).toHaveBeenCalledTimes(2)
    const query = (prisma.cfdi.findMany as jest.Mock).mock.calls[1][0]
    expect(query).toMatchObject({
      where: { status: 'STAMPED', OR: [{ taxBreakdown: { equals: Prisma.DbNull } }, { xmlUrl: null }] },
      take: 20,
      orderBy: [{ stampedAt: 'asc' }, { id: 'asc' }],
    })
    expect(query.where.stampedAt.lt.getTime()).toBeGreaterThanOrEqual(before - 10 * 60_000)
    expect(query.where.stampedAt.lt.getTime()).toBeLessThanOrEqual(Date.now() - 10 * 60_000)
    expect(completarArchivos).toHaveBeenCalledTimes(2)
    expect(completarArchivos).toHaveBeenLastCalledWith(expect.objectContaining({ cfdiId: 'b', providerInvoiceId: 'b', uuid: 'b' }))
  })
  it('selecciona también STAMP_FAILED inciertas con versión y sellos intactos', async () => {
    ;(prisma.cfdi.findMany as jest.Mock).mockResolvedValueOnce([]).mockResolvedValueOnce([])
    await new CfdiReconcileJob().runNow()
    expect((prisma.cfdi.findMany as jest.Mock).mock.calls[0][0]).toMatchObject({
      where: {
        OR: [{ status: 'STAMPING' }, { status: 'STAMP_FAILED', protocoloIva: 1, falloDefinitivo: false, enviadoAt: { not: null } }],
      },
      select: { attempts: true, protocoloIva: true, falloDefinitivo: true, enviadoAt: true },
    })
    expect(reconcileStuckCfdi).not.toHaveBeenCalled()
  })
  it('avanza ambas páginas después de fallos y vuelve al inicio al agotarlas', async () => {
    const date = new Date(Date.now() - 20 * 60_000)
    const row = (id: string) => ({
      id,
      updatedAt: date,
      stampedAt: date,
      idempotencyKey: id,
      uuid: id,
      facturapiId: id,
      attempts: 1,
      venue: { slug: 'demo' },
      fiscalEmisor: {},
    })
    ;(prisma.cfdi.findMany as jest.Mock)
      .mockResolvedValueOnce([row('a')])
      .mockResolvedValueOnce([row('a')])
      .mockResolvedValueOnce([row('b')])
      .mockResolvedValueOnce([row('b')])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([row('a')])
      .mockResolvedValueOnce([row('a')])
    ;(reconcileStuckCfdi as jest.Mock).mockRejectedValueOnce(new Error('PAC offline')).mockResolvedValue({ outcome: 'INCONCLUSIVE' })
    ;(completarArchivos as jest.Mock).mockResolvedValue('FALLO')
    const job = new CfdiReconcileJob()
    for (let i = 0; i < 4; i++) await job.runNow()
    const queries = (prisma.cfdi.findMany as jest.Mock).mock.calls.map(([query]) => query)
    expect(queries[2].where.AND).toEqual([{ OR: [{ updatedAt: { gt: date } }, { updatedAt: date, id: { gt: 'a' } }] }])
    expect(queries[3].where.AND).toEqual([{ OR: [{ stampedAt: { gt: date } }, { stampedAt: date, id: { gt: 'a' } }] }])
    expect(queries[6].where.AND).toBeUndefined()
    expect(queries[7].where.AND).toBeUndefined()
    expect((completarArchivos as jest.Mock).mock.calls.map(([p]) => p.cfdiId)).toEqual(['a', 'b', 'a'])
  })
})
