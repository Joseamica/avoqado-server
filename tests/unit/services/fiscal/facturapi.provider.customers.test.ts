import { FacturapiProvider } from '@/services/fiscal/providers/facturapi.provider'

/** Construye un provider con un cliente SDK falso inyectado. */
function providerWith(customers: Record<string, jest.Mock>) {
  const p = new FacturapiProvider('sk_test_x')
  // El cliente del SDK es privado; lo sustituimos para aislar la llamada de red.
  ;(p as unknown as { client: unknown }).client = { customers }
  return p
}

describe('FacturapiProvider — customers', () => {
  describe('upsertCustomer', () => {
    it('crea un Customer nuevo y devuelve su id cuando no hay existingCustomerId', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'cus_1' })
      const p = providerWith({ create, update: jest.fn() })

      const id = await p.upsertCustomer({
        rfc: 'GAL150211KT5',
        razonSocial: 'LA GALETERIE',
        regimenFiscal: '601',
        codigoPostal: '06400',
        email: 'facturacion@lagaleterie.mx',
      })

      expect(id).toBe('cus_1')
      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          legal_name: 'LA GALETERIE',
          tax_id: 'GAL150211KT5',
          tax_system: '601',
          address: { zip: '06400' },
          email: 'facturacion@lagaleterie.mx',
        }),
      )
    })

    it('actualiza el Customer existente y devuelve el mismo id', async () => {
      const update = jest.fn().mockResolvedValue({ id: 'cus_9' })
      const create = jest.fn()
      const p = providerWith({ create, update })

      const id = await p.upsertCustomer({
        rfc: 'GAL150211KT5',
        razonSocial: 'LA GALETERIE',
        regimenFiscal: '601',
        codigoPostal: '06400',
        existingCustomerId: 'cus_9',
      })

      expect(id).toBe('cus_9')
      expect(update).toHaveBeenCalledWith('cus_9', expect.objectContaining({ legal_name: 'LA GALETERIE' }))
      expect(create).not.toHaveBeenCalled()
    })

    it('si el Customer guardado ya no existe en Facturapi, crea uno nuevo en vez de fallar', async () => {
      const update = jest.fn().mockRejectedValue(new Error('Request failed with status code 404'))
      const create = jest.fn().mockResolvedValue({ id: 'cus_nuevo' })
      const p = providerWith({ create, update })

      const id = await p.upsertCustomer({
        rfc: 'GAL150211KT5',
        razonSocial: 'LA GALETERIE',
        regimenFiscal: '601',
        codigoPostal: '06400',
        existingCustomerId: 'cus_borrado',
      })

      expect(id).toBe('cus_nuevo')
      expect(create).toHaveBeenCalled()
    })

    // ── Normalización del nombre (Fase 4) ─────────────────────────────────────
    //
    // Este mismo Customer es el que después valida `validateCustomerTaxInfo()` contra el
    // padrón del SAT. Si aquí se guarda el nombre crudo (minúsculas / espacios de más) pero
    // `createInvoice` sí lo normaliza al timbrar, la validación previa contradice al timbrado
    // real: le dice al operador "está mal" cuando el mismo dato, ya normalizado, sí pasaría.

    it('crea el Customer con el legal_name normalizado aunque el receptor venga mal escrito', async () => {
      const create = jest.fn().mockResolvedValue({ id: 'cus_1' })
      const p = providerWith({ create, update: jest.fn() })

      await p.upsertCustomer({
        rfc: 'GAL150211KT5',
        razonSocial: '  la   galeterie  ',
        regimenFiscal: '601',
        codigoPostal: '06400',
      })

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ legal_name: 'LA GALETERIE' }))
    })

    it('actualiza el Customer existente con el legal_name normalizado aunque el receptor venga mal escrito', async () => {
      const update = jest.fn().mockResolvedValue({ id: 'cus_9' })
      const p = providerWith({ create: jest.fn(), update })

      await p.upsertCustomer({
        rfc: 'GAL150211KT5',
        razonSocial: '  la   galeterie  ',
        regimenFiscal: '601',
        codigoPostal: '06400',
        existingCustomerId: 'cus_9',
      })

      expect(update).toHaveBeenCalledWith('cus_9', expect.objectContaining({ legal_name: 'LA GALETERIE' }))
    })

    it('la recuperación por 404 (Customer borrado en Facturapi) también crea con el legal_name normalizado', async () => {
      const update = jest.fn().mockRejectedValue(new Error('Request failed with status code 404'))
      const create = jest.fn().mockResolvedValue({ id: 'cus_nuevo' })
      const p = providerWith({ create, update })

      await p.upsertCustomer({
        rfc: 'GAL150211KT5',
        razonSocial: '  la   galeterie  ',
        regimenFiscal: '601',
        codigoPostal: '06400',
        existingCustomerId: 'cus_borrado',
      })

      expect(create).toHaveBeenCalledWith(expect.objectContaining({ legal_name: 'LA GALETERIE' }))
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
