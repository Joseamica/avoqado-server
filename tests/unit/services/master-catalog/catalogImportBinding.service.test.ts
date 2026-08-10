import { context, makeHarness, row, text, blank, number, upload, validWorkbook } from './catalogImportTestHarness'

function bindingWorkbook(localSku: string) {
  const workbook = validWorkbook()
  workbook.sheets.VenueBindingRequests.rows = [
    row(7, {
      corporate_sku: text('SKU-001'),
      venue_id: text('venue-1'),
      requested_action: text('CREATE'),
      product_id: blank(),
      local_sku: text(localSku),
      category_id: text('category-1'),
      initial_price: number('25.00'),
      currency: text('MXN'),
    }),
  ]
  return workbook
}

function bindingHarness(localSku: string) {
  const harness = makeHarness(bindingWorkbook(localSku))
  harness.tx.venue.findMany.mockResolvedValue([{ id: 'venue-1', currency: 'MXN' }])
  harness.tx.menuCategory.findMany.mockResolvedValue([{ id: 'category-1', venueId: 'venue-1' }])
  return harness
}

describe('catalog import venue binding indexed SKU boundary', () => {
  it('rejects a worker-legal local SKU whose normalized Product key exceeds V1', async () => {
    const harness = bindingHarness('😀'.repeat(3_000))

    const result = await harness.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: false, previewToken: null })
    expect(result.errors.filter(error => error.source_sheet === 'VenueBindingRequests' && error.source_row === 7)).toEqual([
      expect.objectContaining({ column: 'local_sku', error_code: 'CATALOG_IDENTIFIER_INVALID' }),
    ])
  })

  it('stages a 4096-scalar padded local SKU as its short canonical Product key', async () => {
    const harness = bindingHarness(`${' '.repeat(3_840)}${'😀'.repeat(256)}`)

    const result = await harness.service.preview(context, upload)

    expect(result).toMatchObject({ canConfirm: true, errors: [], previewToken: expect.any(String) })
    const staged = harness.tx.catalogImportLine.createMany.mock.calls.flatMap(call => call[0].data) as Array<{
      sourceSheet: string
      payload: { localSku?: string; venueBindingRequests?: Array<{ localSku: string }> }
    }>
    expect(staged.find(line => line.sourceSheet === 'VenueBindingRequests')?.payload.localSku).toBe('😀'.repeat(256))
    expect(staged.find(line => line.sourceSheet === 'Items')?.payload.venueBindingRequests).toEqual([
      expect.objectContaining({ localSku: '😀'.repeat(256) }),
    ])
  })
})
