// tests/unit/services/fiscal/facturapi.provider.cancel.test.ts
//
// C2 · Tarea 2 (plan v7): la cancelación habla con Facturapi por `fetch` con tiempo límite (antes, el SDK sin tiempo límite: un PAC
// colgado dejaba la petición abierta para siempre y el dueño del intento nunca sabía si su POST salió). El SDK además tiraba el status
// HTTP y el `code` del PAC, y sin ellos no se distingue «trámite existente» (409) de «rechazo concluyente» (400) ni de «no se sabe».
// Verbo, parámetros y códigos medidos en la documentación oficial (docs.facturapi.io «Cancelaciones» y «Errores», 5-oct).
//
// Las 5 pruebas de cancelación que vivían en facturapi.provider.test.ts simulaban `client.invoices.cancel`/`retrieve` del SDK: se
// movieron aquí, con las MISMAS aserciones, sobre `fetch` (tabla de doradas del plan C2: «las del proveedor que simulan
// client.invoices.cancel/retrieve ⇒ fetch con tiempo límite»).

import {
  FacturapiProvider,
  ProviderHttpError,
  TIEMPO_LIMITE_CONSULTA_MS,
  TIEMPO_LIMITE_ENVIO_MS,
} from '@/services/fiscal/providers/facturapi.provider'

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const INVOICE = { id: 'fa_inv_1', uuid: 'UUID-123', series: 'A', folio_number: 1, total: 116 }

describe('C2 · contrato HTTP de la cancelación (fetch con tiempo límite)', () => {
  let fetchMock: jest.SpyInstance
  let timeoutSpy: jest.SpyInstance
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch')
    timeoutSpy = jest.spyOn(AbortSignal, 'timeout')
  })
  afterEach(() => {
    fetchMock.mockRestore()
    timeoutSpy.mockRestore()
  })
  const provider = () => new FacturapiProvider('sk_test_fake')

  it('🔴 cancelInvoice: DELETE https://www.facturapi.io/v2/invoices/<id>?motive=02, con la llave y un tiempo límite de 30 s', async () => {
    fetchMock.mockResolvedValue(ok({ ...INVOICE, status: 'valid', cancellation_status: 'pending' }))
    const r = await provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.facturapi.io/v2/invoices/fa1?motive=02')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({
      method: 'DELETE',
      headers: { Authorization: 'Bearer sk_test_fake' },
      signal: expect.any(AbortSignal),
    })
    // C2 ronda 1 (I2): el DELETE usa SU tiempo límite exportado (de él se deriva ENVIO_TERMINADO_MS).
    expect(timeoutSpy).toHaveBeenCalledWith(TIEMPO_LIMITE_ENVIO_MS)
    expect(TIEMPO_LIMITE_ENVIO_MS).toBe(30_000)
    expect(r).toEqual({ status: 'pending', cancelledAt: null })
  })

  it('control — el motivo 01 exige el sustituto: …?motive=01&substitution=<uuid>', async () => {
    fetchMock.mockResolvedValue(ok({ ...INVOICE, status: 'valid', cancellation_status: 'pending' }))
    await provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '01', substituteUuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
    expect(fetchMock.mock.calls[0][0]).toBe(
      'https://www.facturapi.io/v2/invoices/fa1?motive=01&substitution=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    )
  })

  it('«verifying» cuenta como en trámite', async () => {
    fetchMock.mockResolvedValue(ok({ ...INVOICE, status: 'valid', cancellation_status: 'verifying' }))
    expect(await provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })).toEqual({ status: 'pending', cancelledAt: null })
  })

  it('cancelada y aceptada ⇒ cancelada, con fecha', async () => {
    fetchMock.mockResolvedValue(ok({ ...INVOICE, status: 'canceled', cancellation_status: 'accepted' }))
    const r = await provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })
    expect(r.status).toBe('canceled')
    expect(r.cancelledAt).toBeInstanceOf(Date)
  })

  it.each([
    [409, 'invoice_cancellation_in_progress'],
    [400, 'invoice_cancellation_not_allowed'],
    [400, 'invoice_not_cancelable_by_sat'],
    [503, 'invoice_cancellation_service_unavailable'],
  ])('🔴 HTTP %s %s ⇒ lanza ProviderHttpError con su status y su código (sin ellos no se clasifica)', async (status, code) => {
    fetchMock.mockResolvedValue(ok({ code, message: `mensaje ${code}` }, status))
    const p = provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })
    await expect(p).rejects.toBeInstanceOf(ProviderHttpError)
    await expect(p).rejects.toMatchObject({ status, code, message: `mensaje ${code}` })
  })

  it('un cuerpo que no es JSON (p. ej. un 502 de una puerta de enlace) ⇒ ProviderHttpError sin código: queda «en duda» para quien llama', async () => {
    fetchMock.mockResolvedValue(new Response('<html>Bad gateway</html>', { status: 502 }))
    await expect(provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })).rejects.toMatchObject({ status: 502, code: null })
  })

  it('una respuesta 200 ilegible (sin `status`) no se inventa: lanza', async () => {
    fetchMock.mockResolvedValue(ok({ algo: 'raro' }))
    await expect(provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })).rejects.toThrow(/ilegible/)
  })

  it('control — el tiempo límite se propaga como error (el que llama lo trata como EN DUDA, nunca como rechazo)', async () => {
    fetchMock.mockRejectedValue(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))
    await expect(provider().cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })).rejects.toThrow(/timeout/)
  })

  it('🔴 getCancellationStatus: GET https://www.facturapi.io/v2/invoices/<id> con el mismo tiempo límite; nunca un DELETE', async () => {
    fetchMock.mockResolvedValue(ok({ ...INVOICE, status: 'valid', cancellation_status: 'pending' }))
    expect(await provider().getCancellationStatus('fa1')).toEqual({ status: 'pending', cancelledAt: null })
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.facturapi.io/v2/invoices/fa1')
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ method: 'GET', headers: { Authorization: 'Bearer sk_test_fake' } })
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(TIEMPO_LIMITE_CONSULTA_MS) // C2 ronda 1 (I2)
    expect(TIEMPO_LIMITE_CONSULTA_MS).toBe(30_000)
  })

  it('getCancellationStatus: un error HTTP también lanza ProviderHttpError con su código', async () => {
    fetchMock.mockResolvedValue(ok({ code: 'resource_missing', message: 'No existe' }, 404))
    await expect(provider().getCancellationStatus('fa1')).rejects.toMatchObject({ status: 404, code: 'resource_missing' })
  })
})

// ─── Las 5 pruebas que simulaban el SDK (facturapi.provider.test.ts), ahora sobre fetch ───────────────────────────────────────

describe('cancelInvoice / getCancellationStatus — la regla de siempre, sobre fetch', () => {
  let fetchMock: jest.SpyInstance
  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch')
  })
  afterEach(() => fetchMock.mockRestore())

  // 🔴 `cancellation_status: 'none'` significa que el PAC NO canceló nada. Tratarlo como cancelado hacía
  // que diéramos por cancelada una factura viva — y en una sustitución eso deja DOS facturas vigentes.
  it('control — cancelInvoice NO da por cancelado un `none` ni un status desconocido: la factura sigue viva', async () => {
    const provider = new FacturapiProvider('sk_test_x')
    fetchMock.mockResolvedValueOnce(ok({ ...INVOICE, status: 'valid', cancellation_status: 'none' }))
    await expect(provider.cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })).resolves.toMatchObject({
      status: 'none',
      cancelledAt: null,
    })
    fetchMock.mockResolvedValueOnce(ok({ ...INVOICE, status: 'valid', cancellation_status: 'lo-que-sea' }))
    await expect(provider.cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })).resolves.toMatchObject({
      status: 'none',
      cancelledAt: null,
    })
  })

  it('cancelInvoice: la factura ya cancelada manda sobre el cancellation_status', async () => {
    const provider = new FacturapiProvider('sk_test_x')
    fetchMock.mockResolvedValue(ok({ ...INVOICE, status: 'canceled', cancellation_status: 'none' }))
    const r = await provider.cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })
    expect(r.status).toBe('canceled')
    expect(r.cancelledAt).toBeInstanceOf(Date)
  })

  it('cancelInvoice mapea pending/verifying, accepted, rejected y expired sin inventar una cancelación', async () => {
    const provider = new FacturapiProvider('sk_test_x')
    for (const [raw, esperado] of [
      ['pending', 'pending'],
      ['verifying', 'pending'],
      ['accepted', 'accepted'],
      ['rejected', 'rejected'],
      ['expired', 'expired'],
    ] as const) {
      fetchMock.mockResolvedValueOnce(ok({ ...INVOICE, status: 'valid', cancellation_status: raw }))
      const r = await provider.cancelInvoice({ providerInvoiceId: 'fa1', motivo: '02' })
      expect([raw, r.status]).toEqual([raw, esperado])
      expect([raw, r.cancelledAt]).toEqual([raw, esperado === 'accepted' ? expect.any(Date) : null])
    }
  })

  // Testarudo 24-sep-2026: la A-14 se canceló en el SAT pero Avoqado se quedó con la solicitud «en trámite»
  // para siempre, porque sólo se preguntaba UNA vez (al pedirla). Esta consulta es la que faltaba.
  it('getCancellationStatus CONSULTA (no cancela) y usa la misma regla que cancelInvoice', async () => {
    const provider = new FacturapiProvider('sk_test_x')
    fetchMock.mockResolvedValueOnce(
      ok({
        ...INVOICE,
        status: 'canceled',
        cancellation_status: 'none',
        cancellation: { status: 'accepted', last_checked: '2026-09-21T18:09:00.000Z' },
      }),
    )
    const r = await provider.getCancellationStatus('fa1')
    expect(fetchMock.mock.calls[0][0]).toBe('https://www.facturapi.io/v2/invoices/fa1')
    expect(fetchMock.mock.calls.every(c => c[1].method === 'GET')).toBe(true) // nunca un DELETE
    expect(r.status).toBe('canceled')
    expect(r.cancelledAt).toEqual(new Date('2026-09-21T18:09:00.000Z'))

    fetchMock.mockResolvedValueOnce(ok({ ...INVOICE, status: 'valid', cancellation_status: 'pending' }))
    await expect(provider.getCancellationStatus('fa1')).resolves.toEqual({ status: 'pending', cancelledAt: null })

    // Sin fecha del PAC no se inventa una: cancelada, pero `cancelledAt` vacío.
    fetchMock.mockResolvedValueOnce(ok({ ...INVOICE, status: 'canceled', cancellation_status: 'none', cancellation: null }))
    await expect(provider.getCancellationStatus('fa1')).resolves.toEqual({ status: 'canceled', cancelledAt: null })
  })

  it('cancelInvoice passes motive + substitution', async () => {
    fetchMock.mockResolvedValue(ok({ id: 'fa_inv_1', uuid: 'UUID-123', status: 'canceled', cancellation_status: 'accepted' }))
    const provider = new FacturapiProvider('sk_test_x')
    const r = await provider.cancelInvoice({ providerInvoiceId: 'fa_inv_1', motivo: '02' })
    expect(fetchMock.mock.calls[0][0]).toContain('/invoices/fa_inv_1?motive=02')
    expect(['accepted', 'canceled']).toContain(r.status)
  })
})
