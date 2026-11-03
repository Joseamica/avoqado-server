import { prismaMock } from '@tests/__helpers__/setup'
import logger from '@/config/logger'
import { ConflictError } from '@/errors/AppError'
import { issueInvoiceSchema } from '@/routes/superadmin/billing.schemas'

// Mock the fiscal provider factory so we control the PAC (Facturapi) boundary.
jest.mock('@/services/fiscal/fiscalProvider.factory', () => ({
  resolveFiscalProvider: jest.fn(),
}))
import { resolveFiscalProvider } from '@/services/fiscal/fiscalProvider.factory'
import { ProviderHttpError } from '@/services/fiscal/providers/facturapi.provider'
import {
  computePlatformCfdiTotals,
  classifyStampError,
  issuePlatformCfdi,
  cancelPlatformCfdi,
  discardFailedPlatformCfdi,
  fetchPlatformCfdiArtifact,
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

  describe('classifyStampError', () => {
    const SAT_NOMBRE = 'El campo Nombre del receptor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Receptor.'

    it('clasifica un rechazo del Nombre como razonSocial aunque el mensaje también mencione el RFC', () => {
      const info = classifyStampError(SAT_NOMBRE)
      expect(info.code).toBe('VALIDATION')
      expect(info.field).toBe('razonSocial')
      expect(info.message).toMatch(/razón social/i)
    })

    it('conserva SIEMPRE el mensaje crudo del SAT dentro del mensaje al operador', () => {
      expect(classifyStampError(SAT_NOMBRE).message).toContain(SAT_NOMBRE)
    })

    it('clasifica DomicilioFiscalReceptor como codigoPostal', () => {
      const info = classifyStampError(
        'Validación de timbrado: El campo DomicilioFiscalReceptor del receptor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Receptor.',
      )
      expect(info.field).toBe('codigoPostal')
      expect(info.code).toBe('VALIDATION')
    })

    it('clasifica RegimenFiscalReceptor como regimenFiscal', () => {
      const info = classifyStampError('El campo RegimenFiscalReceptor del receptor no es válido.')
      expect(info.field).toBe('regimenFiscal')
    })

    it('clasifica un rechazo directo del Rfc como rfc', () => {
      const info = classifyStampError('El campo Rfc del receptor no se encuentra en el listado del SAT.')
      expect(info.field).toBe('rfc')
    })

    it('marca la llave del emisor como PROVIDER (falla de infraestructura, no dato corregible)', () => {
      expect(classifyStampError('Unsupported state or unable to authenticate data')).toMatchObject({
        code: 'PROVIDER',
      })
      expect(classifyStampError('bad decrypt').message).toMatch(/llave del emisor/i)
    })

    it('marca un 401 de Facturapi como PROVIDER', () => {
      expect(classifyStampError('Request failed with status code 401')).toMatchObject({ code: 'PROVIDER' })
      expect(classifyStampError('Unauthorized').message).toMatch(/facturapi rechazó la llave/i)
    })

    it('marca una clave SAT/unidad inexistente como VALIDATION, sin campo de receptor', () => {
      const info = classifyStampError('Couldn\'t find unit_key "Uno"')
      expect(info.code).toBe('VALIDATION')
      expect(info.field).toBeUndefined()
      expect(info.message).toMatch(/clave sat o la unidad/i)
      expect(info.message).toContain('unit_key')
    })

    it('marca un rechazo del receptor sin campo identificable como VALIDATION sin field', () => {
      const info = classifyStampError('Los datos del receptor no pudieron validarse.')
      expect(info.code).toBe('VALIDATION')
      expect(info.field).toBeUndefined()
    })

    it('deja pasar un mensaje desconocido tal cual, como PROVIDER', () => {
      expect(classifyStampError('Algo salió mal en el servidor')).toEqual({
        code: 'PROVIDER',
        message: 'Algo salió mal en el servidor',
      })
    })

    // ── Regresión Fase 1 (Important #1): el ancla de "401" no debe cazar subcadenas ──
    // CFDI40147 es el código real del SAT para "Nombre del receptor no coincide". Contiene la
    // subcadena "401". Antes del fix, `msg.includes('401')` clasificaba esto como PROVIDER (falla
    // de credenciales) ANTES de siquiera llegar a RECEPTOR_RULES, perdiendo el mensaje crudo del
    // SAT (las ramas PROVIDER de credenciales no llaman withRaw()). Este es el caso exacto que la
    // Fase 1 existe para arreglar — reproducirlo sería reintroducir el bug original.
    it('CFDI40147 (código SAT que contiene "401" como subcadena) clasifica VALIDATION razonSocial, no PROVIDER', () => {
      const info = classifyStampError(
        'CFDI40147 - El campo Nombre del receptor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Receptor.',
      )
      expect(info.code).toBe('VALIDATION')
      expect(info.field).toBe('razonSocial')
      expect(info.message).toContain('CFDI40147')
    })

    it('un monto como 1401.00 en el mensaje no lo desvía a PROVIDER por contener "401"', () => {
      const info = classifyStampError('Los datos del receptor no pudieron validarse. Monto rechazado: 1401.00')
      expect(info.code).toBe('VALIDATION')
    })

    it('guardarraíl: "Request failed with status code 401" (401 real, con límite de palabra) SIGUE clasificando PROVIDER', () => {
      expect(classifyStampError('Request failed with status code 401')).toMatchObject({ code: 'PROVIDER' })
    })

    // ── Minor #3: RECEPTOR_RULES no debe cazar rechazos del EMISOR ──
    it('un rechazo de Nombre del EMISOR (no receptor) no debe devolver field: razonSocial', () => {
      const info = classifyStampError(
        'El campo Nombre del emisor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Emisor.',
      )
      expect(info.field).not.toBe('razonSocial')
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

    it('on a PAC stamp failure: persists the RAW message in lastError but throws the HUMANIZED one', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'cfdiX', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'cfdiX', ...args.data }))
      const createInvoice = jest.fn().mockRejectedValue(new Error('Unauthorized'))
      mockResolve.mockReturnValue({ createInvoice })

      await expect(issuePlatformCfdi(baseInput)).rejects.toMatchObject({
        code: 'PROVIDER',
        message: expect.stringMatching(/facturapi rechazó la llave/i),
      })

      expect(prismaMock.platformCfdi.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STAMP_FAILED', lastError: 'Unauthorized' }) }),
      )
    })

    it('un rechazo del Nombre por el SAT sale como VALIDATION con field=razonSocial', async () => {
      const SAT = 'El campo Nombre del receptor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Receptor.'
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'cfdiN', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'cfdiN', ...args.data }))
      mockResolve.mockReturnValue({ createInvoice: jest.fn().mockRejectedValue(new Error(SAT)) })

      await expect(issuePlatformCfdi(baseInput)).rejects.toMatchObject({
        code: 'VALIDATION',
        field: 'razonSocial',
        message: expect.stringMatching(/razón social/i),
      })
    })

    it('el mensaje que ve el operador incluye el texto CRUDO del SAT, no sólo la guía', async () => {
      const SAT = 'El campo Nombre del receptor, debe pertenecer al nombre asociado al RFC registrado en el campo Rfc del Receptor.'
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'cfdiR', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'cfdiR', ...args.data }))
      mockResolve.mockReturnValue({ createInvoice: jest.fn().mockRejectedValue(new Error(SAT)) })

      await expect(issuePlatformCfdi(baseInput)).rejects.toMatchObject({
        message: expect.stringContaining(SAT),
      })

      // El crudo se sigue guardando tal cual en lastError.
      expect(prismaMock.platformCfdi.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'STAMP_FAILED', lastError: SAT }) }),
      )
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
      prismaMock.platformCfdi.count.mockResolvedValue(0)
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

    it('allows a PARTIAL payment: REP for the amount, parent bumped by that amount, proportional IVA', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce(PPD_PARENT)
      prismaMock.platformCfdi.count.mockResolvedValue(0)
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'rep1', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: args.where.id, ...args.data }))
      const createPaymentComplement = jest.fn().mockResolvedValue({
        providerInvoiceId: 'fa-rep',
        uuid: 'UUID-REP',
        serie: 'A',
        folio: '9',
        stampedAt: new Date(),
        status: 'valid',
      })
      mockResolve.mockReturnValue({ createPaymentComplement })

      // Pago de la mitad (92742¢ de 185484¢) → base = round(92742/1.16) = 79950
      await registerPlatformPayment({ ...baseInput, idempotencyKey: 'partial-1', amountCents: 92742 })

      expect(createPaymentComplement).toHaveBeenCalledWith(
        expect.objectContaining({
          relatedDocuments: [
            expect.objectContaining({
              amountCents: 92742,
              installment: 1,
              lastBalanceCents: 185484,
              taxes: [{ baseCents: 79950, rate: 0.16, type: 'IVA', factor: 'Tasa', withholding: false }],
            }),
          ],
        }),
      )
      expect(prismaMock.platformCfdi.update).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'inv1' }, data: { amountPaidCents: { increment: 92742 } } }),
      )
    })

    it('numbers the second installment correctly and uses the remaining balance', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...PPD_PARENT, amountPaidCents: 92742 })
      prismaMock.platformCfdi.count.mockResolvedValue(1) // one prior REP already stamped
      prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
      prismaMock.platformCfdi.create.mockResolvedValue({ id: 'rep2', status: 'STAMPING' })
      prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: args.where.id, ...args.data }))
      const createPaymentComplement = jest.fn().mockResolvedValue({
        providerInvoiceId: 'fa-rep2',
        uuid: 'UUID-REP2',
        serie: 'A',
        folio: '10',
        stampedAt: new Date(),
        status: 'valid',
      })
      mockResolve.mockReturnValue({ createPaymentComplement })

      await registerPlatformPayment({ ...baseInput, idempotencyKey: 'partial-2' }) // sin monto → saldo restante 92742

      expect(createPaymentComplement).toHaveBeenCalledWith(
        expect.objectContaining({
          relatedDocuments: [expect.objectContaining({ amountCents: 92742, installment: 2, lastBalanceCents: 92742 })],
        }),
      )
    })

    it('rejects an amount over the remaining balance', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...PPD_PARENT, amountPaidCents: 92742 })
      await expect(registerPlatformPayment({ ...baseInput, idempotencyKey: 'over', amountCents: 100000 })).rejects.toMatchObject({
        code: 'VALIDATION',
      })
    })

    it('rejects when the invoice is already fully paid', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValueOnce(null).mockResolvedValueOnce({ ...PPD_PARENT, amountPaidCents: 185484 })
      await expect(registerPlatformPayment({ ...baseInput, idempotencyKey: 'paid' })).rejects.toMatchObject({ code: 'VALIDATION' })
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

  describe('discardFailedPlatformCfdi (NEW)', () => {
    it('deletes a STAMP_FAILED row with no child payments and returns it', async () => {
      const failed = { id: 'f1', status: 'STAMP_FAILED', receptorRfc: 'XAXX010101000', totalCents: 464000, venueId: null }
      prismaMock.platformCfdi.findUnique.mockResolvedValue(failed)
      prismaMock.platformCfdi.count.mockResolvedValue(0)
      prismaMock.platformCfdi.delete.mockResolvedValue(failed)

      const res = await discardFailedPlatformCfdi('f1')

      expect(prismaMock.platformCfdi.delete).toHaveBeenCalledWith({ where: { id: 'f1' } })
      expect(res).toEqual(failed)
    })

    it('throws NO_CFDI when the row does not exist', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue(null)
      await expect(discardFailedPlatformCfdi('missing')).rejects.toMatchObject({ code: 'NO_CFDI' })
      expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
    })

    it('refuses to delete a STAMPED CFDI (must be cancelled, not discarded)', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 's1', status: 'STAMPED', uuid: 'UUID-1' })
      await expect(discardFailedPlatformCfdi('s1')).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
    })

    it('refuses to delete a failed CFDI that has child payment complements', async () => {
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'f2', status: 'STAMP_FAILED' })
      prismaMock.platformCfdi.count.mockResolvedValue(1)
      await expect(discardFailedPlatformCfdi('f2')).rejects.toMatchObject({ code: 'VALIDATION' })
      expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
// «Por cobrar» (spec 2026-11-02-por-cobrar-superadmin §6): los cambios MÍNIMOS al servicio genérico. Es dinero y fiscal, así
// que cada cambio nace con su prueba Y con la prueba de que el camino de «Nueva factura» (sin ligar) queda exactamente igual.
// ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const mockLoggerError = (logger as unknown as { error: jest.Mock }).error

describe('platformCfdi.service — «Por cobrar»: emitir (líneas con IVA incluido, totales de la foto, filas ligadas)', () => {
  const baseInput = {
    billingTaxProfileId: 'p1',
    lines: [{ description: 'Mensualidad', satProductKey: '81161700', satUnitKey: 'E48', quantity: 1, unitPriceCents: 159900 }],
    formaPago: '03',
    metodoPago: 'PUE' as const,
    idempotencyKey: 'por-cobrar:occ-1:0',
    performedById: 'staff-1',
  }
  const PENDIENTE_SIN_UUID = { ...STAMPED, uuid: null, status: 'pending' as const }

  /** Todo lo que `issuePlatformCfdi` lee antes de timbrar, y un `update` que devuelve la fila ya con lo escrito. */
  function armaEmision(createInvoice: jest.Mock) {
    prismaMock.platformCfdi.findUnique.mockResolvedValue(null) // ninguna fila previa con esa llave
    prismaMock.platformEmisor.findFirst.mockResolvedValue(ACTIVE_EMISOR)
    prismaMock.billingTaxProfile.findUnique.mockResolvedValue(PROFILE)
    prismaMock.platformCfdi.create.mockResolvedValue({ id: 'cfdiL', status: 'STAMPING' })
    prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'cfdiL', status: 'STAMPING', ...args.data }))
    mockResolve.mockReturnValue({ createInvoice })
  }
  const datosDeLaFila = () => prismaMock.platformCfdi.create.mock.calls[0][0].data
  const lasEscrituras = () => prismaMock.platformCfdi.update.mock.calls.map((call: any[]) => call[0].data)

  describe('líneas con el IVA incluido (taxIncluded)', () => {
    it('REGRESIÓN: sin los campos nuevos el concepto llega al proveedor con taxIncluded=false y los totales se calculan de las líneas', async () => {
      const createInvoice = jest.fn().mockResolvedValue(STAMPED)
      armaEmision(createInvoice)

      await issuePlatformCfdi(baseInput)

      expect(createInvoice.mock.calls[0][0].items[0]).toMatchObject({ unitPriceCents: 159900, taxIncluded: false, objetoImp: '02' })
      expect(datosDeLaFila()).toMatchObject({ subtotalCents: 159900, discountCents: 0, taxCents: 25584, totalCents: 185484 })
      expect(datosDeLaFila().platformChargeOccurrenceId).toBeUndefined() // no se liga a nada
    })

    it('taxIncluded=true llega al proveedor tal cual', async () => {
      const createInvoice = jest.fn().mockResolvedValue({ ...STAMPED, totalCents: 49900 })
      armaEmision(createInvoice)
      const licencia = {
        description: 'Licencia',
        satProductKey: '43232611',
        satUnitKey: 'E48',
        quantity: 1,
        unitPriceCents: 49900,
        taxIncluded: true,
      }

      await issuePlatformCfdi({ ...baseInput, lines: [licencia] })

      expect(createInvoice.mock.calls[0][0].items[0]).toMatchObject({ unitPriceCents: 49900, taxIncluded: true, objetoImp: '02' })
    })

    it('con `totals` se guardan ésos, no los que saldrían de las líneas (que sumarían el IVA otra vez)', async () => {
      const createInvoice = jest.fn().mockResolvedValue({ ...STAMPED, totalCents: 49900 })
      armaEmision(createInvoice)
      const licencia = {
        description: 'Licencia',
        satProductKey: '43232611',
        satUnitKey: 'E48',
        quantity: 1,
        unitPriceCents: 49900,
        taxIncluded: true,
      }

      await issuePlatformCfdi({
        ...baseInput,
        lines: [licencia],
        totals: { subtotalCents: 43017, discountCents: 0, taxCents: 6883, totalCents: 49900 },
      })

      // Calculadas de la línea como si fuera precio neto serían 49900 + 7984 = 57884.
      expect(datosDeLaFila()).toMatchObject({ subtotalCents: 43017, discountCents: 0, taxCents: 6883, totalCents: 49900 })
    })
  })

  describe('fila ligada a una ocurrencia (platformChargeOccurrenceId)', () => {
    it('la fila se crea ligada a la ocurrencia', async () => {
      const createInvoice = jest.fn().mockResolvedValue(STAMPED)
      armaEmision(createInvoice)

      await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })

      expect(datosDeLaFila()).toMatchObject({
        platformChargeOccurrenceId: 'occ-1',
        status: 'STAMPING',
        idempotencyKey: 'por-cobrar:occ-1:0',
      })
    })

    it('si el PAC contesta pending SIN UUID: la fila se queda STAMPING con su facturapiId (no STAMPED)', async () => {
      armaEmision(jest.fn().mockResolvedValue(PENDIENTE_SIN_UUID))

      const row = await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })

      expect(lasEscrituras()).toHaveLength(1)
      expect(lasEscrituras()[0]).toMatchObject({ facturapiId: 'fa-inv-1' })
      expect(lasEscrituras()[0].status).toBeUndefined()
      expect(lasEscrituras()[0].uuid).toBeUndefined()
      expect(row.status).toBe('STAMPING')
      expect(row.facturapiId).toBe('fa-inv-1')
    })

    it('un PAC que dice valid pero no trae UUID tampoco se da por timbrado', async () => {
      armaEmision(jest.fn().mockResolvedValue({ ...STAMPED, uuid: null, status: 'valid' }))

      const row = await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })

      expect(row.status).toBe('STAMPING')
      expect(lasEscrituras()[0].status).toBeUndefined()
    })

    it('sin el timbre no manda el correo al cliente (no hay nada que entregar)', async () => {
      const sendInvoiceByEmail = jest.fn().mockResolvedValue(undefined)
      armaEmision(jest.fn().mockResolvedValue(PENDIENTE_SIN_UUID))
      mockResolve.mockReturnValue({ createInvoice: jest.fn().mockResolvedValue(PENDIENTE_SIN_UUID), sendInvoiceByEmail })
      // Si el correo se intentara, la fila estaría lista para enviarse (así la prueba no pasa en vacío).
      prismaMock.platformCfdi.findUnique.mockImplementation(async ({ where }: any) =>
        where.id ? { id: 'cfdiL', status: 'STAMPED', facturapiId: 'fa-inv-1', platformEmisorId: 'em1', billingTaxProfileId: 'p1' } : null,
      )
      prismaMock.platformEmisor.findUnique.mockResolvedValue(ACTIVE_EMISOR)

      await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })
      await new Promise(resolve => setImmediate(resolve))

      expect(sendInvoiceByEmail).not.toHaveBeenCalled()
    })

    it('con el timbre SÍ manda el correo al cliente, también ligada', async () => {
      const sendInvoiceByEmail = jest.fn().mockResolvedValue(undefined)
      armaEmision(jest.fn().mockResolvedValue(STAMPED))
      mockResolve.mockReturnValue({ createInvoice: jest.fn().mockResolvedValue(STAMPED), sendInvoiceByEmail })
      prismaMock.platformCfdi.findUnique.mockImplementation(async ({ where }: any) =>
        where.id ? { id: 'cfdiL', status: 'STAMPED', facturapiId: 'fa-inv-1', platformEmisorId: 'em1', billingTaxProfileId: 'p1' } : null,
      )
      prismaMock.platformEmisor.findUnique.mockResolvedValue(ACTIVE_EMISOR)

      await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })
      await new Promise(resolve => setImmediate(resolve))

      expect(sendInvoiceByEmail).toHaveBeenCalledWith('fa-inv-1', 'cliente@demo.mx')
    })

    it('REGRESIÓN: SIN ligar, el mismo pending sin UUID sigue quedando STAMPED como hoy (deuda ajena, no se toca)', async () => {
      armaEmision(jest.fn().mockResolvedValue(PENDIENTE_SIN_UUID))

      const row = await issuePlatformCfdi(baseInput)

      expect(lasEscrituras()[0]).toMatchObject({ status: 'STAMPED', facturapiId: 'fa-inv-1', uuid: null })
      expect(row.status).toBe('STAMPED')
    })

    it('si el total que timbró el PAC difiere: guarda el del PAC y lo registra con logger.error', async () => {
      armaEmision(jest.fn().mockResolvedValue({ ...STAMPED, totalCents: 185485 }))

      const row = await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })

      expect(lasEscrituras()[0]).toMatchObject({ status: 'STAMPED', totalCents: 185485 })
      expect(row.totalCents).toBe(185485)
      expect(mockLoggerError).toHaveBeenCalledTimes(1)
      expect(JSON.stringify(mockLoggerError.mock.calls[0])).toMatch(/185484.*185485|185485.*185484/)
    })

    it('si el PAC contesta sin timbre Y con otro total, también guarda el del PAC', async () => {
      armaEmision(jest.fn().mockResolvedValue({ ...PENDIENTE_SIN_UUID, totalCents: 185485 }))

      await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })

      expect(lasEscrituras()[0]).toMatchObject({ facturapiId: 'fa-inv-1', totalCents: 185485 })
      expect(mockLoggerError).toHaveBeenCalledTimes(1)
    })

    it('si el total del PAC coincide: no toca el total ni registra nada', async () => {
      armaEmision(jest.fn().mockResolvedValue(STAMPED)) // 185484, igual al calculado

      await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })

      expect(lasEscrituras()[0].totalCents).toBeUndefined()
      expect(mockLoggerError).not.toHaveBeenCalled()
    })

    it('REGRESIÓN: SIN ligar, un total distinto del PAC no se guarda ni se registra (camino genérico igual que hoy)', async () => {
      armaEmision(jest.fn().mockResolvedValue({ ...STAMPED, totalCents: 185485 }))

      await issuePlatformCfdi(baseInput)

      expect(lasEscrituras()[0].totalCents).toBeUndefined()
      expect(mockLoggerError).not.toHaveBeenCalled()
    })
  })

  describe('reserveCheck (la comprobación que corre junto con la reserva de la fila)', () => {
    it('corre en la MISMA transacción, ANTES de crear la fila STAMPING', async () => {
      const orden: string[] = []
      const createInvoice = jest.fn().mockResolvedValue(STAMPED)
      armaEmision(createInvoice)
      prismaMock.platformCfdi.create.mockImplementation(async () => {
        orden.push('crear')
        return { id: 'cfdiL', status: 'STAMPING' }
      })
      const reserveCheck = jest.fn(async (tx: unknown) => {
        orden.push('comprobar')
        expect(tx).toBe(prismaMock) // el tx de la transacción que abrió issuePlatformCfdi
      })

      await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1', reserveCheck })

      expect(orden).toEqual(['comprobar', 'crear'])
      expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
      expect(createInvoice).toHaveBeenCalledTimes(1)
    })

    it('si lanza: no hay fila ni llamada al PAC, y el error sale tal cual', async () => {
      const createInvoice = jest.fn().mockResolvedValue(STAMPED)
      armaEmision(createInvoice)
      const rechazo = new ConflictError('El cobro ya no está pagado', 'PLATFORM_CHARGE_NOT_PAID')
      const reserveCheck = jest.fn().mockRejectedValue(rechazo)

      await expect(issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1', reserveCheck })).rejects.toBe(rechazo)

      expect(reserveCheck).toHaveBeenCalledTimes(1)
      expect(prismaMock.platformCfdi.create).not.toHaveBeenCalled()
      expect(prismaMock.platformCfdi.update).not.toHaveBeenCalled() // ni siquiera un STAMP_FAILED
      expect(createInvoice).not.toHaveBeenCalled()
    })

    it('una llave que ya tiene fila regresa esa fila SIN correr la comprobación (idempotente)', async () => {
      const createInvoice = jest.fn()
      armaEmision(createInvoice)
      prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'previa', status: 'STAMPING' })
      const reserveCheck = jest.fn()

      const row = await issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1', reserveCheck })

      expect(row.id).toBe('previa')
      expect(reserveCheck).not.toHaveBeenCalled()
      expect(createInvoice).not.toHaveBeenCalled()
    })

    it('REGRESIÓN: sin reserveCheck no se abre ninguna transacción (la fila se crea como siempre)', async () => {
      armaEmision(jest.fn().mockResolvedValue(STAMPED))

      await issuePlatformCfdi(baseInput)

      expect(prismaMock.$transaction).not.toHaveBeenCalled()
      expect(prismaMock.platformCfdi.create).toHaveBeenCalledTimes(1)
    })
  })

  // 🔴 Fix ronda 1, punto 1 (spec §6 «Por qué así»): una falla que no sea un rechazo confirmado del PAC no prueba que el documento no
  // haya quedado en camino. Si la fila pasara a STAMP_FAILED, el reintento inmediato preguntaría por la llave, Facturapi todavía
  // podría no tenerla (`null`), se cerraría el intento y se timbraría con otra llave: dos CFDI por un pago.
  describe('una falla que NO es un rechazo confirmado del PAC deja la fila ligada en STAMPING', () => {
    const TRANSPORTE: Array<[string, Error]> = [
      [
        'un timeout (nuestro corte a los 30 s)',
        Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }),
      ],
      ['un 502 con cuerpo HTML (el JSON no se puede leer)', new SyntaxError('Unexpected token < in JSON at position 0')],
      ['una falla de red', new TypeError('fetch failed')],
      ['un 502 de la puerta de enlace', new ProviderHttpError(502, null, 'Bad Gateway')],
      ['un 503', new ProviderHttpError(503, 'service_unavailable', 'Servicio no disponible')],
      [
        'un 4xx con un código que no es de rechazo (409 de llave repetida)',
        new ProviderHttpError(409, 'idempotency_conflict', 'Llave repetida'),
      ],
      [
        'un código de rechazo pero con status 5xx (no es una respuesta de validación)',
        new ProviderHttpError(500, 'invalid_request', 'Error interno'),
      ],
    ]
    const RECHAZOS: Array<[number, string]> = [
      [400, 'invalid_request'],
      [400, 'product_key_not_found'],
      [422, 'invoice_stamping_validation_error'],
    ]
    const SAT_RFC = 'El campo Rfc del receptor no se encuentra en el listado del SAT.'

    it.each(TRANSPORTE)(
      'ligada, %s: la fila SIGUE en STAMPING con su lastError y un intento más, y el error se lanza',
      async (_nombre, falla) => {
        armaEmision(jest.fn().mockRejectedValue(falla))

        await expect(issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })).rejects.toBeInstanceOf(PlatformBillingError)

        expect(lasEscrituras()).toEqual([{ lastError: falla.message, attempts: { increment: 1 } }]) // sin `status`: no pasa a STAMP_FAILED
      },
    )

    it.each(TRANSPORTE)('REGRESIÓN: SIN ligar, %s sigue pasando la fila a STAMP_FAILED, como hoy', async (_nombre, falla) => {
      armaEmision(jest.fn().mockRejectedValue(falla))

      await expect(issuePlatformCfdi(baseInput)).rejects.toBeInstanceOf(PlatformBillingError)

      expect(lasEscrituras()).toEqual([{ status: 'STAMP_FAILED', lastError: falla.message, attempts: { increment: 1 } }])
    })

    it.each(RECHAZOS)('ligada, un rechazo CONFIRMADO (%i %s) sí pasa a STAMP_FAILED: corregir un RFC no espera', async (status, code) => {
      armaEmision(jest.fn().mockRejectedValue(new ProviderHttpError(status, code, SAT_RFC)))

      await expect(issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })).rejects.toMatchObject({
        code: 'VALIDATION',
        field: 'rfc',
      })

      expect(lasEscrituras()).toEqual([{ status: 'STAMP_FAILED', lastError: SAT_RFC, attempts: { increment: 1 } }])
    })

    it('el error que sale conserva la guía y el mensaje crudo (sin cambios para quien lo lee)', async () => {
      armaEmision(jest.fn().mockRejectedValue(new ProviderHttpError(502, null, 'Bad Gateway')))

      await expect(issuePlatformCfdi({ ...baseInput, platformChargeOccurrenceId: 'occ-1' })).rejects.toMatchObject({
        code: 'PROVIDER',
        message: expect.stringContaining('Bad Gateway'),
      })
    })
  })
})

describe('platformCfdi.service — «Por cobrar»: descartar una factura fallida', () => {
  it('rechaza una fila ligada a una ocurrencia: se reintenta desde «Por cobrar»', async () => {
    prismaMock.platformCfdi.findUnique.mockResolvedValue({ id: 'f3', status: 'STAMP_FAILED', platformChargeOccurrenceId: 'occ-1' })

    await expect(discardFailedPlatformCfdi('f3')).rejects.toMatchObject({
      code: 'VALIDATION',
      message: expect.stringMatching(/Por cobrar/),
    })

    expect(prismaMock.platformCfdi.delete).not.toHaveBeenCalled()
  })

  it('REGRESIÓN: una fila fallida SIN ligar (platformChargeOccurrenceId null) se descarta como hoy', async () => {
    const failed = {
      id: 'f4',
      status: 'STAMP_FAILED',
      platformChargeOccurrenceId: null,
      receptorRfc: 'XAXX010101000',
      totalCents: 1,
      venueId: null,
    }
    prismaMock.platformCfdi.findUnique.mockResolvedValue(failed)
    prismaMock.platformCfdi.count.mockResolvedValue(0)
    prismaMock.platformCfdi.delete.mockResolvedValue(failed)

    await expect(discardFailedPlatformCfdi('f4')).resolves.toEqual(failed)

    expect(prismaMock.platformCfdi.delete).toHaveBeenCalledWith({ where: { id: 'f4' } })
  })
})

describe('platformCfdi.service — «Por cobrar»: modo de prueba (PLATFORM_CHARGES_SANDBOX) en cancelar, PDF, XML y correo', () => {
  const EMISOR_DE_QA = { ...ACTIVE_EMISOR, providerKeyEnc: null } // el emisor de QA no trae llave guardada
  const OPERACIONES: Array<[string, (id: string) => Promise<unknown>]> = [
    ['cancelar', id => cancelPlatformCfdi(id, '02')],
    ['bajar el PDF', id => fetchPlatformCfdiArtifact(id, 'pdf')],
    ['bajar el XML', id => fetchPlatformCfdiArtifact(id, 'xml')],
    ['mandar el correo', id => sendPlatformCfdiEmail(id, 'cliente@demo.mx')],
  ]

  const dadaLaFila = (ligada: boolean, emisor: Record<string, unknown> = EMISOR_DE_QA) => {
    prismaMock.platformCfdi.findUnique.mockResolvedValue({
      id: 'c1',
      status: 'STAMPED',
      facturapiId: 'fa1',
      platformEmisorId: 'em1',
      billingTaxProfileId: 'p1',
      serie: 'A',
      folio: '118',
      platformChargeOccurrenceId: ligada ? 'occ-1' : null,
    })
    prismaMock.platformEmisor.findUnique.mockResolvedValue(emisor)
    prismaMock.platformCfdi.update.mockImplementation((args: any) => Promise.resolve({ id: 'c1', ...args.data }))
    mockResolve.mockReturnValue({
      cancelInvoice: jest.fn().mockResolvedValue({ status: 'canceled', cancelledAt: new Date() }),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('pdf')),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('xml')),
      sendInvoiceByEmail: jest.fn().mockResolvedValue(undefined),
    })
  }
  const sandboxUsado = () => mockResolve.mock.calls[mockResolve.mock.calls.length - 1][1]

  afterEach(() => {
    delete process.env.PLATFORM_CHARGES_SANDBOX
  })

  it.each(OPERACIONES)('con la variable, %s de una fila LIGADA usa sandbox: true', async (_nombre, operacion) => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    dadaLaFila(true)

    await operacion('c1')

    expect(sandboxUsado()).toEqual({ sandbox: true })
  })

  it.each(OPERACIONES)('REGRESIÓN: con la variable, %s de una fila SIN ligar sigue con sandbox: false', async (_nombre, operacion) => {
    process.env.PLATFORM_CHARGES_SANDBOX = 'true'
    dadaLaFila(false)

    await operacion('c1')

    expect(sandboxUsado()).toEqual({ sandbox: false })
  })

  it.each(OPERACIONES)('REGRESIÓN: sin la variable, %s de una fila LIGADA sigue con sandbox: false', async (_nombre, operacion) => {
    dadaLaFila(true)

    await operacion('c1')

    expect(sandboxUsado()).toEqual({ sandbox: false })
  })

  it.each(OPERACIONES)(
    'REGRESIÓN: sin la variable, %s de una fila SIN ligar sigue con sandbox: false (y con una llave guardada, sin problema)',
    async (_nombre, operacion) => {
      dadaLaFila(false, ACTIVE_EMISOR) // trae providerKeyEnc: la ruta de siempre no se entera de nada

      await operacion('c1')

      expect(sandboxUsado()).toEqual({ sandbox: false })
    },
  )

  it.each(OPERACIONES)(
    'con la variable y el emisor con llave guardada, %s de una fila LIGADA se niega y no habla con Facturapi',
    async (_nombre, operacion) => {
      process.env.PLATFORM_CHARGES_SANDBOX = 'true'
      dadaLaFila(true, ACTIVE_EMISOR)

      await expect(operacion('c1')).rejects.toBeInstanceOf(PlatformBillingError)

      expect(mockResolve).not.toHaveBeenCalled()
    },
  )
})

describe('issueInvoiceSchema — el formulario genérico no puede producir líneas con IVA incluido', () => {
  it('descarta taxIncluded de una línea y conserva el resto', () => {
    const parsed = issueInvoiceSchema.parse({
      body: {
        billingTaxProfileId: 'p1',
        lines: [
          { description: 'Licencia', satProductKey: '43232611', satUnitKey: 'E48', quantity: 1, unitPriceCents: 49900, taxIncluded: true },
        ],
        formaPago: '03',
        metodoPago: 'PUE',
      },
    })

    expect(parsed.body.lines[0]).not.toHaveProperty('taxIncluded')
    expect(parsed.body.lines[0]).toMatchObject({ description: 'Licencia', unitPriceCents: 49900 })
  })
})
