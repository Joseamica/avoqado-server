// El guard de ventas por sucursal (venueSalesGuard) NO es el objeto de esta suite:
// se prueba en tests/unit/services/venueSalesGuard.test.ts. Sin este mock, cada
// servicio de venta consulta venue.salesEnabled contra un prismaMock que no lo define.
jest.mock('@/services/venueSalesGuard', () => ({
  __esModule: true,
  assertVenueSalesEnabled: jest.fn(),
}))

import { Prisma } from '@prisma/client'

// ── Mocks ──────────────────────────────────────────────────────────────────
// prismaClient: bulkManualSales' preview path calls the resolvers directly
// with the BASE client as the `tx` arg (read-only findFirst/findMany — no
// $transaction needed for a dry preview).
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    $transaction: jest.fn(),
    serializedItemCustodyEvent: { create: jest.fn() },
  },
}))

// Resolvers (Task 3) — used directly by the PREVIEW path.
const resolveIccidMock = jest.fn()
const resolveVenueMock = jest.fn()
const resolveStaffByCodeMock = jest.fn()
const resolveCategoryMock = jest.fn()
const mapPaymentFormMock = jest.fn()
const parseAmountMock = jest.fn()
jest.mock('@/services/dashboard/manualSale.resolvers', () => ({
  __esModule: true,
  resolveIccid: (...a: any[]) => resolveIccidMock(...a),
  resolveVenue: (...a: any[]) => resolveVenueMock(...a),
  resolveStaffByCode: (...a: any[]) => resolveStaffByCodeMock(...a),
  resolveCategory: (...a: any[]) => resolveCategoryMock(...a),
  mapPaymentForm: (...a: any[]) => mapPaymentFormMock(...a),
  parseAmount: (...a: any[]) => parseAmountMock(...a),
}))

// serializedInventoryService.markAsSold — hit via the REAL createOneManualSale
// during apply tests.
const markAsSoldMock = jest.fn()
jest.mock('@/services/serialized-inventory/serializedInventory.service', () => ({
  __esModule: true,
  serializedInventoryService: {
    markAsSold: (...a: any[]) => markAsSoldMock(...a),
  },
}))

// logAction — fire-and-forget audit; only relevant via createOneManualSale.
jest.mock('@/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

// createOneManualSale (Task 4) lives in the SAME file as bulkManualSales
// (both exported from manualSale.service.ts). Under commonjs + ts-jest, a
// same-module function-to-function call compiles to a direct local
// reference, NOT `exports.createOneManualSale(...)` — so `jest.spyOn` on the
// imported module object would silently fail to intercept it. Instead of
// spying, we drive createOneManualSale's REAL implementation through the
// same resolver + $transaction mocks already set up above (mirrors
// manualSale.service.test.ts) — this also exercises the real integration
// between the two, which is arguably the more honest test.
import { bulkManualSales } from '@/services/dashboard/manualSale.service'
import prisma from '@/utils/prismaClient'
import type { ManualSaleRowInput } from '@/schemas/dashboard/manualSale.schema'

const prismaMock = prisma as jest.Mocked<typeof prisma>

/** Build a fresh tx-client mock whose create() calls return stable ids (mirrors manualSale.service.test.ts). */
function makeTxClient() {
  return {
    order: { create: jest.fn().mockResolvedValue({ id: 'order-1' }) },
    orderItem: { create: jest.fn().mockResolvedValue({ id: 'orderitem-1' }) },
    payment: { create: jest.fn().mockResolvedValue({ id: 'payment-1' }) },
    saleVerification: { create: jest.fn().mockResolvedValue({ id: 'verification-1' }) },
  }
}

/** Wire $transaction to run the callback against a fresh tx client every call (one tx per row). */
function wireTxPerCall() {
  ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(makeTxClient()))
}

const ORG_ID = 'org-1'
const ACTOR_STAFF_ID = 'actor-staff-1'

function row(overrides: Partial<ManualSaleRowInput> = {}): ManualSaleRowInput {
  return {
    iccid: '8952140064323812041F',
    promoterCode: 'P123',
    promoterName: 'Ana López',
    storeId: '898',
    storeName: 'BAE MUÑOZ SLP (898)',
    saleDate: '2026-04-24',
    saleType: 'Línea nueva',
    paymentForm: 'Efectivo',
    amount: 150,
    simType: 'SIM de Evento',
    ...overrides,
  }
}

/** Happy-path resolver stubs: every resolver resolves cleanly (used by PREVIEW tests). */
function stubResolversHappy() {
  resolveIccidMock.mockResolvedValue({
    item: { id: 'sim-1', serialNumber: '8952140064323812041F', categoryId: 'cat-1' },
  })
  resolveVenueMock.mockResolvedValue({
    venue: { id: 'store-venue-1', name: 'BAE MUÑOZ SLP', slug: 'bae-munoz-slp' },
  })
  resolveStaffByCodeMock.mockResolvedValue({
    staff: { id: 'seller-staff-1', firstName: 'Ana', lastName: 'López', employeeCode: 'P123' },
  })
  resolveCategoryMock.mockResolvedValue({ categoryId: 'cat-1' })
  mapPaymentFormMock.mockReturnValue({ method: 'CASH', amountApplies: true })
  parseAmountMock.mockReturnValue(new Prisma.Decimal(150))
}

describe('manualSale.service — bulkManualSales', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    markAsSoldMock.mockResolvedValue({ item: { id: 'sim-1', serialNumber: '8952140064323812041F' } })
  })

  // ── PREVIEW (apply=false) ──────────────────────────────────────────────
  describe('preview (apply=false)', () => {
    it('classifies an available ICCID into crear', async () => {
      stubResolversHappy()

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, [row()], false)

      expect(result.crear).toEqual([{ index: 0, iccid: '8952140064323812041F', storeName: 'BAE MUÑOZ SLP (898)' }])
      expect(result.omitir).toEqual([])
      expect(result.error).toEqual([])
      expect(result.created).toBeUndefined()
    })

    it('classifies an already-sold ICCID into omitir', async () => {
      stubResolversHappy()
      resolveIccidMock.mockResolvedValue({ error: 'ICCID ya vendido' })

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, [row()], false)

      expect(result.omitir).toEqual([
        { index: 0, iccid: '8952140064323812041F', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'ICCID ya vendido' },
      ])
      expect(result.crear).toEqual([])
      expect(result.error).toEqual([])
    })

    it('classifies a missing-seller row into error', async () => {
      stubResolversHappy()
      resolveStaffByCodeMock.mockResolvedValue({ error: 'Vendedor no encontrado' })

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, [row()], false)

      expect(result.error).toEqual([
        { index: 0, iccid: '8952140064323812041F', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'Vendedor no encontrado' },
      ])
      expect(result.crear).toEqual([])
      expect(result.omitir).toEqual([])
    })

    it('does not write anything during preview (resolvers are called, no tx/create)', async () => {
      stubResolversHappy()

      await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, [row()], false)

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(resolveIccidMock).toHaveBeenCalledTimes(1)
      // Resolvers are called with the base prisma client as the tx arg (read-only).
      expect(resolveIccidMock).toHaveBeenCalledWith(ORG_ID, '8952140064323812041F', prismaMock)
    })
  })

  // ── APPLY (apply=true) ─────────────────────────────────────────────────
  // Drives the REAL createOneManualSale (Task 4) through the resolver +
  // $transaction mocks — see the comment above the import for why we don't
  // spy on the same-module export.
  describe('apply (apply=true)', () => {
    it('creates 2 good rows + 1 sold row: created=2, omitir.length=1, good rows unaffected by the bad one', async () => {
      wireTxPerCall()
      // Resolver stubs happy by default; the middle row's ICCID resolver fails
      // (per-call override) to simulate an already-sold SIM.
      resolveVenueMock.mockResolvedValue({ venue: { id: 'venue-1', name: 'BAE MUÑOZ SLP', slug: 'bae', timezone: 'America/Mexico_City' } })
      resolveStaffByCodeMock.mockResolvedValue({ staff: { id: 'seller-1', firstName: 'Ana', lastName: 'López', employeeCode: 'P123' } })
      resolveCategoryMock.mockResolvedValue({ categoryId: 'cat-1' })
      mapPaymentFormMock.mockReturnValue({ method: 'CASH', amountApplies: true })
      parseAmountMock.mockReturnValue(new Prisma.Decimal(150))
      resolveIccidMock
        .mockResolvedValueOnce({ item: { id: 'sim-1', serialNumber: 'ICCID-GOOD-1', categoryId: 'cat-1' } })
        .mockResolvedValueOnce({ error: 'ICCID ya vendido' })
        .mockResolvedValueOnce({ item: { id: 'sim-3', serialNumber: 'ICCID-GOOD-2', categoryId: 'cat-1' } })

      const rows = [row({ iccid: 'ICCID-GOOD-1' }), row({ iccid: 'ICCID-SOLD-1' }), row({ iccid: 'ICCID-GOOD-2' })]

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, rows, true)

      expect(result.created).toBe(2)
      expect(result.crear).toEqual([
        { index: 0, iccid: 'ICCID-GOOD-1', storeName: 'BAE MUÑOZ SLP (898)' },
        { index: 2, iccid: 'ICCID-GOOD-2', storeName: 'BAE MUÑOZ SLP (898)' },
      ])
      expect(result.omitir).toEqual([{ index: 1, iccid: 'ICCID-SOLD-1', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'ICCID ya vendido' }])
      expect(result.error).toEqual([])
      // Each row opened its OWN $transaction (one bad row did not stop the others).
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(3)
    })

    it('routes a non-"ICCID ya vendido" failure into error (not omitir)', async () => {
      wireTxPerCall()
      stubResolversHappy()
      resolveVenueMock.mockResolvedValue({ error: 'Tienda no encontrada' })

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, [row()], true)

      expect(result.error).toEqual([
        { index: 0, iccid: '8952140064323812041F', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'Tienda no encontrada' },
      ])
      expect(result.omitir).toEqual([])
      expect(result.crear).toEqual([])
      expect(result.created).toBe(0)
    })

    it('does not wrap the per-row apply loop in one shared top-level $transaction', async () => {
      const calls: unknown[] = []
      ;(prismaMock.$transaction as jest.Mock).mockImplementation(async (cb: any) => {
        calls.push(cb)
        return cb(makeTxClient())
      })
      stubResolversHappy()

      await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, [row({ iccid: 'ICCID-1' }), row({ iccid: 'ICCID-2' })], true)

      // bulkManualSales itself must never open its own OUTER $transaction that
      // wraps both rows — each row gets its own INDEPENDENT $transaction call
      // (owned entirely by createOneManualSale, Task 4), so a failure in row 1
      // can never roll back row 2. Two rows → exactly two separate calls.
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(2)
    })
  })

  // ── DEDUP (shared by preview + apply) ──────────────────────────────────
  describe('dedup by normalized ICCID', () => {
    it('preview: second occurrence of a duplicate ICCID (case/whitespace-insensitive) is omitted, motivo duplicado', async () => {
      stubResolversHappy()

      const rows = [row({ iccid: '  abc123  ' }), row({ iccid: 'ABC123', storeName: 'Other Store' })]

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, rows, false)

      // First occurrence (index 0) goes through the normal resolver classification.
      expect(result.crear).toEqual([{ index: 0, iccid: '  abc123  ', storeName: 'BAE MUÑOZ SLP (898)' }])
      // Second occurrence (index 1) is omitted for being a duplicate — never resolved.
      expect(result.omitir).toEqual([{ index: 1, iccid: 'ABC123', storeName: 'Other Store', motivo: 'ICCID duplicado en el archivo' }])
      // Resolvers ran exactly once — for the kept (first) row only.
      expect(resolveIccidMock).toHaveBeenCalledTimes(1)
    })

    it('apply: second occurrence of a duplicate ICCID is omitted, motivo duplicado, and createOneManualSale runs once', async () => {
      wireTxPerCall()
      stubResolversHappy()

      const rows = [row({ iccid: 'dup-1' }), row({ iccid: 'DUP-1' })]

      const result = await bulkManualSales(ORG_ID, ACTOR_STAFF_ID, rows, true)

      expect(result.created).toBe(1)
      expect(result.omitir).toEqual([
        { index: 1, iccid: 'DUP-1', storeName: 'BAE MUÑOZ SLP (898)', motivo: 'ICCID duplicado en el archivo' },
      ])
      // Only ONE row reached createOneManualSale → only one $transaction opened.
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
    })
  })
})
