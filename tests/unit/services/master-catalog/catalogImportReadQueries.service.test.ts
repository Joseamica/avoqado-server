import {
  queryCatalogImportPreviewBatchTx,
  queryCatalogImportPreviewItemDetailTx,
  queryCatalogImportPreviewSectionPageTx,
  type CatalogImportPreviewSection,
} from '@/services/master-catalog/catalogImportRead.service'

const organizationId = 'org-pits'
const batchId = 'import-batch-1'

describe('catalogImportReadQueries.service bounded PostgreSQL projections', () => {
  it('reads bounded capacity and complete durable-integrity scalars without hydrating dependencies', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) }

    await queryCatalogImportPreviewBatchTx(tx as never, { organizationId, importBatchId: batchId })

    const sql = tx.$queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] }
    const text = sql.strings.join('?')
    expect(text).toContain("#>> '{capacity,schemaVersion}'")
    expect(text).toContain('invalidLineCount')
    expect(text).toContain('invalidPayloadCount')
    expect(text).toContain('capacityIntegrityValid')
    expect(text).toContain('l."catalogItemId" IS NULL')
    expect(text).toContain("CASE WHEN jsonb_typeof(finding.value) = 'object' THEN")
    expect(text).toContain('lineCount')
    expect(text).toContain('itemCount')
    expect(text).toContain('organizationValueDeactivations')
    expect(text).toContain('jsonb_array_elements')
    expect(text).toContain('jsonb_array_length(l."errors")')
    expect(text).toContain('invalidReferenceMarkerCount')
    expect(text).toContain("proposal.value -> 'capacityMarker'")
    expect(text).toContain('sha256')
    expect(text).toContain('WHERE marker IS NOT NULL GROUP BY marker')
    expect(text).not.toContain("proposal.value ->> 'capacityMarker' AS marker")
    expect(text).not.toContain("normalize(proposal.value ->> 'name'")
    expect(text).toContain("WHEN 'PREVIEWED'")
    expect(text).toContain("WHEN 'FAILED'")
    expect(text).toContain("WHEN 'APPLIED'")
    // WHY: SQL proves only bounded structural safety. Confirmation remains the
    // sole full Task 5/NFKC/WHATWG authority before any mutation.
    expect(text).toContain('jsonb_array_length(proposal_line."payload" -> \'referenceProposals\') BETWEEN 0 AND ?')
    expect(sql.values).toContain(4)
    expect(text).toContain("referenceProposals') = 'array' THEN CASE")
    expect(text).toContain("= '[]'::jsonb")
    expect(sql.values).toEqual(expect.arrayContaining(['source_sheet', 'source_row', 'error_code', 'message', 'suggestion']))
    expect(text).not.toContain('jsonb_object_length')
    expect(text).toContain('LIMIT 1')
    expect(text).not.toMatch(/SELECT\s+[^;]*\b"dependencies"\s*(,|FROM)/su)
    expect(sql.values).toEqual(expect.arrayContaining([organizationId, batchId]))
  })

  it('maps the real scalar SQL row into the exact batch parser shape', async () => {
    const raw = {
      id: batchId,
      organizationId,
      schemaVersion: 1,
      targetHash: 'a'.repeat(64),
      previewTokenHash: 'b'.repeat(64),
      staffId: 'staff-owner',
      state: 'PREVIEWED',
      previewExpiresAt: new Date('2026-08-09T02:30:00.000Z'),
      lineCount: '4',
      itemCount: '1',
      capacityIntegrityValid: true,
      invalidLineCount: '0',
      invalidPayloadCount: '0',
      oversizedSheetCount: '0',
      capacitySchemaVersion: '1',
      capacityCostModelVersion: '1',
      capacityMeasurement: 'EXACT',
      capacityWorkUnits: '52',
      capacityLimit: '12000',
      capacityWithinLimit: 'true',
      capacityBase: '32',
      capacityReferences: '0',
      capacityCreates: '0',
      capacityUpdates: '20',
      capacityRetires: '0',
      capacityValues: '4',
      capacityDeactivations: '4',
    }
    const tx = { $queryRaw: jest.fn().mockResolvedValue([raw]) }

    const result = await queryCatalogImportPreviewBatchTx(tx as never, { organizationId, importBatchId: batchId })

    expect(result).toEqual({
      id: batchId,
      organizationId,
      schemaVersion: 1,
      targetHash: raw.targetHash,
      previewTokenHash: raw.previewTokenHash,
      staffId: 'staff-owner',
      state: 'PREVIEWED',
      previewExpiresAt: raw.previewExpiresAt,
      lineCount: '4',
      itemCount: '1',
      capacityIntegrityValid: true,
      invalidLineCount: '0',
      invalidPayloadCount: '0',
      oversizedSheetCount: '0',
      capacity: {
        schemaVersion: '1',
        costModelVersion: '1',
        measurement: 'EXACT',
        workUnits: '52',
        limit: '12000',
        withinLimit: 'true',
        breakdown: {
          base: '32',
          referenceProposals: '0',
          createItems: '0',
          updateItems: '20',
          retireItems: '0',
          organizationValues: '4',
          deactivations: '4',
        },
      },
    })
  })

  it.each([
    'ITEMS',
    'ORGANIZATION_VALUES',
    'BUSINESS_TYPES',
    'REFERENCE_PROPOSALS',
    'VENUE_BINDING_REQUESTS',
    'ERRORS',
  ] as CatalogImportPreviewSection[])('uses one closed, parameterized, limited %s query without raw payloads', async section => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) }

    await queryCatalogImportPreviewSectionPageTx(tx as never, {
      organizationId,
      importBatchId: batchId,
      section,
      after: null,
      take: 51,
    })

    const sql = tx.$queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] }
    const text = sql.strings.join('?')
    expect(text).toContain('LIMIT')
    expect(text).toContain('ORDER BY')
    expect(text).not.toContain('SELECT l.*')
    expect(text).not.toMatch(/AS\s+"payload"/u)
    expect(sql.values).toEqual(expect.arrayContaining([organizationId, batchId, 51]))
    if (section !== 'REFERENCE_PROPOSALS' && section !== 'ERRORS') {
      expect(text).toContain('proofCorporateSku')
      expect(text).not.toContain('AS "corporateSku"')
    }
    if (section === 'ORGANIZATION_VALUES') {
      expect(text).toContain('UNION ALL')
      expect(text).toContain('organizationValueDeactivations')
      expect(text).toContain("'DEACTIVATE'::text")
    }
    if (section === 'REFERENCE_PROPOSALS') {
      expect(text).toContain('proofName')
      expect(text).toContain('proofParentId')
      expect(text).toContain('proofParentName')
      expect(text).toContain('proofMarkerBaseHash')
      expect(text).toContain('proofParentBindingValid')
      expect(text).toContain('EXISTS')
      expect(text).toContain('root_proposal')
      expect(text).toContain('sha256')
      expect(text).toContain("left((entry.value -> 'name') #>> '{}', ?)")
      expect(sql.values).toEqual(expect.arrayContaining([4_097, 285, 1_053, 566, 2_102]))
      expect(text).not.toContain('AS "capacityMarker"')
    }
    if (section === 'VENUE_BINDING_REQUESTS') {
      expect(text).toContain('proofLocalSku')
      expect(text).not.toContain('AS "localSku"')
    }
    if (section === 'ORGANIZATION_VALUES' || section === 'REFERENCE_PROPOSALS' || section === 'ERRORS') {
      expect(text).toContain('WITH ORDINALITY')
    } else expect(text).not.toContain('WITH ORDINALITY')
  })

  it('loads item detail through scalar excerpts and guarded JSON counts only', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) }

    await queryCatalogImportPreviewItemDetailTx(tx as never, { organizationId, importBatchId: batchId, sourceRow: 2 })

    const sql = tx.$queryRaw.mock.calls[0]?.[0] as { strings: string[]; values: unknown[] }
    const text = sql.strings.join('?')
    expect(text).toContain('jsonb_array_length')
    expect(text).toContain('proofCorporateSku')
    expect(text).not.toContain('AS "corporateSku"')
    expect(text).toContain('LIMIT 1')
    expect(text).not.toContain('SELECT l.*')
    expect(text).not.toMatch(/AS\s+"payload"/u)
  })
})
