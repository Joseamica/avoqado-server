/**
 * 🔴 DINERO — Fase 2, Task 4: LAS RUTAS QUE YA EXISTEN LLAMAN AL GESTO ÚNICO.
 *
 * `abrirTurnoDeCaja` (Task 3) estaba construido, probado… y sin un solo llamador. Mientras las
 * rutas no lo llamaran, el gesto único no ocurría en ningún lado. Y que lo llamen las rutas de
 * SIEMPRE —`POST /mobile/venues/:id/cash-drawer/open` y `POST /tpv/venues/:id/shifts/open`— es
 * justo lo que permite desplegar el servidor sin actualizar una sola app en la calle.
 *
 * ── El caso REAL, Testarudo 1-sep-2026 ────────────────────────────────────────────────────
 *
 * La tablet abrió la **Caja** a las 07:38 con $2,000 y la PAX abrió el **Turno** a las 08:12 con
 * $0: dos registros, dos fondos y dos cierres para UNA sola caja física. Después de esto, el
 * segundo gesto **liga** en vez de duplicar — y 🔴 **el turno queda con los $2,000 que alguien
 * CONTÓ, no con el $0 que alguien tecleó**. El dinero contado gana sobre el tecleado, que es la
 * misma regla con la que el fondo de lo que ya estaba nunca se pisa.
 *
 * ── El contrato ───────────────────────────────────────────────────────────────────────────
 *
 * Las dos respuestas quedan **byte a byte** como hoy MÁS un campo opcional (`shiftId` en la del
 * cajón, `cashDrawerSessionId` en la del turno). Ninguna app instalada puede notar un campo que
 * falte, cambie de nombre o cambie de tipo: hay pruebas que enumeran los campos de hoy.
 */

jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))

const mockBroadcastShiftEvent = jest.fn()
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => ({ broadcastShiftEvent: mockBroadcastShiftEvent })) },
}))

import { Decimal } from '@prisma/client/runtime/library'

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { openSession } from '@/services/mobile/cash-drawer.mobile.service'
import { openShiftForVenue } from '@/services/tpv/shift.tpv.service'

const m = prisma as any
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const TURNO = 'turno-1'
const CAJA = 'caja-1'

/** Martes 3-sep-2026 09:00 en CDMX (UTC−6). Bien dentro del día de negocio (corte 04:00). */
const HOY_0900 = new Date('2026-09-03T15:00:00.000Z')
/** El mismo día de negocio, 07:38 — la hora a la que Testarudo abrió su caja. */
const HOY_0738 = new Date('2026-09-03T13:38:00.000Z')

/**
 * La caja que la tablet dejó abierta. `startingAmount` es lo que el cajero CONTÓ.
 */
function cajaAbierta(over: Record<string, unknown> = {}) {
  return {
    id: CAJA,
    venueId: VENUE,
    status: 'OPEN',
    deviceName: 'Sunmi D3',
    openedByStaffId: STAFF,
    openedByName: 'Viridiana',
    openedAt: HOY_0738,
    startingAmount: new Decimal(2000),
    shiftId: null,
    closedByStaffId: null,
    closedByName: null,
    closedAt: null,
    actualAmount: null,
    overShort: null,
    closingNote: null,
    events: [{ id: 'ev-open', sessionId: CAJA, type: 'OPEN', amount: new Decimal(2000), createdAt: HOY_0738, localId: null }],
    ...over,
  }
}

/** El turno que la PAX dejó abierto. */
function turnoAbierto(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: STAFF,
    startTime: HOY_0738,
    endTime: null,
    status: 'OPEN',
    startingCash: new Decimal(2000),
    notes: null,
    ...over,
  }
}

/**
 * Fila completa de `Shift` tal y como la devuelve Prisma SIN `include` — que es exactamente
 * lo que la PAX recibe hoy en `data`. La lista de campos es el CONTRATO.
 */
function filaDeTurno(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: STAFF,
    startTime: HOY_0900,
    endTime: null,
    startingCash: new Decimal(0),
    endingCash: null,
    cashDifference: null,
    cashDeclared: null,
    cardDeclared: null,
    vouchersDeclared: null,
    otherDeclared: null,
    totalSales: new Decimal(0),
    totalTips: new Decimal(0),
    totalCashTips: new Decimal(0),
    totalOrders: 0,
    totalCashPayments: new Decimal(0),
    totalCardPayments: new Decimal(0),
    totalVoucherPayments: new Decimal(0),
    totalOtherPayments: new Decimal(0),
    totalProductsSold: 0,
    inventoryConsumed: null,
    reportData: null,
    status: 'OPEN',
    notes: null,
    originSystem: 'AVOQADO',
    posRawData: null,
    externalId: null,
    createdAt: HOY_0900,
    updatedAt: HOY_0900,
    ...over,
  }
}

/**
 * Arma el mundo: qué hay abierto y qué devuelven las escrituras. Guarda lo que se CREÓ para
 * poder afirmar sobre el fondo con el que nació cada registro.
 */
function mundo({ turno = null as any, caja = null as any }) {
  const creado: { turno?: any; caja?: any } = {}

  m.venue.findUnique.mockResolvedValue({
    id: VENUE,
    name: 'Testarudo Cafe',
    timezone: 'America/Mexico_City',
    posType: null,
    posStatus: 'NOT_INTEGRATED',
  })
  m.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF,
    venueId: VENUE,
    posStaffId: null,
    staff: { id: STAFF, firstName: 'Héctor', lastName: 'Ruiz' },
  })

  m.shift.findFirst.mockResolvedValue(turno)
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.shift.create.mockImplementation(({ data }: any) => {
    creado.turno = data
    return Promise.resolve({ id: TURNO })
  })
  // La relectura de la ruta de la PAX: devuelve la fila con el fondo con el que nació.
  m.shift.findUnique.mockImplementation(({ where }: any) => {
    if (where?.id !== TURNO) return Promise.resolve(null)
    const fondo = creado.turno ? creado.turno.startingCash : (turno?.startingCash ?? new Decimal(0))
    return Promise.resolve(filaDeTurno({ startingCash: fondo }))
  })

  m.cashDrawerSession.findFirst.mockResolvedValue(caja)
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  m.cashDrawerSession.create.mockImplementation(({ data }: any) => {
    creado.caja = data
    return Promise.resolve({ id: CAJA })
  })
  // `findUnique` sirve a DOS llamadas distintas: la del guard de la liga (`where.shiftId`) y
  // la relectura de la ruta del cajón (`where.id`).
  m.cashDrawerSession.findUnique.mockImplementation(({ where }: any) => {
    if (where?.shiftId !== undefined) return Promise.resolve(null)
    if (where?.id !== CAJA) return Promise.resolve(null)
    const base = caja ?? cajaAbierta({ startingAmount: creado.caja?.startingAmount ?? new Decimal(0), events: [] })
    return Promise.resolve(base)
  })

  return creado
}

beforeEach(() => {
  jest.clearAllMocks()
  jest.useFakeTimers().setSystemTime(HOY_0900)
  m.$transaction = jest.fn((fn: any) => fn(m))
  mockLogAction.mockResolvedValue(undefined as never)
})

afterEach(() => {
  jest.useRealTimers()
})

// ============================================================================
// 1 · El caso REAL de Testarudo: la tablet abrió la caja, la PAX pide turno
// ============================================================================

describe('🔴 Testarudo: la caja ya está abierta y la PAX abre turno', () => {
  it('crea UN turno y NO una segunda caja: liga en vez de duplicar', async () => {
    mundo({ caja: cajaAbierta() })

    await openShiftForVenue(VENUE, STAFF, 0, 'station-1')

    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
  })

  it('🔴 el turno nace con los $2,000 que alguien CONTÓ, no con el $0 que la PAX tecleó', async () => {
    const creado = mundo({ caja: cajaAbierta() })

    await openShiftForVenue(VENUE, STAFF, 0, 'station-1')

    expect(Number(creado.turno.startingCash)).toBe(2000)
  })

  it('la caja queda LIGADA al turno recién creado', async () => {
    mundo({ caja: cajaAbierta() })

    await openShiftForVenue(VENUE, STAFF, 0)

    expect(m.cashDrawerSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CAJA, shiftId: null }, data: { shiftId: TURNO } }),
    )
  })

  it('la respuesta de la PAX trae el id del cajón (campo NUEVO y aditivo)', async () => {
    mundo({ caja: cajaAbierta() })

    const shift: any = await openShiftForVenue(VENUE, STAFF, 0)

    expect(shift.cashDrawerSessionId).toBe(CAJA)
  })
})

// ============================================================================
// 2 · El espejo: la PAX abrió turno, la tablet abre caja
// ============================================================================

describe('🔴 Espejo: el turno ya está abierto y la tablet abre caja', () => {
  it('crea UNA caja y NO un segundo turno: liga en vez de duplicar', async () => {
    mundo({ turno: turnoAbierto() })

    await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 0 })

    expect(m.cashDrawerSession.create).toHaveBeenCalledTimes(1)
    expect(m.shift.create).not.toHaveBeenCalled()
  })

  it('🔴 la caja nace con el fondo que ya tenía el turno, no con el $0 tecleado en la tablet', async () => {
    const creado = mundo({ turno: turnoAbierto() })

    await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 0 })

    expect(Number(creado.caja.startingAmount)).toBe(2000)
  })

  it('la caja queda LIGADA al turno que ya estaba', async () => {
    mundo({ turno: turnoAbierto() })

    await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 0 })

    expect(m.cashDrawerSession.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: CAJA, shiftId: null }, data: { shiftId: TURNO } }),
    )
  })

  it('la respuesta de la tablet trae el id del turno (campo NUEVO y aditivo)', async () => {
    mundo({ turno: turnoAbierto() })

    const sesion: any = await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 0 })

    expect(sesion.shiftId).toBe(TURNO)
  })
})

// ============================================================================
// 3 · Sin nada abierto: cualquiera de los dos gestos deja los DOS registros
// ============================================================================

describe('sin nada abierto, un solo gesto abre las dos cosas', () => {
  it('desde la PAX: turno + caja, con el MISMO fondo', async () => {
    const creado = mundo({})

    const shift: any = await openShiftForVenue(VENUE, STAFF, 1500)

    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(m.cashDrawerSession.create).toHaveBeenCalledTimes(1)
    expect(Number(creado.turno.startingCash)).toBe(1500)
    expect(Number(creado.caja.startingAmount)).toBe(1500)
    expect(shift.cashDrawerSessionId).toBe(CAJA)
  })

  it('desde la tablet: caja + turno, con el MISMO fondo', async () => {
    const creado = mundo({})

    const sesion: any = await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 1500 })

    expect(m.cashDrawerSession.create).toHaveBeenCalledTimes(1)
    expect(m.shift.create).toHaveBeenCalledTimes(1)
    expect(Number(creado.caja.startingAmount)).toBe(1500)
    expect(Number(creado.turno.startingCash)).toBe(1500)
    expect(sesion.shiftId).toBe(TURNO)
  })
})

// ============================================================================
// 4 · Ya están las dos: una apertura repetida NO rebota ni duplica
// ============================================================================

describe('ya hay turno y caja: la apertura repetida confirma, no rebota', () => {
  it('desde la tablet no crea nada y devuelve lo que hay', async () => {
    mundo({ turno: turnoAbierto(), caja: cajaAbierta({ shiftId: TURNO }) })

    const sesion: any = await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 999 })

    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(sesion.id).toBe(CAJA)
    expect(sesion.shiftId).toBe(TURNO)
  })

  it('desde la PAX tampoco: antes contestaba 400 «ya hay un turno abierto»', async () => {
    mundo({ turno: turnoAbierto(), caja: cajaAbierta({ shiftId: TURNO }) })

    const shift: any = await openShiftForVenue(VENUE, STAFF, 999)

    expect(m.shift.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.create).not.toHaveBeenCalled()
    expect(shift.id).toBe(TURNO)
    expect(shift.cashDrawerSessionId).toBe(CAJA)
  })

  it('🔴 el fondo de lo que ya estaba NUNCA se pisa', async () => {
    mundo({ turno: turnoAbierto(), caja: cajaAbierta({ shiftId: TURNO }) })

    await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 999 })

    const escrituras = m.cashDrawerSession.updateMany.mock.calls.map((c: any) => c[0]?.data ?? {})
    expect(escrituras.every((d: any) => d.startingAmount === undefined)).toBe(true)
    expect(m.shift.updateMany).not.toHaveBeenCalled()
  })
})

// ============================================================================
// 5 · El contrato: aditivo y nada más
// ============================================================================

describe('🔴 contrato: las respuestas de hoy, más un campo opcional', () => {
  it('la del cajón conserva EXACTAMENTE los campos de hoy', async () => {
    mundo({ caja: cajaAbierta({ shiftId: TURNO }), turno: turnoAbierto() })

    const sesion: any = await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 0 })

    // Los campos de HOY, uno por uno. Si alguno desaparece o se renombra, esta prueba cae.
    for (const campo of [
      'id',
      'venueId',
      'deviceName',
      'status',
      'openedByStaffId',
      'openedByName',
      'openedAt',
      'startingAmount',
      'closedByStaffId',
      'closedByName',
      'closedAt',
      'actualAmount',
      'overShort',
      'closingNote',
      'events',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(sesion, campo)).toBe(true)
    }
    expect(typeof sesion.openedAt).toBe('string')
    expect(typeof sesion.startingAmount).toBe('number')
    expect(Array.isArray(sesion.events)).toBe(true)
  })

  it('la del cajón sigue ocultando el esperado sin el permiso, y sirviéndolo con él', async () => {
    mundo({ caja: cajaAbierta({ shiftId: TURNO }), turno: turnoAbierto() })
    const sinPermiso: any = await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'V', startingAmount: 0 })
    expect(sinPermiso.expectedAmount).toBeUndefined()

    jest.clearAllMocks()
    m.$transaction = jest.fn((fn: any) => fn(m))
    mundo({ caja: cajaAbierta({ shiftId: TURNO }), turno: turnoAbierto() })
    const conPermiso: any = await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'V', startingAmount: 0 }, true)
    expect(conPermiso.expectedAmount).toBeDefined()
  })

  it('la del turno conserva EXACTAMENTE los campos de hoy y NO añade relaciones', async () => {
    mundo({})

    const shift: any = await openShiftForVenue(VENUE, STAFF, 500)

    for (const campo of [
      'id',
      'venueId',
      'staffId',
      'startTime',
      'endTime',
      'status',
      'startingCash',
      'endingCash',
      'totalSales',
      'totalTips',
      'totalOrders',
      'totalCashPayments',
      'totalCardPayments',
      'totalVoucherPayments',
      'totalOtherPayments',
      'totalProductsSold',
      'externalId',
      'posRawData',
    ]) {
      expect(Object.prototype.hasOwnProperty.call(shift, campo)).toBe(true)
    }
    // 🔴 Ninguna relación embebida: la PAX declara `staff: StaffDto?` y un `include` nuevo le
    // cambiaría el payload sin que nadie lo pidiera.
    expect(shift.staff).toBeUndefined()
    expect(shift.cashDrawerSession).toBeUndefined()

    // 🔴 Y se fija la FORMA de la consulta, no sólo el resultado: comprobar el objeto devuelto sólo
    // guarda esto mientras el mock no traiga la relación, así que un `include` nuevo podría colarse
    // sin que ninguna prueba se enterara. Pedir la fila pelada es lo que garantiza el contrato.
    const relectura = m.shift.findUnique.mock.calls.find((c: any) => c[0]?.where?.id === TURNO)
    expect(relectura).toBeDefined()
    expect(relectura[0].include).toBeUndefined()
    expect(relectura[0].select).toBeUndefined()
  })
})

// ============================================================================
// 6 · Efectos que no se pueden duplicar ni perder
// ============================================================================

describe('bitácora y tiempo real', () => {
  it('abrir desde la tablet escribe CASH_DRAWER_OPENED UNA sola vez', async () => {
    mundo({})

    await openSession({ venueId: VENUE, staffId: STAFF, staffName: 'Viridiana', startingAmount: 100 })

    const aperturas = mockLogAction.mock.calls.filter((c: any) => c[0]?.action === 'CASH_DRAWER_OPENED')
    expect(aperturas).toHaveLength(1)
  })

  it('abrir desde la PAX escribe SHIFT_OPENED UNA sola vez', async () => {
    mundo({})

    await openShiftForVenue(VENUE, STAFF, 100, 'station-1')

    const aperturas = mockLogAction.mock.calls.filter((c: any) => c[0]?.action === 'SHIFT_OPENED')
    expect(aperturas).toHaveLength(1)
  })

  it('el aviso en tiempo real del turno se emite cuando se CREA', async () => {
    mundo({})

    await openShiftForVenue(VENUE, STAFF, 100)

    expect(mockBroadcastShiftEvent).toHaveBeenCalledWith(VENUE, 'opened', expect.objectContaining({ shiftId: TURNO, status: 'OPEN' }))
  })

  it('🔴 y NO se emite cuando el turno sólo se LIGÓ: nadie abrió nada', async () => {
    mundo({ turno: turnoAbierto() })

    await openShiftForVenue(VENUE, STAFF, 100)

    expect(mockBroadcastShiftEvent).not.toHaveBeenCalled()
  })
})
