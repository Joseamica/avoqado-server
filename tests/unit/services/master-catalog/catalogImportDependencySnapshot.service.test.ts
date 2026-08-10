import { calculateCatalogImportConfirmCapacityV1 } from '@/services/master-catalog/catalogImportCapacity.service'
import { parseCatalogImportDependencySnapshotV1 } from '@/services/master-catalog/catalogImportDependencySnapshot.service'

function snapshot() {
  return {
    schemaVersion: 1,
    capacity: calculateCatalogImportConfirmCapacityV1([]),
    items: [],
    priceDependentItemIds: [],
    organizationValues: [],
    references: [],
    mappings: [],
    profiles: [],
  }
}

describe('catalog import dependency snapshot capacity authority', () => {
  it('accepts a closed exact capacity and a proven lower-bound overflow', async () => {
    const exact = snapshot()
    const lowerBound = {
      ...exact,
      capacity: {
        ...exact.capacity,
        measurement: 'LOWER_BOUND',
        workUnits: 12_001,
        withinLimit: false,
        breakdown: { ...exact.capacity.breakdown, updateItems: 11_969, deactivations: 11_969 },
      },
    }

    await expect(parseCatalogImportDependencySnapshotV1(exact, () => undefined)).resolves.toEqual(exact)
    await expect(parseCatalogImportDependencySnapshotV1(lowerBound, () => undefined)).resolves.toEqual(lowerBound)
  })

  it.each([
    ['missing', ({ capacity: _capacity, ...rest }: ReturnType<typeof snapshot>) => rest],
    ['extra key', (value: ReturnType<typeof snapshot>) => ({ ...value, capacity: { ...value.capacity, hidden: true } })],
    [
      'self-inconsistent arithmetic',
      (value: ReturnType<typeof snapshot>) => ({ ...value, capacity: { ...value.capacity, workUnits: value.capacity.workUnits + 1 } }),
    ],
    [
      'SQL-like string coercion',
      (value: ReturnType<typeof snapshot>) => ({
        ...value,
        capacity: { ...value.capacity, schemaVersion: '1', withinLimit: 'true' },
      }),
    ],
  ])('rejects %s capacity before it can become a query authority', async (_label, mutate) => {
    await expect(parseCatalogImportDependencySnapshotV1(mutate(snapshot()) as never, () => undefined)).rejects.toMatchObject({
      statusCode: 409,
      code: 'STALE_PREVIEW',
    })
  })
})
