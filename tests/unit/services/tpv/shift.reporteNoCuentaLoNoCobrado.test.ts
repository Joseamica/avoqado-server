/**
 * 🔴 DINERO. El reporte de turnos NO puede contar dinero que no entró.
 *
 * Dos defectos distintos en el mismo sitio (`getShifts` / `getShiftsSummary`), y el segundo es
 * el sutil:
 *
 * (a) **Ningún filtro por `status`.** El `where` de los cobros filtraba por `processedById` y por
 *     fecha, nunca por `COMPLETED`. `b4bit.service.ts:377` crea el `Payment` en `PENDING` CON el
 *     `shiftId` del turno abierto, y a los `OC`/`EX` los pasa a `FAILED` (`:418`, `:802`, `:1492`):
 *     un cobro cripto de $500 que nunca se confirmó salía como cobrado, y seguía saliendo después
 *     de quedar `FAILED`. La verdad ya estaba escrita dos veces en este mismo archivo —
 *     `getCurrentShift` (`:108`) y el CIERRE (`:1462`) filtran `status: 'COMPLETED'`—: el reporte
 *     era el único de los tres que no.
 *
 * (b) **El respaldo histórico no tenía techo.** `getShifts` deja pasar un cobro con `shiftId`
 *     NULO que cuelgue de una orden de este turno (las órdenes de pos-sync tienen turno y sus
 *     cobros no; ver `shift.getShifts.cobroDeOtroTurno.test.ts:81`). Sin acotar, ese respaldo
 *     acepta un cobro ocurrido DESPUÉS del cierre y lo mete en un turno ya firmado.
 *     Medido en la base local: de 8 cobros con esa forma, los 8 caen tras el cierre de su turno,
 *     entre 1 701 y 3 015 horas después (70–125 días), $4 638.00 en total.
 *
 * 🔴 Y el límite del arreglo, que también está MEDIDO y es lo que impide "acotar todo por la
 * ventana": 19 cobros que llevan su PROPIO `Payment.shiftId` caen fuera de la ventana de ese
 * mismo turno ($6 874.06 en la base local). `Payment.shiftId` es la autoridad del servidor
 * (`shared/turnoDeCaja.ts`, task 1): la ventana sólo puede gobernar el RESPALDO de los huérfanos,
 * nunca la rama estampada — acotarla borraría dinero bien atribuido.
 */

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findMany: jest.fn(), count: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
    payment: { findMany: jest.fn() },
    order: { count: jest.fn() },
    orderItem: { findMany: jest.fn() },
    review: { count: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    venue: { findUnique: jest.fn() },
    staff: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
    $transaction: jest.fn(),
  },
}))

jest.mock('@/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
jest.mock('@/communication/rabbitmq/publisher', () => ({ publishCommand: jest.fn() }))
jest.mock('@/communication/sockets', () => ({ __esModule: true, default: { getBroadcastingService: jest.fn().mockReturnValue(null) } }))
jest.mock('@/services/access/cashReconciliationAccess.service', () => ({ isCashReconciliationEnabled: jest.fn() }))
jest.mock('@/services/dashboard/shift.dashboard.service', () => ({ resolveShiftCashDrawer: jest.fn().mockResolvedValue(null) }))

import prisma from '@/utils/prismaClient'
import { getShifts, getShiftsSummary, cobroSinTurnoPerteneceAlTurno } from '@/services/tpv/shift.tpv.service'

const mockPrisma = prisma as unknown as { $transaction: jest.Mock }
const turnosFindMany = () => (prisma as unknown as { shift: { findMany: jest.Mock } }).shift.findMany

/** Fija en el tiempo la ventana del turno de las pruebas de abajo. */
const ABRE = new Date('2026-09-03T14:00:00.000Z')
const CIERRA = new Date('2026-09-03T22:00:00.000Z')

function turnoCerrado(extra: Record<string, unknown> = {}) {
  return {
    id: 'turno-A',
    venueId: 'venue-1',
    staff: null,
    status: 'CLOSED',
    startTime: ABRE,
    endTime: CIERRA,
    updatedAt: CIERRA,
    orders: [],
    payments: [],
    ...extra,
  }
}

function cobro(extra: Record<string, unknown> = {}) {
  return {
    id: 'pago-1',
    shiftId: null,
    status: 'COMPLETED',
    amount: 500,
    tipAmount: 0,
    processedById: 'staff-1',
    createdAt: new Date('2026-09-03T18:00:00.000Z'),
    allocations: [],
    ...extra,
  }
}

/**
 * (a) El `status` se filtra EN LA CONSULTA, no en JavaScript — es el mismo predicado que ya usan
 * `getCurrentShift` y el cierre, y así el índice `Payment_venueId_status_createdAt_idx` sirve y no
 * se hidrata una fila para tirarla. Consecuencia honesta: una prueba con un fixture `FAILED` NO
 * probaría nada (el mock devuelve lo que se le diga, pase lo que pase). La aserción de FORMA de
 * aquí abajo es el ÚNICO candado real de este defecto: si alguien quita el `status`, falla aquí.
 */
describe('🔴 (a) el reporte pide sólo cobros COMPLETED', () => {
  beforeEach(() => jest.clearAllMocks())

  it('getShifts: el `where` de los cobros del TURNO exige COMPLETED', async () => {
    mockPrisma.$transaction.mockResolvedValue([[], 0])
    ;(prisma as unknown as { shift: { count: jest.Mock } }).shift.count.mockResolvedValue(0)
    ;(prisma as unknown as { venue: { findUnique: jest.Mock } }).venue.findUnique.mockResolvedValue(null)

    await getShifts('venue-1', 20, 1)

    expect(turnosFindMany().mock.calls[0][0].include.payments.where.status).toBe('COMPLETED')
  })

  it('getShifts: el `where` de los cobros de la ORDEN exige COMPLETED', async () => {
    mockPrisma.$transaction.mockResolvedValue([[], 0])
    ;(prisma as unknown as { shift: { count: jest.Mock } }).shift.count.mockResolvedValue(0)
    ;(prisma as unknown as { venue: { findUnique: jest.Mock } }).venue.findUnique.mockResolvedValue(null)

    await getShifts('venue-1', 20, 1)

    expect(turnosFindMany().mock.calls[0][0].include.orders.include.payments.where.status).toBe('COMPLETED')
  })

  it('getShiftsSummary: el `where` de los cobros del turno exige COMPLETED', async () => {
    turnosFindMany().mockResolvedValue([])
    ;(prisma as unknown as { payment: { findMany: jest.Mock } }).payment.findMany.mockResolvedValue([])
    ;(prisma as unknown as { order: { count: jest.Mock } }).order.count.mockResolvedValue(0)
    ;(prisma as unknown as { review: { count: jest.Mock } }).review.count.mockResolvedValue(0)

    await getShiftsSummary('venue-1')

    expect(turnosFindMany().mock.calls[0][0].include.payments.where.status).toBe('COMPLETED')
  })

  it('REGRESIÓN — getShiftsSummary sigue pidiendo COMPLETED en los cobros HUÉRFANOS', async () => {
    turnosFindMany().mockResolvedValue([])
    const pagoFindMany = (prisma as unknown as { payment: { findMany: jest.Mock } }).payment.findMany
    pagoFindMany.mockResolvedValue([])
    ;(prisma as unknown as { order: { count: jest.Mock } }).order.count.mockResolvedValue(0)
    ;(prisma as unknown as { review: { count: jest.Mock } }).review.count.mockResolvedValue(0)

    await getShiftsSummary('venue-1')

    expect(pagoFindMany.mock.calls[0][0].where.status).toBe('COMPLETED')
    expect(pagoFindMany.mock.calls[0][0].where.shiftId).toBeNull()
  })
})

/**
 * (b) El respaldo de los huérfanos, acotado a la ventana del turno. Mismo patrón que
 * `gavetaCerrable` (`shared/turnoDeCaja.ts:888`): ventana + `OR` sobre el id.
 */
describe('🔴 (b) el respaldo histórico se acota a [startTime, endTime]', () => {
  beforeEach(() => jest.clearAllMocks())

  const correr = async (turno: Record<string, unknown>) => {
    mockPrisma.$transaction.mockResolvedValue([[turno], 1])
    const { data } = await getShifts('venue-1', 20, 1)
    return data[0]
  }

  it('el cobro sin turno DENTRO de la ventana sigue contando (pos-sync histórico)', async () => {
    const fila = await correr(turnoCerrado({ orders: [{ id: 'orden-pos', payments: [cobro({ amount: 80 })] }] }))
    expect(fila.paymentSum).toBe(80)
  })

  it('🔴 el cobro sin turno ocurrido DESPUÉS del cierre NO entra a un turno ya firmado', async () => {
    const tardio = cobro({ amount: 500, createdAt: new Date('2026-09-04T02:00:00.000Z') })
    const fila = await correr(turnoCerrado({ orders: [{ id: 'orden-1', payments: [tardio] }] }))
    expect(fila.paymentSum).toBe(0)
  })

  it('el cobro sin turno ocurrido ANTES de abrir tampoco entra', async () => {
    const temprano = cobro({ amount: 500, createdAt: new Date('2026-09-03T09:00:00.000Z') })
    const fila = await correr(turnoCerrado({ orders: [{ id: 'orden-1', payments: [temprano] }] }))
    expect(fila.paymentSum).toBe(0)
  })

  it('en un turno ABIERTO (endTime null) no hay techo: el cobro posterior sí cuenta', async () => {
    const tardio = cobro({ amount: 500, createdAt: new Date('2026-09-05T02:00:00.000Z') })
    const fila = await correr(turnoCerrado({ status: 'OPEN', endTime: null, orders: [{ id: 'orden-1', payments: [tardio] }] }))
    expect(fila.paymentSum).toBe(500)
  })

  it('🔴 el cobro CON el shiftId de ESTE turno cuenta AUNQUE caiga fuera de la ventana', async () => {
    // Medido: 19 cobros de la base local están en esta situación ($6 874.06). `Payment.shiftId`
    // es la autoridad del servidor; acotarla borraría dinero bien atribuido.
    const propio = cobro({ shiftId: 'turno-A', amount: 700, createdAt: new Date('2026-09-04T02:00:00.000Z') })
    const fila = await correr(turnoCerrado({ orders: [{ id: 'orden-1', payments: [propio] }] }))
    expect(fila.paymentSum).toBe(700)
  })

  it('FALLA CERRADO — un cobro sin `createdAt` (select estrechado) no se cuenta', async () => {
    const sinFecha = cobro({ amount: 500 })
    delete (sinFecha as Record<string, unknown>).createdAt
    const fila = await correr(turnoCerrado({ orders: [{ id: 'orden-1', payments: [sinFecha] }] }))
    expect(fila.paymentSum).toBe(0)
  })

  it('FALLA CERRADO — un turno sin `startTime` no adopta huérfanos', async () => {
    const turno = turnoCerrado({ orders: [{ id: 'orden-1', payments: [cobro({ amount: 500 })] }] })
    delete (turno as Record<string, unknown>).startTime
    const fila = await correr(turno)
    expect(fila.paymentSum).toBe(0)
  })

  it('FALLA CERRADO — `endTime` ausente (no `null`) no se lee como turno abierto', async () => {
    // `null` = turno abierto. `undefined` = el campo no se pidió: no se puede afirmar nada,
    // así que no se adopta. Es el mismo `=== null` que ya protege el predicado del `shiftId`.
    const turno = turnoCerrado({ orders: [{ id: 'orden-1', payments: [cobro({ amount: 500 })] }] })
    delete (turno as Record<string, unknown>).endTime
    const fila = await correr(turno)
    expect(fila.paymentSum).toBe(0)
  })
})

/** La regla, a solas. Pura: sin base, sin reloj. */
describe('cobroSinTurnoPerteneceAlTurno', () => {
  const dentro = new Date('2026-09-03T18:00:00.000Z')

  it('acepta el instante exacto de apertura y el de cierre (ventana inclusiva)', () => {
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: ABRE }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(true)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: CIERRA }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(true)
  })

  it('rechaza un milisegundo antes de abrir y uno después de cerrar', () => {
    const justoAntes = new Date(ABRE.getTime() - 1)
    const justoDespues = new Date(CIERRA.getTime() + 1)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: justoAntes }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(false)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: justoDespues }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(false)
  })

  it('un turno abierto no tiene techo', () => {
    const muyDespues = new Date('2027-01-01T00:00:00.000Z')
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: muyDespues }, { status: 'OPEN', startTime: ABRE, endTime: null })).toBe(true)
  })

  it('falla cerrado ante datos ausentes o ilegibles', () => {
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: undefined }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(false)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: null }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(false)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: dentro }, { status: 'CLOSED', startTime: undefined, endTime: CIERRA })).toBe(false)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: dentro }, { status: 'CLOSED', startTime: ABRE, endTime: undefined })).toBe(false)
    expect(cobroSinTurnoPerteneceAlTurno({ createdAt: 'no es fecha' }, { status: 'CLOSED', startTime: ABRE, endTime: CIERRA })).toBe(false)
  })
})
