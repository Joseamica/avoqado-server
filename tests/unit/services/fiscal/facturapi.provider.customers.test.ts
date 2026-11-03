import { FacturapiProvider, ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import { CustomerDataRejectedError } from '@/services/fiscal/providers/fiscal-provider.interface'

/** Construye un provider con un cliente SDK falso inyectado. */
function providerWith(customers: Record<string, jest.Mock>) {
  const p = new FacturapiProvider('sk_test_x')
  // El cliente del SDK es privado; lo sustituimos para aislar la llamada de red.
  ;(p as unknown as { client: unknown }).client = { customers }
  return p
}

describe('FacturapiProvider — customers', () => {
  describe('upsertCustomer', () => {
    const responde = (status: number, cuerpo: unknown) =>
      new Response(JSON.stringify(cuerpo), { status, headers: { 'Content-Type': 'application/json' } })
    const DATOS = { rfc: 'NEG150211KT5', razonSocial: 'NEGOCIO DE PRUEBA', regimenFiscal: '601', codigoPostal: '06400' }
    let red: jest.SpyInstance
    const llamada = (i = 0) => {
      const [url, init] = red.mock.calls[i] as [string, RequestInit]
      return { url, metodo: init.method, cuerpo: JSON.parse(String(init.body)) }
    }

    beforeEach(() => {
      red = jest.spyOn(global, 'fetch')
    })
    afterEach(() => {
      red.mockRestore()
    })

    it('crea un Customer nuevo y devuelve su id cuando no hay existingCustomerId', async () => {
      red.mockResolvedValue(responde(201, { id: 'cus_1' }))

      const id = await new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, email: 'facturacion@negocio.mx' })

      expect(id).toBe('cus_1')
      expect(llamada().url).toBe('https://www.facturapi.io/v2/customers')
      expect(llamada().metodo).toBe('POST')
      expect(llamada().cuerpo).toEqual({
        legal_name: 'NEGOCIO DE PRUEBA',
        tax_id: 'NEG150211KT5',
        tax_system: '601',
        address: { zip: '06400' },
        email: 'facturacion@negocio.mx',
      })
    })

    it('actualiza el Customer existente y devuelve el mismo id', async () => {
      red.mockResolvedValue(responde(200, { id: 'cus_9' }))

      const id = await new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, existingCustomerId: 'cus_9' })

      expect(id).toBe('cus_9')
      expect(red).toHaveBeenCalledTimes(1)
      expect(llamada().url).toBe('https://www.facturapi.io/v2/customers/cus_9')
      expect(llamada().metodo).toBe('PUT')
    })

    it('si el Customer guardado ya no existe en Facturapi, crea uno nuevo en vez de fallar', async () => {
      red
        .mockResolvedValueOnce(responde(404, { code: 'customer_not_found', message: 'No se encontró el cliente.' }))
        .mockResolvedValueOnce(responde(201, { id: 'cus_nuevo' }))

      const id = await new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, existingCustomerId: 'cus_borrado' })

      expect(id).toBe('cus_nuevo')
      expect(llamada(1).metodo).toBe('POST')
    })

    // ── Normalización del nombre (Fase 4) ─────────────────────────────────────
    //
    // Este mismo Customer es el que después valida `validateCustomerTaxInfo()` contra el
    // padrón del SAT. Si aquí se guarda el nombre crudo (minúsculas / espacios de más) pero
    // `createInvoice` sí lo normaliza al timbrar, la validación previa contradice al timbrado
    // real: le dice al operador "está mal" cuando el mismo dato, ya normalizado, sí pasaría.

    it('crea el Customer con el legal_name normalizado aunque el receptor venga mal escrito', async () => {
      red.mockResolvedValue(responde(201, { id: 'cus_1' }))

      await new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, razonSocial: '  negocio   de prueba  ' })

      expect(llamada().cuerpo.legal_name).toBe('NEGOCIO DE PRUEBA')
    })

    it('actualiza el Customer existente con el legal_name normalizado aunque el receptor venga mal escrito', async () => {
      red.mockResolvedValue(responde(200, { id: 'cus_9' }))

      await new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, razonSocial: '  negocio   de prueba  ', existingCustomerId: 'cus_9' })

      expect(llamada().cuerpo.legal_name).toBe('NEGOCIO DE PRUEBA')
    })

    it('la recuperación por 404 (Customer borrado en Facturapi) también crea con el legal_name normalizado', async () => {
      red
        .mockResolvedValueOnce(responde(404, { code: 'customer_not_found', message: 'No se encontró el cliente.' }))
        .mockResolvedValueOnce(responde(201, { id: 'cus_nuevo' }))

      await new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, razonSocial: '  negocio   de prueba  ', existingCustomerId: 'cus_borrado' })

      expect(llamada(1).cuerpo.legal_name).toBe('NEGOCIO DE PRUEBA')
    })

    // ── Lo que Facturapi contesta de verdad (medido en modo de prueba el 3-nov-2026) ─────────────────────────────────

    it.each([
      ['un RFC que no está en la lista del SAT', 'tax_id_not_found', 'tax_id', 'rfc', 'Este RFC del receptor no existe en la lista de RFC inscritos no cancelados del SAT.'],
      ['un régimen que no le toca a ese RFC', 'tax_system_not_allowed_for_tax_id', 'tax_system', 'regimenFiscal', 'El régimen fiscal no está permitido para el RFC en los registros del SAT.'],
      ['un código postal que no existe', 'invalid_request', 'address.zip', 'codigoPostal', 'No se encontró el código postal "00000". Verifica que sea correcto.'],
    ])('🔴 %s es un rechazo con su campo, no una caída', async (_caso, code, path, field, message) => {
      red.mockResolvedValue(responde(400, { code, path, message }))

      const error = await new FacturapiProvider('sk_test_x').upsertCustomer(DATOS).catch(e => e)

      expect(error).toBeInstanceOf(CustomerDataRejectedError)
      expect(error.validation).toEqual({ valid: false, errors: [{ field, message }] })
    })

    it('🔴 un rechazo al actualizar no crea otro Customer', async () => {
      red.mockResolvedValue(responde(400, { code: 'tax_id_not_found', path: 'tax_id', message: 'No existe' }))

      await expect(new FacturapiProvider('sk_test_x').upsertCustomer({ ...DATOS, existingCustomerId: 'cus_9' })).rejects.toBeInstanceOf(
        CustomerDataRejectedError,
      )

      expect(red).toHaveBeenCalledTimes(1)
    })

    it.each([
      ['una llave mal', 401, { message: 'No autorizado' }],
      ['el proveedor caído', 503, { message: 'Servicio no disponible' }],
      ['un 400 que no dice qué campo', 400, { code: 'invalid_request', message: 'Algo salió mal' }],
    ])('%s NO es un veredicto sobre el receptor', async (_caso, status, cuerpo) => {
      red.mockResolvedValue(responde(status, cuerpo))

      const error = await new FacturapiProvider('sk_test_x').upsertCustomer(DATOS).catch(e => e)

      expect(error).toBeInstanceOf(ProviderHttpError)
      expect(error).not.toBeInstanceOf(CustomerDataRejectedError)
    })

    it('sin red tampoco es un veredicto', async () => {
      red.mockRejectedValue(new TypeError('fetch failed'))

      const error = await new FacturapiProvider('sk_test_x').upsertCustomer(DATOS).catch(e => e)

      expect(error).not.toBeInstanceOf(CustomerDataRejectedError)
    })
  })

  describe('validateCustomerTaxInfo', () => {
    it('mapea el path de Facturapi al campo del formulario', async () => {
      const validateTaxInfo = jest.fn().mockResolvedValue({
        is_valid: false,
        errors: [
          { path: 'legal_name', message: 'El nombre no coincide con el registrado en el SAT' },
          { path: 'address.zip', message: 'El CP no coincide' },
          { path: 'tax_system', message: 'Régimen incorrecto' },
          { path: 'tax_id', message: 'RFC no encontrado' },
        ],
      })
      const p = providerWith({ validateTaxInfo })

      const res = await p.validateCustomerTaxInfo('cus_1')

      expect(res.valid).toBe(false)
      expect(res.errors.map(e => e.field)).toEqual(['razonSocial', 'codigoPostal', 'regimenFiscal', 'rfc'])
      expect(res.errors[0].message).toMatch(/no coincide/i)
    })

    it('un path desconocido cae en "otro" sin perder el mensaje', async () => {
      const validateTaxInfo = jest.fn().mockResolvedValue({
        is_valid: false,
        errors: [{ path: 'algo_nuevo', message: 'Mensaje del PAC' }],
      })
      const p = providerWith({ validateTaxInfo })

      const res = await p.validateCustomerTaxInfo('cus_1')

      expect(res.errors).toEqual([{ field: 'otro', message: 'Mensaje del PAC' }])
    })

    it('devuelve valid=true sin errores cuando el SAT acepta los datos', async () => {
      const p = providerWith({ validateTaxInfo: jest.fn().mockResolvedValue({ is_valid: true, errors: [] }) })
      await expect(p.validateCustomerTaxInfo('cus_1')).resolves.toEqual({ valid: true, errors: [] })
    })
  })
})
