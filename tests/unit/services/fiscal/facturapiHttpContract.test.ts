import { FacturapiProvider, ProviderHttpError, esRechazoConfirmado } from '@/services/fiscal/providers/facturapi.provider'

const params = {
  receptor: { rfc: 'EKU9003173C9', razonSocial: 'ESCUELA KEMPER', regimenFiscal: '601', codigoPostal: '64000', usoCfdi: 'G03' },
  items: [],
  formaPago: '01',
  metodoPago: 'PUE' as const,
  idempotencyKey: 'key#1',
  externalId: 'key#1',
}

describe('contrato HTTP de timbrado', () => {
  let fetchMock: jest.SpyInstance
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch')
  })
  afterEach(() => fetchMock.mockRestore())
  it('conserva identidad en el cuerpo y pending sin inventar UUID ni valid', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'pending-id', status: 'pending' }), { status: 202 }))
    expect(await new FacturapiProvider('sk_test_fake').createInvoice(params)).toMatchObject({
      providerInvoiceId: 'pending-id',
      status: 'pending',
      uuid: null,
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ external_id: 'key#1', idempotency_key: 'key#1' })
  })
  it.each([400, 422, 500])('conserva HTTP %s y code del PAC', async status => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'invalid_request', message: 'Dato inválido' }), { status }))
    await expect(new FacturapiProvider('sk_test_fake').createInvoice(params)).rejects.toMatchObject({
      status,
      code: 'invalid_request',
      message: 'Dato inválido',
    })
  })
  it('sólo el primer envío con 4xx confirmado es definitivo', () => {
    expect(esRechazoConfirmado(new ProviderHttpError(400, 'invalid_request', 'bad'), true)).toBe(true)
    expect(esRechazoConfirmado(new ProviderHttpError(400, 'product_key_not_found', 'bad'), true)).toBe(true)
    expect(esRechazoConfirmado(new ProviderHttpError(400, 'invoice_stamping_validation_error', 'bad'), true)).toBe(true)
    expect(esRechazoConfirmado(new ProviderHttpError(500, 'invalid_request', 'bad'), true)).toBe(false)
    expect(esRechazoConfirmado(new ProviderHttpError(422, 'unknown', 'bad'), true)).toBe(false)
    expect(esRechazoConfirmado(new ProviderHttpError(400, 'invalid_request', 'bad'), false)).toBe(false)
    expect(esRechazoConfirmado(new Error('network'), true)).toBe(false)
  })
  const globalParams = {
    receptor: {
      legal_name: 'PÚBLICO EN GENERAL' as const,
      tax_id: 'XAXX010101000' as const,
      tax_system: '616' as const,
      address: { zip: '64000' },
    },
    items: [],
    payment_form: '04',
    use: 'S01' as const,
    global: { periodicity: 'month' as const, months: '05', year: 2026 },
    externalId: 'global#1',
    idempotencyKey: 'global#1',
  }
  it.each([400, 422, 500])('global conserva HTTP%s y code', async status => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ code: 'invalid_request', message: 'bad' }), { status }))
    await expect(new FacturapiProvider('sk_test_fake').createGlobalInvoice(globalParams)).rejects.toMatchObject({
      status,
      code: 'invalid_request',
    })
  })
  it('global pending conserva ambas identidades protocolo1', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'pending', status: 'pending' }), { status: 202 }))
    expect(await new FacturapiProvider('sk_test_fake').createGlobalInvoice(globalParams)).toMatchObject({ status: 'pending', uuid: null })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ type: 'I', external_id: 'global#1', idempotency_key: 'global#1' })
  })
  it('global legacy no inventa idempotency_key', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ id: 'pending', status: 'pending' }), { status: 202 }))
    await new FacturapiProvider('sk_test_fake').createGlobalInvoice({
      ...globalParams,
      idempotencyKey: undefined,
      externalId: 'legacy-global',
    })
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).idempotency_key).toBeUndefined()
  })
})
