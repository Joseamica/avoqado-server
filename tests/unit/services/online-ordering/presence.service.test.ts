import { prismaMock } from '@tests/__helpers__/setup'
import { MAX_PENDING_PER_VENUE } from '@/services/online-ordering/constants'
import { __resetPresenceDebounceForTests, getAcceptingStatus, storeView, touchInboxPoll, touchToPayPoll } from '@/services/online-ordering/presence.service'

const NOW = new Date('2026-10-14T18:30:00.000Z') // miércoles 12:30 CDMX
const settingsRow = (o: Record<string, unknown> = {}) => ({
  id: 's',
  venueId: 'v1',
  enabled: true,
  minOrderAmount: 0,
  defaultPrepMinutes: 15,
  acceptsPayAtPickup: true,
  manualPause: false,
  pausedUntil: null,
  hours: null,
  lastInboxPollAt: new Date(NOW.getTime() - 30_000),
  ...o,
})

beforeEach(() => {
  __resetPresenceDebounceForTests()
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.onlineOrder.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0)
})

describe('touchInboxPoll', () => {
  it('escribe el latido y amortigua las escrituras dentro de 30 s', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    await expect(touchInboxPoll('v1', NOW)).resolves.toBe(true)
    await expect(touchInboxPoll('v1', new Date(NOW.getTime() + 10_000))).resolves.toBe(false)
    await expect(touchInboxPoll('v1', new Date(NOW.getTime() + 31_000))).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledTimes(2)
  })

  it('si la escritura falla, el debounce no se mueve: el siguiente sondeo vuelve a intentar (R13)', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce({ count: 1 })
    await expect(touchInboxPoll('v1', NOW)).rejects.toThrow('db')
    await expect(touchInboxPoll('v1', new Date(NOW.getTime() + 5_000))).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledTimes(2)
  })
})

describe('touchToPayPoll (tienda híbrida: el latido de quien puede cobrar folios)', () => {
  const tx = () => {
    const t: any = {
      $executeRaw: jest.fn().mockResolvedValue(0),
      onlineOrderingSettings: { upsert: jest.fn().mockResolvedValue({}) },
      reservationSettings: { findUnique: jest.fn().mockResolvedValue(null) },
    }
    ;(prismaMock.$transaction as jest.Mock).mockImplementationOnce(async (fn: any) => fn(t))
    return t
  }

  it('con fila: escribe lastToPayPollAt y se amortigua 30 s', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    await expect(touchToPayPoll('v1', NOW)).resolves.toBe(true)
    await expect(touchToPayPoll('v1', new Date(NOW.getTime() + 10_000))).resolves.toBe(false)
    await expect(touchToPayPoll('v1', new Date(NOW.getTime() + 31_000))).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledTimes(2)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { lastToPayPollAt: NOW } })
  })

  it('sin fila de ajustes, el primer latido la crea apagada, en «Mi equipo», con lastToPayPollAt (R37)', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 0 })
    const t = tx()
    await expect(touchToPayPoll('v1', NOW)).resolves.toBe(true)
    expect(t.$executeRaw).toHaveBeenCalled() // el candado de ajustes
    const arg = t.onlineOrderingSettings.upsert.mock.calls[0][0]
    expect(arg.where).toEqual({ venueId: 'v1' })
    expect(arg.create).toEqual({ venueId: 'v1', enabled: false, requiresAcceptance: true, lastToPayPollAt: NOW })
    expect(arg.update).toEqual({ lastToPayPollAt: NOW })
  })

  it('al crear la fila precarga el horario de reservas, como updateSettings', async () => {
    const hours = {
      monday: { enabled: true, ranges: [{ open: '09:00', close: '18:00' }] },
      tuesday: { enabled: false, ranges: [] },
      wednesday: { enabled: false, ranges: [] },
      thursday: { enabled: false, ranges: [] },
      friday: { enabled: false, ranges: [] },
      saturday: { enabled: false, ranges: [] },
      sunday: { enabled: false, ranges: [] },
    }
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 0 })
    const t = tx()
    t.reservationSettings.findUnique.mockResolvedValue({ operatingHours: hours })
    await touchToPayPoll('v1', NOW)
    expect(t.onlineOrderingSettings.upsert.mock.calls[0][0].create.hours).toEqual(hours)
  })

  it('si la escritura falla, el debounce no se mueve', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockRejectedValueOnce(new Error('db')).mockResolvedValueOnce({ count: 1 })
    await expect(touchToPayPoll('v1', NOW)).rejects.toThrow('db')
    await expect(touchToPayPoll('v1', new Date(NOW.getTime() + 5_000))).resolves.toBe(true)
  })

  it('Bandeja y TPV a la vez: los dos latidos se escriben (R11)', async () => {
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
    await expect(touchInboxPoll('v1', NOW)).resolves.toBe(true)
    await expect(touchToPayPoll('v1', NOW)).resolves.toBe(true)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { lastInboxPollAt: NOW } })
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({ where: { venueId: 'v1' }, data: { lastToPayPollAt: NOW } })
  })
})

describe('getAcceptingStatus — «Nadie» lee el latido de folios', () => {
  it('con la Bandeja abierta y sin latido de folios en 2 min ⇒ OFFLINE / NO_DEVICE', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ requiresAcceptance: false, lastToPayPollAt: new Date(NOW.getTime() - 121_000) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OFFLINE', reason: 'NO_DEVICE' })
  })

  it('con latido de folios hace 1 min y sin Bandeja ⇒ OPEN', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ requiresAcceptance: false, lastInboxPollAt: null, lastToPayPollAt: new Date(NOW.getTime() - 60_000) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', reason: null })
  })

  it('«Mi equipo» sigue leyendo la Bandeja, aunque no haya latido de folios', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ requiresAcceptance: true, lastToPayPollAt: null }) as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
  })

  it('el estado no filtra los latidos dentro de config', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ lastToPayPollAt: NOW }) as any)
    const st = await getAcceptingStatus('v1', NOW)
    expect(st.config).not.toHaveProperty('lastToPayPollAt')
    expect(st.config).not.toHaveProperty('lastInboxPollAt')
  })
})

describe('getAcceptingStatus', () => {
  it('OPEN cuando está encendida, en horario, sin pausa y con una bandeja reciente', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow() as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', reason: null })
  })

  it('DISABLED si nunca se encendió', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(null)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'DISABLED', reason: 'NOT_ENABLED' })
  })

  it('PAUSED por pausa manual y por pausa temporal vigente (la del piso incluida)', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ manualPause: true }) as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'MANUAL_PAUSE' })

    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ pausedUntil: new Date(NOW.getTime() + 600_000) }) as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'MANUAL_PAUSE' })
  })

  it('una pausa temporal ya vencida no cuenta', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ pausedUntil: new Date(NOW.getTime() - 60_000) }) as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
  })

  it('CLOSED fuera de horario', async () => {
    const hours = {
      monday: { enabled: false, ranges: [] },
      tuesday: { enabled: false, ranges: [] },
      wednesday: { enabled: true, ranges: [{ open: '18:00', close: '22:00' }] },
      thursday: { enabled: false, ranges: [] },
      friday: { enabled: false, ranges: [] },
      saturday: { enabled: false, ranges: [] },
      sunday: { enabled: false, ranges: [] },
    }
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ hours }) as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
  })

  it('OFFLINE si ninguna bandeja consultó en 2 minutos', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ lastInboxPollAt: new Date(NOW.getTime() - 121_000) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OFFLINE', reason: 'NO_DEVICE' })
  })

  it('OFFLINE si nunca hubo un latido', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ lastInboxPollAt: null }) as any)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OFFLINE' })
  })

  it('PAUSED por saturación cuando hay demasiados pedidos por aceptar', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow() as any)
    prismaMock.onlineOrder.count.mockResolvedValue(MAX_PENDING_PER_VENUE)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'TOO_BUSY' })
  })
})

describe('getAcceptingStatus — tienda híbrida: los folios sin pagar no son saturación', () => {
  // 30 filas de folio (requiresAcceptance:false) y ninguna por aceptar: sólo cuenta quien pregunta por requiresAcceptance:true.
  const FOLIOS = ({ where }: any) => Promise.resolve(where.requiresAcceptance === true ? 0 : MAX_PENDING_PER_VENUE) as any
  const DE_MI_EQUIPO = ({ where }: any) => Promise.resolve(where.requiresAcceptance === true ? MAX_PENDING_PER_VENUE : 0) as any

  it('30 folios sin pagar no pausan la tienda', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow() as any)
    prismaMock.onlineOrder.count.mockImplementation(FOLIOS)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
  })

  it('30 por aceptar de «Mi equipo» sí la pausan', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow() as any)
    prismaMock.onlineOrder.count.mockImplementation(DE_MI_EQUIPO)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'TOO_BUSY' })
  })
})

describe('getAcceptingStatus — fase 2: los borradores de tarjeta vigentes cuentan para la saturación', () => {
  it('pedidos por aceptar + borradores vigentes = 30 → PAUSED TOO_BUSY; un vencido no cuenta', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow() as any)
    prismaMock.onlineOrder.count.mockResolvedValue(MAX_PENDING_PER_VENUE - 1)
    prismaMock.onlineOrderCharge.count.mockResolvedValue(1)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'TOO_BUSY' })
    expect(prismaMock.onlineOrderCharge.count).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: 'PENDING_AUTH', checkoutExpiresAt: { gt: NOW } },
    })
    prismaMock.onlineOrderCharge.count.mockResolvedValue(0) // el vencido ya no entra en la cuenta
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
  })
})

describe('storeView (ronda 1: un solo armado del estado de la tienda para el panel, la bandeja y el MCP)', () => {
  it('toma estado y motivo del cálculo, y las dos pausas de los ajustes que usó', async () => {
    const hasta = new Date(NOW.getTime() + 600_000)
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ pausedUntil: hasta, manualPause: true }) as any)
    expect(storeView(await getAcceptingStatus('v1', NOW))).toEqual({
      status: 'PAUSED',
      reason: 'MANUAL_PAUSE',
      pausedUntil: hasta.toISOString(),
      manualPause: true,
    })
  })

  it('con ajustes ya leídos no los vuelve a leer', async () => {
    const leidos = { ...settingsRow(), minOrderAmount: 0, pausedUntil: null } as any
    expect(storeView(await getAcceptingStatus('v1', NOW, leidos))).toEqual({
      status: 'OPEN',
      reason: null,
      pausedUntil: null,
      manualPause: false,
    })
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
  })
})
