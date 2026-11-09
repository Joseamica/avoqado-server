/**
 * Desvincular el celular (App de campo, bloque 1, Tarea 6). Prisma, la bitácora y la revocación van mockeados.
 */
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { revocarSesionesDelCelular } from '@/services/tpv/campo/celular/sesionDeCelular'
import { desvincularCelular } from '@/services/tpv/campo/celular/desvincularCelular.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { celularDeCampo: { updateMany: jest.fn(), findFirst: jest.fn() } },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/services/tpv/campo/celular/sesionDeCelular', () => ({ revocarSesionesDelCelular: jest.fn() }))

const db = prisma as any
const AHORA = new Date('2026-11-09T12:00:00.000Z')
const H = (n: number) => String(n).repeat(64)
const fila = (extra: object = {}) => ({
  id: 'cel1',
  organizationId: 'org1',
  staffId: 'staff1',
  staffIdVinculado: null,
  desvinculadoAt: AHORA,
  porSubir: 3,
  huellasPorSubir: [H(1), H(2)],
  ...extra,
})
const p = { celularId: 'cel1', organizationId: 'org1', motivo: 'PANEL' as const, porStaffId: 'admin1' }

beforeEach(() => {
  jest.resetAllMocks()
  jest.useFakeTimers().setSystemTime(AHORA)
  ;(logAction as jest.Mock).mockResolvedValue(undefined)
  ;(revocarSesionesDelCelular as jest.Mock).mockResolvedValue(1)
  db.celularDeCampo.updateMany.mockResolvedValue({ count: 1 })
  db.celularDeCampo.findFirst.mockResolvedValue(fila())
})
afterEach(() => jest.useRealTimers())

describe('desvincularCelular', () => {
  it('suelta a la persona con un CAS sólo si sigue vinculado, y de la organización', async () => {
    const r = await desvincularCelular(p)

    expect(db.celularDeCampo.updateMany).toHaveBeenCalledWith({
      where: { id: 'cel1', organizationId: 'org1', staffIdVinculado: { not: null } },
      data: { staffIdVinculado: null, sesionId: null, desvinculadoAt: AHORA, desvinculadoPor: 'admin1', motivoDesvinculo: 'PANEL' },
    })
    expect(r).toEqual({
      desvinculadoAt: '2026-11-09T12:00:00.000Z',
      graciaHasta: '2026-11-10T12:00:00.000Z',
      porSubir: 3,
      huellasReportadas: 2,
      yaEstaba: false,
    })
  })

  it('revoca SÓLO las sesiones del celular y lo asienta en la bitácora con porSubir y las huellas', async () => {
    await desvincularCelular(p)

    expect(revocarSesionesDelCelular).toHaveBeenCalledWith('cel1', 'campo_desvinculado')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'admin1',
        organizationId: 'org1',
        action: 'CAMPO_CELULAR_DESVINCULADO',
        entity: 'CelularDeCampo',
        entityId: 'cel1',
        data: { motivo: 'PANEL', porSubir: 3, huellasReportadas: 2 },
      }),
    )
  })

  it('la segunda vez: yaEstaba con los datos que ya tenía, sin revocar ni asentar de nuevo', async () => {
    db.celularDeCampo.updateMany.mockResolvedValue({ count: 0 })
    db.celularDeCampo.findFirst.mockResolvedValue(fila({ desvinculadoAt: new Date('2026-11-09T02:00:00.000Z'), porSubir: 1 }))

    const r = await desvincularCelular({ ...p, motivo: 'CELULAR', porStaffId: null })

    expect(r).toEqual({
      desvinculadoAt: '2026-11-09T02:00:00.000Z',
      graciaHasta: '2026-11-10T02:00:00.000Z',
      porSubir: 1,
      huellasReportadas: 2,
      yaEstaba: true,
    })
    expect(revocarSesionesDelCelular).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('celular de otra organización (o inexistente) → 404 y no se revoca nada', async () => {
    db.celularDeCampo.updateMany.mockResolvedValue({ count: 0 })
    db.celularDeCampo.findFirst.mockResolvedValue(null)

    await expect(desvincularCelular({ ...p, organizationId: 'otra' })).rejects.toMatchObject({ statusCode: 404 })
    expect(db.celularDeCampo.findFirst).toHaveBeenCalledWith({ where: { id: 'cel1', organizationId: 'otra' } })
    expect(revocarSesionesDelCelular).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('el panel de otra persona y el celular mismo quedan con su motivo (CELULAR sin autor)', async () => {
    await desvincularCelular({ ...p, motivo: 'CELULAR', porStaffId: null })
    expect(db.celularDeCampo.updateMany.mock.calls[0][0].data).toMatchObject({ desvinculadoPor: null, motivoDesvinculo: 'CELULAR' })
  })
})
