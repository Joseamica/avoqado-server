/**
 * 🔴 DINERO — Fase 2, Task 5: CERRAR el turno de caja del NEGOCIO también es UN gesto.
 *
 * La Task 4 unificó la APERTURA: la caja física (que abre la tablet) y el turno (que abre la PAX)
 * son dos registros de UNA sola caja, y quien llega primero crea mientras el segundo liga. El
 * CIERRE se quedó partido: hoy una caja creada por la apertura del turno desde la PAX la cierra el
 * auto-cierre de las 04:00 o el relevo de la mañana siguiente, así que los venues sólo-PAX verían un
 * bloque «Caja física · sin conteo» todos los días.
 *
 * Aquí se cierra esa mitad. Las dos reglas duras:
 *
 *   1. 🔴 **Un cierre NUNCA inventa un conteo.** Si la PAX no manda uno, la gaveta ligada se cierra
 *      con `actualAmount` y `overShort` en NULL y sin evento `CLOSE` — la misma firma exacta del
 *      cierre automático (`cashDrawerAutoClose`, regla 1). Escribir un 0 diría «alguien contó y
 *      había cero» y le firmaría al cajero un faltante del tamaño de las ventas del día.
 *   2. 🔴 **Nunca se cierra el registro de otro.** La gaveta que se cierra tiene que ser la que
 *      estaba abierta ANTES del cierre del turno y no pertenecer a un turno distinto: si entre el
 *      cierre y esta llamada alguien abre la caja de la tarde, cerrarla dejaría a su turno nuevo
 *      sin gaveta y al cajero de la tarde contando una caja que ya se cerró sola.
 */

jest.mock('@/services/tpv/shift.tpv.service', () => ({
  __esModule: true,
  cerrarTurnoPorCierreDeCaja: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { cerrarTurnoPorCierreDeCaja } from '@/services/tpv/shift.tpv.service'
import { cerrarTurnoDeCaja, esperadoDelCajonAbierto } from '@/services/shared/turnoDeCaja'
import { Prisma } from '@prisma/client'

const m = prisma as any
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>
const mockCerrarTurno = cerrarTurnoPorCierreDeCaja as jest.MockedFunction<typeof cerrarTurnoPorCierreDeCaja>

const VENUE = 'venue-1'
const STAFF = 'staff-1'
const TURNO = 'turno-1'
const CAJA = 'caja-1'

/** Martes 3-sep-2026, 20:00 en CDMX (UTC−6): la hora a la que se cierra el mostrador. */
const AHORA = new Date('2026-09-04T02:00:00.000Z')
const ahora = () => AHORA
/** La gaveta se abrió a las 08:00 del mismo día. */
const ABIERTA_A_LAS_8 = new Date('2026-09-03T14:00:00.000Z')

/**
 * La gaveta del mostrador: $2,000 de fondo, $1,000 de ventas en efectivo y un retiro de $50.
 * Esperado = 2000 + 1000 − 50 = **$2,950** — y ése es justo el número que el turno NO sabe
 * calcular por su cuenta, porque `Shift` no conoce los retiros.
 */
const EVENTOS = [
  { type: 'OPEN', amount: new Prisma.Decimal(2000) },
  { type: 'CASH_SALE', amount: new Prisma.Decimal(1000) },
  { type: 'PAY_OUT', amount: new Prisma.Decimal(50) },
]

function gavetaAbierta(over: Record<string, unknown> = {}) {
  return {
    id: CAJA,
    venueId: VENUE,
    status: 'OPEN',
    shiftId: TURNO,
    startingAmount: new Prisma.Decimal(2000),
    openedAt: ABIERTA_A_LAS_8,
    ...over,
  }
}

function mundo({ gaveta = gavetaAbierta() as any, turno = { id: TURNO } as any, casGana = true } = {}) {
  m.cashDrawerSession.findFirst.mockResolvedValue(gaveta)
  m.cashDrawerSession.updateMany.mockResolvedValue({ count: casGana ? 1 : 0 })
  m.cashDrawerSession.update.mockResolvedValue({})
  m.cashDrawerEvent.findMany.mockResolvedValue(EVENTOS)
  m.cashDrawerEvent.create.mockResolvedValue({ id: 'ev-close' })
  m.shift.findFirst.mockResolvedValue(turno)
  m.$transaction = jest.fn((fn: any) => fn(m))
}

const paramsPax = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  staffName: 'Héctor Ruiz',
  source: 'TURNO_TPV' as const,
  yaCerrado: { shiftId: TURNO },
  conteo: null,
  now: ahora,
  ...over,
})

const paramsTablet = (over: Record<string, unknown> = {}) => ({
  venueId: VENUE,
  staffId: STAFF,
  staffName: 'Viridiana',
  source: 'CAJA_MOVIL' as const,
  yaCerrado: { cashDrawerSessionId: CAJA },
  conteo: new Prisma.Decimal(2950),
  esperadoDelCajon: new Prisma.Decimal(2950),
  now: ahora,
  ...over,
})

const datosDelCas = () => m.cashDrawerSession.updateMany.mock.calls[0][0]

beforeEach(() => {
  mundo()
  mockCerrarTurno.mockResolvedValue({ id: TURNO } as never)
})

// ============================================================================
// LA PAX CIERRA EL TURNO ⇒ SE CIERRA LA GAVETA LIGADA
// ============================================================================

describe('cerrarTurnoDeCaja — desde la PAX: el turno cerró, se cierra la gaveta', () => {
  it('🔴 SIN conteo no se inventa uno: ni `actualAmount`, ni `overShort`, ni evento CLOSE', async () => {
    const r = await cerrarTurnoDeCaja(paramsPax())

    expect(r.cajaCerradaId).toBe(CAJA)
    expect(r.conConteo).toBe(false)
    const { data } = datosDelCas()
    expect(data.status).toBe('CLOSED')
    expect(data).not.toHaveProperty('actualAmount')
    // Un evento lleva `amount`, y una fila en cero se lee como un conteo. Es la regla 1 de
    // `cashDrawerAutoClose`, y la misma que ya cumple el relevo al abrir.
    expect(m.cashDrawerEvent.create).not.toHaveBeenCalled()
    expect(m.cashDrawerSession.update).not.toHaveBeenCalled()
  })

  it('el CAS lleva `status: OPEN` y el venue: dos cierres a la vez no se pisan ni cruzan negocios', async () => {
    await cerrarTurnoDeCaja(paramsPax())

    expect(datosDelCas().where).toMatchObject({ id: CAJA, venueId: VENUE, status: 'OPEN' })
  })

  it('🔴 CON conteo, el `overShort` sale de los EVENTOS de la gaveta — el retiro de $50 incluido', async () => {
    // 2000 + 1000 − 50 = 2950 esperado. El cajero contó 2950 ⇒ cuadra.
    // Con la fórmula del turno (`startingCash + ventas`, ciega a los retiros) habría salido un
    // faltante inventado de $50, que es el defecto de dinero que este cierre unificado mata.
    const r = await cerrarTurnoDeCaja(paramsPax({ conteo: new Prisma.Decimal(2950) }))

    expect(r.conConteo).toBe(true)
    expect(Number(datosDelCas().data.actualAmount)).toBe(2950)
    expect(Number(m.cashDrawerSession.update.mock.calls[0][0].data.overShort)).toBe(0)
    const evento = m.cashDrawerEvent.create.mock.calls[0][0].data
    expect(evento).toMatchObject({ sessionId: CAJA, venueId: VENUE, type: 'CLOSE', staffId: STAFF })
    expect(Number(evento.amount)).toBe(2950)
  })

  it('un faltante real sigue saliendo como faltante', async () => {
    await cerrarTurnoDeCaja(paramsPax({ conteo: new Prisma.Decimal(2900) }))

    expect(Number(m.cashDrawerSession.update.mock.calls[0][0].data.overShort)).toBe(-50)
  })

  it('sin gaveta abierta no hay nada que cerrar, y no se escribe una sola fila', async () => {
    mundo({ gaveta: null })

    const r = await cerrarTurnoDeCaja(paramsPax())

    expect(r.cajaCerradaId).toBeUndefined()
    expect(r.motivo).toBe('SIN_PAREJA')
    expect(m.cashDrawerSession.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 sólo se busca una gaveta de ESTE turno o sin turno, y abierta ANTES del cierre', async () => {
    // Si entre el cierre del turno y esta llamada alguien abre la caja de la tarde, cerrarla
    // dejaría a su turno nuevo sin gaveta y al cajero contra una caja que se cerró sola.
    await cerrarTurnoDeCaja(paramsPax())

    const { where } = m.cashDrawerSession.findFirst.mock.calls[0][0]
    expect(where).toMatchObject({ venueId: VENUE, status: 'OPEN' })
    expect(where.openedAt).toEqual({ lte: AHORA })
    expect(where.OR).toEqual([{ shiftId: TURNO }, { shiftId: null }])
  })

  it('si otro se adelantó y la gaveta ya no estaba abierta, no se crea el evento CLOSE', async () => {
    mundo({ casGana: false })

    const r = await cerrarTurnoDeCaja(paramsPax({ conteo: new Prisma.Decimal(2950) }))

    expect(r.motivo).toBe('YA_CERRADO')
    expect(r.cajaCerradaId).toBeUndefined()
    expect(m.cashDrawerEvent.create).not.toHaveBeenCalled()
  })

  it('la bitácora dice si hubo conteo, y con qué números', async () => {
    await cerrarTurnoDeCaja(paramsPax({ conteo: new Prisma.Decimal(2900) }))

    const [asiento] = mockLogAction.mock.calls.filter(c => (c[0] as { action?: string })?.action === 'CASH_DRAWER_CLOSED')
    expect(asiento[0]).toMatchObject({ entity: 'CashDrawerSession', entityId: CAJA, venueId: VENUE, staffId: STAFF })
    expect(asiento[0].data).toMatchObject({
      expectedAmount: 2950,
      actualAmount: 2900,
      overShort: -50,
      sinConteo: false,
      source: 'TURNO_TPV',
    })
  })

  it('sin conteo la bitácora lo dice y NO inventa montos', async () => {
    await cerrarTurnoDeCaja(paramsPax())

    const [asiento] = mockLogAction.mock.calls.filter(c => (c[0] as { action?: string })?.action === 'CASH_DRAWER_CLOSED')
    expect(asiento[0].data).toMatchObject({ sinConteo: true, actualAmount: null, overShort: null })
  })
})

// ============================================================================
// LA TABLET CIERRA LA GAVETA ⇒ SE CIERRA EL TURNO DEL NEGOCIO
// ============================================================================

describe('cerrarTurnoDeCaja — desde la tablet: la gaveta cerró, se cierra el turno', () => {
  it('🔴 cierra el turno abierto del NEGOCIO con el conteo de la gaveta', async () => {
    const r = await cerrarTurnoDeCaja(paramsTablet())

    expect(r.shiftCerradoId).toBe(TURNO)
    expect(r.conConteo).toBe(true)
    expect(mockCerrarTurno).toHaveBeenCalledTimes(1)
    const [venueId, shiftId, opciones] = mockCerrarTurno.mock.calls[0]
    expect(venueId).toBe(VENUE)
    expect(shiftId).toBe(TURNO)
    expect(Number(opciones.conteo)).toBe(2950)
    expect(opciones.actorStaffId).toBe(STAFF)
  })

  it('🔴 le pasa el ESPERADO de la gaveta: es lo que hace que los dos cierres firmen el mismo número', async () => {
    // Sin esto, el turno recalcularía su esperado contra un `startingCash` congelado en la
    // apertura — el hueco del relevo de mostrador (gaveta refondeada a media jornada).
    await cerrarTurnoDeCaja(paramsTablet())

    expect(Number(mockCerrarTurno.mock.calls[0][2].esperadoDelCajon)).toBe(2950)
    expect(mockCerrarTurno.mock.calls[0][2].cashDrawerSessionId).toBe(CAJA)
  })

  it('sin turno abierto no hay nada que cerrar', async () => {
    mundo({ turno: null })

    const r = await cerrarTurnoDeCaja(paramsTablet())

    expect(r.motivo).toBe('SIN_PAREJA')
    expect(mockCerrarTurno).not.toHaveBeenCalled()
  })

  it('🔴 el turno se busca por NEGOCIO, no por persona: quien cierra puede no ser quien abrió', async () => {
    await cerrarTurnoDeCaja(paramsTablet())

    expect(m.shift.findFirst.mock.calls[0][0].where).toEqual({ venueId: VENUE, status: 'OPEN', endTime: null })
  })

  it('un cierre en curso del turno NO tumba el cierre de la gaveta, que ya está commiteado', async () => {
    // El dinero de la gaveta ya se firmó. Un fallo aquí no puede convertirlo en un error para el
    // cajero: degrada a lo de hoy (el turno sigue abierto) y lo dice en el log.
    mockCerrarTurno.mockRejectedValue(Object.assign(new Error('cierre en proceso'), { code: 'SHIFT_CLOSE_IN_PROGRESS' }) as never)

    const r = await cerrarTurnoDeCaja(paramsTablet())

    expect(r.shiftCerradoId).toBeUndefined()
    expect(r.motivo).toBe('CIERRE_EN_CURSO')
  })
})

// ============================================================================
// EL ESPERADO DE LA GAVETA — lo que el turno NO sabe calcular
// ============================================================================

/**
 * 🔴 Auditoría de Codex (3-sep-2026), P1: los DOS cierres calculaban el esperado con fórmulas
 * distintas, y **el del turno ignora `PAY_IN` y `PAY_OUT` por completo**:
 *
 *   · turno  → `startingCash + ventas en efectivo + propina en efectivo + tenders físicos`
 *   · gaveta → `startingAmount + CASH_SALE + PAY_IN − PAY_OUT`
 *
 * Codex midió el caso y comprobó además que **no existía ni una prueba** de un cierre de turno con
 * un movimiento manual de caja. Los dos escenarios están abajo, con sus números.
 */
describe('esperadoDelCajonAbierto — la gaveta es la que conoce los movimientos', () => {
  const conEventos = (eventos: Array<{ type: string; amount: number }>, fondo: number) => {
    m.cashDrawerSession.findFirst.mockResolvedValue({
      id: CAJA,
      startingAmount: new Prisma.Decimal(fondo),
      events: eventos.map(e => ({ type: e.type, amount: new Prisma.Decimal(e.amount) })),
    })
  }

  it('🔴 el INGRESO de $100 (caso de Codex): la gaveta espera $600 donde el turno esperaría $500', async () => {
    // Fondo $500, un PAY_IN de $100, cero ventas, el cajero cuenta $600. La gaveta firma
    // `overShort = 0`; el turno, con su fórmula, firmaba `cashDifference = +100` — dos números
    // contradictorios firmados para la MISMA caja física.
    conEventos(
      [
        { type: 'OPEN', amount: 500 },
        { type: 'PAY_IN', amount: 100 },
      ],
      500,
    )

    const r = await esperadoDelCajonAbierto(VENUE, TURNO, AHORA)

    expect(r?.sessionId).toBe(CAJA)
    expect(Number(r?.esperado)).toBe(600)
  })

  it('🔴 el RETIRO de $50: el turno inventaría un faltante del tamaño exacto del retiro', async () => {
    conEventos(
      [
        { type: 'OPEN', amount: 2000 },
        { type: 'CASH_SALE', amount: 1000 },
        { type: 'PAY_OUT', amount: 50 },
      ],
      2000,
    )

    expect(Number((await esperadoDelCajonAbierto(VENUE, TURNO, AHORA))?.esperado)).toBe(2950)
  })

  it('sin gaveta abierta devuelve null, y el cierre se queda con la fórmula de siempre', async () => {
    m.cashDrawerSession.findFirst.mockResolvedValue(null)

    expect(await esperadoDelCajonAbierto(VENUE, TURNO, AHORA)).toBeNull()
  })

  it('🔴 y busca con el MISMO filtro que el cierre: de este turno o de ninguno, abierta antes', async () => {
    conEventos([{ type: 'OPEN', amount: 100 }], 100)

    await esperadoDelCajonAbierto(VENUE, TURNO, AHORA)

    const { where } = m.cashDrawerSession.findFirst.mock.calls[0][0]
    expect(where).toMatchObject({ venueId: VENUE, status: 'OPEN' })
    expect(where.openedAt).toEqual({ lte: AHORA })
    expect(where.OR).toEqual([{ shiftId: TURNO }, { shiftId: null }])
  })
})
