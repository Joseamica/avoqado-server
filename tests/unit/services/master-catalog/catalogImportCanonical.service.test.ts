import { createHash } from 'node:crypto'
import { canonicalizeAndHashCatalogImportRows } from '@/services/master-catalog/catalogImportCanonical.service'
import { canonicalJsonV1 } from '@/services/master-catalog/catalogHash.service'
import { expectCatalogImportEventLoopBudgetV1, startCatalogImportEventLoopProbeV1 } from './catalogImportEventLoopTestHarness'

function synchronousDigest(rows: readonly unknown[]): string {
  const payload = `catalog-import-rows:v1\n[${rows.map(row => canonicalJsonV1(row)).join(',')}]`
  return createHash('sha256').update(payload).digest('hex')
}

describe('catalog import streaming canonical hash', () => {
  it('is byte-identical to canonicalJsonV1 for ordinal, NFC, integer-like, and magic-key vectors', async () => {
    const rows = [{ z: 'e\u0301', a: [true, null, { b: 2, a: 'x' }] }, JSON.parse('{"__proto__":{"x":1},"2":"two","10":"ten","ä":2,"z":1}')]

    await expect(canonicalizeAndHashCatalogImportRows(rows)).resolves.toEqual({
      hash: synchronousDigest(rows),
    })
  })

  it('preserves strict sparse/NFC-collision/unsupported-value rejection semantics', async () => {
    const sparse: unknown[] = []
    sparse.length = 2
    sparse[1] = 1
    const collision = { é: 1, 'e\u0301': 2 }

    for (const value of [sparse, collision, { invalid: 1.5 }, { invalid: undefined }]) {
      await expect(canonicalizeAndHashCatalogImportRows([value])).rejects.toThrow('CATALOG_CANONICAL_JSON_INVALID')
    }
  })

  it('domain-separates the closed row, audit, and dependency namespaces', async () => {
    const rows = [{ id: 'same-bytes' }]
    const rowDigest = await canonicalizeAndHashCatalogImportRows(rows)
    const auditDigest = await canonicalizeAndHashCatalogImportRows(rows, {
      namespace: 'catalog-import-audit-envelopes:v1',
    })
    const dependencyDigest = await canonicalizeAndHashCatalogImportRows(rows, {
      namespace: 'catalog-import-dependencies:v1',
    })

    expect(new Set([rowDigest.hash, auditDigest.hash, dependencyDigest.hash]).size).toBe(3)
  })

  it('yields inside one maximum-nesting staged line instead of blocking until the outer row ends', async () => {
    const line = {
      sourceSheet: 'Items',
      sourceRow: 2,
      payload: {
        venueBindingRequests: Array.from({ length: 4_096 }, (_, index) => ({
          venueId: `venue-${index}`,
          note: `${index}:${'x'.repeat(4_090)}`,
        })),
      },
    }
    const probe = startCatalogImportEventLoopProbeV1()

    const result = await canonicalizeAndHashCatalogImportRows([line])
    const samples = probe.stop()

    // WHY: This reproduces a single ~16 MiB nested payload that previously
    // blocked one turn for >100 ms despite the outer-row chunk loop.
    expect(result.hash).toBe(synchronousDigest([line]))
    expectCatalogImportEventLoopBudgetV1(samples)
  }, 20_000)
})
