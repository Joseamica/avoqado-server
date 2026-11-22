import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import { MAX_PENDING_PER_VENUE } from '@/services/online-ordering/constants'
import {
  __resetPresenceDebounceForTests,
  getAcceptingStatus,
  PAUSA_SOLA_TOPE,
  __resetPausasConfirmadasParaPruebas,
  avanzarCortePausaSola,
  registrarSiLaPausoSola,
  storeView,
  touchInboxPoll,
  touchToPayPoll,
} from '@/services/online-ordering/presence.service'
import { __resetInterruptorParaPruebas } from '@/services/online-ordering/interruptorPausaSola'

const NOW = new Date('2026-10-14T18:30:00.000Z') // miércoles 12:30 CDMX
const queryRaw = () => prismaMock.$queryRaw as unknown as jest.Mock
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

/** v5: el interruptor «pausa sola desde» está puesto desde hace un día (la pausa sola ya cuenta); cada prueba puede cambiarlo. */
const INICIO_DE_SIEMPRE = new Date(NOW.getTime() - 24 * 60 * 60_000)
const interruptor = (desde: Date | null) => {
  __resetInterruptorParaPruebas()
  ;(prismaMock.interruptorDePlataforma.findUnique as jest.Mock).mockResolvedValue(desde ? { desde } : null)
}
/** El corte que la lectura usa con el interruptor en [desde]: cuentan las horas límite ≥ desde (la consulta usa `>`). */
const corteDe = (desde: Date) => new Date(desde.getTime() - 1)

beforeEach(() => {
  __resetPresenceDebounceForTests()
  __resetInterruptorParaPruebas()
  __resetPausasConfirmadasParaPruebas()
  interruptor(INICIO_DE_SIEMPRE)
  prismaMock.venue.findUnique.mockResolvedValue({ timezone: 'America/Mexico_City' } as any)
  prismaMock.onlineOrder.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0)
  prismaMock.onlineOrder.findMany.mockResolvedValue([])
  queryRaw().mockResolvedValue([])
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
    expect(arg.create).toEqual({ venueId: 'v1', enabled: false, requiresAcceptance: true, lastToPayPollAt: NOW, autoPauseResumedAt: NOW })
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
  it('con la Bandeja abierta y sin latido de folios en 15 min ⇒ OFFLINE / NO_DEVICE', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ requiresAcceptance: false, lastToPayPollAt: new Date(NOW.getTime() - 900_001) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OFFLINE', reason: 'NO_DEVICE' })
  })

  it('D659: la TPV dormida late cada 3–5 min (medido en Mindform y Flautas) ⇒ con latido hace 5 min sigue OPEN', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ requiresAcceptance: false, lastInboxPollAt: null, lastToPayPollAt: new Date(NOW.getTime() - 300_000) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', reason: null })
  })

  it('D660: de noche la caja de Mindform latió cada 10–11 min (medido el 17-nov) ⇒ con latido hace 11 min sigue OPEN', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ requiresAcceptance: false, lastInboxPollAt: null, lastToPayPollAt: new Date(NOW.getTime() - 660_000) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', reason: null })
  })

  it('D660: justo en 15 min todavía cuenta (el borde es inclusivo, como el de la Bandeja)', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({ requiresAcceptance: false, lastInboxPollAt: null, lastToPayPollAt: new Date(NOW.getTime() - 900_000) }) as any,
    )
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
  })

  it('D659: «Mi equipo» no cambia: la Bandeja sin consultar en 2 min ⇒ OFFLINE aunque la caja haya latido hace 1 min', async () => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({
        requiresAcceptance: true,
        lastInboxPollAt: new Date(NOW.getTime() - 121_000),
        lastToPayPollAt: new Date(NOW.getTime() - 60_000),
      }) as any,
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
    // D661 (r6 #6): un borrador de «Nadie» (sin teléfono en la columna) tiene su propio cupo y no satura la tienda.
    expect(prismaMock.onlineOrderCharge.count).toHaveBeenCalledWith({
      where: { venueId: 'v1', status: 'PENDING_AUTH', checkoutExpiresAt: { gt: NOW }, customerPhone: { not: '' } },
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
      autoPausedAt: null,
    })
  })

  it('con ajustes ya leídos no los vuelve a leer', async () => {
    const leidos = { ...settingsRow(), minOrderAmount: 0, pausedUntil: null } as any
    expect(storeView(await getAcceptingStatus('v1', NOW, leidos))).toEqual({
      status: 'OPEN',
      reason: null,
      pausedUntil: null,
      manualPause: false,
      autoPausedAt: null,
    })
    expect(prismaMock.onlineOrderingSettings.findUnique).not.toHaveBeenCalled()
  })
})

describe('R56 · «último pedido para pagar en caja»: en «Nadie» la tienda deja de recibir folios 10 min antes del cierre', () => {
  const dia = (ranges: Array<{ open: string; close: string }>) => ({ enabled: true, ranges })
  const semana = (ranges: Array<{ open: string; close: string }>) => {
    const d = dia(ranges)
    return { monday: d, tuesday: d, wednesday: d, thursday: d, friday: d, saturday: d, sunday: d }
  }
  const CIERRE_21 = semana([{ open: '09:00', close: '21:00' }])
  /** Hora de pared de CDMX (UTC-6) del 14-oct. */
  const a = (hhmmss: string) => new Date(`2026-10-14T${hhmmss}-06:00`)
  /** La tienda prendida, con su latido de hace 30 s (de la TPV en «Nadie», de la Bandeja en «Mi equipo»). */
  const tienda = (ahora: Date, o: Record<string, unknown> = {}) =>
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(
      settingsRow({
        requiresAcceptance: false,
        hours: CIERRE_21,
        lastToPayPollAt: new Date(ahora.getTime() - 30_000),
        lastInboxPollAt: new Date(ahora.getTime() - 30_000),
        ...o,
      }) as any,
    )

  it('a las 20:50:01 con cierre a las 21:00: CLOSED / OUTSIDE_HOURS, lo mismo que fuera de horario', async () => {
    tienda(a('20:50:01'))
    await expect(getAcceptingStatus('v1', a('20:50:01'))).resolves.toMatchObject({ status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
  })

  it('a las 20:49:59 (y a las 20:50 en punto) sigue OPEN: el folio nace con al menos 10 min para pagar', async () => {
    for (const hora of ['20:49:59', '20:50:00']) {
      tienda(a(hora))
      await expect(getAcceptingStatus('v1', a(hora))).resolves.toMatchObject({ status: 'OPEN', reason: null })
    }
  })

  it('franjas contiguas (09–21 + 21–23): el cierre real es a las 23:00, así que a las 20:55 sigue OPEN; a las 22:50:01 ya no', async () => {
    const contiguas = semana([
      { open: '09:00', close: '21:00' },
      { open: '21:00', close: '23:00' },
    ])
    tienda(a('20:55:00'), { hours: contiguas })
    await expect(getAcceptingStatus('v1', a('20:55:00'))).resolves.toMatchObject({ status: 'OPEN' })
    tienda(a('22:50:01'), { hours: contiguas })
    await expect(getAcceptingStatus('v1', a('22:50:01'))).resolves.toMatchObject({ status: 'CLOSED', reason: 'OUTSIDE_HOURS' })
  })

  it('«Mi equipo» a las 20:55 sigue OPEN, como hoy (sólo los folios tienen último pedido)', async () => {
    tienda(a('20:55:00'), { requiresAcceptance: true })
    await expect(getAcceptingStatus('v1', a('20:55:00'))).resolves.toMatchObject({ status: 'OPEN', reason: null })
  })

  it('sin horario no hay cierre ni último pedido', async () => {
    tienda(a('20:55:00'), { hours: null })
    await expect(getAcceptingStatus('v1', a('20:55:00'))).resolves.toMatchObject({ status: 'OPEN' })
  })
})

describe('D662 parte 2 (v4) · la pausa sola la decide UNA consulta exacta en Postgres (aquí: su forma y qué se hace con su respuesta)', () => {
  const min = (n: number) => new Date(NOW.getTime() + n * 60_000)
  /** La fila que devuelve la consulta. La lógica (fallas, respuestas, pareja) se prueba contra Postgres en lifecycle.integration. */
  const vuelta = (o: Record<string, unknown> = {}) => [
    { fallas: 0, ultimaFalla: null, fallaSuelta: null, pausaId: null, pausaAt: null, pausaDesde: null, ...o },
  ]
  const pausada = () => vuelta({ fallas: 2, ultimaFalla: min(-1), pausaId: 'ooB', pausaAt: min(-1), pausaDesde: min(-2) })
  const conVuelta = (rows: unknown[], ajustes: Record<string, unknown> = {}) => {
    prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue(settingsRow({ autoPauseResumedAt: min(-60), ...ajustes }) as any)
    queryRaw().mockResolvedValue(rows)
    prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
  }
  const sql = (n = 0) => {
    const [plantilla, ...valores] = queryRaw().mock.calls[n] as [TemplateStringsArray, ...unknown[]]
    const q = Prisma.sql(plantilla, ...valores)
    return { texto: q.sql.replace(/\s+/g, ' '), valores: q.values }
  }
  const flush = () => new Promise(r => setImmediate(r))

  it('con pareja ⇒ PAUSED / MANUAL_PAUSE (apps viejas: «Pausada») y autoPausedAt = la hora límite de la segunda falla', async () => {
    conVuelta(pausada())
    const st = await getAcceptingStatus('v1', NOW)
    expect(st).toMatchObject({ status: 'PAUSED', reason: 'MANUAL_PAUSE', autoPausedAt: min(-1).toISOString() })
    expect(storeView(st)).toMatchObject({
      status: 'PAUSED',
      reason: 'MANUAL_PAUSE',
      autoPausedAt: min(-1).toISOString(),
      manualPause: false,
    })
  })

  it('la consulta (v4): fallas de «Mi equipo» entre el corte y ahora; la respuesta es sólo la marca; lo del SERVIDOR anterior no cuenta', async () => {
    const corte = min(-30)
    conVuelta(vuelta(), { autoPauseResumedAt: corte })
    await getAcceptingStatus('v1', NOW)
    const { texto, valores } = sql()
    expect(texto).toContain('oo."requiresAcceptance" = true')
    expect(texto).toContain('oo."acceptDeadlineAt" >')
    expect(texto).toContain('oo."acceptDeadlineAt" <=')
    // Respuesta a tiempo = la marca de la persona, a más tardar en la hora límite (ya no acceptedAt/rejectedAt: Codex p2-r8 #1 y #2).
    expect(texto).toContain('NOT (oo."staffAnsweredAt" IS NOT NULL AND oo."staffAnsweredAt" <= oo."acceptDeadlineAt")')
    expect(texto).not.toContain('"acceptedAt"')
    // Lo que contestó el SERVIDOR anterior ya trae la marca (se selló al llegar el inicio): la lectura sólo mira la marca (p2v4-r3 #1).
    expect(texto).not.toContain('oo."createdAt" <')
    expect(texto).not.toContain(`'ACCEPTED'`)
    // Lo que terminó solo ANTES de su hora límite no cuenta (null-seguro con COALESCE).
    expect(texto).toContain(`NOT COALESCE(oo."cancelledBy" = 'CUSTOMER' AND oo."cancelledAt" <= oo."acceptDeadlineAt", false)`)
    expect(texto).toContain(
      `oo."rejectReason" = 'PAYMENT_FAILED' AND oo."staffAnsweredAt" IS NULL AND oo."rejectedAt" <= oo."acceptDeadlineAt"`,
    )
    // Pareja: dos fallas seguidas por hora límite e id, sin una respuesta a tiempo (sólo la marca) en (primera, segunda].
    expect(texto).toContain('LAG(f.t) OVER (ORDER BY f.t ASC, f.id ASC)')
    expect(texto).toContain('s."staffAnsweredAt" > p.prev AND s."staffAnsweredAt" <= p.t AND s."staffAnsweredAt" <= s."acceptDeadlineAt"')
    expect(texto).not.toContain('s."staffAnsweredAt" IS NULL')
    expect(valores).toEqual(expect.arrayContaining(['v1', corte, NOW, PAUSA_SOLA_TOPE]))
  })

  it('sin pareja ⇒ OPEN y autoPausedAt null', async () => {
    conVuelta(vuelta({ fallas: 1, ultimaFalla: min(-1), fallaSuelta: min(-1) }))
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', autoPausedAt: null })
  })

  it('v5: sin el interruptor PAUSA_SOLA_DESDE no hay pausa sola, ni consulta, ni escritura (todo como hoy)', async () => {
    interruptor(null)
    conVuelta(pausada(), { autoPauseResumedAt: null })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', autoPausedAt: null })
    await flush()
    expect(queryRaw()).not.toHaveBeenCalled()
    expect(prismaMock.onlineOrderingSettings.updateMany).not.toHaveBeenCalled()
  })

  it('v5: con la fila del interruptor pero «desde» vacío (apagado) tampoco hay pausa sola', async () => {
    __resetInterruptorParaPruebas()
    ;(prismaMock.interruptorDePlataforma.findUnique as jest.Mock).mockResolvedValue({ desde: null })
    conVuelta(pausada(), { autoPauseResumedAt: null })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN', autoPausedAt: null })
    expect(queryRaw()).not.toHaveBeenCalled()
  })

  it('v5: antes de la hora del interruptor tampoco; desde esa hora, sí', async () => {
    interruptor(new Date(NOW.getTime() + 1))
    conVuelta(pausada(), { autoPauseResumedAt: null })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
    expect(queryRaw()).not.toHaveBeenCalled()
    interruptor(NOW)
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', autoPausedAt: min(-1).toISOString() })
  })

  it('v5: el corte efectivo es max(corte propio, interruptor); un corte vacío cuenta desde la hora del interruptor', async () => {
    const inicio = min(-20)
    interruptor(inicio)
    conVuelta(vuelta(), { autoPauseResumedAt: null })
    await getAcceptingStatus('v1', NOW)
    expect(sql().valores).toEqual(expect.arrayContaining([corteDe(inicio)]))
    queryRaw().mockClear()
    conVuelta(vuelta(), { autoPauseResumedAt: min(-60) })
    await getAcceptingStatus('v1', NOW)
    expect(sql().valores.filter(v => v instanceof Date && v.getTime() === min(-60).getTime())).toHaveLength(0)
    queryRaw().mockClear()
    conVuelta(vuelta(), { autoPauseResumedAt: min(-5) })
    await getAcceptingStatus('v1', NOW)
    expect(sql().valores).toEqual(expect.arrayContaining([min(-5)]))
    expect(sql().valores.filter(v => v instanceof Date && v.getTime() === corteDe(inicio).getTime())).toHaveLength(0)
  })

  it('v4 (hueco 3 y T2): una pareja reciente espera lo que se está guardando (candados de las cuentas, sin fila) y vuelve a leer', async () => {
    const ahora = new Date()
    const reciente = new Date(ahora.getTime() - 5_000)
    conVuelta([])
    queryRaw()
      .mockResolvedValueOnce(vuelta({ fallas: 2, ultimaFalla: reciente, pausaId: 'ooB', pausaAt: reciente, pausaDesde: min(-3) }))
      .mockResolvedValueOnce([{ n: 2 }]) // cuántas cuentas
      .mockResolvedValueOnce([]) // FOR SHARE NOWAIT
      .mockResolvedValueOnce(vuelta()) // al releer: la cajera sí había aceptado a tiempo
    // (el latido de la prueba es del reloj fijo: sin pausa sola sale «sin aparato», no «en pausa»)
    await expect(getAcceptingStatus('v1', ahora)).resolves.toMatchObject({ status: 'OFFLINE', autoPausedAt: null })
    expect(sql(2).texto).toContain('FOR SHARE OF o NOWAIT')
    expect(sql(2).texto).toContain('oo."acceptDeadlineAt" >=')
    // Sólo los pedidos que todavía pueden cambiar el veredicto: sin marca y por aceptar (Codex p2v4-r1 #6).
    expect(sql(2).texto).toContain(`oo."staffAnsweredAt" IS NULL AND oo.status = 'PENDING_ACCEPTANCE'`)
    expect(sql(2).valores).toEqual(expect.arrayContaining([min(-3)]))
  })

  it('v4: si una cuenta está tomada (55P03), reintenta sin hacer fila hasta tenerlas; la pausa confirmada no vuelve a esperar', async () => {
    const ahora = new Date()
    const reciente = new Date(ahora.getTime() - 5_000)
    const par = vuelta({ fallas: 2, ultimaFalla: reciente, pausaId: 'ooB', pausaAt: reciente, pausaDesde: min(-3) })
    conVuelta([])
    queryRaw()
      .mockResolvedValueOnce(par)
      .mockResolvedValueOnce([{ n: 2 }])
      .mockRejectedValueOnce(new Error('Raw query failed. Code: `55P03`. Message: `could not obtain lock on row in relation "Order"`'))
      .mockResolvedValueOnce([{ n: 2 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(par)
      .mockResolvedValueOnce(par) // segunda lectura: ya confirmada, sin candados
    await expect(getAcceptingStatus('v1', ahora)).resolves.toMatchObject({ status: 'PAUSED', autoPausedAt: reciente.toISOString() })
    expect(queryRaw()).toHaveBeenCalledTimes(6)
    await expect(getAcceptingStatus('v1', ahora)).resolves.toMatchObject({ status: 'PAUSED' })
    expect(queryRaw()).toHaveBeenCalledTimes(7)
  })

  it('Codex p2v4-r1 #4: un «Reanudar» guardado mientras la lectura esperaba ya cuenta (relee el corte propio)', async () => {
    const ahora = new Date()
    const reciente = new Date(ahora.getTime() - 5_000)
    const par = vuelta({ fallas: 2, ultimaFalla: reciente, pausaId: 'ooB', pausaAt: reciente, pausaDesde: min(-3) })
    conVuelta([])
    ;(prismaMock.onlineOrderingSettings.findUnique as jest.Mock)
      .mockResolvedValueOnce(settingsRow({ autoPauseResumedAt: min(-60) }))
      .mockResolvedValueOnce({ autoPauseResumedAt: new Date(ahora.getTime() - 1_000) })
    queryRaw()
      .mockResolvedValueOnce(par)
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(vuelta())
    await expect(getAcceptingStatus('v1', ahora)).resolves.toMatchObject({ status: 'OFFLINE', autoPausedAt: null })
    expect(sql(3).valores).toEqual(expect.arrayContaining([new Date(ahora.getTime() - 1_000)]))
  })

  it('v4: una pareja de hace 30 s o más ya es definitiva: no espera candados', async () => {
    conVuelta(pausada())
    await getAcceptingStatus('v1', NOW)
    expect(queryRaw()).toHaveBeenCalledTimes(1)
  })

  it('Codex p2-r4 #1: una vuelta llena de fallas sin pareja sube el corte (sin pasar de la última leída) y da otra vuelta', async () => {
    conVuelta([])
    queryRaw()
      .mockResolvedValueOnce(vuelta({ fallas: PAUSA_SOLA_TOPE, ultimaFalla: min(-20), fallaSuelta: null }))
      .mockResolvedValueOnce(pausada())
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', autoPausedAt: min(-1).toISOString() })
    expect(queryRaw()).toHaveBeenCalledTimes(2)
    const nuevo = new Date(min(-20).getTime() - 1)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', OR: [{ autoPauseResumedAt: null }, { autoPauseResumedAt: { lt: nuevo } }] },
      data: { autoPauseResumedAt: nuevo },
    })
    expect(sql(1).valores).toEqual(expect.arrayContaining([nuevo]))
  })

  it('Codex p2-r4 #5: sin pausa, la lectura sube el corte sola (sin esperarlo) si avanza 5 min o más; la falla suelta se queda', async () => {
    conVuelta(vuelta())
    await getAcceptingStatus('v1', NOW)
    await flush()
    const definitivo = new Date(NOW.getTime() - 30_000)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', OR: [{ autoPauseResumedAt: null }, { autoPauseResumedAt: { lt: definitivo } }] },
      data: { autoPauseResumedAt: definitivo },
    })

    prismaMock.onlineOrderingSettings.updateMany.mockClear()
    conVuelta(vuelta({ fallas: 1, ultimaFalla: min(-40), fallaSuelta: min(-40) }))
    await getAcceptingStatus('v1', NOW)
    await flush()
    const antesDeLaSuelta = new Date(min(-40).getTime() - 1)
    expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
      where: { venueId: 'v1', OR: [{ autoPauseResumedAt: null }, { autoPauseResumedAt: { lt: antesDeLaSuelta } }] },
      data: { autoPauseResumedAt: antesDeLaSuelta },
    })

    prismaMock.onlineOrderingSettings.updateMany.mockClear()
    conVuelta(vuelta(), { autoPauseResumedAt: min(-3) })
    await getAcceptingStatus('v1', NOW)
    await flush()
    expect(prismaMock.onlineOrderingSettings.updateMany).not.toHaveBeenCalled()
  })

  it('en «Nadie» no aplica (ni consulta)', async () => {
    conVuelta(pausada(), { requiresAcceptance: false, lastToPayPollAt: new Date(NOW.getTime() - 60_000) })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'OPEN' })
    expect(queryRaw()).not.toHaveBeenCalled()
  })

  it('apagada sigue DISABLED (no consulta)', async () => {
    conVuelta(pausada(), { enabled: false })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'DISABLED' })
    expect(queryRaw()).not.toHaveBeenCalled()
  })

  it('la pausa del gerente gana con su forma de hoy (autoPausedAt null: su «Reanudar» no la abriría)', async () => {
    conVuelta(pausada(), { manualPause: true })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'MANUAL_PAUSE', autoPausedAt: null })
  })

  it('con una pausa de 15/30/60 vigente también sale autoPausedAt: al vencer, sigue pausada sola', async () => {
    conVuelta(pausada(), { pausedUntil: min(10) })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({
      status: 'PAUSED',
      reason: 'MANUAL_PAUSE',
      autoPausedAt: min(-1).toISOString(),
    })
  })

  it('pestaña VIEJA del panel: con una pausa de 15/30/60 vigente manda SU fin (no la hora de la pausa sola)', async () => {
    conVuelta(pausada(), { pausedUntil: min(10) })
    const st = await getAcceptingStatus('v1', NOW)
    expect(storeView(st, { pestanaVieja: true }).pausedUntil).toBe(min(10).toISOString())
  })

  it('🔴 full-testing: pestaña VIEJA con una pausa de 15/30/60 YA VENCIDA en la fila: manda la hora en que se pausó sola, no el fin viejo', async () => {
    // La pausa temporal venció hace 5 min y su `pausedUntil` se quedó guardado; después la tienda se pausó sola. La pestaña vieja sólo
    // sabe decir «Pausada hasta <pausedUntil>»: con el fin viejo diría una hora que ya pasó. Vencida = la misma regla y el mismo reloj
    // de la lectura (`pausedUntil > ahora` es vigente).
    conVuelta(pausada(), { pausedUntil: min(-5) })
    const st = await getAcceptingStatus('v1', NOW)
    expect(st).toMatchObject({ status: 'PAUSED', reason: 'MANUAL_PAUSE', autoPausedAt: min(-1).toISOString() })
    expect(storeView(st, { pestanaVieja: true }).pausedUntil).toBe(min(-1).toISOString())
    // El panel nuevo sigue recibiendo la fila tal cual (lee `autoPausedAt`).
    expect(storeView(st).pausedUntil).toBe(min(-5).toISOString())
  })

  it('gana sobre fuera de horario y sobre sin aparato: sólo «Reanudar» la abre', async () => {
    conVuelta(pausada(), { lastInboxPollAt: null })
    await expect(getAcceptingStatus('v1', NOW)).resolves.toMatchObject({ status: 'PAUSED', reason: 'MANUAL_PAUSE' })
  })

  it('no filtra autoPauseResumedAt, updatedAt ni version dentro de config; la versión de los ajustes sale aparte (Codex p2v4-r2 #5)', async () => {
    conVuelta(vuelta(), { autoPauseResumedAt: min(-30), updatedAt: min(-2), version: 7 })
    const st = await getAcceptingStatus('v1', NOW)
    expect(st.config).not.toHaveProperty('autoPauseResumedAt')
    expect(st.config).not.toHaveProperty('updatedAt')
    expect(st.config).not.toHaveProperty('version')
    expect(st.versionDeAjustes).toBe(7)
  })

  it('Codex p2v4-r3 #5 / r4 #5: si los ajustes cambiaron durante la espera, relee todo el estado con la versión releída', async () => {
    const ahora = new Date()
    const reciente = new Date(ahora.getTime() - 5_000)
    const par = vuelta({ fallas: 2, ultimaFalla: reciente, pausaId: 'ooB', pausaAt: reciente, pausaDesde: min(-3) })
    // 🔴 Codex p2v5-r4 #5: el guardado que confirmó DESPUÉS puede traer una hora de Prisma MENOR (la fijó antes de esperar el candado). Se
    // compara la versión que sube la base (`version`), nunca la hora: con la hora, esta relectura no se hacía.
    const horaMenor = min(-20)
    conVuelta([])
    ;(prismaMock.onlineOrderingSettings.findUnique as jest.Mock)
      .mockResolvedValueOnce(settingsRow({ autoPauseResumedAt: min(-60), updatedAt: min(-10), version: 3 }))
      .mockResolvedValueOnce({ autoPauseResumedAt: new Date(ahora.getTime() - 1_000), version: 4 })
    // Cambiaron los ajustes durante la espera: se relee TODO el estado con los ajustes nuevos (p2v4-r4 #5).
    ;(prismaMock.onlineOrderingSettings.findUnique as jest.Mock).mockResolvedValueOnce(
      settingsRow({ autoPauseResumedAt: new Date(ahora.getTime() - 1_000), updatedAt: horaMenor, version: 4 }),
    )
    queryRaw()
      .mockResolvedValueOnce(par)
      .mockResolvedValueOnce([{ n: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(vuelta())
      .mockResolvedValueOnce(vuelta())
    const st = await getAcceptingStatus('v1', ahora)
    expect(st).toMatchObject({ status: 'OFFLINE', autoPausedAt: null })
    expect(st.versionDeAjustes).toBe(4)
    expect(st.config).not.toHaveProperty('__releido')
  })

  it('Codex p2v4-r2 #2 / r3 #3: la espera no pasa de L(B) + 30 s con el reloj de AHORA (una cuenta tomada después ya no puede cambiar el veredicto)', async () => {
    const reciente = new Date(Date.now() - 29_990) // L(B) hace casi 30 s: queda ~10 ms de espera posible
    const par = vuelta({ fallas: 2, ultimaFalla: reciente, pausaId: 'ooB', pausaAt: reciente, pausaDesde: min(-3) })
    conVuelta([])
    const ocupada = new Error('Raw query failed. Code: `55P03`. Message: `could not obtain lock`')
    queryRaw().mockImplementation(async (plantilla: TemplateStringsArray) => {
      const texto = plantilla.join('?')
      if (texto.includes('FOR SHARE')) throw ocupada
      if (texto.includes('count(*)::int AS n')) return [{ n: 1 }]
      return par
    })
    const t0 = Date.now()
    await expect(getAcceptingStatus('v1', new Date(Date.now()))).resolves.toMatchObject({ status: 'PAUSED' })
    expect(Date.now() - t0).toBeLessThan(1_000)
  })

  describe('avanzarCortePausaSola (tras la respuesta de una persona)', () => {
    const fila = (o: Record<string, unknown> = {}) =>
      prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({
        enabled: true,
        requiresAcceptance: true,
        autoPauseResumedAt: min(-60),
        ...o,
      } as any)

    it('sin pausa: sube a lo definitivo (30 s antes de ahora), sin umbral, con un updateMany que nunca lo baja', async () => {
      fila({ autoPauseResumedAt: min(-2) })
      queryRaw().mockResolvedValue(vuelta())
      prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(true)
      const nuevo = new Date(NOW.getTime() - 30_000)
      expect(prismaMock.onlineOrderingSettings.updateMany).toHaveBeenCalledWith({
        where: { venueId: 'v1', OR: [{ autoPauseResumedAt: null }, { autoPauseResumedAt: { lt: nuevo } }] },
        data: { autoPauseResumedAt: nuevo },
      })
    })

    it('con pausa no se mueve (la pareja se queda hasta «Reanudar»)', async () => {
      fila()
      queryRaw().mockResolvedValue(pausada())
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(false)
      expect(prismaMock.onlineOrderingSettings.updateMany).not.toHaveBeenCalled()
    })

    it('si no sube, con la tienda en «Nadie» o sin interruptor, no escribe; con el corte vacío sí sube desde el interruptor', async () => {
      fila({ autoPauseResumedAt: new Date(NOW.getTime() - 30_000) })
      queryRaw().mockResolvedValue(vuelta())
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(false)
      fila({ requiresAcceptance: false })
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(false)
      interruptor(null)
      fila({ autoPauseResumedAt: null })
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(false)
      expect(prismaMock.onlineOrderingSettings.updateMany).not.toHaveBeenCalled()
      interruptor(INICIO_DE_SIEMPRE)
      prismaMock.onlineOrderingSettings.updateMany.mockResolvedValue({ count: 1 })
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(true)
    })

    it('nunca lanza: un error de la base sólo deja la lectura más larga', async () => {
      prismaMock.onlineOrderingSettings.findUnique.mockRejectedValue(new Error('db'))
      await expect(avanzarCortePausaSola('v1', NOW)).resolves.toBe(false)
    })
  })

  describe('bitácora ONLINE_ORDERING_AUTO_PAUSED (registrarSiLaPausoSola)', () => {
    it('sólo cuando ESTE pedido (por id) es la segunda falla de la pareja', async () => {
      prismaMock.onlineOrderingSettings.findUnique.mockResolvedValue({
        enabled: true,
        manualPause: false,
        requiresAcceptance: true,
        autoPauseResumedAt: min(-60),
      } as any)
      queryRaw().mockResolvedValue(pausada())
      prismaMock.onlineOrder.findFirst.mockResolvedValue({ order: { orderNumber: 'W-1' } } as any)
      await expect(registrarSiLaPausoSola('v1', 'ooA', NOW)).resolves.toBe(false)
      await expect(registrarSiLaPausoSola('v1', 'ooB', NOW)).resolves.toBe(true)
    })
  })
})
