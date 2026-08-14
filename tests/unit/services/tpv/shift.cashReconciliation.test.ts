import { Decimal } from '@prisma/client/runtime/library'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    shift: { findFirst: jest.fn(), updateMany: jest.fn(), update: jest.fn() },
    payment: { findMany: jest.fn() },
    orderItem: { findMany: jest.fn() },
    rawMaterialMovement: { findMany: jest.fn() },
    staffVenue: { findFirst: jest.fn() },
    activityLog: { create: jest.fn() },
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
  isCashReconciliationEnabled: jest.fn(),
}))

import prisma from '@/utils/prismaClient'
import { publishCommand } from '@/communication/rabbitmq/publisher'
import { isCashReconciliationEnabled } from '@/services/access/cashReconciliationAccess.service'
import { closeShiftForVenueWithResult } from '@/services/tpv/shift.tpv.service'

const mockPrisma = prisma as any
const mockAccess = isCashReconciliationEnabled as jest.MockedFunction<typeof isCashReconciliationEnabled>
const VENUE_ID = 'venue-reconciliation'
const SHIFT_ID = 'shift-reconciliation'
const STAFF_ID = 'shift-owner'
const ACTOR_ID = 'authenticated-closer'

function openShift(overrides: Record<string, unknown> = {}) {
  return {
    id: SHIFT_ID,
    venueId: VENUE_ID,
    staffId: STAFF_ID,
    startTime: new Date('2026-08-08T14:00:00.000Z'),
    endTime: null,
    status: 'OPEN',
    updatedAt: new Date('2026-08-08T14:00:00.000Z'),
    startingCash: new Decimal('1000.00'),
    externalId: null,
    venue: { posType: 'NONE', posStatus: 'DISCONNECTED', name: 'Caja H0.6' },
    ...overrides,
  }
}

function payment(amount: string, method = 'CASH') {
  return { id: `payment-${amount}`, amount: new Decimal(amount), tipAmount: new Decimal(0), method }
}

describe('closeShiftForVenueWithResult cash reconciliation', () => {
  let shift: ReturnType<typeof openShift>
  let tx: any
  let finalWrite: any

  beforeEach(() => {
    jest.clearAllMocks()
    shift = openShift()
    finalWrite = undefined
    mockAccess.mockResolvedValue(true)
    mockPrisma.shift.findFirst.mockResolvedValue(shift)
    mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.shift.update.mockResolvedValue({ ...shift, endTime: new Date(), status: 'CLOSED' })
    mockPrisma.payment.findMany.mockResolvedValue([])
    mockPrisma.orderItem.findMany.mockResolvedValue([])
    mockPrisma.rawMaterialMovement.findMany.mockResolvedValue([])
    mockPrisma.staffVenue.findFirst.mockResolvedValue(null)

    tx = {
      shift: {
        updateMany: jest.fn(async (args: any) => {
          finalWrite = args
          return { count: 1 }
        }),
        findUnique: jest.fn(async () => ({ ...shift, ...finalWrite.data })),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(tx))
  })

  it('applies an entitled physical count as total drawer cash using Decimal end to end', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([payment('5000.00')])

    const result = await closeShiftForVenueWithResult(
      VENUE_ID,
      SHIFT_ID,
      { cashReconciliationAction: 'COUNTED', countedCash: '6000.00' },
      { actorStaffId: ACTOR_ID, ipAddress: '127.0.0.1', userAgent: 'jest' },
    )

    expect(mockAccess).toHaveBeenCalledWith(VENUE_ID)
    expect(finalWrite.data.endingCash.toString()).toBe('6000')
    expect(finalWrite.data.cashDeclared.toString()).toBe('6000')
    expect(finalWrite.data.cashDifference.toString()).toBe('0')
    expect(result.reconciliation).toEqual({ outcome: 'APPLIED', countedCash: '6000.00', cashDifference: '0.00' })
    expect(tx.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        staffId: ACTOR_ID,
        venueId: VENUE_ID,
        action: 'SHIFT_CLOSED',
        entity: 'Shift',
        entityId: SHIFT_ID,
        ipAddress: '127.0.0.1',
        userAgent: 'jest',
        data: expect.objectContaining({
          source: 'NEW',
          action: 'COUNTED',
          outcome: 'APPLIED',
          countedCash: '6000.00',
          expectedCash: '6000.00',
          cashDifference: '0.00',
        }),
      }),
    })
  })

  it('fails the additive feature closed without preventing the shift close', async () => {
    mockAccess.mockResolvedValue(false)
    mockPrisma.payment.findMany.mockResolvedValue([payment('5000.00')])

    const result = await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {
      cashReconciliationAction: 'COUNTED',
      countedCash: '6000.00',
    })

    expect(finalWrite.data.endingCash.toString()).toBe('5000')
    expect(finalWrite.data.cashDeclared).toBeNull()
    expect(finalWrite.data.cashDifference).toBeNull()
    expect(result.reconciliation).toEqual({ outcome: 'IGNORED_DISABLED', countedCash: '6000.00' })
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toEqual(
      expect.objectContaining({ outcome: 'IGNORED_DISABLED', ignoreReason: 'cash reconciliation is disabled' }),
    )
  })

  it('does not fall back to legacy cash when a higher-priority new action is invalid', async () => {
    const result = await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {
      cashReconciliationAction: 'COUNTED',
      countedCash: '1,000.00',
      cashDeclared: 999,
    })

    expect(mockAccess).not.toHaveBeenCalled()
    expect(finalWrite.data.cashDeclared).toBeNull()
    expect(finalWrite.data.cashDifference).toBeNull()
    expect(result.reconciliation.outcome).toBe('IGNORED_INVALID')
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toEqual(
      expect.objectContaining({ source: 'NEW', outcome: 'IGNORED_INVALID', ignoreReason: expect.any(String) }),
    )
  })

  it('records an intentional skip distinctly from an old client omission', async () => {
    const skipped = await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { cashReconciliationAction: 'SKIPPED' })
    expect(skipped.reconciliation).toEqual({ outcome: 'SKIPPED' })
    expect(finalWrite.data.cashDifference).toBeNull()
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toEqual(
      expect.objectContaining({ source: 'NEW', action: 'SKIPPED', outcome: 'SKIPPED' }),
    )
  })

  it('stores a valid count but leaves difference null when the calculated difference overflows Decimal(10,2)', async () => {
    shift = openShift({ startingCash: new Decimal('99999999.99') })
    mockPrisma.shift.findFirst.mockResolvedValue(shift)
    mockPrisma.payment.findMany.mockResolvedValue([payment('1.00')])

    const result = await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {
      cashReconciliationAction: 'COUNTED',
      countedCash: '0.00',
    })

    expect(finalWrite.data.endingCash.toString()).toBe('0')
    expect(finalWrite.data.cashDeclared.toString()).toBe('0')
    expect(finalWrite.data.cashDifference).toBeNull()
    expect(result.reconciliation).toEqual({ outcome: 'IGNORED_OVERFLOW', countedCash: '0.00' })
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toEqual(
      expect.objectContaining({
        outcome: 'IGNORED_OVERFLOW',
        countedCash: '0.00',
        expectedCash: '100000000.99',
        calculatedDifference: '-100000000.99',
        ignoreReason: 'cash difference exceeds Decimal(10,2)',
      }),
    )
  })

  it('keeps active Desktop/legacy declaration and SoftRestaurant semantics ungated', async () => {
    shift = openShift({
      startingCash: new Decimal('500.00'),
      externalId: 'soft-shift-1',
      venue: { posType: 'SOFTRESTAURANT', posStatus: 'CONNECTED', name: 'Legacy venue' },
    })
    mockPrisma.shift.findFirst.mockResolvedValue(shift)
    mockPrisma.payment.findMany.mockResolvedValue([payment('600.00')])

    const result = await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {
      cashDeclared: 700,
      cardDeclared: 25,
    })

    expect(mockAccess).not.toHaveBeenCalled()
    expect(finalWrite.data.endingCash.toString()).toBe('1200')
    expect(finalWrite.data.cashDeclared.toString()).toBe('700')
    // H0.6 must not retrofit reconciliation into the active Desktop declaration path.
    expect(finalWrite.data.cashDifference).toBeNull()
    expect(result.reconciliation.outcome).toBe('LEGACY_APPLIED')
    expect(publishCommand).toHaveBeenCalledTimes(1)
    expect(publishCommand).toHaveBeenCalledWith(
      `command.softrestaurant.${VENUE_ID}`,
      expect.objectContaining({ payload: expect.objectContaining({ shiftId: 'soft-shift-1', cashDeclared: 700, cardDeclared: 25 }) }),
    )
    expect((publishCommand as jest.Mock).mock.invocationCallOrder[0]).toBeGreaterThan(mockPrisma.$transaction.mock.invocationCallOrder[0])
  })

  it('does not invent a cash shortage for legacy metadata without a cash declaration', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([payment('600.00')])

    await closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, {
      notes: 'Cierre administrativo',
      cardDeclared: 25,
    })

    expect(finalWrite.data.cashDeclared).toBeNull()
    expect(finalWrite.data.cashDifference).toBeNull()
    expect(finalWrite.data.notes).toBe('Cierre administrativo')
  })
})

// ── Propina en efectivo dentro del arqueo (Fudo-parity) ──
//
// El billete de propina ENTRA físicamente al cajón junto con la venta, así que el
// efectivo esperado tiene que incluirlo o el cierre reporta un sobrante falso del
// tamaño de las propinas. El dueño cuenta, ve el desglose y reparte DESPUÉS: por eso
// no hace falta registrar un egreso.
//
// 🔴 El guard que importa: `totalCashPayments` es también la cifra de VENTAS en
// efectivo que consumen el MCP (`mcp/tools/shifts.ts`), `cashSales` del dashboard y
// `salesTotal`. Sumarle la propina ahí arreglaría el arqueo inflando las ventas.
// Son dos conceptos distintos y deben quedar separados.
describe('closeShiftForVenueWithResult — propina en efectivo en el arqueo', () => {
  let shift: ReturnType<typeof openShift>
  let tx: any
  let finalWrite: any

  const paymentWithTip = (amount: string, tip: string, method = 'CASH') => ({
    id: `payment-${amount}-${tip}-${method}`,
    amount: new Decimal(amount),
    tipAmount: new Decimal(tip),
    method,
  })

  const closeCounting = (countedCash: string) =>
    closeShiftForVenueWithResult(VENUE_ID, SHIFT_ID, { cashReconciliationAction: 'COUNTED', countedCash }, { actorStaffId: ACTOR_ID })

  beforeEach(() => {
    jest.clearAllMocks()
    shift = openShift()
    finalWrite = undefined
    mockAccess.mockResolvedValue(true)
    mockPrisma.shift.findFirst.mockResolvedValue(shift)
    mockPrisma.shift.updateMany.mockResolvedValue({ count: 1 })
    mockPrisma.shift.update.mockResolvedValue({ ...shift, endTime: new Date(), status: 'CLOSED' })
    mockPrisma.payment.findMany.mockResolvedValue([])
    mockPrisma.orderItem.findMany.mockResolvedValue([])
    mockPrisma.rawMaterialMovement.findMany.mockResolvedValue([])
    mockPrisma.staffVenue.findFirst.mockResolvedValue(null)

    tx = {
      shift: {
        updateMany: jest.fn(async (args: any) => {
          finalWrite = args
          return { count: 1 }
        }),
        findUnique: jest.fn(async () => ({ ...shift, ...finalWrite.data })),
      },
      activityLog: { create: jest.fn().mockResolvedValue({ id: 'audit-1' }) },
    }
    mockPrisma.$transaction.mockImplementation(async (callback: any) => callback(tx))
  })

  it('cuenta la propina en efectivo dentro del efectivo esperado', async () => {
    // Venta $5,000 + propina $500 en efectivo, fondo $1,000 → en el cajón hay $6,500.
    mockPrisma.payment.findMany.mockResolvedValue([paymentWithTip('5000.00', '500.00')])

    const result = await closeShiftForVenueWithResult(
      VENUE_ID,
      SHIFT_ID,
      { cashReconciliationAction: 'COUNTED', countedCash: '6500.00' },
      { actorStaffId: ACTOR_ID, ipAddress: '127.0.0.1', userAgent: 'jest' },
    )

    expect(result.reconciliation).toEqual({ outcome: 'APPLIED', countedCash: '6500.00', cashDifference: '0.00' })
    expect(finalWrite.data.cashDifference.toString()).toBe('0')
    expect(tx.activityLog.create.mock.calls[0][0].data.data).toEqual(
      expect.objectContaining({ expectedCash: '6500.00', cashDifference: '0.00' }),
    )
  })

  it('NO infla las ventas en efectivo con la propina (guard del reporte)', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([paymentWithTip('5000.00', '500.00')])

    await closeCounting('6500.00')

    // La venta sigue siendo $5,000: es lo que consumen MCP, cashSales y salesTotal.
    expect(finalWrite.data.totalCashPayments.toString()).toBe('5000')
    expect(finalWrite.data.totalSales.toString()).toBe('5000')
    expect(finalWrite.data.totalTips.toString()).toBe('500')
  })

  it('la propina de TARJETA no entra al cajón', async () => {
    // El dinero de la propina con tarjeta llega por el depósito del banco, no al cajón.
    mockPrisma.payment.findMany.mockResolvedValue([paymentWithTip('5000.00', '500.00', 'CREDIT_CARD')])

    const result = await closeCounting('1000.00')

    expect(result.reconciliation).toEqual({ outcome: 'APPLIED', countedCash: '1000.00', cashDifference: '0.00' })
  })

  it('mezcla efectivo y tarjeta: sólo la propina en efectivo mueve el cajón', async () => {
    mockPrisma.payment.findMany.mockResolvedValue([
      paymentWithTip('5000.00', '500.00'),
      paymentWithTip('2000.00', '300.00', 'CREDIT_CARD'),
    ])

    // Cajón = fondo 1000 + venta efectivo 5000 + propina efectivo 500 = 6500.
    const result = await closeCounting('6500.00')

    expect(result.reconciliation).toEqual({ outcome: 'APPLIED', countedCash: '6500.00', cashDifference: '0.00' })
    expect(finalWrite.data.totalCashPayments.toString()).toBe('5000')
  })
})
