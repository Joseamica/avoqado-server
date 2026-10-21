/**
 * clearTable's ActivityLog coverage (Plan B Task 6 — lockstep verification,
 * 2026-07-27).
 *
 * "Liberar mesa" is one of the anomalies the audit trail is supposed to catch
 * (alongside comp/discount/cancel), and it reaches this same function from
 * THREE callers: the online `/tpv` controller, the online `/mobile` controller,
 * and the offline sync reducer replaying a queued CLEAR_TABLE intent. Before
 * this change none of the three wrote an `ActivityLog` row — an owner
 * auditing a shift after a Wi-Fi outage would see nothing for every table a
 * POS freed while offline. Fixed at the service layer (not the frozen
 * `/mobile` controller or the frozen offline reducer) so all three callers
 * inherit it; `performedBy` is optional so the two frozen callers — which
 * cannot be edited to pass the actor — still get an audited row, just with
 * `staffId: null` instead of zero visibility.
 */
import { clearTable } from '../../../../src/services/tpv/table.tpv.service'
import { BadRequestError, NotFoundError } from '../../../../src/errors/AppError'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    table: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn() },
    order: { findMany: jest.fn(), findFirst: jest.fn() },
    $queryRaw: jest.fn(),
    $transaction: jest.fn(),
  },
}))
jest.mock('../../../../src/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null) },
}))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '../../../../src/utils/prismaClient'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'

const mockedPrisma = prisma as unknown as {
  table: { findFirst: jest.Mock; findMany: jest.Mock; update: jest.Mock }
  order: { findMany: jest.Mock; findFirst: jest.Mock }
  $queryRaw: jest.Mock
  $transaction: jest.Mock
}
const mockedLogAction = logAction as jest.Mock

describe('table.tpv.service — clearTable ActivityLog', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockedPrisma.table.findFirst.mockResolvedValue(null)
    mockedPrisma.order.findMany.mockResolvedValue([])
    mockedPrisma.$transaction.mockImplementation(async callback => callback(mockedPrisma))
    mockedPrisma.table.findMany.mockImplementation(async () => {
      const row = await mockedPrisma.table.findFirst.getMockImplementation()?.()
      return row ? [{ status: 'OCCUPIED', ...row }] : []
    })
    mockedPrisma.order.findFirst.mockImplementation(async () => {
      const rows = await mockedPrisma.order.findMany.getMockImplementation()?.()
      return rows?.find((row: { paymentStatus: string }) => row.paymentStatus !== 'PAID') ?? null
    })
    mockedPrisma.$queryRaw.mockImplementation(async (query: unknown) => {
      const sql = Array.isArray(query)
        ? query.join(' ')
        : query && typeof query === 'object' && 'strings' in query && Array.isArray(query.strings)
          ? query.strings.join(' ')
          : ''
      if (sql.includes('FROM "Venue"')) return [{ id: 'venue-1' }]
      if (sql.includes('FROM "Order"')) {
        const rows = await mockedPrisma.order.findMany.getMockImplementation()?.()
        return rows.map((row: { id: string }) => ({ id: row.id }))
      }
      if (sql.includes('FROM "Table"')) return [{ id: 'table-1' }]
      throw new Error('Unexpected clear-table topology SQL')
    })
  })

  const table = { id: 'table-1', number: '12', status: 'OCCUPIED', currentOrderId: 'order-1' }

  // ── NEW: ActivityLog coverage ────────────────────────────────────────────

  it('writes a TABLE_CLEARED ActivityLog row attributed to performedBy when the caller has one (online /tpv path)', async () => {
    mockedPrisma.table.findFirst.mockResolvedValue(table)
    mockedPrisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        tableId: 'table-1',
        status: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        orderNumber: 'ORD-1',
        paymentStatus: 'PAID',
      },
    ])
    mockedPrisma.table.update.mockResolvedValue({ ...table, status: 'AVAILABLE', currentOrderId: null })

    await clearTable('venue-1', 'table-1', 'staff-99')

    expect(mockedLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'TABLE_CLEARED',
        entity: 'Table',
        entityId: 'table-1',
        staffId: 'staff-99',
        venueId: 'venue-1',
      }),
    )
  })

  it('still writes the ActivityLog row (staffId: null) when no performedBy is available — the offline reducer and the frozen /mobile controller cannot pass one, but the mutation must not go unaudited', async () => {
    mockedPrisma.table.findFirst.mockResolvedValue(table)
    mockedPrisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        tableId: 'table-1',
        status: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        orderNumber: 'ORD-1',
        paymentStatus: 'PAID',
      },
    ])
    mockedPrisma.table.update.mockResolvedValue({ ...table, status: 'AVAILABLE', currentOrderId: null })

    await clearTable('venue-1', 'table-1')

    expect(mockedLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'TABLE_CLEARED', staffId: null }))
  })

  it('does NOT write ActivityLog when the clear is rejected (unpaid order) — no mutation happened', async () => {
    mockedPrisma.table.findFirst.mockResolvedValue(table)
    mockedPrisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        tableId: 'table-1',
        status: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        orderNumber: 'ORD-1',
        paymentStatus: 'PENDING',
      },
    ])

    await expect(clearTable('venue-1', 'table-1', 'staff-99')).rejects.toThrow(BadRequestError)
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  // ── REGRESSION: existing clearTable business rules untouched ────────────

  it('regression: still throws NotFoundError when the table does not belong to the venue', async () => {
    mockedPrisma.table.findFirst.mockResolvedValue(null)

    await expect(clearTable('venue-1', 'ghost-table')).rejects.toThrow(NotFoundError)
    expect(mockedLogAction).not.toHaveBeenCalled()
  })

  it('regression: still blocks clearing while ANY open order on the table is unpaid (multi-cheque)', async () => {
    mockedPrisma.table.findFirst.mockResolvedValue(table)
    mockedPrisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        tableId: 'table-1',
        status: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        orderNumber: 'ORD-1',
        paymentStatus: 'PAID',
      },
      {
        id: 'order-2',
        tableId: 'table-1',
        status: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        orderNumber: 'ORD-2',
        paymentStatus: 'PARTIAL',
      },
    ])

    await expect(clearTable('venue-1', 'table-1', 'staff-99')).rejects.toThrow('Cannot clear table with unpaid order ORD-2')
  })

  it('regression: still marks the table AVAILABLE and clears currentOrderId when every open order is paid', async () => {
    mockedPrisma.table.findFirst.mockResolvedValue(table)
    mockedPrisma.order.findMany.mockResolvedValue([
      {
        id: 'order-1',
        tableId: 'table-1',
        status: 'PENDING',
        createdAt: new Date('2026-10-01T00:00:00Z'),
        orderNumber: 'ORD-1',
        paymentStatus: 'PAID',
      },
    ])
    mockedPrisma.table.update.mockResolvedValue({ ...table, status: 'AVAILABLE', currentOrderId: null })

    await clearTable('venue-1', 'table-1', 'staff-99')

    expect(mockedPrisma.table.update).toHaveBeenCalledWith({
      where: { id: 'table-1' },
      data: { status: 'AVAILABLE', currentOrderId: null },
    })
  })
})
