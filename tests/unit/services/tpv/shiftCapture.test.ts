/**
 * shiftCapture.test.ts
 *
 * Verifies that shift lifecycle audit records are written with the correct
 * action / entity / venueId arguments.
 *
 * Coverage:
 *   - openShiftForVenue  → SHIFT_OPENED  (driven through success path)
 *   - closeShiftForVenue → SHIFT_CLOSED  (atomically with the final Shift write)
 *
 * Strategy: mock prisma locally so we control exactly what DB calls return,
 * then assert logAction was called with the right shape. logAction itself is
 * already mocked by the global setup.ts:
 *   jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
 */

import { logAction } from '@/services/dashboard/activity-log.service'
import { Decimal } from '@prisma/client/runtime/library'

// ── Local prisma mock (overrides the global one for this test file) ───────────
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findUnique: jest.fn() },
    shift: {
      findFirst: jest.fn(),
      // Ronda de arreglo 1 (P1.2): la apertura barre las anomalías «CLOSED con `endTime` nulo»
      // antes de leer el turno vivo. Sin este modelo la lectura devuelve `undefined` y revienta.
      findMany: jest.fn(),
      // Fase 2: la ruta RELEE el turno recién abierto para devolver la fila completa.
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    staffVenue: { findFirst: jest.fn() },
    // Fase 2 (3-sep-2026): `openShiftForVenue` delega en `abrirTurnoDeCaja`, que abre el turno Y el
    // cajón físico ligados. Sin este modelo la apertura revienta con «Cannot read … of undefined».
    cashDrawerSession: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    payment: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    $transaction: jest.fn(),
    // `lockShiftLifecycleForVenue` toma un advisory lock por `$queryRaw`; no devuelve filas.
    $queryRaw: jest.fn().mockResolvedValue([]),
  },
}))

// Other deps the service imports at module level
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}))

jest.mock('@/communication/rabbitmq/publisher', () => ({
  publishCommand: jest.fn(),
}))

jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: {
    getBroadcastingService: jest.fn().mockReturnValue(null),
  },
}))

// ── Helpers ───────────────────────────────────────────────────────────────────
import prisma from '@/utils/prismaClient'

const mockPrisma = prisma as any
const mockLogAction = logAction as jest.MockedFunction<typeof logAction>
const mockTxShiftUpdateMany = jest.fn()
const mockTxShiftFindUnique = jest.fn()
const mockTxActivityCreate = jest.fn()

const VENUE_ID = 'venue-1'
const SHIFT_ID = 'shift-1'
const STAFF_ID = 'staff-1'

/** Minimal Shift row returned by prisma.shift.create */
function makeCreatedShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-06-15T10:00:00Z'),
    endTime: null,
    status: 'OPEN',
    startingCash: new Decimal(500),
    endingCash: null,
    totalSales: new Decimal(0),
    totalTips: new Decimal(0),
    totalOrders: 0,
    totalCashPayments: new Decimal(0),
    totalCardPayments: new Decimal(0),
    totalVoucherPayments: new Decimal(0),
    totalOtherPayments: new Decimal(0),
    totalProductsSold: 0,
    cashDeclared: null,
    cardDeclared: null,
    vouchersDeclared: null,
    otherDeclared: null,
    notes: null,
    externalId: null,
    posRawData: null,
    ...overrides,
  }
}

/** Minimal open Shift row returned by prisma.shift.findFirst (for closeShiftForVenue) */
function makeOpenShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-06-15T10:00:00Z'),
    endTime: null,
    status: 'OPEN',
    startingCash: new Decimal(500),
    externalId: null,
    venue: { posType: 'NONE', posStatus: 'DISCONNECTED', name: 'Test Venue' },
    ...overrides,
  }
}

/** Minimal updated Shift returned by prisma.shift.update (for closeShiftForVenue) */
function makeUpdatedShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-06-15T10:00:00Z'),
    endTime: new Date('2026-06-15T18:00:00Z'),
    status: 'CLOSED',
    startingCash: new Decimal(500),
    endingCash: new Decimal(1200),
    totalSales: new Decimal(700),
    totalTips: new Decimal(50),
    totalOrders: 5,
    totalCashPayments: new Decimal(700),
    totalCardPayments: new Decimal(0),
    totalVoucherPayments: new Decimal(0),
    totalOtherPayments: new Decimal(0),
    totalProductsSold: 12,
    cashDeclared: new Decimal(700),
    cardDeclared: null,
    vouchersDeclared: null,
    otherDeclared: null,
    notes: null,
    externalId: null,
    inventoryConsumed: [],
    reportData: null,
    ...overrides,
  }
}

// ── Import service (after all mocks are in place) ─────────────────────────────
import { openShiftForVenue, closeShiftForVenue } from '@/services/tpv/shift.tpv.service'

/**
 * 🔴 Fase 2 (3-sep-2026): abrir el turno desde la PAX es UN gesto con DOS registros ligados.
 * `openShiftForVenue` delega en `abrirTurnoDeCaja`, que corre dentro de una transacción, releva lo
 * que quedó abierto de otro día de negocio (de ahí `venue.timezone`) y crea también el cajón.
 */
function sembrarAperturaUnificada(shiftCreado = makeCreatedShift()) {
  mockPrisma.venue.findUnique.mockResolvedValue({
    id: VENUE_ID,
    name: 'Test Venue',
    timezone: 'America/Mexico_City',
    posType: 'NONE',
    posStatus: 'DISCONNECTED',
  })
  mockPrisma.shift.findMany.mockResolvedValue([]) // ni anomalías «CLOSED sin endTime» que sanar
  mockPrisma.shift.findFirst.mockResolvedValue(null) // no hay turno abierto
  mockPrisma.staffVenue.findFirst.mockResolvedValue({
    staffId: STAFF_ID,
    venueId: VENUE_ID,
    posStaffId: null,
    staff: { id: STAFF_ID, firstName: 'Ana', lastName: 'García' },
  })
  mockPrisma.shift.create.mockResolvedValue({ id: SHIFT_ID })
  // La RELECTURA de la que sale la respuesta de la ruta.
  mockPrisma.shift.findUnique.mockResolvedValue(shiftCreado)
  mockPrisma.cashDrawerSession.findFirst.mockResolvedValue(null) // no hay caja abierta
  mockPrisma.cashDrawerSession.findUnique.mockResolvedValue(null)
  mockPrisma.cashDrawerSession.create.mockResolvedValue({ id: 'caja-nueva' })
  mockPrisma.cashDrawerSession.updateMany.mockResolvedValue({ count: 1 })
  mockPrisma.$transaction.mockImplementation((cb: any) => cb(mockPrisma))
  return shiftCreado
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('ActivityLog dual-write in shift.tpv.service', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    // Silence fire-and-forget — logAction always resolves
    mockLogAction.mockResolvedValue(undefined)
  })

  // ── openShiftForVenue → SHIFT_OPENED ─────────────────────────────────────

  describe('openShiftForVenue → SHIFT_OPENED', () => {
    it('fires logAction with action SHIFT_OPENED, entity Shift, and venueId', async () => {
      sembrarAperturaUnificada()

      await openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')

      // 🔴 Fase 2: la apertura escribe DOS renglones (el turno y el cajón que abre con él), así que
      // se cuenta el que esta prueba cuida en vez del total — contar el total la volvería a romper
      // cada vez que el gesto único gane un efecto.
      const aperturasDelTurno = mockLogAction.mock.calls.filter(c => (c[0] as any)?.action === 'SHIFT_OPENED')
      expect(aperturasDelTurno).toHaveLength(1)
      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'SHIFT_OPENED',
          entity: 'Shift',
          entityId: SHIFT_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
        }),
      )
    })

    it('includes startingCash and stationId in data', async () => {
      sembrarAperturaUnificada()

      await openShiftForVenue(VENUE_ID, STAFF_ID, 250, 'kiosk-2')

      expect(mockLogAction).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ startingCash: 250, stationId: 'kiosk-2' }),
        }),
      )
    })

    // ── Regression: return value unchanged ──────────────────────────────────
    it('still returns the shift row — the same fields, plus the drawer id', async () => {
      const created = sembrarAperturaUnificada()

      const result = await openShiftForVenue(VENUE_ID, STAFF_ID, 500)

      // 🔴 Ya no es la MISMA referencia (la fila se relee y se le añade el campo nuevo), pero el
      // contrato de la PAX es el contenido: los campos de siempre, intactos.
      expect(result).toMatchObject(created)
      expect(result.cashDrawerSessionId).toBe('caja-nueva')
    })
  })

  // ── closeShiftForVenue → SHIFT_CLOSED ────────────────────────────────────

  describe('closeShiftForVenue → SHIFT_CLOSED', () => {
    beforeEach(() => {
      // Shared setup: open shift in DB
      mockPrisma.shift.findFirst.mockResolvedValue(makeOpenShift())
      // No payments or order items for this base case
      mockPrisma.payment.findMany.mockResolvedValue([])
      mockPrisma.orderItem.findMany.mockResolvedValue([])
      mockPrisma.rawMaterialMovement.findMany.mockResolvedValue([])
      mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
      mockTxShiftUpdateMany.mockResolvedValue({ count: 1 })
      mockTxShiftFindUnique.mockResolvedValue(makeUpdatedShift())
      mockTxActivityCreate.mockResolvedValue({ id: 'activity-shift-closed' })
      mockPrisma.$transaction.mockImplementation((callback: any) =>
        callback({
          // `claimShiftForClose` relee el turno bajo el lock (`findClosableShift` → `shift.findFirst`)
          // antes del CAS OPEN→CLOSING. Sin fila, el cierre muere con «Shift not found».
          shift: {
            updateMany: mockTxShiftUpdateMany,
            findUnique: mockTxShiftFindUnique,
            findFirst: jest.fn().mockResolvedValue(makeOpenShift()),
          },
          $queryRaw: jest.fn().mockResolvedValue([]), // advisory lock del ciclo de vida del turno
          activityLog: { create: mockTxActivityCreate },
        }),
      )
    })

    it('writes SHIFT_CLOSED, entity Shift, and venueId inside the final transaction', async () => {
      const updated = makeUpdatedShift()
      mockTxShiftFindUnique.mockResolvedValue(updated)

      await closeShiftForVenue(VENUE_ID, SHIFT_ID)

      expect(mockTxActivityCreate).toHaveBeenCalledTimes(1)
      expect(mockTxActivityCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          action: 'SHIFT_CLOSED',
          entity: 'Shift',
          entityId: SHIFT_ID,
          venueId: VENUE_ID,
          staffId: STAFF_ID,
        }),
      })
    })

    it('includes totalSales, totalTips, and endingCash in data', async () => {
      const updated = makeUpdatedShift()
      mockTxShiftFindUnique.mockResolvedValue(updated)

      await closeShiftForVenue(VENUE_ID, SHIFT_ID)

      expect(mockTxActivityCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          data: expect.objectContaining({
            totalSales: 0, // no payments in mock → computed Decimal(0)
            totalTips: 0,
            endingCash: 0, // no count and no cash payments → existing no-count semantics
          }),
        }),
      })
    })

    it('includes cashDiscrepancy when cashDeclared is provided', async () => {
      const updated = makeUpdatedShift()
      mockTxShiftFindUnique.mockResolvedValue(updated)
      // One cash payment of 600; declared 700 → discrepancy = 700 - 600 = 100
      mockPrisma.payment.findMany.mockResolvedValue([{ id: 'p1', amount: new Decimal(600), tipAmount: new Decimal(0), method: 'CASH' }])

      await closeShiftForVenue(VENUE_ID, SHIFT_ID, { cashDeclared: 700 } as any)

      expect(mockTxActivityCreate).toHaveBeenCalledWith({
        data: expect.objectContaining({
          data: expect.objectContaining({ cashDiscrepancy: 100 }),
        }),
      })
    })

    it('leaves cashDiscrepancy undefined when no cashDeclared is provided', async () => {
      mockTxShiftFindUnique.mockResolvedValue(makeUpdatedShift())

      await closeShiftForVenue(VENUE_ID, SHIFT_ID) // no closeData

      const callArg = mockTxActivityCreate.mock.calls[0][0].data
      expect((callArg.data as any)?.cashDiscrepancy).toBeUndefined()
    })

    // ── Regression: return value unchanged ──────────────────────────────────
    it('still returns the updated shift object', async () => {
      const updated = makeUpdatedShift()
      mockTxShiftFindUnique.mockResolvedValue(updated)

      const result = await closeShiftForVenue(VENUE_ID, SHIFT_ID)

      expect(result).toBe(updated)
    })
  })
})

/**
 * 🔴 EL CHECK Y EL CREATE SON OPERACIONES SEPARADAS: la carrera la para la BASE, no el código.
 *
 * `openShiftForVenue` pregunta con un `findFirst` si ya hay turno abierto y CREA después. Dos
 * terminales que abren a la vez pasan las dos el check antes de que ninguna cree, y el venue queda
 * con DOS turnos OPEN — que no es sólo un registro de más: `turnoAbiertoDelNegocio` elige «el más
 * reciente», así que con dos abiertos el dinero del negocio se parte entre ellos según el reloj.
 *
 * Lo que de verdad lo impide es el índice único parcial `Shift(venueId) WHERE status='OPEN'`
 * (migración `20260903030000_shift_one_open_per_venue`, Fase 2). Aquí sólo se traduce ese choque al
 * `ConflictError` que las apps ya conocen del cajón, en vez de dejar escapar un P2002 como 500 —
 * un 500 en la apertura del turno es un cajero mirando «algo salió mal» con fila enfrente.
 */
describe('openShiftForVenue — la doble apertura simultánea no puede salir como 500', () => {
  const { ConflictError } = jest.requireActual('@/errors/AppError')
  const { Prisma } = jest.requireActual('@prisma/client')

  const p2002 = (target: string | string[] = 'Shift_venueId_open_key') =>
    new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
      code: 'P2002',
      clientVersion: 'test',
      meta: { target },
    })

  beforeEach(() => {
    jest.clearAllMocks()
    sembrarAperturaUnificada()
  })

  it('🔴 el P2002 del índice único parcial se traduce a ConflictError (409), no a un 500', async () => {
    mockPrisma.shift.create.mockRejectedValue(p2002())

    await expect(openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('🔴 y con la forma REAL medida contra Postgres el 3-sep (`target: [venueId]`, sin `constraint`)', async () => {
    // Ésta es la ruta VIVA de la PAX. Comparando sólo contra el nombre del índice, la traducción no
    // disparaba nunca y un doble intento legítimo salía como 500 en la cara del cajero.
    mockPrisma.shift.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', {
        code: 'P2002',
        clientVersion: 'test',
        meta: { modelName: 'Shift', target: ['venueId'] },
      }),
    )

    await expect(openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')).rejects.toBeInstanceOf(ConflictError)
  })

  it('cualquier otro error de la base sigue subiendo tal cual (no se disfraza de conflicto)', async () => {
    mockPrisma.shift.create.mockRejectedValue(new Error('la base se cayó'))

    await expect(openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')).rejects.toThrow('la base se cayó')
  })

  it('🔴 OTRO P2002 —`Shift(venueId, externalId)`, que se puebla en venues integrados— NO se disfraza de turno abierto', async () => {
    // Mirar sólo `error.code` le diría al cajero «ya hay un turno abierto» sobre un negocio que no
    // tiene ninguno, y lo mandaría a buscar algo que no existe.
    mockPrisma.shift.create.mockRejectedValue(p2002(['venueId', 'externalId']))

    await expect(openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')).rejects.not.toBeInstanceOf(ConflictError)
  })

  it('un P2002 sin `meta.target` tampoco se traduce: no se adivina', async () => {
    mockPrisma.shift.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' }),
    )

    await expect(openShiftForVenue(VENUE_ID, STAFF_ID, 500, 'station-1')).rejects.not.toBeInstanceOf(ConflictError)
  })
})
