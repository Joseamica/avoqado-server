import { SerializedInventoryService } from '../../../../src/services/serialized-inventory/serializedInventory.service'
import type { PrismaClient } from '@prisma/client'

/**
 * Regression (2026-06-09, found via MCP write QA): markAsReturned/markAsDamaged
 * normalized the serial to UPPERCASE and updated by the unique (venueId,serial)
 * key, so legacy LOWER-cased items (the codebase notes "a handful are stored
 * lower-cased") could never be returned/damaged — update hit no record. The
 * search path already matched case variants; these mutators now do too.
 */
describe('markAsReturned / markAsDamaged — legacy lower-cased serials', () => {
  it('resolves a lower-cased stored serial via case variants and updates that exact record', async () => {
    const stored = '8952140064023736359f' // legacy lower-cased row
    const findFirst = jest.fn().mockResolvedValue({ serialNumber: stored })
    const update = jest.fn().mockResolvedValue({ id: 'it1', serialNumber: stored, status: 'RETURNED' })
    const db = { serializedItem: { findFirst, update } } as unknown as PrismaClient

    // caller passes the canonical UPPERCASE (what normalizeSerial would produce)
    await new SerializedInventoryService(db).markAsReturned('v1', stored.toUpperCase())

    const where = (findFirst.mock.calls[0][0] as { where: { venueId: string; serialNumber: { in: string[] } } }).where
    expect(where.venueId).toBe('v1')
    expect(where.serialNumber.in).toEqual(expect.arrayContaining([stored.toUpperCase(), stored]))
    // updated using the ACTUAL stored (lower-cased) serial — the pre-fix bug
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_serialNumber: { venueId: 'v1', serialNumber: stored } } }),
    )
  })

  it('markAsDamaged also resolves case-insensitively', async () => {
    const stored = 'abc123def'
    const findFirst = jest.fn().mockResolvedValue({ serialNumber: stored })
    const update = jest.fn().mockResolvedValue({ id: 'it2', serialNumber: stored, status: 'DAMAGED' })
    const db = { serializedItem: { findFirst, update } } as unknown as PrismaClient
    await new SerializedInventoryService(db).markAsDamaged('v1', 'ABC123DEF')
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_serialNumber: { venueId: 'v1', serialNumber: stored } } }),
    )
  })

  it('falls back to the normalized serial (preserving prior not-found) when nothing matches', async () => {
    const findFirst = jest.fn().mockResolvedValue(null)
    const update = jest.fn().mockRejectedValue(new Error('Record to update not found.'))
    const db = { serializedItem: { findFirst, update } } as unknown as PrismaClient
    await expect(new SerializedInventoryService(db).markAsReturned('v1', '  ghost ')).rejects.toThrow()
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId_serialNumber: { venueId: 'v1', serialNumber: 'GHOST' } } }),
    )
  })
})
