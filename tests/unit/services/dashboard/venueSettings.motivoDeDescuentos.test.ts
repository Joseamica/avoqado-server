/**
 * «Pedir motivo en los descuentos» (`VenueSettings.discountReasonRequired` + `discountReasons`, encargo f998c8): se escribe por el
 * `PUT /dashboard/venues/:venueId/settings` de hoy. Puntos por donde se puede perder o mentir:
 *  1. el middleware de validación tira lo que `UpdateVenueSettingsSchema` no conozca;
 *  2. un venue SIN fila toma la rama `create` del upsert;
 *  3. no se prende con la lista vacía y, prendido, no se quita el último motivo (el POS no tendría qué ofrecer).
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    venueSettings: { findUnique: jest.fn(), upsert: jest.fn(), create: jest.fn() },
    $transaction: jest.fn(),
    $queryRaw: jest.fn(),
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
import { updateVenueSettings } from '@/services/dashboard/venueSettings.dashboard.service'

const db = prisma as any

describe('motivo de descuentos en el esquema del PUT', () => {
  const parse = (body: unknown) => UpdateVenueSettingsSchema.safeParse({ params: { venueId: 'venue' }, body })

  it('conserva las dos llaves (si no, el middleware las tiraría y el switch se vería encendido sin guardar nada)', () => {
    const r = parse({ discountReasonRequired: true, discountReasons: ['Error de captura'] })
    expect(r.success && r.data.body).toEqual({ discountReasonRequired: true, discountReasons: ['Error de captura'] })
  })

  it('rechaza tipos raros con mensajes en español', () => {
    const a = parse({ discountReasonRequired: 'si' })
    expect(a.success).toBe(false)
    if (!a.success) expect(a.error.issues[0].message).toMatch(/Pedir motivo/)
    const b = parse({ discountReasons: [1] })
    expect(b.success).toBe(false)
    if (!b.success) expect(b.error.issues[0].message).toBe('Cada motivo debe ser un texto')
  })
})

describe('motivo de descuentos: PUT', () => {
  let fila: Record<string, unknown> | null

  beforeEach(() => {
    jest.clearAllMocks()
    fila = null
    db.venue.findUnique.mockResolvedValue({ id: 'venue-1' })
    db.$transaction.mockImplementation(async (cb: any) => cb(db))
    db.$queryRaw.mockResolvedValue([])
    db.venueSettings.findUnique.mockImplementation(async () => fila)
    db.venueSettings.upsert.mockImplementation(async ({ create, update }: any) => {
      fila = fila ? { ...fila, ...update } : { id: 'settings-1', discountReasonRequired: false, discountReasons: [], ...create }
      return fila
    })
  })

  it('sin fila: prender con lista nace prendido y con la lista limpia (rama create)', async () => {
    await updateVenueSettings('venue-1', { discountReasonRequired: true, discountReasons: [' Error de captura ', ''] } as any, 'staff-1')
    const args = db.venueSettings.upsert.mock.calls[0][0]
    expect(args.create).toEqual(expect.objectContaining({ discountReasonRequired: true, discountReasons: ['Error de captura'] }))
    expect(args.update).toEqual({ discountReasonRequired: true, discountReasons: ['Error de captura'] })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'SETTINGS_UPDATED',
        data: expect.objectContaining({ updatedFields: expect.arrayContaining(['discountReasonRequired', 'discountReasons']) }),
      }),
    )
  })

  it('no se prende con la lista guardada vacía: 400 y no escribe', async () => {
    fila = { id: 's', discountReasonRequired: false, discountReasons: [] }
    await expect(updateVenueSettings('venue-1', { discountReasonRequired: true } as any, 'staff-1')).rejects.toThrow(/al menos un motivo/)
    expect(db.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('prendido, quitar el último motivo es 400 y no escribe', async () => {
    fila = { id: 's', discountReasonRequired: true, discountReasons: ['A'] }
    await expect(updateVenueSettings('venue-1', { discountReasons: [] } as any, 'staff-1')).rejects.toThrow(/apaga/)
    expect(db.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('un repetido es 400 en español', async () => {
    await expect(updateVenueSettings('venue-1', { discountReasons: ['Error', 'error'] } as any, 'staff-1')).rejects.toThrow(/repetido/)
  })

  it('Codex r2 #1: valida otra vez con la fila BLOQUEADA en la transacción que escribe (dos administradores a la vez)', async () => {
    // Primera lectura: switch apagado con un motivo (quitarlo pasa). Dentro de la transacción, otro administrador ya lo prendió.
    let lecturas = 0
    db.venueSettings.findUnique.mockImplementation(async () => {
      lecturas += 1
      return lecturas === 1
        ? { id: 's', discountReasonRequired: false, discountReasons: ['A'] }
        : { id: 's', discountReasonRequired: true, discountReasons: ['A'] }
    })
    await expect(updateVenueSettings('venue-1', { discountReasons: [] } as any, 'staff-1')).rejects.toThrow(/apaga/)
    expect(db.$queryRaw).toHaveBeenCalled()
    expect(String(db.$queryRaw.mock.calls[0][0].join('?'))).toMatch(/FOR UPDATE/)
    expect(db.venueSettings.upsert).not.toHaveBeenCalled()
  })

  it('regresión: un PUT sin estas llaves no las toca ni las lee', async () => {
    fila = { id: 's', discountReasonRequired: true, discountReasons: ['A'] }
    await updateVenueSettings('venue-1', { enableShifts: false } as any, 'staff-1')
    expect(db.venueSettings.upsert.mock.calls[0][0].update).toEqual({ enableShifts: false })
  })
})
