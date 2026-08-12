import { Prisma } from '@prisma/client'
import {
  acquireRecipeCostGraphVenueLockV1,
  lockRecipeCostGraphRowsV1,
  lockRecipeCostGraphsForRawMaterialUpdateV1,
  lockRecipeCostProductForUpdateV1,
  lockRecipeCostRawMaterialForUpdateV1,
  lockRecipeCostRawMaterialsForShareV1,
} from '@/services/dashboard/recipe-cost-graph-lock'

function sqlText(call: unknown[]): string {
  return (call[0] as { strings: string[] }).strings.join('?').replace(/\s+/g, ' ').trim()
}

describe('recipe-cost graph lock protocol', () => {
  it('takes one parameterized transaction-scoped venue lock', async () => {
    const executeRaw = jest.fn().mockResolvedValue(0)

    await acquireRecipeCostGraphVenueLockV1({ $executeRaw: executeRaw } as unknown as Prisma.TransactionClient, 'venue-1')

    const statement = executeRaw.mock.calls[0][0] as { strings: string[]; values: unknown[] }
    expect(statement.strings.join('?')).toContain('pg_advisory_xact_lock')
    expect(statement.strings.join('')).not.toContain('venue-1')
    expect(statement.values).toEqual(['h1a:recipe-cost-graph:v1:venue-1'])
  })

  it('locks Recipe, ordered RecipeLine, then sorted RawMaterial rows', async () => {
    const calls: string[] = []
    const queryRaw = jest
      .fn()
      .mockImplementationOnce(async (...args: unknown[]) => {
        calls.push(sqlText(args))
        return [{ id: 'recipe-1' }]
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        calls.push(sqlText(args))
        return [
          { id: 'line-2', rawMaterialId: 'raw-z' },
          { id: 'line-1', rawMaterialId: 'raw-a' },
          { id: 'line-3', rawMaterialId: 'raw-z' },
        ]
      })
      .mockImplementationOnce(async (...args: unknown[]) => {
        calls.push(sqlText(args))
        return [{ id: 'raw-a' }, { id: 'raw-z' }]
      })

    const locked = await lockRecipeCostGraphRowsV1({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, 'venue-1', 'recipe-1')

    // WHY: This fixed lock order coordinates yield, line, and cost writers and
    // prevents deadlocks caused by callers discovering ingredients differently.
    expect(locked).toBe(true)
    expect(calls[0]).toMatch(/FROM "Recipe"[\s\S]*FOR UPDATE OF recipe, product/i)
    expect(calls[1]).toMatch(/FROM "RecipeLine"[\s\S]*ORDER BY id[\s\S]*FOR UPDATE/i)
    expect(calls[2]).toMatch(/FROM "RawMaterial"[\s\S]*ORDER BY id[\s\S]*FOR SHARE/i)
    expect((queryRaw.mock.calls[2][0] as { values: unknown[] }).values).toEqual(['venue-1', 'raw-a', 'raw-z'])
  })

  it('returns false without line or material locks when the tenant-scoped Recipe vanished', async () => {
    const queryRaw = jest.fn().mockResolvedValueOnce([])

    await expect(
      lockRecipeCostGraphRowsV1({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, 'venue-1', 'recipe-gone'),
    ).resolves.toBe(false)
    expect(queryRaw).toHaveBeenCalledTimes(1)
  })

  it('locks candidate ingredients in stable venue scope and a cost editor row exclusively', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'raw-a' }, { id: 'raw-z' }])
      .mockResolvedValueOnce([{ id: 'raw-a' }])
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient

    await expect(lockRecipeCostRawMaterialsForShareV1(tx, 'venue-1', ['raw-z', 'raw-a', 'raw-z'])).resolves.toEqual(['raw-a', 'raw-z'])
    await expect(lockRecipeCostRawMaterialForUpdateV1(tx, 'venue-1', 'raw-a')).resolves.toBe(true)

    expect(sqlText(queryRaw.mock.calls[0])).toMatch(/ORDER BY id[\s\S]*FOR SHARE/i)
    expect((queryRaw.mock.calls[0][0] as { values: unknown[] }).values).toEqual(['venue-1', 'raw-a', 'raw-z'])
    expect(sqlText(queryRaw.mock.calls[1])).toMatch(/FOR UPDATE/i)
  })

  it('locks a tenant-scoped Product exclusively before Recipe creation', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ id: 'product-1' }])

    await expect(
      lockRecipeCostProductForUpdateV1({ $queryRaw: queryRaw } as unknown as Prisma.TransactionClient, 'venue-1', 'product-1'),
    ).resolves.toBe(true)

    expect(sqlText(queryRaw.mock.calls[0])).toMatch(/FROM "Product"[\s\S]*"venueId" = \?[\s\S]*FOR UPDATE/i)
  })

  it('locks all affected graph structures before sorted RM rows, with the edited RM exclusive', async () => {
    const queryRaw = jest
      .fn()
      .mockResolvedValueOnce([{ id: 'recipe-a' }])
      .mockResolvedValueOnce([{ id: 'line-a', rawMaterialId: 'raw-z' }])
      .mockResolvedValueOnce([{ id: 'recipe-b' }])
      .mockResolvedValueOnce([{ id: 'line-b', rawMaterialId: 'raw-a' }])
      .mockResolvedValueOnce([{ id: 'raw-a' }])
      .mockResolvedValueOnce([{ id: 'raw-target' }])
      .mockResolvedValueOnce([{ id: 'raw-z' }])

    await expect(
      lockRecipeCostGraphsForRawMaterialUpdateV1(
        { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient,
        'venue-1',
        ['recipe-b', 'recipe-a'],
        'raw-target',
      ),
    ).resolves.toEqual(['recipe-a', 'recipe-b'])

    // WHY: Every mutable graph row is held before any RM cost row; the edited
    // ingredient gets UPDATE while peers use SHARE, all in ordinal ID order.
    expect(sqlText(queryRaw.mock.calls[0])).toMatch(/FROM "Recipe"[\s\S]*FOR UPDATE OF recipe, product/i)
    expect(sqlText(queryRaw.mock.calls[3])).toMatch(/FROM "RecipeLine"[\s\S]*FOR UPDATE/i)
    expect(sqlText(queryRaw.mock.calls[4])).toMatch(/id = \?[\s\S]*FOR SHARE/i)
    expect(sqlText(queryRaw.mock.calls[5])).toMatch(/id = \?[\s\S]*FOR UPDATE/i)
    expect(sqlText(queryRaw.mock.calls[6])).toMatch(/id = \?[\s\S]*FOR SHARE/i)
  })
})
