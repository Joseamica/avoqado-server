import { prismaMock } from '@tests/__helpers__/setup'

// Mock the fiscal provider factory so we control the PAC (Facturapi) boundary.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({
  resolveFiscalProvider: jest.fn(),
}))
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import {
  computePlatformCfdiTotals,
  issuePlatformCfdi,
  cancelPlatformCfdi,
  registerPlatformPayment,
  sendPlatformCfdiEmail,
} from '@/services/superadmin/platform-billing/platformCfdi.service'
import { PlatformBillingError } from '@/services/superadmin/platform-billing/platformEmisor.service'

const mockResolve = resolveFiscalProvider as jest.Mock

const ACTIVE_EMISOR = {
  id: 'em1',
  provider: 'FACTURAPI',
  providerKeyEnc: 'enc-key',
  csdStatus: 'ACTIVE',
  serie: 'A',
  defaultUsoCfdi: null,
}

const PROFILE = {
  id: 'p1',
  rfc: 'XAXX010101000',
  razonSocial: 'Cliente Demo SA de CV',
  regimenFiscal: '601',
  codigoPostal: '06000',
  defaultUsoCfdi: 'G03',
  email: 'cliente@demo.mx',
  organizationId: 'org1',
  venueId: null,
}

const STAMPED = {
  providerInvoiceId: 'fa-inv-1',
  uuid: 'UUID-0001',
  serie: 'A',
  folio: '123',
  totalCents: 185484,
  stampedAt: new Date('2026-06-27T12:00:00Z'),
  status: 'valid' as const,
}

describe('platformCfdi.service', () => {
  describe('computePlatformCfdiTotals (NEW)', () => {
    it('computes the 1599+IVA monthly fee preset to the cent (IVA add-on)', () => {
      const totals = computePlatformCfdiTotals([
        { description: 'Mensualidad', satProductKey: '81161700', satUnitKey: 'E48', quantity: 1, unitPriceCents: 159900 },
      ])
      expect(totals).toEqual({ subtotalCents: 159900, discountCents: 0, taxCents: 25584, totalCents: 185484 })
    })

    it('sums multiple lines and respects discounts', () => {
      const totals = computePlatformCfdiTotals([
        { description: 'A', satProductKey: '1', satUnitKey: 'E48', quantity: 2, unitPriceCents: 10000 },
        { description: 'B', satProductKey: '2', satUnitKey: 'H87', quantity: 1, unitPriceCents: 50000, discountCents: 5000 },
      ])
      // importe = 20000 + 50000 = 70000; discount = 5000; base = 65000; tax = round(20000*.16)+round(45000*.16)=3200+7200=10400
      expect(totals).toEqual({ subtotalCents: 70000, discountCents: 5000, taxCents: 10400, totalCents: 75400 })
    })

    it('treats tax-exempt lines as zero IVA', () => {
      const totals = computePlatformCfdiTotals([
        { description: 'Exento', satProductKey: '1', satUnitKey: 'E48', quantity: 1, unitPriceCents: 100000, taxExempt: true },
      ])
      expect(totals).toEqual({ subtotalCents: 100000, discountCents: 0, taxCents: 0, totalCents: 100000 })
    })
  })

  describe('issuePlatformCfdi (NEW)', () => {
    const baseInput = {
      billingTaxProfileId: 'p1',
      lines: [{ description: 'Mensualidad', satProductKey: '81161700', satUnitKey: 'E48', quantity: 1, unitPriceCents: 159900 }],
      formaPago: '04',
      metodoPago: 'PUE' as const,
      idempotencyKey: 'idem-1',
      performedById: 'staff-1',
    }

    it('stamps a PUE income CFDI and persists STAMPED with the timbre', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null) // no prior idempotent row
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'cfdi1', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'cfdi1', ...args.data }))
      const createInvoice = jest.fn().mockResolvedValue(STAMPED)
      mockResolve.mockReturnValue({ createInvoice })

      const result = await issuePlatformCfdi(baseInput)

      expect(createInvoice).toHaveBeenCalledWith(
        expect.objectContaining({
          formaPago: '04',
          metodoPago: 'PUE',
          serie: 'A',
          externalId: 'idem-1',
          receptor: expect.objectContaining({ rfc: 'XAXX010101000', usoCfdi: 'G03' }),
        }),
      )
      // money snapshot persisted on the reserve row
      expect(prismaMock.platformCfdi.create).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ totalCents: 185484, status: 'STAMPING', type: 'INGRESO' }) }),
      )
      expect(result.status).toBe('STAMPED')
      expect(result.uuid).toBe('UUID-0001')
    })

    it('passes metodoPago=PPD through for invoice-before-payment', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'cfdi2', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'cfdi2', ...args.data }))
      const createInvoice = jest.fn().mockResolvedValue(STAMPED)
      mockResolve.mockReturnValue({ createInvoice })

      await issuePlatformCfdi({ ...baseInput, idempotencyKey: 'idem-2', metodoPago: 'PPD', formaPago: '99' })

      expect(createInvoice).toHaveBeenCalledWith(expect.objectContaining({ metodoPago: 'PPD', formaPago: '99' }))
    })

    it('is idempotent: a repeated idempotencyKey returns the prior row WITHOUT re-stamping', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'cfdiX', status: 'STAMPED', uuid: 'UUID-X' })
      const createInvoice = jest.fn()
      mockResolve.mockReturnValue({ createInvoice })

      const result = await issuePlatformCfdi(baseInput)

      expect(result.id).toBe('cfdiX')
      expect(createInvoice).not.toHaveBeenCalled()
    })

    it('throws NO_EMISOR when no platform emisor is configured', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(null)
      await expect(issuePlatformCfdi(baseInput)).rejects.toMatchObject({ code: 'NO_EMISOR' })
    })

    it('refuses to stamp (non-sandbox) when the CSD is not ACTIVE', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      prismaMock.platformEmisor.findFirst.mockResolvedValue({ ...ACTIVE_EMISOR, csdStatus: 'NONE' })
      await expect(issuePlatformCfdi(baseInput)).rejects.toMatchObject({ code: 'CSD_INACTIVE' })
    })

    it('rejects an empty concept list', async () => {
      await expect(issuePlatformCfdi({ ...baseInput, lines: [] })).rejects.toBeInstanceOf(PlatformBillingError)
    })
  })

  describe('cancelPlatformCfdi (NEW)', () => {
    it('requires a substitute UUID for motivo 01', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'c1', status: 'STAMPED', facturapiId: 'fa1', platformEmisorId: 'em1' })
      await expect(cancelPlatformCfdi('c1', '01')).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('refuses to cancel a CFDI that is not STAMPED', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'c1', status: 'DRAFT', facturapiId: null, platformEmisorId: 'em1' })
      await expect(cancelPlatformCfdi('c1', '02')).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })

  describe('registerPlatformPayment (NEW — complemento de pago / REP)', () => {
    const PPD_PARENT = {
      id: 'inv1',
      type: 'INGRESO',
      metodoPago: 'PPD',
      status: 'STAMPED',
      uuid: 'UUID-PPD',
      totalCents: 185484,
      amountPaidCents: 0,
      subtotalCents: 159900,
      discountCents: 0,
      taxCents: 25584,
      serie: 'A',
      billingTaxProfileId: 'p1',
      organizationId: 'org1',
      venueId: null,
      receptorRfc: 'XAXX010101000',
      receptorNombre: 'Cliente Demo',
      receptorRegimen: '601',
      receptorCp: '06000',
      lines: [
        { description: 'Mensualidad', satProductKey: '81161700', satUnitKey: 'E48', quantity: 1, unitPriceCents: 159900, taxRate: 0.16 },
      ],
    }
    const baseInput = {
      platformCfdiId: 'inv1',
      paymentDate: '2026-06-28T12:00:00',
      formaPago: '03',
      idempotencyKey: 'pay-1',
      performedById: 'staff-1',
    }

    it('stamps a REP, increments parent amountPaidCents, sends the right related-doc taxes', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(PPD_PARENT)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'rep1', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: args.where.id, ...args.data }))
      const createPaymentComplement = jest.fn().mockResolvedValue({
        providerInvoiceId: 'fa-rep',
        uuid: 'UUID-REP',
        serie: 'A',
        folio: '9',
        stampedAt: new Date('2026-06-28T12:00:00Z'),
        status: 'valid',
      })
      mockResolve.mockReturnValue({ createPaymentComplement })

      const rep = await registerPlatformPayment(baseInput)

      expect(createPaymentComplement).toHaveBeenCalledWith(
        expect.objectContaining({
          paymentForm: '03',
          relatedDocuments: [
            expect.objectContaining({
              uuid: 'UUID-PPD',
              amountCents: 185484,
              installment: 1,
              lastBalanceCents: 185484,
              taxes: [{ baseCents: 159900, rate: 0.16, type: 'IVA', factor: 'Tasa', withholding: false }],
            }),
          ],
        }),
      )
      expect(prismaMock.platformCfdi.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv1' }, data: { amountPaidCents: { increment: 185484 } } }),
      )
      expect(rep.status).toBe('STAMPED')
      expect(rep.uuid).toBe('UUID-REP')
    })

    it('rejects a PUE invoice (no complemento needed)', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...PPD_PARENT, metodoPago: 'PUE' })
      await expect(registerPlatformPayment({ ...baseInput, idempotencyKey: 'p2' })).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects when a payment is already registered (parcialidades unsupported in MVP)', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...PPD_PARENT, amountPaidCents: 185484 })
      await expect(registerPlatformPayment({ ...baseInput, idempotencyKey: 'p3' })).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('is idempotent: a repeated key returns the prior REP without re-stamping', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce({ id: 'repX', status: 'STAMPED' })
      const createPaymentComplement = jest.fn()
      mockResolve.mockReturnValue({ createPaymentComplement })
      const rep = await registerPlatformPayment({ ...baseInput, idempotencyKey: 'dup' })
      expect(rep.id).toBe('repX')
      expect(createPaymentComplement).not.toHaveBeenCalled()
    })
  })

  describe('sendPlatformCfdiEmail (NEW)', () => {
    it('sends a stamped CFDI with the override email and stamps emailSentAt', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'STAMPED',
        facturapiId: 'fa1',
        platformEmisorId: 'em1',
        billingTaxProfileId: 'p1',
      })
      prismaMock.platformEmisor.findUnique.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'c1', ...args.data }))
      const sendInvoiceByEmail = jest.fn().mockResolvedValue(undefined)
      mockResolve.mockReturnValue({ sendInvoiceByEmail })

      const res = await sendPlatformCfdiEmail('c1', 'cliente@demo.mx')

      expect(sendInvoiceByEmail).toHaveBeenCalledWith('fa1', 'cliente@demo.mx')
      expect(res.emailSentAt).toBeTruthy()
    })

    it('falls back to the receptor profile email when no override is given', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'STAMPED',
        facturapiId: 'fa1',
        platformEmisorId: 'em1',
        billingTaxProfileId: 'p1',
      })
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', email: 'perfil@demo.mx' })
      prismaMock.platformEmisor.findUnique.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'c1', ...args.data }))
      const sendInvoiceByEmail = jest.fn().mockResolvedValue(undefined)
      mockResolve.mockReturnValue({ sendInvoiceByEmail })

      await sendPlatformCfdiEmail('c1')

      expect(sendInvoiceByEmail).toHaveBeenCalledWith('fa1', 'perfil@demo.mx')
    })

    it('rejects when there is no email (override nor profile)', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({
        id: 'c1',
        status: 'STAMPED',
        facturapiId: 'fa1',
        platformEmisorId: 'em1',
        billingTaxProfileId: 'p1',
      })
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue({ id: 'p1', email: null })
      await expect(sendPlatformCfdiEmail('c1')).rejects.toMatchObject({ code: 'VALIDATION' })
    })

    it('rejects sending a CFDI that is not STAMPED', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'c1', status: 'DRAFT', facturapiId: null, platformEmisorId: 'em1' })
      await expect(sendPlatformCfdiEmail('c1', 'x@y.com')).rejects.toMatchObject({ code: 'VALIDATION' })
    })
  })
})
