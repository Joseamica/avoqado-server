// C1 (Tarea 8): el job de la factura global recorre los emisores con CSD activo de 100 en 100 por id, corre por cada uno la pasada de
// pendientes (`emitirGlobalesPendientes`) con el cursor que guardó para ESE emisor, y un emisor que truena no frena a los demás (re-revisión
// de la T7, b). El trabajo de cada emisor (pendientes aisladas, periodos recientes) lo cubren las pruebas del servicio y la integración.
const mockFindMany = jest.fn()
jest.mock('../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { fiscalEmisor: { findMany: (...a: any[]) => mockFindMany(...a) } },
}))
const mockPendientes = jest.fn()
jest.mock('../../../src/services/fiscal/cfdiGlobal.service', () => ({
  emitirGlobalesPendientes: (...a: any[]) => mockPendientes(...a),
}))
jest.mock('../../../src/observability/jobContext', () => ({ scheduleJob: jest.fn(() => ({ start: jest.fn(), stop: jest.fn() })) }))
import { CfdiGlobalJob } from '../../../src/jobs/cfdiGlobal.job'
import logger from '../../../src/config/logger'

const ids = (prefijo: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefijo}${String(i).padStart(3, '0')}` }))

describe('CfdiGlobalJob — emisores paginados, cursor por emisor, fallos aislados', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockPendientes.mockResolvedValue({ resultados: [], cursor: null })
  })

  it('🔴 lee los emisores de 100 en 100 por id (cada página acotada) y corre la pasada de pendientes de cada uno', async () => {
    const p1 = ids('a', 100)
    const p2 = ids('b', 3)
    mockFindMany.mockResolvedValueOnce(p1).mockResolvedValueOnce(p2)
    await new CfdiGlobalJob().runNow()
    expect(mockFindMany).toHaveBeenCalledTimes(2)
    expect(mockFindMany.mock.calls[0][0]).toMatchObject({ where: { csdStatus: 'ACTIVE' }, orderBy: { id: 'asc' }, take: 100 })
    expect(mockFindMany.mock.calls[1][0]).toMatchObject({ where: { csdStatus: 'ACTIVE', id: { gt: 'a099' } }, take: 100 })
    expect(mockPendientes.mock.calls.map(c => c[0].emisorId)).toEqual([...p1, ...p2].map(x => x.id))
  })

  it('🔴 guarda el cursor de CADA emisor y se lo devuelve en la pasada siguiente', async () => {
    const cursor = { updatedAt: new Date('2026-10-01T00:09:00Z'), id: 'c09' }
    mockFindMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }])
    mockPendientes.mockImplementation(async ({ emisorId, cursor: c }: any) => ({
      resultados: [],
      cursor: emisorId === 'e1' && !c ? cursor : null,
    }))
    const job = new CfdiGlobalJob()
    await job.runNow()
    await job.runNow()
    expect(mockPendientes.mock.calls.map(c => [c[0].emisorId, c[0].cursor])).toEqual([
      ['e1', null],
      ['e2', null],
      ['e1', cursor],
      ['e2', null],
    ])
  })

  it('control — un emisor que truena no frena a los demás (el job de base ya aislaba por emisor)', async () => {
    mockFindMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }])
    mockPendientes.mockImplementation(async ({ emisorId }: any) => {
      if (emisorId === 'e2') throw new Error('se cayó la base')
      return { resultados: [{ status: 'STAMPED' }], cursor: null }
    })
    await new CfdiGlobalJob().runNow()
    expect(mockPendientes.mock.calls.map(c => c[0].emisorId)).toEqual(['e1', 'e2', 'e3'])
  })

  it('🔴 m3: el log «tick complete» lleva los conteos por estado y SÓLO los renglones que piden atención (no STAMPED ni NOTHING_TO_INVOICE)', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger)
    mockFindMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }])
    mockPendientes.mockImplementation(async ({ emisorId }: any) => ({
      cursor: null,
      resultados:
        emisorId === 'e1'
          ? [{ status: 'STAMPED' }, { status: 'NOTHING_TO_INVOICE' }, { status: 'NOTHING_TO_INVOICE' }]
          : [
              { status: 'DETENIDO', reason: 'revisión de soporte' },
              { status: 'SKIPPED', reason: 'en proceso' },
            ],
    }))
    await new CfdiGlobalJob().runNow()
    const cierre = info.mock.calls.find(c => String(c[0]).includes('tick complete'))
    expect((cierre as unknown[] | undefined)?.[1]).toEqual({
      porEstado: { STAMPED: 1, NOTHING_TO_INVOICE: 2, DETENIDO: 1, SKIPPED: 1 },
      atencion: [
        expect.objectContaining({ emisorId: 'e2', status: 'DETENIDO', reason: 'revisión de soporte' }),
        expect.objectContaining({ emisorId: 'e2', status: 'SKIPPED', reason: 'en proceso' }),
      ],
    })
    info.mockRestore()
  })

  it('🔴 T10: el renglón de CADA resultado dice qué quedó fuera (`excluidas`), también en las timbradas y en «nada que facturar»', async () => {
    const info = jest.spyOn(logger, 'info').mockImplementation(() => logger)
    mockFindMany.mockResolvedValue([{ id: 'e1' }])
    mockPendientes.mockResolvedValue({
      cursor: null,
      resultados: [
        { status: 'NOTHING_TO_INVOICE', candidateCount: 0, excluidas: { SIN_TERMINAL: 3 } },
        { status: 'STAMPED', candidateCount: 2, excluidas: { EFECTIVO: 1, COMERCIO_FUERA: 2 } },
        { status: 'STAMPED', candidateCount: 1, excluidas: {} },
      ],
    })
    await new CfdiGlobalJob().runNow()
    const renglones = info.mock.calls.map(c => String(c[0])).filter(l => l.includes('emisor=e1 status='))
    expect(renglones).toHaveLength(3)
    expect(renglones[0]).toContain('excluidas={"SIN_TERMINAL":3}')
    expect(renglones[1]).toContain('excluidas={"EFECTIVO":1,"COMERCIO_FUERA":2}')
    expect(renglones[2]).not.toContain('excluidas=') // sin nada fuera, el renglón no crece
    info.mockRestore()
  })
})
