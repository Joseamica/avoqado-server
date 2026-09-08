/**
 * Real PostgreSQL proof for StockCount revision serialization.
 *
 * This suite accepts only a caller-provided local database whose name contains
 * "test". It creates one isolated organization/venue and count ids namespaced
 * by this process, never migrates or resets the database, and removes only its
 * own rows.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { cancelStockCount, confirmStockCount, updateStockCount } from '@/services/mobile/inventory.mobile.service'

const fixtureKey = `${process.pid}-${Date.now()}-stock-count-revision`
const organizationId = `stock-revision-org-${fixtureKey}`
const venueId = `stock-revision-venue-${fixtureKey}`
const staffId = `stock-revision-staff-${fixtureKey}`
const countPrefix = `stock-revision-count-${fixtureKey}`
const productPrefix = `stock-revision-product-${fixtureKey}`
let fixtureCreated = false
let countSequence = 0
let productSequence = 0
let categoryId: string

type StoredCount = {
  id: string
  status: 'IN_PROGRESS' | 'APPLYING' | 'COMPLETED' | 'CANCELLED'
  revision: number
  note: string | null
}

type StoredLine = {
  counted: unknown
  countedAt: Date | null
  appliedAt: Date | null
}

function assertDisposableTestDatabase(): void {
  const declared = new URL(process.env.TEST_DATABASE_URL ?? '')
  const effective = new URL(process.env.DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(declared.hostname)
  expect(declared.pathname.toLowerCase()).toContain('test')
  expect(effective.toString()).toBe(declared.toString())
}

async function createCount(): Promise<string> {
  countSequence += 1
  const id = `${countPrefix}-${countSequence}`
  await prisma.stockCount.create({ data: { id, venueId, type: 'FULL', status: 'IN_PROGRESS' } })
  return id
}

async function createCountWithProductLine(initialStock = 3): Promise<{ countId: string; lineId: string; inventoryId: string }> {
  productSequence += 1
  const productId = `${productPrefix}-${productSequence}`
  const product = await prisma.product.create({
    data: {
      id: productId,
      venueId,
      categoryId,
      name: `Revision product ${productSequence}`,
      sku: `revision-sku-${fixtureKey}-${productSequence}`,
      price: new Prisma.Decimal(100),
      trackInventory: true,
      inventoryMethod: 'QUANTITY',
    },
  })
  const inventory = await prisma.inventory.create({
    data: { productId: product.id, venueId, currentStock: new Prisma.Decimal(initialStock) },
  })
  countSequence += 1
  const countId = `${countPrefix}-${countSequence}`
  const count = await prisma.stockCount.create({
    data: {
      id: countId,
      venueId,
      type: 'CYCLE',
      status: 'IN_PROGRESS',
      note: 'before',
      items: { create: { productId: product.id, expected: new Prisma.Decimal(initialStock), counted: new Prisma.Decimal(0) } },
    },
    include: { items: { select: { id: true } } },
  })
  return { countId, lineId: count.items[0].id, inventoryId: inventory.id }
}

async function readCount(id: string): Promise<StoredCount> {
  const rows = await prisma.$queryRaw<StoredCount[]>(Prisma.sql`
    SELECT id, status, revision, note
    FROM "StockCount"
    WHERE id = ${id} AND "venueId" = ${venueId}
  `)
  if (rows.length !== 1) throw new Error(`Expected one StockCount row for ${id}`)
  return rows[0]
}

async function readLine(id: string): Promise<StoredLine> {
  const rows = await prisma.$queryRaw<StoredLine[]>(Prisma.sql`
    SELECT counted, "countedAt", "appliedAt"
    FROM "StockCountItem"
    WHERE id = ${id}
  `)
  if (rows.length !== 1) throw new Error(`Expected one StockCountItem row for ${id}`)
  return rows[0]
}

// 🔴 NO es genérica a propósito. `Promise.allSettled([put, cancel])` produce una tupla de
// resultados con tipos de valor DISTINTOS, y ahí TypeScript no puede inferir una sola `T`:
// el typecheck reventaba con TS2769 sobre `settled.filter(fulfilled)`. Ningún sitio de
// llamada usa el valor ya estrechado —sólo cuenta cuántos ganaron—, así que `unknown`
// alcanza, y deja esta guarda igual que `revisionConflict` y `staleOrApplying`.
function fulfilled(result: PromiseSettledResult<unknown>): result is PromiseFulfilledResult<unknown> {
  return result.status === 'fulfilled'
}

function revisionConflict(result: PromiseSettledResult<unknown>): boolean {
  if (result.status !== 'rejected') return false
  const error = result.reason as { statusCode?: number; code?: string }
  return error.statusCode === 409 && error.code === 'INVENTORY_COUNT_REVISION_CONFLICT'
}

function staleOrApplying(result: PromiseSettledResult<unknown>): boolean {
  if (result.status !== 'rejected') return false
  const error = result.reason as { statusCode?: number; code?: string }
  return error.statusCode === 409 && (error.code === 'INVENTORY_COUNT_REVISION_CONFLICT' || error.code === 'STOCK_COUNT_APPLYING')
}

beforeAll(async () => {
  assertDisposableTestDatabase()
  const columns = await prisma.$queryRaw<Array<{ columnName: string }>>(Prisma.sql`
    SELECT column_name AS "columnName"
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = 'StockCount'
      AND column_name = 'revision'
  `)
  if (columns.length !== 1) throw new Error('STOCK_COUNT_REVISION_SCHEMA_GATE: disposable test DB is missing StockCount.revision')

  await prisma.organization.create({
    data: {
      id: organizationId,
      name: `Stock revision ${fixtureKey}`,
      email: `stock-revision-${fixtureKey}@example.test`,
      phone: '5500000000',
    },
  })
  fixtureCreated = true
  await prisma.venue.create({
    data: {
      id: venueId,
      organizationId,
      name: `Stock revision ${fixtureKey}`,
      slug: `stock-revision-${fixtureKey}`,
      timezone: 'America/Mexico_City',
      currency: 'MXN',
    },
  })
  await prisma.staff.create({
    data: { id: staffId, email: `stock-revision-staff-${fixtureKey}@example.test`, firstName: 'Stock', lastName: 'Revision' },
  })
  const category = await prisma.menuCategory.create({
    data: { venueId, name: `Revision category ${fixtureKey}`, slug: `revision-category-${fixtureKey}` },
  })
  categoryId = category.id
})

afterAll(async () => {
  if (!fixtureCreated) return
  assertDisposableTestDatabase()
  await prisma.stockCount.deleteMany({ where: { id: { startsWith: countPrefix }, venueId } })
  await prisma.inventoryMovement.deleteMany({ where: { inventory: { venueId } } })
  await prisma.inventory.deleteMany({ where: { venueId } })
  await prisma.product.deleteMany({ where: { id: { startsWith: productPrefix }, venueId } })
  await prisma.menuCategory.deleteMany({ where: { id: categoryId, venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId, organizationId } })
  await prisma.organization.deleteMany({ where: { id: organizationId } })
  await prisma.staff.deleteMany({ where: { id: staffId } })
})

describe('StockCount revision — real PostgreSQL concurrency', () => {
  describe('new revision behavior', () => {
    it('keeps a real A=5/B=8 line, note, revision, and confirmed stock from the same winning snapshot', async () => {
      const { countId, lineId, inventoryId } = await createCountWithProductLine()
      const settled = await Promise.allSettled([
        updateStockCount(countId, venueId, [{ id: lineId, counted: 5 }], 'writer-a', 0),
        updateStockCount(countId, venueId, [{ id: lineId, counted: 8 }], 'writer-b', 0),
      ])

      expect(settled.filter(fulfilled)).toHaveLength(1)
      expect(settled.filter(revisionConflict)).toHaveLength(1)
      const winnerIndex = settled.findIndex(fulfilled)
      expect(settled[winnerIndex]).toMatchObject({ status: 'fulfilled', value: { success: true, revision: 1 } })
      await expect(readCount(countId)).resolves.toMatchObject({
        status: 'IN_PROGRESS',
        revision: 1,
        note: winnerIndex === 0 ? 'writer-a' : 'writer-b',
      })
      const winningCounted = winnerIndex === 0 ? 5 : 8
      const winningLine = await readLine(lineId)
      expect(Number(winningLine.counted)).toBe(winningCounted)
      expect(winningLine.countedAt).toBeInstanceOf(Date)

      await expect(confirmStockCount(countId, venueId, staffId, 1)).resolves.toEqual({ success: true, revision: 2 })
      const inventory = await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      expect(Number(inventory.currentStock)).toBe(winningCounted)
      await expect(readCount(countId)).resolves.toMatchObject({ status: 'COMPLETED', revision: 2 })
      await expect(readLine(lineId)).resolves.toMatchObject({ appliedAt: expect.any(Date) })
    })

    it('rejects deterministic stale A after B stores 8, without changing B line, note, or stock', async () => {
      const { countId, lineId, inventoryId } = await createCountWithProductLine()

      await expect(updateStockCount(countId, venueId, [{ id: lineId, counted: 8 }], 'writer-b', 0)).resolves.toEqual({
        success: true,
        revision: 1,
      })
      await expect(updateStockCount(countId, venueId, [{ id: lineId, counted: 5 }], 'writer-a', 0)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: expect.objectContaining({ expectedRevision: 0, currentRevision: 1, status: 'IN_PROGRESS' }),
      })
      await expect(confirmStockCount(countId, venueId, staffId, 0)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: expect.objectContaining({ expectedRevision: 0, currentRevision: 1, status: 'IN_PROGRESS' }),
      })

      await expect(readCount(countId)).resolves.toMatchObject({ status: 'IN_PROGRESS', revision: 1, note: 'writer-b' })
      const storedLine = await readLine(lineId)
      expect(Number(storedLine.counted)).toBe(8)
      expect(storedLine.countedAt).toBeInstanceOf(Date)
      const inventory = await prisma.inventory.findUniqueOrThrow({ where: { id: inventoryId } })
      expect(Number(inventory.currentStock)).toBe(3)
    })

    it('serializes PUT against confirm so a stale snapshot never also completes', async () => {
      const { countId, lineId } = await createCountWithProductLine()
      const settled = await Promise.allSettled([
        updateStockCount(countId, venueId, [{ id: lineId, counted: 5 }], 'put-winner-if-first', 0),
        confirmStockCount(countId, venueId, staffId, 0),
      ])

      expect(settled.filter(fulfilled)).toHaveLength(1)
      // If PUT waits behind the APPLYING claim it receives the retryable domain
      // conflict; if it observes the final COMPLETED row it receives revision
      // conflict. Both prove that it never mutates the claimed snapshot.
      expect(settled.filter(staleOrApplying)).toHaveLength(1)
      const stored = await readCount(countId)
      expect(stored.revision).toBe(1)
      if (settled[0].status === 'fulfilled') {
        expect(stored).toMatchObject({ status: 'IN_PROGRESS', note: 'put-winner-if-first' })
      } else {
        expect(stored).toMatchObject({ status: 'COMPLETED', note: 'before' })
      }
    })

    it('rolls back the line, note, countedAt, and revision when the aggregate revision write is lost', async () => {
      const { countId, lineId } = await createCountWithProductLine()
      const maxRevision = 2_147_483_647
      await prisma.$executeRaw(Prisma.sql`
        UPDATE "StockCount"
        SET revision = ${maxRevision}
        WHERE id = ${countId} AND "venueId" = ${venueId}
      `)

      await expect(updateStockCount(countId, venueId, [{ id: lineId, counted: 8 }], 'must-roll-back', maxRevision)).rejects.toThrow()

      await expect(readCount(countId)).resolves.toMatchObject({ status: 'IN_PROGRESS', revision: maxRevision, note: 'before' })
      const rolledBackLine = await readLine(lineId)
      expect(Number(rolledBackLine.counted)).toBe(0)
      expect(rolledBackLine).toMatchObject({ countedAt: null, appliedAt: null })
    })

    it('serializes PUT against cancel so only one transition from the same base wins', async () => {
      const countId = await createCount()
      const settled = await Promise.allSettled([
        updateStockCount(countId, venueId, [], 'put-winner-if-first', 0),
        cancelStockCount(countId, venueId, staffId, 0),
      ])

      expect(settled.filter(fulfilled)).toHaveLength(1)
      expect(settled.filter(revisionConflict)).toHaveLength(1)
      const stored = await readCount(countId)
      expect(stored.revision).toBe(1)
      expect(stored.status).toBe(settled[0].status === 'fulfilled' ? 'IN_PROGRESS' : 'CANCELLED')
    })

    it('accepts exactly one lost confirm retry and rejects a later +2 state', async () => {
      const countId = await createCount()
      await expect(confirmStockCount(countId, venueId, staffId, 0)).resolves.toEqual({ success: true, revision: 1 })
      await expect(confirmStockCount(countId, venueId, staffId, 0)).resolves.toEqual({ success: true, revision: 1 })

      await prisma.$executeRaw(Prisma.sql`
        UPDATE "StockCount"
        SET revision = revision + 1
        WHERE id = ${countId} AND "venueId" = ${venueId}
      `)
      await expect(confirmStockCount(countId, venueId, staffId, 0)).rejects.toMatchObject({
        statusCode: 409,
        code: 'INVENTORY_COUNT_REVISION_CONFLICT',
        details: expect.objectContaining({ expectedRevision: 0, currentRevision: 2, status: 'COMPLETED' }),
      })
    })
  })

  describe('regression behavior', () => {
    it('keeps legacy PUT last-write-wins while incrementing every accepted write', async () => {
      const countId = await createCount()
      await expect(updateStockCount(countId, venueId, [], 'legacy-a')).resolves.toEqual({ success: true, revision: 1 })
      await expect(updateStockCount(countId, venueId, [], 'legacy-b')).resolves.toEqual({ success: true, revision: 2 })
      await expect(readCount(countId)).resolves.toMatchObject({ status: 'IN_PROGRESS', revision: 2, note: 'legacy-b' })
    })
  })
})
