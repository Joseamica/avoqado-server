import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { isWithinHours } from '@/services/online-ordering/hours'
import {
  buildVenueContact,
  DEFAULT_CONFIG,
  getSettings,
  pauseOnlineOrdering,
  storeRequirements,
  updateSettings,
} from '@/services/online-ordering/settings.service'

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

/** Un negocio con domicilio, teléfono y aviso de privacidad PUBLICADO (una versión propia, no la plantilla). */
const VENUE_COMPLETO = { name: 'Flautas', address: 'Av. Coyoacán 123', city: 'CDMX', state: 'CDMX', zipCode: '04000', phone: '5512345678' }
const AVISO = { id: 'pnv1', content: 'Aviso', contentHash: 'h', language: 'es', createdAt: new Date('2026-10-01T00:00:00Z') }
const conRequisitos = (venue: Record<string, unknown> = VENUE_COMPLETO, aviso: unknown = AVISO) => {
  prismaMock.venue.findUnique.mockResolvedValue(venue as any)
  prismaMock.privacyNoticeVersion.findFirst.mockResolvedValue(aviso as any)
}

describe('buildVenueContact', () => {
  it('une domicilio, ciudad, estado y CP con «, » y recorta el teléfono', () => {
    expect(buildVenueContact({ address: 'Av. Coyoacán 123', city: 'CDMX', state: 'CDMX', zipCode: '04000', phone: '5512345678' })).toEqual({
      address: 'Av. Coyoacán 123, CDMX, CDMX, 04000',
      phone: '5512345678',
    })
  })

  it('todo nulo o en blanco ⇒ { address: null, phone: null }', () => {
    expect(buildVenueContact({ address: null, city: null, state: null, zipCode: null, phone: null })).toEqual({
      address: null,
      phone: null,
    })
    expect(buildVenueContact({ address: '  ', city: '', state: ' ', zipCode: '', phone: '   ' })).toEqual({ address: null, phone: null })
  })

  it('salta las partes vacías y recorta cada una', () => {
    expect(
      buildVenueContact({ address: '  Av. Coyoacán 123 ', city: '', state: null, zipCode: ' 04000 ', phone: ' 55 1234 5678 ' }),
    ).toEqual({
      address: 'Av. Coyoacán 123, 04000',
      phone: '55 1234 5678',
    })
  })
})

describe('storeRequirements', () => {
  it('con domicilio, teléfono y una versión PROPIA del aviso, todo se cumple', async () => {
    conRequisitos()
    await expect(storeRequirements('v1')).resolves.toEqual({ address: true, phone: true, privacyNotice: true })
  })

  it('sin teléfono y sólo con la PLANTILLA del aviso (sin versión propia), faltan teléfono y aviso', async () => {
    conRequisitos({ ...VENUE_COMPLETO, phone: '  ' }, null)
    await expect(storeRequirements('v1')).resolves.toEqual({ address: true, phone: false, privacyNotice: false })
  })

  it('sin ningún dato de domicilio falta el domicilio', async () => {
    conRequisitos({ ...VENUE_COMPLETO, address: null, city: null, state: null, zipCode: null })
    await expect(storeRequirements('v1')).resolves.toMatchObject({ address: false })
  })
})

describe('settings.service', () => {
  // Los casos que ENCIENDEN la tienda necesitan un negocio que cumpla los requisitos (R18); cada caso puede cambiarlo.
  beforeEach(() => conRequisitos())

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

  it('A6: lee, combina, valida y escribe DENTRO de una transacción con el candado del negocio (también la primera vez); la bitácora sale después', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      onlineOrderingSettings: { findUnique: jest.fn().mockResolvedValue(null), upsert: jest.fn().mockResolvedValue(row()) },
      reservationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => fn(tx))

    await updateSettings('v1', { enabled: true }, 'staff1')

    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    const [strings, key] = tx.$executeRaw.mock.calls[0]
    expect((strings as string[]).join('?')).toContain('pg_advisory_xact_lock(hashtext(?))')
    expect(key).toBe('online-ordering-settings:v1')
    const lockAt = tx.$executeRaw.mock.invocationCallOrder[0]
    for (const later of [
      tx.onlineOrderingSettings.findUnique.mock.invocationCallOrder[0],
      tx.reservationSettings.findUnique.mock.invocationCallOrder[0],
      tx.onlineOrderingSettings.upsert.mock.invocationCallOrder[0],
    ]) {
      expect(lockAt).toBeLessThan(later)
    }
    // Nada de leer-combinar-escribir corre en el cliente raíz, fuera del candado.
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
    expect(prismaMock.reservationSettings.findUnique).not.toHaveBeenCalled()
    expect((logAction as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(
      tx.onlineOrderingSettings.upsert.mock.invocationCallOrder[0],
    )
  })

  it('R18: encender sin teléfono es 400 STORE_REQUIREMENTS_MISSING con lo que falta, y no guarda ni audita nada', async () => {
    conRequisitos({ ...VENUE_COMPLETO, phone: null })
    await expect(updateSettings('v1', { enabled: true }, 'staff1')).rejects.toMatchObject({
      statusCode: 400,
      code: 'STORE_REQUIREMENTS_MISSING',
      details: { missing: ['phone'] },
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('R18: sin nada de lo exigido lista los tres faltantes, en orden', async () => {
    conRequisitos({ address: null, city: null, state: null, zipCode: null, phone: null }, null)
    await expect(updateSettings('v1', { enabled: true, minOrderAmount: 50 }, 'staff1')).rejects.toMatchObject({
      code: 'STORE_REQUIREMENTS_MISSING',
      details: { missing: ['address', 'phone', 'privacyNotice'] },
    })
  })

  it('R18: con domicilio, teléfono y aviso publicado, encender se guarda', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(row({ enabled: false }) as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(row({ enabled: true }) as any)
    await expect(updateSettings('v1', { enabled: true }, 'staff1')).resolves.toMatchObject({ enabled: true })
    expect((prismaMock.onlineOrderingSettings.upsert.mock.calls[0][0] as any).update).toEqual({ enabled: true })
  })

  it('R18: apagar o cambiar otros campos NUNCA exige requisitos (ni los consulta)', async () => {
    conRequisitos({ address: null, city: null, state: null, zipCode: null, phone: null }, null)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(row() as any)
    prismaMock.onlineOrderingSettings.upsert.mockResolvedValue(row() as any)
    await expect(updateSettings('v1', { minOrderAmount: 50 }, 'staff1')).resolves.toBeDefined()
    await expect(updateSettings('v1', { enabled: false }, 'staff1')).resolves.toBeDefined()
    await expect(updateSettings('v1', { manualPause: true, pausedUntil: null }, 'staff1')).resolves.toBeDefined()
    expect(prismaMock.onlineOrderingSettings.upsert).toHaveBeenCalledTimes(3)
    expect(prismaMock.venue.findUnique).not.toHaveBeenCalled()
    expect(prismaMock.privacyNoticeVersion.findFirst).not.toHaveBeenCalled()
  })

  it('A6: lo que se rechaza por validación (sin medio de pago) se rechaza bajo el candado y no escribe', async () => {
    const tx = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      onlineOrderingSettings: { findUnique: jest.fn().mockResolvedValue(row({ enabled: true })), upsert: jest.fn() },
      reservationSettings: { findUnique: jest.fn() },
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => fn(tx))
    await expect(updateSettings('v1', { acceptsPayAtPickup: false }, 'staff1')).rejects.toMatchObject({ code: 'NO_PAYMENT_MODE' })
    expect(tx.$executeRaw).toHaveBeenCalledTimes(1)
    expect(tx.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
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
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ manualPause: false } as any)
    const now = new Date('2026-10-14T18:30:00.000Z')

    await expect(pauseOnlineOrdering('v1', 30, 'staff1', now)).resolves.toEqual({
      pausedUntil: '2026-10-14T19:00:00.000Z',
      manualPause: false,
    })

    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1' },
      data: { pausedUntil: new Date('2026-10-14T19:00:00.000Z') },
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDERING_PAUSED', staffId: 'staff1', venueId: 'v1' }))
  })

  it('reanudar limpia la pausa y audita RESUMED', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ manualPause: false } as any)
    await expect(pauseOnlineOrdering('v1', null, 'staff1')).resolves.toEqual({ pausedUntil: null, manualPause: false })
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { pausedUntil: null } })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'ONLINE_ORDERING_RESUMED' }))
  })

  it('M-8: reanudar con la pausa del GERENTE puesta lo dice (`manualPause: true`): la tienda sigue frenada aunque `pausedUntil` sea null', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({ manualPause: true } as any)
    await expect(pauseOnlineOrdering('v1', null, 'staff1')).resolves.toEqual({ pausedUntil: null, manualPause: true })
    expect(prismaMock.onlineOrderingSettings.findUnique).toHaveBeenCalledWith({ where: { venueId: 'v1' }, select: { manualPause: true } })
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
