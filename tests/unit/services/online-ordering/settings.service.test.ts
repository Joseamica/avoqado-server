import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { isWithinHours } from '@/services/online-ordering/hours'
import { DEFAULT_CONFIG, getSettings, pauseOnlineOrdering, updateSettings } from '@/services/online-ordering/settings.service'

const row = (o: Record<string, unknown> = {}) => ({
  id: 'set1',
  venueId: 'v1',
  enabled: true,
  minOrderAmount: new Prisma.Decimal('50.00'),
  defaultPrepMinutes: 20,
  acceptsPayAtPickup: true,
  manualPause: false,
  pausedUntil: null,
  hours: null,
  lastInboxPollAt: null,
  ...o,
})

const dia = (enabled: boolean, open = '09:00', close = '18:00') => ({ enabled, ranges: enabled ? [{ open, close }] : [] })
const semana = () => ({
  monday: dia(true),
  tuesday: dia(true),
  wednesday: dia(true),
  thursday: dia(true),
  friday: dia(true),
  saturday: dia(true, '10:00', '14:00'),
  sunday: dia(false),
})

describe('settings.service', () => {
  it('sin fila devuelve los defaults: apagado y sin latido', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(null)
    await expect(getSettings('v1')).resolves.toEqual({ ...DEFAULT_CONFIG, lastInboxPollAt: null })
    expect(DEFAULT_CONFIG.enabled).toBe(false)
  })

  it('convierte Decimal a número de pesos y la pausa a ISO', async () => {
    const until = new Date('2026-10-15T20:00:00.000Z')
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(row({ pausedUntil: until }) as any)
    const s = await getSettings('v1')
    expect(s.minOrderAmount).toBe(50)
    expect(s.pausedUntil).toBe(until.toISOString())
  })

  it('con fila existente: upsert sólo con los campos del parche, audita y NO relee el horario de reservas', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(row() as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(row({ minOrderAmount: new Prisma.Decimal('80.00') }) as any)

    const out = await updateSettings('v1', { minOrderAmount: 80 }, 'staff1')

    const call = prismaMock.onlineOrderingSettings.upsert.mock.calls[0][0] as any
    expect(call.where).toEqual({ venueId: 'v1' })
    expect(call.update).toEqual({ minOrderAmount: 80 })
    expect(out.minOrderAmount).toBe(80)
    expect(prismaMock.reservationSettings.findUnique).not.toHaveBeenCalled()
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff1', venueId: 'v1', action: 'ONLINE_ORDERING_SETTINGS_UPDATED' }),
    )
  })

  it('no deja encendida una tienda sin ningún medio de pago', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(row() as any)
    await expect(updateSettings('v1', { acceptsPayAtPickup: false }, 'staff1')).rejects.toMatchObject({
      code: 'NO_PAYMENT_MODE',
      statusCode: 400,
    })
    expect(prismaMock.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
  })

  it('la primera vez precarga el horario de reservas si existe y es válido (R16)', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(null)
    prismaMock.reservationSettings.findUnique.mockResolvedValue({ operatingHours: semana() } as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(row({ hours: semana() }) as any)

    await updateSettings('v1', { enabled: true }, 'staff1')

    const call = prismaMock.onlineOrderingSettings.upsert.mock.calls[0][0] as any
    expect(call.create).toMatchObject({ venueId: 'v1', enabled: true, hours: semana() })
    expect(call.update).toEqual({ enabled: true })
  })

  it('un horario de reservas inválido no se precarga', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(null)
    prismaMock.reservationSettings.findUnique.mockResolvedValue({
      operatingHours: { ...semana(), monday: dia(true, '25:00', '30:00') },
    } as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(row() as any)

    await updateSettings('v1', { enabled: true }, 'staff1')

    expect((prismaMock.onlineOrderingSettings.upsert.mock.calls[0][0] as any).create.hours).toBeUndefined()
  })

  it('H5: un horario de reservas NOCTURNO (22:00–02:00) se precarga y a la 01:00 la tienda está en horario', async () => {
    const nocturno = { ...semana(), friday: dia(true, '22:00', '02:00') }
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(null)
    prismaMock.reservationSettings.findUnique.mockResolvedValue({ operatingHours: nocturno } as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(row({ hours: nocturno }) as any)

    await updateSettings('v1', { enabled: true }, 'staff1')

    const hours = (prismaMock.onlineOrderingSettings.upsert.mock.calls[0][0] as any).create.hours
    expect(hours).toEqual(nocturno)
    // sábado 17-oct-2026 01:00 CDMX = 07:00Z: todavía es la franja del viernes
    expect(isWithinHours(hours, new Date('2026-10-17T07:00:00Z'), 'America/Mexico_City')).toBe(true)
  })

  it('pausar desde el piso escribe pausedUntil y audita PAUSED (R12)', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    const now = new Date('2026-10-14T18:30:00.000Z')

    await expect(pauseOnlineOrdering('v1', 30, 'staff1', now)).resolves.toEqual({ pausedUntil: '2026-10-14T19:00:00.000Z' })

    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      data: { pausedUntil: new Date('2026-10-14T19:00:00.000Z') },
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDERING_PAUSED', staffId: 'staff1', venueId: 'v1' }))
  })

  it('reanudar limpia la pausa y audita RESUMED', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    await expect(pauseOnlineOrdering('v1', null, 'staff1')).resolves.toEqual({ pausedUntil: null })
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { pausedUntil: null } })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDERING_RESUMED' }))
  })

  it('pausar no crea la fila: una tienda nunca configurada responde ONLINE_ORDERING_NOT_CONFIGURED', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 0 })
    await expect(pauseOnlineOrdering('v1', 15, 'staff1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'ONLINE_ORDERING_NOT_CONFIGURED',
    })
    expect(prismaMock.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
  })
})
