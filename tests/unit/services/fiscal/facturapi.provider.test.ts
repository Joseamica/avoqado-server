const mockCreate = jest.fn()
const mockRetrieve = jest.fn()
const mockCancel = jest.fn()
const mockList = jest.fn()
const mockOrgCreate = jest.fn()
const mockOrgRenewLiveApiKey = jest.fn()
const mockOrgGetTestApiKey = jest.fn()
const mockOrgUploadCertificate = jest.fn()
const mockOrgUpdateLegal = jest.fn()
const mockOrgRetrieve = jest.fn()
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
      retrieve: mockOrgRetrieve,
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

/** El cuerpo CRUDO (texto) del primer POST: sirve para comparar byte a byte, con el orden de las llaves. */
const cuerpoCrudo = (): string => (global.fetch as unknown as jest.Mock).mock.calls[0][1].body as string

describe('FacturapiProvider', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    jest.spyOn(global, 'fetch').mockImplementation(async (_url, init) => {
      const body = await mockCreate(JSON.parse(init!.body as string))
      return new Response(JSON.stringify(body), { status: body?.status === 'pending' ? 202 : 200 })
    })
  })
  afterEach(() => jest.restoreAllMocks())

  // ── createInvoice ──────────────────────────────────────────────────────────

  it('createInvoice maps our cents-based params to the SDK and returns a StampedInvoice', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    const result = await provider.createInvoice(BASE_CREATE_PARAMS)
    expect(result.uuid).toBe('UUID-123')
    expect(result.totalCents).toBe(11600)
    expect(mockCreate).toHaveBeenCalledTimes(1)
    // The direct HTTP body carries the dedicated duplicate-prevention key.
    const body = mockCreate.mock.calls[0][0]
    expect(body.i_key).toBeUndefined()
    expect(body.idempotency_key).toBe('idem-1')
    expect(mockCreate.mock.calls[0][1]).toBeUndefined() // no second-arg query param
    // unit price sent to SDK is pesos, not cents
    const sentItems = body.items
    expect(sentItems[0].product.price).toBe(100)
    // BASE params carry no taxIncluded flag → NET semantics (PAC adds IVA on top)
    expect(sentItems[0].product.tax_included).toBe(false)
  })

  it('createInvoice sends tax_included:true for IVA-included (gross) items so the PAC keeps the paid total', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createInvoice({
      ...BASE_CREATE_PARAMS,
      items: [{ ...BASE_CREATE_PARAMS.items[0], unitPriceCents: 11600, taxIncluded: true }],
    })
    const product = mockCreate.mock.calls[0][0].items[0].product
    expect(product.price).toBe(116) // gross pesos sent as-is
    expect(product.tax_included).toBe(true) // PAC back-computes base+IVA → stamped total stays 116
  })

  it('D9: con `unitPriceDecimal` el precio al PAC lleva sus 6 decimales; sin él, los centavos de siempre', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createInvoice({
      ...BASE_CREATE_PARAMS,
      items: [{ ...BASE_CREATE_PARAMS.items[0], quantity: 1.537, unitPriceCents: 4500, unitPriceDecimal: '44.996747', taxIncluded: true }],
    })
    expect(mockCreate.mock.calls[0][0].items[0].product.price).toBe(44.996747)
  })

  it('createInvoice envía `taxability` (ObjetoImp) por concepto: sin él facturapi asume 02 y un «no objeto» (01) se timbraría como objeto de impuesto', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createInvoice({
      ...BASE_CREATE_PARAMS,
      items: [{ ...BASE_CREATE_PARAMS.items[0], objetoImp: '01', taxes: [] }],
    })
    expect(mockCreate.mock.calls[0][0].items[0].product.taxability).toBe('01')
  })

  // C2 · Tarea 2: las pruebas de `cancelInvoice`/`getCancellationStatus` (antes con `client.invoices.cancel`/`retrieve` del SDK) viven en
  // facturapi.provider.cancel.test.ts, con las mismas aserciones, sobre `fetch` con tiempo límite.

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

  // ── C1: sku, base de cada traslado y precio con 6 decimales (los tres documentos) ───────────────────────

  const GLOBAL_RECEPTOR = {
    legal_name: 'PÚBLICO EN GENERAL' as const,
    tax_id: 'XAXX010101000' as const,
    tax_system: '616' as const,
    address: { zip: '83000' },
  }

  it('🔴 C1: la global manda sku, base de cada traslado y el precio con 6 decimales', async () => {
    mockCreate.mockResolvedValue({ ...MOCK_INVOICE_RESPONSE, uuid: 'GLOBAL-UUID' })
    const provider = new FacturapiProvider('sk_test_x')
    await provider.createGlobalInvoice({
      receptor: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '83000' } },
      items: [
        {
          satProductKey: '01010101',
          satUnitKey: 'ACT',
          description: 'Venta',
          quantity: 1,
          unitPriceCents: 28793,
          unitPriceDecimal: '287.931034',
          discountCents: 0,
          sku: 'F-9',
          objetoImp: '02',
          taxIncluded: false,
          taxes: [
            { type: 'IVA', factor: 'Tasa', rate: 0.16, withholding: false, base: '137.931034' },
            { type: 'IVA', factor: 'Exento', rate: 0, withholding: false, base: '50.000000' },
          ],
        },
      ],
      payment_form: '04',
      use: 'S01',
      global: { periodicity: 'day', months: '10', year: 2026 },
    })
    const product = mockCreate.mock.calls[0][0].items[0].product
    expect(product.sku).toBe('F-9')
    expect(product.price).toBe(287.931034)
    expect(product.taxes).toEqual([
      { type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false, base: 137.931034 },
      { type: 'IVA', rate: 0, factor: 'Exento', withholding: false, base: 50 },
    ])
  })

  it('control — una factura sin sku ni base manda exactamente lo de hoy', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    await new FacturapiProvider('sk_test_x').createInvoice(BASE_CREATE_PARAMS)
    const product = mockCreate.mock.calls[0][0].items[0].product
    expect(product).not.toHaveProperty('sku')
    expect(product.taxes[0]).not.toHaveProperty('base')
  })

  it('🔴 C1: la factura individual también manda el sku y la base de cada traslado', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    await new FacturapiProvider('sk_test_x').createInvoice({
      ...BASE_CREATE_PARAMS,
      items: [
        {
          ...BASE_CREATE_PARAMS.items[0],
          sku: 'TKT-1',
          taxes: [{ type: 'IVA' as const, factor: 'Tasa' as const, rate: 0.16, withholding: false, base: '100.000000' }],
        },
      ],
    })
    const product = mockCreate.mock.calls[0][0].items[0].product
    expect(product.sku).toBe('TKT-1')
    expect(product.taxes).toEqual([{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false, base: 100 }])
  })

  it('🔴 C1: una base cero explícita se manda como 0 (no se confunde con «sin base»)', async () => {
    mockCreate.mockResolvedValue({ ...MOCK_INVOICE_RESPONSE, uuid: 'GLOBAL-UUID' })
    await new FacturapiProvider('sk_test_x').createGlobalInvoice({
      receptor: GLOBAL_RECEPTOR,
      items: [
        {
          ...BASE_CREATE_PARAMS.items[0],
          taxes: [{ type: 'IVA' as const, factor: 'Tasa' as const, rate: 0.16, withholding: false, base: '0.000000' }],
        },
      ],
      payment_form: '01',
      use: 'S01',
      global: { periodicity: 'month', months: '05', year: 2026 },
    })
    const taxes = mockCreate.mock.calls[0][0].items[0].product.taxes
    expect(taxes[0]).toHaveProperty('base', 0)
  })

  it('control — un sku vacío no se manda (un NoIdentificacion vacío el PAC lo rechazaría)', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    await new FacturapiProvider('sk_test_x').createInvoice({
      ...BASE_CREATE_PARAMS,
      items: [{ ...BASE_CREATE_PARAMS.items[0], sku: '' }],
    })
    expect(mockCreate.mock.calls[0][0].items[0].product).not.toHaveProperty('sku')
  })

  it('🔴 C1: la global con `unitPriceDecimal` manda sus 6 decimales; sin él, los centavos de siempre', async () => {
    mockCreate.mockResolvedValue({ ...MOCK_INVOICE_RESPONSE, uuid: 'GLOBAL-UUID' })
    const provider = new FacturapiProvider('sk_test_x')
    const params = {
      receptor: GLOBAL_RECEPTOR,
      payment_form: '01',
      use: 'S01' as const,
      global: { periodicity: 'month' as const, months: '05', year: 2026 },
    }
    await provider.createGlobalInvoice({
      ...params,
      items: [{ ...BASE_CREATE_PARAMS.items[0], unitPriceCents: 4500, unitPriceDecimal: '44.996747' }],
    })
    expect(mockCreate.mock.calls[0][0].items[0].product.price).toBe(44.996747)
    await provider.createGlobalInvoice({ ...params, items: [{ ...BASE_CREATE_PARAMS.items[0], unitPriceCents: 4500 }] })
    expect(mockCreate.mock.calls[1][0].items[0].product.price).toBe(45)
  })

  // 🔴 «Los payloads de hoy no cambian»: el CUERPO CRUDO (texto, con el orden de las llaves) de una factura y de una
  // global sin sku ni base es el de antes de la Tarea 4. El esperado se escribió contra el código SIN tocar.
  it('control — el cuerpo de la factura individual de hoy sale byte a byte igual (IVA incluido, descuento, exento, relación)', async () => {
    mockCreate.mockResolvedValue(MOCK_INVOICE_RESPONSE)
    await new FacturapiProvider('sk_test_x').createInvoice({
      ...BASE_CREATE_PARAMS,
      receptor: { ...BASE_CREATE_PARAMS.receptor, razonSocial: '  escuela kemper   urgate sa de cv ', email: 'cliente@example.com' },
      serie: 'F',
      externalId: 'ext-1',
      relation: { tipoRelacion: '04', relatedUuids: ['UUID-VIEJO'] },
      items: [
        { ...BASE_CREATE_PARAMS.items[0], quantity: 2, unitPriceCents: 11600, discountCents: 150, taxIncluded: true },
        { ...BASE_CREATE_PARAMS.items[0], quantity: 1.537, unitPriceCents: 4500, unitPriceDecimal: '44.996747', taxIncluded: true },
        { ...BASE_CREATE_PARAMS.items[0], description: 'Libro', objetoImp: '01', unitPriceCents: 9900, taxes: [] },
      ],
    })
    const esperado = {
      customer: {
        legal_name: 'ESCUELA KEMPER URGATE SA DE CV',
        tax_id: 'EKU9003173C9',
        tax_system: '601',
        address: { zip: '64000' },
        email: 'cliente@example.com',
      },
      use: 'G03',
      payment_form: '01',
      payment_method: 'PUE',
      series: 'F',
      idempotency_key: 'idem-1',
      external_id: 'ext-1',
      related_documents: [{ relationship: '04', documents: ['UUID-VIEJO'] }],
      items: [
        {
          quantity: 2,
          discount: 1.5,
          product: {
            description: 'Servicio',
            product_key: '90101500',
            unit_key: 'E48',
            price: 116,
            tax_included: true,
            taxability: '02',
            taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }],
          },
        },
        {
          quantity: 1.537,
          discount: 0,
          product: {
            description: 'Servicio',
            product_key: '90101500',
            unit_key: 'E48',
            price: 44.996747,
            tax_included: true,
            taxability: '02',
            taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }],
          },
        },
        {
          quantity: 1,
          discount: 0,
          product: {
            description: 'Libro',
            product_key: '90101500',
            unit_key: 'E48',
            price: 99,
            tax_included: false,
            taxability: '01',
            taxes: [],
          },
        },
      ],
    }
    expect(cuerpoCrudo()).toBe(JSON.stringify(esperado))
  })

  it('control — el cuerpo de una global sin sku ni base sale byte a byte igual (centavos, sin `unitPriceDecimal`)', async () => {
    mockCreate.mockResolvedValue({ ...MOCK_INVOICE_RESPONSE, uuid: 'GLOBAL-UUID' })
    await new FacturapiProvider('sk_test_x').createGlobalInvoice({
      receptor: GLOBAL_RECEPTOR,
      items: [
        { ...BASE_CREATE_PARAMS.items[0], unitPriceCents: 11600, taxIncluded: true },
        { ...BASE_CREATE_PARAMS.items[0], description: 'Exento', objetoImp: '01', unitPriceCents: 5000, taxes: [] },
      ],
      payment_form: '04',
      use: 'S01',
      global: { periodicity: 'month', months: '05', year: 2026 },
      serie: 'G',
      externalId: 'g-1',
      idempotencyKey: 'g-1',
    })
    const esperado = {
      type: 'I',
      customer: { legal_name: 'PÚBLICO EN GENERAL', tax_id: 'XAXX010101000', tax_system: '616', address: { zip: '83000' } },
      use: 'S01',
      payment_form: '04',
      payment_method: 'PUE',
      series: 'G',
      external_id: 'g-1',
      idempotency_key: 'g-1',
      global: { periodicity: 'month', months: '05', year: 2026 },
      items: [
        {
          quantity: 1,
          discount: 0,
          product: {
            description: 'Servicio',
            product_key: '90101500',
            unit_key: 'E48',
            price: 116,
            tax_included: true,
            taxability: '02',
            taxes: [{ type: 'IVA', rate: 0.16, factor: 'Tasa', withholding: false }],
          },
        },
        {
          quantity: 1,
          discount: 0,
          product: {
            description: 'Exento',
            product_key: '90101500',
            unit_key: 'E48',
            price: 50,
            tax_included: false,
            taxability: '01',
            taxes: [],
          },
        },
      ],
    }
    expect(cuerpoCrudo()).toBe(JSON.stringify(esperado))
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

  it('getInvoice y findByExternalId conservan pending sin UUID', async () => {
    mockRetrieve.mockResolvedValue({ id: 'pending-id', status: 'pending' })
    mockList.mockResolvedValue({ data: [{ id: 'pending-id', status: 'pending' }] })
    const provider = new FacturapiProvider('sk_test_x')
    expect(await provider.getInvoice('pending-id')).toMatchObject({ status: 'pending', uuid: null })
    expect(await provider.findByExternalId('identity')).toMatchObject({ status: 'pending', uuid: null })
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

  it('updateOrgLegal calls organizations.updateLegal with the mapped body — including the REQUIRED name', async () => {
    mockOrgUpdateLegal.mockResolvedValue({ id: 'org1' })
    const provider = new FacturapiProvider('sk_test_x')
    await provider.updateOrgLegal({ providerOrgId: 'org1', legalName: 'Empresa SA', taxSystem: '601', zip: '64000' })
    // Facturapi's OrganizationLegalInput marks FOUR fields required: name (nombre
    // comercial), legal_name, tax_system, address. Omitting name makes the whole
    // provision fail with 'El campo "name" es requerido.' (prod, 2026-09-01).
    expect(mockOrgUpdateLegal).toHaveBeenCalledWith('org1', {
      name: 'Empresa SA',
      legal_name: 'Empresa SA',
      tax_system: '601',
      address: { zip: '64000' },
    })
  })

  it('getOrganizationStatus maps is_production_ready + pending_steps types', async () => {
    mockOrgRetrieve.mockResolvedValue({
      id: 'org1',
      is_production_ready: false,
      pending_steps: [
        { type: 'certificate', description: 'Sube tus certificados' },
        { type: 'manifiesto', description: 'Firma la carta manifiesto' },
      ],
    })
    const provider = new FacturapiProvider('sk_test_x')
    const r = await provider.getOrganizationStatus('org1')
    expect(mockOrgRetrieve).toHaveBeenCalledWith('org1')
    expect(r).toEqual({ isProductionReady: false, pendingSteps: ['certificate', 'manifiesto'] })
  })

  it('getOrganizationStatus tolerates a missing pending_steps array (org lista)', async () => {
    mockOrgRetrieve.mockResolvedValue({ id: 'org1', is_production_ready: true })
    const provider = new FacturapiProvider('sk_test_x')
    const r = await provider.getOrganizationStatus('org1')
    expect(r).toEqual({ isProductionReady: true, pendingSteps: [] })
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

// ─── C2 · T7 ronda 1 (M1): el XML se baja por `fetch` con tiempo límite y conserva el status HTTP ───
describe('C2 · T7 ronda 1 · downloadXml', () => {
  afterEach(() => jest.restoreAllMocks())
  it('🔴 baja /v2/invoices/{id}/xml con la llave y un tiempo límite, y devuelve los bytes', async () => {
    mockInvoicesDownloadXml.mockResolvedValue(Buffer.from('del SDK')) // el camino de antes (sin status), para que el rojo sea por aserción
    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue(new Response('<cfdi:Comprobante/>', { status: 200 }))
    const xml = await new FacturapiProvider('sk_test_x').downloadXml('fa inv/1')
    expect(xml.toString('utf8')).toBe('<cfdi:Comprobante/>')
    expect(fetchMock).toHaveBeenCalledWith('https://www.facturapi.io/v2/invoices/fa%20inv%2F1/xml', {
      method: 'GET',
      headers: { Authorization: 'Bearer sk_test_x' },
      signal: expect.any(AbortSignal),
    })
    expect(mockInvoicesDownloadXml).not.toHaveBeenCalled()
  })
  it.each([404, 401, 403, 500])('🔴 un %i del PAC sale como ProviderHttpError con su status (y su mensaje)', async status => {
    mockInvoicesDownloadXml.mockRejectedValue(new Error('Invoice not found')) // el SDK de antes tira un Error SIN status
    jest
      .spyOn(global, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ message: 'Invoice not found' }), { status, headers: { 'content-type': 'application/json' } }),
      )
    await expect(new FacturapiProvider('sk_test_x').downloadXml('fa_1')).rejects.toMatchObject({
      name: 'ProviderHttpError',
      status,
      message: 'Invoice not found',
    })
  })
})
