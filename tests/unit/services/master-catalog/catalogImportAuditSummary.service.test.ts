import {
  summarizeCatalogImportAuditEnvelopes,
  validateCatalogImportAuditEnvelope,
} from '@/services/master-catalog/catalogImportAuditSummary.service'
import type { CatalogMutationAuditEnvelope } from '@/services/master-catalog/catalogItem.types'

function envelope(overrides: Partial<CatalogMutationAuditEnvelope> = {}): CatalogMutationAuditEnvelope {
  return {
    action: 'CATALOG_ITEM_CREATED',
    entity: 'CatalogItem',
    entityId: 'catalog-item-1',
    batchId: 'import-batch-1',
    before: { sku: 'SECRET-SKU', amount: '99.99' },
    ...overrides,
  }
}

describe('catalog import audit-envelope summary', () => {
  it('consumes every valid BATCH envelope into deterministic bounded metadata without raw payload', async () => {
    const values = [envelope(), envelope({ action: 'CATALOG_BRAND_CREATED', entity: 'CatalogBrand', entityId: 'brand-1' })]

    const validated = values.map(value => validateCatalogImportAuditEnvelope(value, 'import-batch-1', value.entityId))
    const summary = await summarizeCatalogImportAuditEnvelopes(validated)

    expect(summary).toMatchObject({
      auditEnvelopeCount: 2,
      auditEnvelopeDigest: expect.stringMatching(/^[a-f0-9]{64}$/u),
      mutationGroups: [
        { action: 'CATALOG_BRAND_CREATED', entity: 'CatalogBrand', count: 1 },
        { action: 'CATALOG_ITEM_CREATED', entity: 'CatalogItem', count: 1 },
      ],
    })
    // WHY: The summary is allowed to identify entities, but commercial values
    // and row-by-row before/after payloads must remain outside ActivityLog.
    expect(JSON.stringify(summary)).not.toContain('SECRET-SKU')
    expect(JSON.stringify(summary)).not.toContain('99.99')
    const changedDelta = await summarizeCatalogImportAuditEnvelopes([
      envelope({ before: { sku: 'SECRET-SKU', amount: '100.00' } }),
      values[1]!,
    ])
    expect(changedDelta.auditEnvelopeDigest).not.toBe(summary.auditEnvelopeDigest)
  })

  it('rejects missing/foreign evidence and an unbounded mutation-group vocabulary', async () => {
    expect(() => validateCatalogImportAuditEnvelope(undefined, 'import-batch-1', 'item-1')).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_AUDIT_ENVELOPE_INVALID' }),
    )
    expect(() => validateCatalogImportAuditEnvelope(envelope({ batchId: 'foreign-batch' }), 'import-batch-1', 'catalog-item-1')).toThrow(
      expect.objectContaining({ code: 'CATALOG_IMPORT_AUDIT_ENVELOPE_INVALID' }),
    )

    const overflow = Array.from({ length: 33 }, (_, index) => envelope({ action: `ACTION_${index}`, entityId: `catalog-item-${index}` }))
    await expect(summarizeCatalogImportAuditEnvelopes(overflow)).rejects.toMatchObject({
      code: 'CATALOG_IMPORT_AUDIT_ENVELOPE_INVALID',
    })
  })
})
