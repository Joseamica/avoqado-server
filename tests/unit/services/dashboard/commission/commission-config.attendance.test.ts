/**
 * Config de esquemas — la regla de asistencia entra y sale completa, nunca a medias.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    commissionConfig: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn() },
    venue: { findUnique: jest.fn() },
  },
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { createCommissionConfig, updateCommissionConfig } from '@/services/dashboard/commission/commission-config.service'

const db = prisma as any

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ id: 'venue-1', organizationId: 'org-1' })
  db.commissionConfig.create.mockImplementation(async (args: any) => ({ id: 'cfg-1', ...args.data }))
  db.commissionConfig.findFirst.mockResolvedValue({ id: 'cfg-1', venueId: 'venue-1', _count: { calculations: 0 } })
  db.commissionConfig.update.mockImplementation(async (args: any) => ({ id: 'cfg-1', ...args.data }))
})

describe('asistencia → comisiones en el config', () => {
  it('crear con la regla prendida guarda linked + porcentaje', async () => {
    await createCommissionConfig(
      'venue-1',
      { name: 'Meseros', defaultRate: 0.03, attendanceLinked: true, attendanceLatePenaltyRate: 0.25 } as any,
      'staff-1',
    )
    expect(db.commissionConfig.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ attendanceLinked: true, attendanceLatePenaltyRate: 0.25 }),
    )
  })

  it('el default de fábrica es APAGADA: crear sin mencionarla guarda linked=false, rate=null', async () => {
    await createCommissionConfig('venue-1', { name: 'Meseros', defaultRate: 0.03 } as any, 'staff-1')
    expect(db.commissionConfig.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ attendanceLinked: false, attendanceLatePenaltyRate: null }),
    )
  })

  it('prenderla SIN porcentaje se rechaza: un interruptor que no hace nada confunde', async () => {
    await expect(
      createCommissionConfig('venue-1', { name: 'X', defaultRate: 0.03, attendanceLinked: true } as any, 'staff-1'),
    ).rejects.toThrow(/porcentaje/)
    await expect(updateCommissionConfig('cfg-1', 'venue-1', { attendanceLinked: true } as any, 'staff-1')).rejects.toThrow(/porcentaje/)
  })

  it('porcentaje fuera de (0,1] se rechaza en crear y en actualizar', async () => {
    for (const bad of [0, -0.1, 1.5, Number.NaN]) {
      await expect(
        createCommissionConfig(
          'venue-1',
          { name: 'X', defaultRate: 0.03, attendanceLinked: true, attendanceLatePenaltyRate: bad } as any,
          'staff-1',
        ),
      ).rejects.toThrow(/porcentaje/)
    }
  })

  it('actualizar sólo el porcentaje (regla ya prendida) pasa', async () => {
    await updateCommissionConfig('cfg-1', 'venue-1', { attendanceLatePenaltyRate: 0.5 } as any, 'staff-1')
    expect(db.commissionConfig.update.mock.calls[0][0].data).toEqual(expect.objectContaining({ attendanceLatePenaltyRate: 0.5 }))
  })
})
