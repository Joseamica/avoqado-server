const mockCreate = jest.fn()
const mockRetrieve = jest.fn()
const mockCancel = jest.fn()
const mockList = jest.fn()
const mockOrgCreate = jest.fn()
const mockOrgRenewLiveApiKey = jest.fn()
const mockOrgGetTestApiKey = jest.fn()
const mockOrgUploadCertificate = jest.fn()
const mockOrgUpdateLegal = jest.fn()
const mockInvoicesDownloadXml = jest.fn()
const mockInvoicesDownloadPdf = jest.fn()

jest.mock('facturapi', () => {
  return jest.fn().mockImplementation(() => ({
    invoices: {
      create: mockCreate,
      retrieve: mockRetrieve,
      cancel: mockCancel,
      list: mockList,
      downloadXml: mockInvoicesDownloadXml,
      downloadPdf: mockInvoicesDownloadPdf,
    },
    organizations: {
      create: mockOrgCreate,
      renewLiveApiKey: mockOrgRenewLiveApiKey,
      getTestApiKey: mockOrgGetTestApiKey,
      uploadCertificate: mockOrgUploadCertificate,
      updateLegal: mockOrgUpdateLegal,
    },
  }))
})

import { FacturapiProvider } from '../../../../src/services/fiscal/providers/facturapi.provider'

const MOCK_INVOICE_RESPONSE = {
  id: 'fa_inv_1',
  uuid: 'UUID-123',
  series: 'A',
  folio_number: 42,
  total: 116.0,
  stamp: { date: '2026-06-03T10:00:00Z' },
  status: 'valid',
  cancellation_status: 'none',
}

const BASE_CREATE_PARAMS = {
  receptor: {
    rfc: 'EKU9003173C9',
    razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
    regimenFiscal: '601',
    codigoPostal: '64000',
    usoCfdi: 'G03',
  },
  items: [
    {
      satProductKey: '90101500',
      satUnitKey: 'E48',
      description: 'Servicio',
      quantity: 1,
      unitPriceCents: 10000,
      discountCents: 0,
      objetoImp: '02',
      taxes: [{ type: 'IVA' as const, factor: 'Tasa' as const, rate: 0.16, withholding: false }],
    },
  ],
  formaPago: '01',
  metodoPago: 'PUE' as const,
  idempotencyKey: 'idem-1',
}

describe('FacturapiProvider', () => {
  beforeEach(() => jest.clearAllMocks())

  // ── createInvoice ──────────────────────────────────────────────────────────

  it('createInvoice maps our cents-based params to the SDK and returns a StampedInvoice', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.createInvoice(BASE_CREATE_PARAMS)
    expect(result.uuid).toBe('UUID-123')
    expect(result.totalCents).toBe(11600)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    // facturapi rejects idempotency on create (query OR body, verified live) → adapter must NOT forward
    // it; idempotency is enforced at our service layer via the unique Cfdi.idempotencyKey.
    const body = mockCreate.mock.calls[0][0]
    expect(body.i_key).toBeUndefined()
    expect(body.idempotency_key).toBeUndefined()
    expect(mockCreate.mock.calls[0][1]).toBeUndefined() // no second-arg query param
    // unit price sent to SDK is pesos (net), not cents
    const sentItems = body.items
    expect(sentItems[0].product.price).toBe(100)
  })

  it('createInvoice passes external_id when externalId is provided', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createInvoice({ ...BASE_CREATE_PARAMS, externalId: 'cfdi-order-o1' })
    const body = mockCreate.mock.calls[0][0]
    expect(body.external_id).toBe('cfdi-order-o1')
  })

  it('createInvoice does NOT include external_id when externalId is absent', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createInvoice(BASE_CREATE_PARAMS) // no externalId
    const body = mockCreate.mock.calls[0][0]
    expect(body.external_id).toBeUndefined()
  })

  // ── createGlobalInvoice ────────────────────────────────────────────────────

  it('createGlobalInvoice passes external_id when externalId is provided', async () => {
    mockCreate.mockResolvedValue({ ...MOCK_INVOICE_RESPONSE, uuid: 'GLOBAL-UUID' })
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createGlobalInvoice({
      receptor: {
        legal_name: 'PÚBLICO EN GENERAL',
        tax_id: 'XAXX010101000',
        tax_system: '616',
        address: { zip: '83000' },
      },
      items: BASE_CREATE_PARAMS.items,
      payment_form: '01',
      use: 'S01',
      global: { periodicity: 'month', months: '05', year: 2026 },
      externalId: 'cfdi-global-e1-2026-05-04',
    })
    const body = mockCreate.mock.calls[0][0]
    expect(body.external_id).toBe('cfdi-global-e1-2026-05-04')
  })

  it('createGlobalInvoice does NOT include external_id when externalId is absent', async () => {
    mockCreate.mockResolvedValue({ ...MOCK_INVOICE_RESPONSE, uuid: 'GLOBAL-UUID' })
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createGlobalInvoice({
      receptor: {
        legal_name: 'PÚBLICO EN GENERAL',
        tax_id: 'XAXX010101000',
        tax_system: '616',
        address: { zip: '83000' },
      },
      items: BASE_CREATE_PARAMS.items,
      payment_form: '01',
      use: 'S01',
      global: { periodicity: 'month', months: '05', year: 2026 },
      // no externalId
    })
    const body = mockCreate.mock.calls[0][0]
    expect(body.external_id).toBeUndefined()
  })

  // ── findByExternalId ───────────────────────────────────────────────────────

  it('findByExternalId returns the first valid summary when the PAC returns a match', async () => {
    mockList.mockResolvedValue({
      page: 1,
      total_pages: 1,
      total_results: 1,
      data: [
        {
          id: 'fp1',
          uuid: 'UUID-EXT',
          series: null,
          folio_number: '1',
          total: 116.0,
          status: 'valid',
          cancellation_status: 'none',
          customer: { tax_id: 'TEST010101AAA' },
          global: null,
          stamp: { date: '2026-06-05T16:41:00Z' },
        },
      ],
    })
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.findByExternalId('cfdi-order-o1')

    expect(result).not.toBeNull()
    expect(result!.providerInvoiceId).toBe('fp1')
    expect(result!.uuid).toBe('UUID-EXT')
    expect(result!.status).toBe('valid')
    // list was called with the external_id filter
    expect(mockList).toHaveBeenCalledWith(expect.objectContaining({ external_id: 'cfdi-order-o1' }))
  })

  it('findByExternalId returns null when the PAC returns an empty list', async () => {
    mockList.mockResolvedValue({ page: 1, total_pages: 1, total_results: 0, data: [] })
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.findByExternalId('cfdi-order-nonexistent')
    expect(result).toBeNull()
  })

  it('findByExternalId prefers the first valid result when mixed statuses are returned', async () => {
    mockList.mockResolvedValue({
      page: 1,
      total_pages: 1,
      total_results: 2,
      data: [
        // canceled first (should be skipped in favor of the valid one)
        {
          id: 'fp-canceled',
          uuid: 'UUID-CANCELED',
          series: null,
          folio_number: '1',
          total: 116.0,
          status: 'canceled',
          cancellation_status: 'accepted',
          customer: { tax_id: 'TEST010101AAA' },
          global: null,
          stamp: null,
        },
        {
          id: 'fp-valid',
          uuid: 'UUID-VALID',
          series: null,
          folio_number: '2',
          total: 116.0,
          status: 'valid',
          cancellation_status: 'none',
          customer: { tax_id: 'TEST010101AAA' },
          global: null,
          stamp: { date: '2026-06-05T16:41:00Z' },
        },
      ],
    })
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.findByExternalId('cfdi-order-o1')
    expect(result).not.toBeNull()
    expect(result!.providerInvoiceId).toBe('fp-valid')
    expect(result!.status).toBe('valid')
  })

  it('findByExternalId returns the first result (canceled) when no valid result exists', async () => {
    mockList.mockResolvedValue({
      page: 1,
      total_pages: 1,
      total_results: 1,
      data: [
        {
          id: 'fp-canceled',
          uuid: 'UUID-CANCELED',
          series: null,
          folio_number: '1',
          total: 116.0,
          status: 'canceled',
          cancellation_status: 'accepted',
          customer: { tax_id: 'TEST010101AAA' },
          global: null,
          stamp: null,
        },
      ],
    })
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.findByExternalId('cfdi-order-canceled')
    expect(result).not.toBeNull()
    expect(result!.providerInvoiceId).toBe('fp-canceled')
    expect(result!.status).toBe('canceled')
  })

  it('findByExternalId propagates PAC errors (network failure → caller marks INCONCLUSIVE)', async () => {
    mockList.mockRejectedValue(new Error('ECONNRESET'))
    const provider = new FacturapiProvider('sk_test_x')
    await expect(provider.findByExternalId('cfdi-order-o1')).rejects.toThrow('ECONNRESET')
  })

  // ── Other existing tests ───────────────────────────────────────────────────

  it('cancelInvoice passes motive + substitution', async () => {
    mockCancel.mockResolvedValue({
      id: 'fa_inv_1',
      uuid: 'UUID-123',
      status: 'canceled',
      cancellation_status: 'accepted',
    })
    const provider = new FacturapiProvider('sk_test_x')
    const r = await provider.cancelInvoice({ providerInvoiceId: 'fa_inv_1', motivo: '02' })
    expect(mockCancel).toHaveBeenCalledWith('fa_inv_1', expect.objectContaining({ motive: '02' }))
    expect(['accepted', 'canceled']).toContain(r.status)
  })

  it('updateOrgLegal calls organizations.updateLegal with the mapped body', async () => {
    mockOrgUpdateLegal.mockResolvedValue({ id: 'org1' })
    const provider = new FacturapiProvider('sk_test_x')
    await provider.updateOrgLegal({ providerOrgId: 'org1', legalName: 'Empresa SA', taxSystem: '601', zip: '64000' })
    expect(mockOrgUpdateLegal).toHaveBeenCalledWith('org1', {
      legal_name: 'Empresa SA',
      tax_system: '601',
      address: { zip: '64000' },
    })
  })

  it('throws a clear error when the SDK rejects (PAC/SAT error)', async () => {
    mockCreate.mockRejectedValue(new Error('TaxObjectError: 02 required'))
    const provider = new FacturapiProvider('sk_test_x')
    await expect(
      provider.createInvoice({
        receptor: {
          rfc: 'X',
          razonSocial: 'Y',
          regimenFiscal: '601',
          codigoPostal: '64000',
          usoCfdi: 'G03',
        },
        items: [],
        formaPago: '01',
        metodoPago: 'PUE',
        idempotencyKey: 'i',
      }),
    ).rejects.toThrow(/TaxObjectError/)
  })
})
