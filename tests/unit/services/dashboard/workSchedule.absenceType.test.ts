/**
 * Fase 3 del checador: el TIPO de ausencia viaja completo por el cuadrante.
 * Referente (buscado en vivo 2026-08-26): Sesame separa vacaciones · permisos con/sin goce ·
 * bajas. El tipo vive en la MISMA excepción OFF que ya gana en el resolvedor: así capturar
 * unas vacaciones deja de marcar FALTA sin un segundo libro que se desincronice.
 */

jest.mock('@/utils/prismaClient', () => {
  const tx = {
    staffWorkSchedule: { upsert: jest.fn(), deleteMany: jest.fn() },
    staffWorkScheduleException: { deleteMany: jest.fn(), createMany: jest.fn() },
  }
  return {
    __esModule: true,
    default: {
      staffVenue: { findFirst: jest.fn() },
      staffWorkSchedule: { findUnique: jest.fn() },
      staffWorkScheduleException: { findMany: jest.fn() },
      $transaction: jest.fn(async (cb: (c: typeof tx) => unknown) => cb(tx)),
      __tx: tx,
    },
  }
})
jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { getWorkSchedule, replaceWorkSchedule, resolveExpectedDay } from '@/services/dashboard/workSchedule.service'

const db = prisma as any
const weekly = { wednesday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] } }

beforeEach(() => {
  jest.clearAllMocks()
  db.staffVenue.findFirst.mockResolvedValue({ staffId: 'staff-1' })
  db.staffWorkSchedule.findUnique.mockResolvedValue({ weekly })
  db.staffWorkScheduleException.findMany.mockResolvedValue([])
})

describe('el tipo viaja completo', () => {
  it('replaceWorkSchedule persiste el tipo de la excepción OFF', async () => {
    await replaceWorkSchedule(
      'venue-1',
      'sv-1',
      { weekly, exceptions: [{ startDate: '2026-09-01', endDate: '2026-09-05', kind: 'OFF', type: 'VACATION', note: 'playa' }] },
      'actor-1',
    )
    expect(db.__tx.staffWorkScheduleException.createMany.mock.calls[0][0].data[0]).toEqual(
      expect.objectContaining({ kind: 'OFF', type: 'VACATION' }),
    )
  })

  it('sin tipo se guarda null (descanso simple — filas previas siguen valiendo)', async () => {
    await replaceWorkSchedule('venue-1', 'sv-1', { weekly, exceptions: [{ startDate: '2026-09-01', endDate: '2026-09-01', kind: 'OFF' }] }, 'a')
    expect(db.__tx.staffWorkScheduleException.createMany.mock.calls[0][0].data[0].type).toBeNull()
  })

  it('un tipo de ausencia sobre un día HOURS se rechaza: cambiar el horario no es faltar', async () => {
    await expect(
      replaceWorkSchedule(
        'venue-1',
        'sv-1',
        { weekly, exceptions: [{ startDate: '2026-09-01', endDate: '2026-09-01', kind: 'HOURS', startTime: '10:00', endTime: '14:00', type: 'VACATION' }] },
        'a',
      ),
    ).rejects.toThrow(/ausencia/)
  })

  it('getWorkSchedule devuelve el tipo', async () => {
    db.staffWorkScheduleException.findMany.mockResolvedValue([
      { id: 'e1', startDate: '2026-09-01', endDate: '2026-09-05', kind: 'OFF', startTime: null, endTime: null, note: null, type: 'SICK_LEAVE' },
    ])
    const r = await getWorkSchedule('venue-1', 'sv-1')
    expect(r.exceptions[0]).toEqual(expect.objectContaining({ type: 'SICK_LEAVE' }))
  })
})

describe('resolveExpectedDay expone el tipo del día ganador', () => {
  it('vacaciones ganan al cuadrante y el día sabe POR QUÉ no se viene', () => {
    const r = resolveExpectedDay(weekly, [{ startDate: '2026-08-26', endDate: '2026-08-28', kind: 'OFF', type: 'VACATION' }], '2026-08-26')
    expect(r).toEqual(expect.objectContaining({ isDayOff: true, absenceType: 'VACATION' }))
  })

  it('descanso semanal (sin excepción) no trae tipo', () => {
    const r = resolveExpectedDay({ wednesday: { enabled: false, ranges: [] } }, [], '2026-08-26')
    expect(r.isDayOff).toBe(true)
    expect(r.absenceType ?? null).toBeNull()
  })
})
