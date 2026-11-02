/**
 * «Sólo saldo a favor» (`VenueSettings.storeCreditOnly`, spec 2026-10-30 §5.1): se lee y se escribe por el
 * `GET/PUT /dashboard/venues/:venueId/settings` de hoy. Tres puntos por donde el campo se puede perder en silencio:
 *  1. el middleware de validación tira lo que `UpdateVenueSettingsSchema` no conozca;
 *  2. un venue SIN fila de ajustes toma la rama `create` del upsert, y sin la línea explícita nacería en false;
 *  3. la bitácora tiene que decir «de X a Y».
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn(), upsert: jest.fn(), create: jest.fn() },
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
import { UpdateVenueSettingsSchema } from '@/schemas/dashboard/venueSettings.schema'
import { getVenueSettings, updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'

const db = prisma as any

describe('storeCreditOnly en el esquema del PUT', () => {
  const parse = (body: unknown) => UpdateVenueSettingsSchema.safeParse({ params: { venueId: 'venue' }, body })

  it.each([true, false])(
    'conserva %s (si no, el middleware lo tiraría y el switch se vería encendido sin guardar nada)',
    storeCreditOnly => {
      const resultado = parse({ storeCreditOnly })
      expect(resultado.success && resultado.data.body).toEqual({ storeCreditOnly })
    },
  )

  it('es opcional: un PUT que no lo trae no lo inventa', () => {
    const resultado = parse({ enableShifts: false })
    expect(resultado.success && resultado.data.body).toEqual({ enableShifts: false })
  })

  it.each([null, 'true', 1])('rechaza %j con un mensaje en español', storeCreditOnly => {
    const resultado = parse({ storeCreditOnly })
    expect(resultado.success).toBe(false)
    if (!resultado.success) expect(resultado.error.issues[0].message).toBe('El ajuste «Sólo saldo a favor» debe ser true o false')
  })
})

describe('storeCreditOnly: PUT y luego GET', () => {
  /** La fila de VenueSettings de mentira: el upsert aplica `create` o `update` y lo que no se escribe toma el default de la base. */
  let fila: Record<string, unknown> | null

  beforeEach(() => {
    jest.clearAllMocks()
    fila = null
    db.venue.findUnique.mockResolvedValue({ id: 'venue-1' })
    db.venueSettings.findUnique.mockImplementation(async () => fila)
    db.venueSettings.create.mockImplementation(async ({ data }: any) => {
      fila = { id: 'settings-1', storeCreditOnly: false, ...data }
      return fila
    })
    db.venueSettings.upsert.mockImplementation(async ({ create, update }: any) => {
      fila = fila ? { ...fila, ...update } : { id: 'settings-1', storeCreditOnly: false, ...create }
      return fila
    })
  })

  it.each([
    ['con fila de ajustes previa', { id: 'settings-1', venueId: 'venue-1', storeCreditOnly: false }],
    ['sin fila de ajustes (la rama create del upsert)', null],
  ])('PUT storeCreditOnly=true y luego GET lo regresa, %s', async (_caso, previa) => {
    fila = previa
    await updateVenueSettings('venue-1', { storeCreditOnly: true }, 'staff-1')

    const args = db.venueSettings.upsert.mock.calls[0][0]
    expect(args.create).toEqual(expect.objectContaining({ venueId: 'venue-1', storeCreditOnly: true }))
    expect(args.update).toEqual({ storeCreditOnly: true })

    await expect(getVenueSettings('venue-1')).resolves.toMatchObject({ storeCreditOnly: true })
  })

  it('apagarlo (false) también se conserva, con y sin fila previa', async () => {
    await updateVenueSettings('venue-1', { storeCreditOnly: false }, 'staff-1')
    expect(db.venueSettings.upsert.mock.calls[0][0].create).toEqual(expect.objectContaining({ storeCreditOnly: false }))

    fila = { id: 'settings-1', venueId: 'venue-1', storeCreditOnly: true }
    await updateVenueSettings('venue-1', { storeCreditOnly: false }, 'staff-1')
    await expect(getVenueSettings('venue-1')).resolves.toMatchObject({ storeCreditOnly: false })
  })

  it('la bitácora dice quién y de qué a qué', async () => {
    fila = { id: 'settings-1', venueId: 'venue-1', storeCreditOnly: false }
    await updateVenueSettings('venue-1', { storeCreditOnly: true }, 'staff-1')
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: 'staff-1',
        venueId: 'venue-1',
        action: 'SETTINGS_UPDATED',
        data: expect.objectContaining({ changes: { storeCreditOnly: { from: false, to: true } } }),
      }),
    )
  })

  it('un PUT de otro campo no toca storeCreditOnly en ninguna de las dos ramas del upsert', async () => {
    await updateVenueSettings('venue-1', { enableShifts: false }, 'staff-1')
    const args = db.venueSettings.upsert.mock.calls[0][0]
    expect(args.create).not.toHaveProperty('storeCreditOnly')
    expect(args.update).not.toHaveProperty('storeCreditOnly')
  })
})
