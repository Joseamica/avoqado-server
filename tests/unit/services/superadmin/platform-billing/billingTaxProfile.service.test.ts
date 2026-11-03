import { prismaMock } from '@tests/__helpers__/setup'

// Mock Firebase storage so the test never touches a real bucket.
jest.mock('@/services/storage.service', () => ({
  buildStoragePath: (p: string) => `dev/${p}`,
  uploadFileToStorage: jest.fn(),
  deleteFileFromStorage: jest.fn(),
}))
import { uploadFileToStorage, deleteFileFromStorage } from '@/services/storage.service'
import { uploadConstancia } from '@/services/superadmin/platform-billing/billingTaxProfile.service'

// Mock the fiscal provider factory so we control the PAC (Facturapi) boundary.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({
  resolveFiscalProvider: jest.fn(),
}))
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import {
  saveBillingTaxProfileIfSatAccepts,
  upsertBillingTaxProfile,
  validateBillingTaxProfile,
} from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import { CustomerDataRejectedError, type SatValidationResult } from '@/services/fiscal/providers/fiscal-provider.interface'
import logger from '@/config/logger'

const mockUpload = uploadFileToStorage as jest.Mock
const mockDelete = deleteFileFromStorage as jest.Mock
const mockResolve = resolveFiscalProvider as jest.Mock
const EMISOR = { id: 'em1', provider: 'FACTURAPI', providerKeyEnc: 'enc', csdStatus: 'ACTIVE', serie: 'A' }
const pac = (veredicto: unknown) => ({
  upsertCustomer: jest.fn().mockResolvedValue('cus_1'),
  validateCustomerTaxInfo: jest.fn().mockResolvedValue(veredicto),
})

describe('billingTaxProfile.service — uploadConstancia (NEW)', () => {
  it('uploads the file to Firebase under the profile path and stores the URL', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', constanciaUrl: null, venueId: null })
    mockUpload.mockResolvedValue('https://storage.googleapis.com/bucket/dev/platform-billing/tax-profiles/p1/constancia.pdf')
    prismaMock.billingTaxProfile.update.mockImplementation((args: any) => Promise.resolve({ id: 'p1', ...args.data }))

    const res = await uploadConstancia('p1', Buffer.from('%PDF-1.4 test').toString('base64'), 'application/pdf')

    expect(mockUpload).toHaveBeenCalledWith(
      expect.any(Buffer),
      expect.stringContaining('platform-billing/tax-profiles/p1/constancia.pdf'),
      'application/pdf',
    )
    expect(res.constanciaUrl).toContain('constancia.pdf')
  })

  it('best-effort deletes the prior constancia before replacing it', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', constanciaUrl: 'https://old/constancia.pdf', venueId: null })
    mockUpload.mockResolvedValue('https://new/constancia.pdf')
    prismaMock.billingTaxProfile.update.mockImplementation((args: any) => Promise.resolve({ id: 'p1', ...args.data }))

    await uploadConstancia('p1', Buffer.from('x').toString('base64'), 'application/pdf')

    expect(mockDelete).toHaveBeenCalledWith('https://old/constancia.pdf')
  })

  it('rejects when the profile is not found', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(null)
    await expect(uploadConstancia('nope', 'eA==', 'application/pdf')).rejects.toMatchObject({ code: 'NO_PROFILE' })
  })

  it('rejects an empty file', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', constanciaUrl: null })
    await expect(uploadConstancia('p1', '', 'application/pdf')).rejects.toMatchObject({ code: 'VALIDATION' })
  })
})

describe('validateBillingTaxProfile (fase 2)', () => {
  const PROFILE = {
    id: 'p1',
    rfc: 'GAL150211KT5',
    razonSocial: 'LA GALETERIE',
    regimenFiscal: '601',
    codigoPostal: '06400',
    email: 'facturacion@lagaleterie.mx',
    facturapiCustomerId: null,
    validationStatus: 'PENDING',
  }

  it('marca VALID y guarda el customerId cuando el SAT acepta los datos', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue({
      id: 'em1',
      provider: 'FACTURAPI',
      providerKeyEnc: 'enc',
      csdStatus: 'ACTIVE',
      serie: 'A',
    } as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 1 } as never)
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockResolvedValue('cus_1'),
      validateCustomerTaxInfo: jest.fn().mockResolvedValue({ valid: true, errors: [] }),
    })

    const res = await validateBillingTaxProfile('p1')

    expect(res.validation).toEqual({ valid: true, errors: [] })
    expect(prismaMock.billingTaxProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ facturapiCustomerId: 'cus_1', validationStatus: 'VALID' }),
      }),
    )
  })

  it('marca INVALID y devuelve el campo culpable cuando el SAT rechaza el nombre', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue({
      id: 'em1',
      provider: 'FACTURAPI',
      providerKeyEnc: 'enc',
      csdStatus: 'ACTIVE',
      serie: 'A',
    } as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 1 } as never)
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockResolvedValue('cus_1'),
      validateCustomerTaxInfo: jest.fn().mockResolvedValue({
        valid: false,
        errors: [{ field: 'razonSocial', message: 'El nombre no coincide con el SAT' }],
      }),
    })

    const res = await validateBillingTaxProfile('p1')

    expect(res.validation?.valid).toBe(false)
    expect(res.validation?.errors[0].field).toBe('razonSocial')
    expect(prismaMock.billingTaxProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ validationStatus: 'INVALID' }) }),
    )
  })

  it('si el PAC falla NO revienta: devuelve validation=null y deja el status como estaba', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue({
      id: 'em1',
      provider: 'FACTURAPI',
      providerKeyEnc: 'enc',
      csdStatus: 'ACTIVE',
      serie: 'A',
    } as never)
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
      validateCustomerTaxInfo: jest.fn(),
    })

    const res = await validateBillingTaxProfile('p1')

    expect(res.validation).toBeNull()
    expect(res.profile.validationStatus).toBe('PENDING')
  })

  it('sin emisor de plataforma devuelve validation=null en vez de reventar', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue(null)

    const res = await validateBillingTaxProfile('p1')
    expect(res.validation).toBeNull()
  })

  it('si el PAC responde OK pero falla la escritura local, el veredicto del SAT NO se pierde (bug propio ≠ PAC caído)', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue({
      id: 'em1',
      provider: 'FACTURAPI',
      providerKeyEnc: 'enc',
      csdStatus: 'ACTIVE',
      serie: 'A',
    } as never)
    prismaMock.billingTaxProfile.updateMany.mockRejectedValue(new Error('constraint violation'))
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockResolvedValue('cus_1'),
      validateCustomerTaxInfo: jest.fn().mockResolvedValue({ valid: true, errors: [] }),
    })
    const errorSpy = jest.spyOn(logger, 'error')
    const warnSpy = jest.spyOn(logger, 'warn')

    const res = await validateBillingTaxProfile('p1')

    // El SAT SÍ respondió (upsertCustomer + validateCustomerTaxInfo tuvieron éxito) — ese
    // veredicto no debe descartarse sólo porque la escritura local falló después.
    expect(res.validation).toEqual({ valid: true, errors: [] })
    // El profile devuelto es el original: la escritura falló, así que no hay `updated` que devolver,
    // pero el veredicto (arriba) sigue presente — nunca `validation: null`.
    expect(res.profile).toEqual(PROFILE)
    // Sí se intentó persistir con el veredicto correcto.
    expect(prismaMock.billingTaxProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ facturapiCustomerId: 'cus_1', validationStatus: 'VALID' }),
      }),
    )
    // Es un bug NUESTRO (falló nuestra escritura, no el PAC): nivel error, nunca warn —
    // así no se confunde en logs con una caída del proveedor.
    expect(errorSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy).not.toHaveBeenCalled()

    errorSpy.mockRestore()
    warnSpy.mockRestore()
  })

  it('rechaza si el perfil no existe', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(null)
    await expect(validateBillingTaxProfile('nope')).rejects.toMatchObject({ code: 'NO_PROFILE' })
  })

  it('🔴 «Revalidar» con un RFC que el proveedor rechaza: lo marca INVALID sin perder el cliente de Facturapi que ya tenía', async () => {
    const RECHAZO: SatValidationResult = { valid: false, errors: [{ field: 'rfc', message: 'El RFC no existe' }] }
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue(EMISOR as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 1 } as never)
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockRejectedValue(new CustomerDataRejectedError(RECHAZO)),
      validateCustomerTaxInfo: jest.fn(),
    })

    const res = await validateBillingTaxProfile('p1')

    expect(res.validation).toEqual(RECHAZO)
    const { data } = prismaMock.billingTaxProfile.updateMany.mock.calls[0][0]
    expect(data.validationStatus).toBe('INVALID')
    expect(data.facturapiCustomerId).toBeUndefined()
  })

  it('el veredicto sólo se escribe sobre los datos que se revisaron', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue(EMISOR as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 1 } as never)
    mockResolve.mockReturnValue(pac({ valid: true, errors: [] }))

    await validateBillingTaxProfile('p1')

    expect(prismaMock.billingTaxProfile.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'p1', rfc: PROFILE.rfc, razonSocial: PROFILE.razonSocial, regimenFiscal: PROFILE.regimenFiscal, codigoPostal: PROFILE.codigoPostal },
      }),
    )
  })

  it('🔴 si los datos cambiaron mientras el SAT contestaba, no presume nada sobre los de ahora', async () => {
    const AHORA = { ...PROFILE, rfc: 'NUE010101AAA', validationStatus: 'PENDING' }
    prismaMock.billingTaxProfile.findUnique.mockResolvedValueOnce(PROFILE as never).mockResolvedValueOnce(AHORA as never)
    prismaMock.platformEmisor.findFirst.mockResolvedValue(EMISOR as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 0 } as never)
    mockResolve.mockReturnValue(pac({ valid: true, errors: [] }))

    const res = await validateBillingTaxProfile('p1')

    expect(res.validation).toBeNull()
    expect(res.profile).toEqual(AHORA)
  })
})

describe('saveBillingTaxProfileIfSatAccepts: primero el SAT, después se guarda', () => {
  const BUENO = {
    id: 'v1',
    customerType: 'VENUE',
    venueId: 'venue1',
    rfc: 'BUE010101AAA',
    razonSocial: 'NEGOCIO BUENO',
    regimenFiscal: '601',
    codigoPostal: '06400',
    email: null,
    facturapiCustomerId: 'cus_viejo',
    validationStatus: 'VALID',
  }
  const TECLEADO = {
    customerType: 'VENUE' as const,
    venueId: 'venue1',
    rfc: ' mal010101aaa ',
    razonSocial: 'NEGOCIO BUENO',
    regimenFiscal: '601',
    codigoPostal: '06400',
    performedById: 'staff1',
  }
  const RECHAZO = { valid: false, errors: [{ field: 'rfc', message: 'El RFC no existe' }] }
  const ACEPTADO = { valid: true, errors: [] }
  const escribio = () =>
    [prismaMock.billingTaxProfile.upsert, prismaMock.billingTaxProfile.create, prismaMock.billingTaxProfile.update, prismaMock.billingTaxProfile.updateMany].filter(
      m => (m as jest.Mock).mock.calls.length > 0,
    ).length

  beforeEach(() => {
    prismaMock.platformEmisor.findFirst.mockResolvedValue(EMISOR as never)
    prismaMock.billingTaxProfile.upsert.mockImplementation((args: any) => Promise.resolve({ ...BUENO, ...args.update }))
  })

  it('🔴 el SAT rechaza: no escribe nada y regresa el perfil como estaba', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    mockResolve.mockReturnValue(pac(RECHAZO))

    const res = await saveBillingTaxProfileIfSatAccepts(TECLEADO)

    expect(res).toEqual({ saved: false, profile: BUENO, validation: RECHAZO, markedInvalid: false })
    expect(escribio()).toBe(0)
  })

  it('🔴 los MISMOS datos que ya estaban y el SAT los rechaza: dejan de estar «Verificados»', async () => {
    const YA_INVALIDO = { ...BUENO, validationStatus: 'INVALID' }
    prismaMock.billingTaxProfile.findUnique.mockResolvedValueOnce(BUENO as never).mockResolvedValueOnce(YA_INVALIDO as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 1 } as never)
    mockResolve.mockReturnValue(pac(RECHAZO))

    const res = await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, rfc: BUENO.rfc })

    expect(res).toEqual({ saved: false, profile: YA_INVALIDO, validation: RECHAZO, markedInvalid: true })
    expect(prismaMock.billingTaxProfile.updateMany.mock.calls[0][0].data).toEqual(expect.objectContaining({ validationStatus: 'INVALID' }))
    expect(prismaMock.billingTaxProfile.upsert).not.toHaveBeenCalled()
  })

  it('🔴 si otra pestaña corrigió el perfil mientras el SAT contestaba, no se dice que dejó de estar verificado: no cambió', async () => {
    const CORREGIDO = { ...BUENO, rfc: 'COR010101AAA' }
    prismaMock.billingTaxProfile.findUnique.mockResolvedValueOnce(BUENO as never).mockResolvedValueOnce(CORREGIDO as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 0 } as never)
    mockResolve.mockReturnValue(pac(RECHAZO))

    const res = await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, rfc: BUENO.rfc })

    expect(res).toEqual({ saved: false, profile: CORREGIDO, validation: RECHAZO, markedInvalid: false })
  })

  it('🔴 si falla la escritura local, tampoco: el perfil sigue como estaba', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    prismaMock.billingTaxProfile.updateMany.mockRejectedValue(new Error('constraint violation'))
    mockResolve.mockReturnValue(pac(RECHAZO))
    const errorSpy = jest.spyOn(logger, 'error').mockImplementation()

    const res = await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, rfc: BUENO.rfc })

    expect(res).toEqual({ saved: false, profile: BUENO, validation: RECHAZO, markedInvalid: false })
    errorSpy.mockRestore()
  })

  it('volver a intentar con datos ya marcados INVALID no es un cambio de estado: no hay nada nuevo que registrar', async () => {
    const YA_INVALIDO = { ...BUENO, validationStatus: 'INVALID' }
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(YA_INVALIDO as never)
    prismaMock.billingTaxProfile.updateMany.mockResolvedValue({ count: 1 } as never)
    mockResolve.mockReturnValue(pac(RECHAZO))

    const res = await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, rfc: BUENO.rfc })

    expect(res).toEqual(expect.objectContaining({ saved: false, markedInvalid: false }))
  })

  it('🔴 cliente externo con un RFC rechazado: no deja ninguna fila nueva, y no hay perfil que regresar', async () => {
    prismaMock.billingTaxProfile.findFirst.mockResolvedValue(null)
    mockResolve.mockReturnValue(pac(RECHAZO))

    const res = await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, customerType: 'STANDALONE', venueId: undefined, displayName: 'Cliente' })

    expect(res).toEqual({ saved: false, profile: null, validation: RECHAZO, markedInvalid: false })
    expect(escribio()).toBe(0)
  })

  it('🔴 un RFC que el proveedor rechaza al dar de alta el cliente es un rechazo, no «el SAT no contestó»: no se guarda', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockRejectedValue(new CustomerDataRejectedError(RECHAZO as SatValidationResult)),
      validateCustomerTaxInfo: jest.fn(),
    })

    const res = await saveBillingTaxProfileIfSatAccepts(TECLEADO)

    expect(res).toEqual({ saved: false, profile: BUENO, validation: RECHAZO, markedInvalid: false })
    expect(escribio()).toBe(0)
  })

  it('le pregunta al SAT por lo tecleado, no por lo guardado, y con el cliente de Facturapi que ya tenía', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    const proveedor = pac(RECHAZO)
    mockResolve.mockReturnValue(proveedor)

    await saveBillingTaxProfileIfSatAccepts(TECLEADO)

    expect(proveedor.upsertCustomer).toHaveBeenCalledWith(
      expect.objectContaining({ rfc: 'MAL010101AAA', existingCustomerId: 'cus_viejo' }),
    )
  })

  it('🔴 el SAT acepta: los datos y «VALID» entran en UNA sola escritura', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    mockResolve.mockReturnValue(pac(ACEPTADO))

    const res = await saveBillingTaxProfileIfSatAccepts(TECLEADO)

    expect(res.saved).toBe(true)
    expect(res.validation).toEqual(ACEPTADO)
    expect(prismaMock.billingTaxProfile.upsert).toHaveBeenCalledTimes(1)
    expect(prismaMock.billingTaxProfile.upsert.mock.calls[0][0].update).toEqual(
      expect.objectContaining({ rfc: 'MAL010101AAA', facturapiCustomerId: 'cus_1', validationStatus: 'VALID', validatedAt: expect.any(Date) }),
    )
    expect(prismaMock.billingTaxProfile.update).not.toHaveBeenCalled()
    expect(prismaMock.billingTaxProfile.updateMany).not.toHaveBeenCalled()
  })

  it('cliente externo nuevo aceptado: nace con su veredicto', async () => {
    prismaMock.billingTaxProfile.findFirst.mockResolvedValue(null)
    prismaMock.billingTaxProfile.create.mockImplementation((args: any) => Promise.resolve({ id: 's1', ...args.data }))
    mockResolve.mockReturnValue(pac(ACEPTADO))

    const res = await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, customerType: 'STANDALONE', venueId: undefined, displayName: 'Cliente' })

    expect(res.saved).toBe(true)
    expect(prismaMock.billingTaxProfile.create.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ rfc: 'MAL010101AAA', displayName: 'Cliente', validationStatus: 'VALID' }),
    )
  })

  it('🔴 el SAT no contesta y cambió un dato fiscal: guarda, sin presumir «VALID»', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    mockResolve.mockReturnValue({ upsertCustomer: jest.fn().mockRejectedValue(new Error('ECONNRESET')), validateCustomerTaxInfo: jest.fn() })

    const res = await saveBillingTaxProfileIfSatAccepts(TECLEADO)

    expect(res.saved).toBe(true)
    expect(res.validation).toBeNull()
    expect(prismaMock.billingTaxProfile.upsert.mock.calls[0][0].update).toEqual(
      expect.objectContaining({ rfc: 'MAL010101AAA', validationStatus: 'PENDING', validatedAt: null }),
    )
  })

  it('el SAT no contesta y sólo cambió el correo: lo ya verificado sigue verificado', async () => {
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)
    mockResolve.mockReturnValue({ upsertCustomer: jest.fn().mockRejectedValue(new Error('ECONNRESET')), validateCustomerTaxInfo: jest.fn() })

    await saveBillingTaxProfileIfSatAccepts({ ...TECLEADO, rfc: BUENO.rfc, email: 'nuevo@correo.mx' })

    const { update } = prismaMock.billingTaxProfile.upsert.mock.calls[0][0]
    expect(update.email).toBe('nuevo@correo.mx')
    expect(update).not.toHaveProperty('validationStatus')
  })

  it('sin emisor de plataforma también se guarda: nunca deja sin poder capturar', async () => {
    prismaMock.platformEmisor.findFirst.mockResolvedValue(null)
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(BUENO as never)

    const res = await saveBillingTaxProfileIfSatAccepts(TECLEADO)

    expect(res.saved).toBe(true)
    expect(res.validation).toBeNull()
    expect(mockResolve).not.toHaveBeenCalled()
  })
})

describe('upsertBillingTaxProfile sin veredicto (el DASHBOARD)', () => {
  it('sigue guardando sin tocar la validación', async () => {
    prismaMock.billingTaxProfile.upsert.mockImplementation((args: any) => Promise.resolve({ id: 'v1', ...args.update }))

    await upsertBillingTaxProfile({ customerType: 'VENUE', venueId: 'venue1', rfc: 'BUE010101AAA', razonSocial: 'NEGOCIO', regimenFiscal: '601', codigoPostal: '06400' })

    const { update } = prismaMock.billingTaxProfile.upsert.mock.calls[0][0]
    expect(update).not.toHaveProperty('validationStatus')
    expect(update).not.toHaveProperty('facturapiCustomerId')
  })
})
