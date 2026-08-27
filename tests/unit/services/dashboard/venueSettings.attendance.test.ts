/**
 * Interruptor de asistencia — el PRIMER guardado de un venue sin fila de settings.
 * Auditoría Codex de la fase 2 del checador (2026-08-26), P2-1 y P3-1.
 *
 * `updateVenueSettings` hace upsert. En la rama `create` armaba la fila con defaults y
 * OMITÍA `attendanceEnabled` / `attendanceGraceMinutes`, así que un venue que apagaba la
 * asistencia por primera vez (53 de 68 venues locales no tienen fila) se quedaba con
 * `true/10` — y el dashboard mostraba el valor pedido, no el guardado. Y el
 * `SETTINGS_UPDATED` salía sin `staffId`: nadie sabía quién apagó qué.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn(), upsert: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'

const db = prisma as any
const audit = logAction as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  db.venue.findUnique.mockResolvedValue({ id: 'venue-1' })
  db.venueSettings.findUnique.mockResolvedValue(null) // venue SIN fila todavía
  db.venueSettings.upsert.mockImplementation(async (args: any) => ({
    id: 'settings-1',
    venueId: 'venue-1',
    ...args.create,
    ...args.update,
  }))
})

describe('updateVenueSettings — asistencia', () => {
  it('P2-1: la rama create conserva attendanceEnabled y attendanceGraceMinutes', async () => {
    await updateVenueSettings('venue-1', { attendanceEnabled: false, attendanceGraceMinutes: 30 } as any, 'staff-1')

    const args = db.venueSettings.upsert.mock.calls[0][0]
    expect(args.create).toEqual(expect.objectContaining({ venueId: 'venue-1', attendanceEnabled: false, attendanceGraceMinutes: 30 }))
    expect(args.update).toEqual(expect.objectContaining({ attendanceEnabled: false, attendanceGraceMinutes: 30 }))
  })

  it('P2-1: sin esos campos en el body, la rama create NO los inventa (quedan los defaults de la base)', async () => {
    await updateVenueSettings('venue-1', { enableShifts: true } as any, 'staff-1')

    const args = db.venueSettings.upsert.mock.calls[0][0]
    expect(args.create).not.toHaveProperty('attendanceEnabled')
    expect(args.create).not.toHaveProperty('attendanceGraceMinutes')
  })

  it('P3-1: SETTINGS_UPDATED lleva quién lo hizo y qué cambió (antes → después)', async () => {
    db.venueSettings.findUnique.mockResolvedValue({ id: 'settings-1', attendanceEnabled: true, attendanceGraceMinutes: 10 })

    await updateVenueSettings('venue-1', { attendanceEnabled: false } as any, 'staff-1')

    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        venueId: 'venue-1',
        action: 'SETTINGS_UPDATED',
        data: expect.objectContaining({
          updatedFields: ['attendanceEnabled'],
          changes: { attendanceEnabled: { from: true, to: false } },
        }),
      }),
    )
  })

  it('regresión: un venue que YA tiene fila sigue actualizándose por la rama update', async () => {
    db.venueSettings.findUnique.mockResolvedValue({ id: 'settings-1', attendanceEnabled: true, attendanceGraceMinutes: 10 })

    const result = await updateVenueSettings('venue-1', { attendanceGraceMinutes: 20 } as any, 'staff-1')

    expect(db.venueSettings.upsert).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: 'venue-1' } }))
    expect(result).toEqual(expect.objectContaining({ attendanceGraceMinutes: 20 }))
  })
})
