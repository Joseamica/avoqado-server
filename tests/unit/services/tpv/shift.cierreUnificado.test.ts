/**
 * 🔴 DINERO — Fase 2, Task 5: EL ESPERADO DEL TURNO SALE DE LA GAVETA, no de un fondo congelado.
 *
 * `Shift.startingCash` es un ESCALAR, así que un turno no puede modelar dos sesiones de caja el
 * mismo día. Escenario alcanzable y normal (relevo de mostrador): 08:00 turno + gaveta con $2,000 →
 * 15:00 la tablet cierra la gaveta y cuenta → 15:05 se abre una gaveta NUEVA con $500 → el turno
 * conserva sus $2,000 y el cierre de la PAX sigue calculando el esperado contra $2,000.
 *
 * Y hay un segundo defecto de la misma familia, éste de todos los días: **`Shift` es CIEGO a los
 * retiros**. Un `PAY_OUT` de $50 baja el esperado de la gaveta y no toca el del turno, así que el
 * cierre de la PAX le firma al cajero un faltante de $50 que nadie causó — el mismo defecto de
 * dinero que ya costó una corrida en campo el 28-ago.
 *
 * Los dos desaparecen con una sola regla: **el esperado del turno es el de la gaveta que el cajero
 * tiene enfrente**, y sólo cuando no hay ninguna se cae a la fórmula de siempre
 * (`startingCash + ventas en efectivo`), byte a byte, para los venues que no usan el módulo de caja.
 */

import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    payment: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    cashDrawerSession: { findFirst: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn().mockReturnValue(null) },
}))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({
  isCashReconciliationEnabled: jest.fn().mockResolvedValue(true),
}))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({
  resolveShiftCashDrawer: jest.fn().mockResolvedValue(null),
}))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  __esModule: true,
  abrirTurnoDeCaja: jest.fn(),
  cerrarTurnoDeCaja: jest.fn(),
  esperadoDelCajonAbierto: jest.fn(),
}))
jest.mock('@/services/shared/parejaDeCierre', () => ({ __esModule: true, asegurarLaLiga: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { cerrarTurnoDeCaja, esperadoDelCajonAbierto } from '@/services/shared/turnoDeCaja'
import { asegurarLaLiga } from '@/services/shared/parejaDeCierre'
import { closeShiftForVenueWithResult, cerrarTurnoPorCierreDeCaja } from '@/services/tpv/shift.tpv.service'

const m = prisma as any
const mockCerrar = cerrarTurnoDeCaja as jest.MockedFunction<typeof cerrarTurnoDeCaja>
const mockEsperado = esperadoDelCajonAbierto as jest.MockedFunction<typeof esperadoDelCajonAbierto>
const mockLigar = asegurarLaLiga as jest.MockedFunction<typeof asegurarLaLiga>

const VENUE = 'venue-1'
const TURNO = 'turno-1'
const CAJA = 'caja-1'
const AHORA = new Date('2026-09-04T02:00:00.000Z')

function turnoAbierto(over: Record<string, unknown> = {}) {
  return {
    id: TURNO,
    venueId: VENUE,
    staffId: 'staff-1',
    startTime: new Date('2026-09-03T14:00:00.000Z'),
    endTime: null,
    status: 'OPEN',
    updatedAt: new Date('2026-09-03T14:00:00.000Z'),
    startingCash: new Decimal('2000.00'),
    externalId: null,
    venue: { posType: 'NONE', posStatus: 'NOT_INTEGRATED', name: 'Testarudo Cafe' },
    ...over,
  }
}

/** $1,000 de ventas en efectivo dentro del turno. */
const COBROS_EN_EFECTIVO = [
  {
    id: 'p1',
    amount: new Decimal('1000.00'),
    tipAmount: new Decimal('0'),
    method: 'CASH',
    fundsFlow: null,
    tenderTypeId: null,
    tenderCountsAsCash: null,
  },
]

/** Lo que la transacción del cierre acabó escribiendo, para poder afirmar sobre el dinero. */
let escrito: any

function mundo(over: Record<string, unknown> = {}) {
  const abierto = turnoAbierto(over)
  escrito = undefined
  const tx = {
    shift: {
      updateMany: jest.fn(async (args: any) => {
        escrito = args.data
        return { count: 1 }
      }),
      findUnique: jest.fn(async () => ({ ...abierto, ...escrito })),
    },
    activityLog: { create: jest.fn(async (args: any) => ({ id: 'audit', ...args })) },
  }
  m.shift.findFirst.mockResolvedValue(abierto)
  m.shift.updateMany.mockResolvedValue({ count: 1 })
  m.payment.findMany.mockResolvedValue(COBROS_EN_EFECTIVO)
  m.orderItem.findMany.mockResolvedValue([])
  m.rawMaterialMovement.findMany.mockResolvedValue([])
  m.staffVenue.findFirst.mockResolvedValue(null)
  m.$transaction.mockImplementation(async (cb: any) => cb(tx))
  return tx
}

/** El cuerpo del cierre CON conteo que manda la PAX. */
const conteo = (monto: string) => ({ cashReconciliationAction: 'COUNTED', countedCash: monto })

beforeEach(() => {
  jest.clearAllMocks()
  mundo()
  mockCerrar.mockResolvedValue({ conConteo: false } as never)
  mockEsperado.mockResolvedValue(null)
  mockLigar.mockResolvedValue(true as never)
})

// ============================================================================
// EL ESPERADO
// ============================================================================

describe('el esperado del turno sale de la GAVETA cuando hay una', () => {
  it('🔴 el retiro de $50: con la gaveta el cierre CUADRA; con la fórmula del turno inventaría un faltante', async () => {
    // Gaveta: 2000 de fondo + 1000 de ventas − 50 de retiro = 2950 esperado.
    // Turno (fórmula vieja): 2000 + 1000 = 3000. El cajero cuenta 2950 y sale −50 de la nada.
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('2950.00') })

    const r = await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2950.00'), { now: () => AHORA })

    expect(r.reconciliation.outcome).toBe('APPLIED')
    expect(r.reconciliation.cashDifference).toBe('0.00')
    expect(Number(escrito.cashDifference)).toBe(0)
  })

  it('🔴 relevo de mostrador: la gaveta se refondeó a $500 y el turno conserva sus $2,000', async () => {
    // La gaveta de la tarde abrió con $500 y vendió $800 ⇒ esperado 1,300. El turno cree que su
    // fondo son $2,000 y que las ventas del día entero (mañana + tarde) son $1,800 ⇒ 3,800.
    // 🔴 La magnitud se MIDE, no se narra: por eso el mundo lleva los $1,800 de cobros de verdad.
    // Revertir el arreglo hace que este mismo cierre firme **−$2,500**.
    m.payment.findMany.mockResolvedValue([
      {
        id: 'p-manana',
        amount: new Decimal('1000.00'),
        tipAmount: new Decimal('0'),
        method: 'CASH',
        fundsFlow: null,
        tenderTypeId: null,
        tenderCountsAsCash: null,
      },
      {
        id: 'p-tarde',
        amount: new Decimal('800.00'),
        tipAmount: new Decimal('0'),
        method: 'CASH',
        fundsFlow: null,
        tenderTypeId: null,
        tenderCountsAsCash: null,
      },
    ])
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('1300.00') })

    const r = await closeShiftForVenueWithResult(VENUE, TURNO, conteo('1300.00'), { now: () => AHORA })

    expect(r.reconciliation.cashDifference).toBe('0.00')
    // El esperado firmado es el de la GAVETA. Con el del turno serían $3,800 (2,000 + 1,800).
    expect(escrito.endingCash.toString()).toBe('1300')
  })

  it('sin gaveta, el esperado sigue siendo el de HOY: `startingCash` + efectivo del turno', async () => {
    // Es el caso de los venues que no usan el módulo de caja: nada cambia para ellos.
    mockEsperado.mockResolvedValue(null)

    const r = await closeShiftForVenueWithResult(VENUE, TURNO, conteo('3000.00'), { now: () => AHORA })

    expect(r.reconciliation.cashDifference).toBe('0.00')
    expect(Number(escrito.cashDifference)).toBe(0)
  })

  it('un faltante real sigue saliendo como faltante contra el esperado de la gaveta', async () => {
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('2950.00') })

    const r = await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2900.00'), { now: () => AHORA })

    expect(r.reconciliation.cashDifference).toBe('-50.00')
  })

  it('la bitácora dice de DÓNDE salió el esperado, y de qué gaveta', async () => {
    const tx = mundo()
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('2950.00') })

    await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2950.00'), { now: () => AHORA })

    const asiento = tx.activityLog.create.mock.calls[0][0].data
    expect(asiento.action).toBe('SHIFT_CLOSED')
    expect(asiento.data).toMatchObject({ expectedCash: '2950.00', expectedSource: 'CAJON', cashDrawerSessionId: CAJA })
  })

  it('sin gaveta la bitácora lo dice igual de explícito', async () => {
    const tx = mundo()

    await closeShiftForVenueWithResult(VENUE, TURNO, conteo('3000.00'), { now: () => AHORA })

    expect(tx.activityLog.create.mock.calls[0][0].data.data).toMatchObject({ expectedCash: '3000.00', expectedSource: 'TURNO' })
  })
})

// ============================================================================
// EL GESTO ÚNICO: CERRAR EL TURNO CIERRA LA GAVETA
// ============================================================================

describe('cerrar el turno desde la PAX cierra también la gaveta ligada', () => {
  it('🔴 sin conteo, la gaveta se cierra SIN conteo: nunca se inventa uno', async () => {
    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => AHORA })

    expect(mockCerrar).toHaveBeenCalledTimes(1)
    expect(mockCerrar.mock.calls[0][0]).toMatchObject({ venueId: VENUE, source: 'TURNO_TPV', yaCerrado: { shiftId: TURNO }, conteo: null })
  })

  it('🔴 con conteo APLICADO, la gaveta recibe el MISMO conteo que firmó el turno', async () => {
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('2950.00') })

    await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2950.00'), { now: () => AHORA })

    expect(Number(mockCerrar.mock.calls[0][0].conteo)).toBe(2950)
  })

  it('🔴 si el conteo se IGNORÓ (venue sin la función), la gaveta se cierra SIN conteo', async () => {
    // Escribirlo en la gaveta sería colar por la puerta de atrás justo lo que el candado deja
    // fuera, y además dejaría las dos mitades diciendo cosas distintas.
    const { isCashReconciliationEnabled } = require('@/services/access/cashReconciliationAccess.service')
    ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValueOnce(false)

    await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2950.00'), { now: () => AHORA })

    expect(mockCerrar.mock.calls[0][0].conteo).toBeNull()
  })

  it('🔴 una DECLARACIÓN legacy tampoco se vuelve un arqueo de la gaveta', async () => {
    // El protocolo legacy de Avoqado Desktop guarda `cashDeclared` y a propósito NO produce
    // `cashDifference` («H0.6 does not retrofit a reconciliation difference»). Pasarlo a la gaveta
    // le fabricaría un `overShort` que ese protocolo decidió no calcular: un descuadre firmado que
    // nadie pidió, y en el único camino donde el conteo no lo hizo quien está viendo el cajón.
    await closeShiftForVenueWithResult(VENUE, TURNO, { cashDeclared: 2950 }, { now: () => AHORA })

    expect(mockCerrar).toHaveBeenCalledTimes(1)
    expect(mockCerrar.mock.calls[0][0].conteo).toBeNull()
  })

  it('🔴 el turno guarda QUIÉN lo cerró, que no tiene por qué ser quien lo abrió', async () => {
    // `staffId` es quien ABRIÓ. Con el gesto único, la caja la puede cerrar la tablet y el turno la
    // PAX, y de personas distintas: sin `closedById` la única constancia del autor vivía en
    // `ActivityLog`, que es best-effort y no se puede unir en una consulta.
    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => AHORA, actorStaffId: 'staff-de-la-tarde' })

    expect(escrito.closedById).toBe('staff-de-la-tarde')
  })

  it('🔴 y NO se inventa el autor cuando no se sabe: nunca se copia quien abrió', async () => {
    // Copiar `staffId` afirmaría que quien abrió también cerró, que es justo el supuesto que esta
    // columna existe para dejar de hacer.
    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => AHORA })

    expect(escrito.closedById).toBeNull()
  })

  it('🔴 la gaveta recibe el MISMO esperado que el turno acaba de firmar, no una segunda foto', async () => {
    // Entre que el turno resuelve su esperado y la gaveta se cierra pasan segundos (pagos, reporte,
    // transacción, publicación al POS, broadcast). Una venta en efectivo en esa ventana postea su
    // `CASH_SALE` a la gaveta abierta: si la gaveta releyera sus eventos firmaría `overShort` = −venta
    // mientras el turno firma 0. La foto es una sola; las firmas, dos.
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('2950.00') })

    await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2950.00'), { now: () => AHORA })

    expect(Number(mockCerrar.mock.calls[0][0].esperadoDelCajon)).toBe(2950)
  })

  it('sin gaveta, no se le inventa un esperado a la que no existe', async () => {
    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => AHORA })

    expect(mockCerrar.mock.calls[0][0].esperadoDelCajon ?? null).toBeNull()
  })

  it('🔴 un fallo al cerrar la gaveta NO tumba el cierre del turno, que ya está commiteado', async () => {
    mockCerrar.mockRejectedValue(new Error('la base se cayó') as never)

    const r = await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => AHORA })

    expect(r.shift.id).toBe(TURNO)
  })

  /**
   * 🔴 Y lo que queda cuando eso pasa NO «degrada a lo de hoy» (Codex, 3-sep-2026): la gaveta sigue
   * OPEN mientras `turnoAbiertoDelNegocio` ya devuelve `null`, así que cada cobro nuevo nace sin
   * turno y su `CASH_SALE` se sigue posteando a esa caja. Efectivo acumulándose en una gaveta que
   * ya nadie va a cuadrar. Por eso el fallo tiene que quedar REPARABLE.
   */
  it('🔴 el fallo queda REPARABLE: la gaveta se liga al turno ANTES de que el turno se cierre', async () => {
    mockEsperado.mockResolvedValue({ sessionId: CAJA, esperado: new Decimal('2950.00') })
    mockCerrar.mockRejectedValue(new Error('la base se cayó') as never)

    await closeShiftForVenueWithResult(VENUE, TURNO, conteo('2950.00'), { now: () => AHORA })

    expect(mockLigar).toHaveBeenCalledWith(expect.anything(), VENUE, TURNO, CAJA)
    // ANTES: si la liga se escribiera después del commit del turno, un proceso que muere en medio
    // dejaría la pareja sin identificar y el barrido no podría cerrarla nunca.
    expect(mockLigar.mock.invocationCallOrder[0]).toBeLessThan(m.$transaction.mock.invocationCallOrder[0])
  })

  it('sin gaveta no hay pareja que ligar', async () => {
    await closeShiftForVenueWithResult(VENUE, TURNO, {}, { now: () => AHORA })

    expect(mockLigar).not.toHaveBeenCalled()
  })

  it('🔴 si el cierre viene DESDE la gaveta tampoco se liga: esa pareja ya la resolvió quien llamó', async () => {
    await cerrarTurnoPorCierreDeCaja(VENUE, TURNO, {
      conteo: new Decimal('2950.00'),
      esperadoDelCajon: new Decimal('2950.00'),
      actorStaffId: 'staff-1',
      cashDrawerSessionId: CAJA,
    })

    expect(mockLigar).not.toHaveBeenCalled()
  })

  it('🔴 si el cierre viene DESDE la gaveta, no se cierra ninguna otra: nada de ping-pong', async () => {
    // Sin esta guarda, cerrar la caja desde la tablet cerraría el turno, y el turno cerraría «la
    // gaveta abierta del negocio» — que en ese instante puede ser la que alguien acaba de abrir
    // para el siguiente relevo.
    await cerrarTurnoPorCierreDeCaja(VENUE, TURNO, {
      conteo: new Decimal('2950.00'),
      esperadoDelCajon: new Decimal('2950.00'),
      actorStaffId: 'staff-1',
      cashDrawerSessionId: CAJA,
    })

    expect(mockCerrar).not.toHaveBeenCalled()
  })

  it('🔴 y ese cierre usa el esperado que le pasó la gaveta, sin volver a resolverlo', async () => {
    await cerrarTurnoPorCierreDeCaja(VENUE, TURNO, {
      conteo: new Decimal('1300.00'),
      esperadoDelCajon: new Decimal('1300.00'),
      actorStaffId: 'staff-1',
      cashDrawerSessionId: CAJA,
    })

    expect(mockEsperado).not.toHaveBeenCalled()
    expect(Number(escrito.cashDifference)).toBe(0)
  })

  it('🔴 el conteo de la tablet NO pasa por el candado del protocolo de la PAX', async () => {
    // El cajero ya contó por un camino que es core y gratis (`/cash-drawer/close` exige
    // `actualAmount`). Volver a pedir el permiso aquí dejaría a la gaveta diciendo «faltan $50» y
    // al turno callado sobre el mismo dinero.
    const { isCashReconciliationEnabled } = require('@/services/access/cashReconciliationAccess.service')
    ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValue(false)

    await cerrarTurnoPorCierreDeCaja(VENUE, TURNO, {
      conteo: new Decimal('2900.00'),
      esperadoDelCajon: new Decimal('2950.00'),
      actorStaffId: 'staff-1',
      cashDrawerSessionId: CAJA,
    })

    expect(Number(escrito.cashDeclared)).toBe(2900)
    expect(Number(escrito.cashDifference)).toBe(-50)
  })

  it('sin conteo desde la gaveta, el turno cierra sin declarar nada', async () => {
    await cerrarTurnoPorCierreDeCaja(VENUE, TURNO, {
      conteo: null,
      esperadoDelCajon: null,
      actorStaffId: 'staff-1',
      cashDrawerSessionId: CAJA,
    })

    expect(escrito.cashDeclared).toBeNull()
    expect(escrito.cashDifference).toBeNull()
  })
})
