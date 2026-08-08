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
import { validateBillingTaxProfile } from '@/services/superadmin/platform-billing/billingTaxProfile.service'
import logger from '@/config/logger'

const mockUpload = uploadFileToStorage as jest.Mock
const mockDelete = deleteFileFromStorage as jest.Mock
const mockResolve = resolveFiscalProvider as jest.Mock

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
    prismaMock.billingTaxProfile.update.mockImplementation((args: any) => Promise.resolve({ ...PROFILE, ...args.data }))
    mockResolve.mockReturnValue({
      upsertCustomer: jest.fn().mockResolvedValue('cus_1'),
      validateCustomerTaxInfo: jest.fn().mockResolvedValue({ valid: true, errors: [] }),
    })

    const res = await validateBillingTaxProfile('p1')

    expect(res.validation).toEqual({ valid: true, errors: [] })
    expect(prismaMock.billingTaxProfile.update).toHaveBeenCalledWith(
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
    prismaMock.billingTaxProfile.update.mockImplementation((args: any) => Promise.resolve({ ...PROFILE, ...args.data }))
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
    expect(prismaMock.billingTaxProfile.update).toHaveBeenCalledWith(
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
    prismaMock.billingTaxProfile.update.mockRejectedValue(new Error('constraint violation'))
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
    // El profile devuelto es el original: el `update` falló, así que no hay `updated` que devolver,
    // pero el veredicto (arriba) sigue presente — nunca `validation: null`.
    expect(res.profile).toEqual(PROFILE)
    // Sí se intentó persistir con el veredicto correcto.
    expect(prismaMock.billingTaxProfile.update).toHaveBeenCalledWith(
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
})
