// tests/unit/services/fiscal/cfdi.service.test.ts
import { Prisma } from '@prisma/client'
import { issueCfdiForOrder, IssueCfdiDeps } from '../../../../src/services/fiscal/cfdi.service'

const D = (n: number) => new Prisma.Decimal(n)
const receptor = { rfc: 'XAXX010101000', razonSocial: 'PUBLICO EN GENERAL', regimenFiscal: '616', codigoPostal: '83240', usoCfdi: 'S01' }

function makeDeps(over: Partial<IssueCfdiDeps> = {}): IssueCfdiDeps {
  const stamped = { providerInvoiceId: 'fa1', uuid: 'UUID-1', serie: 'F', folio: '2', totalCents: 11600, stampedAt: new Date(), status: 'valid' as const }
  return {
    findExistingCfdi: jest.fn().mockResolvedValue(null),
    loadOrderForCfdi: jest.fn().mockResolvedValue({
      venueId: 'v1', venueSlug: 'demo', venueType: 'RESTAURANT',
      emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
      paymentMethod: 'CASH', metodoPago: 'PUE',
      subtotalCents: 10000, taxCents: 1600, totalCents: 11600,
      order: { venueType: 'RESTAURANT', tipAmount: D(0), items: [{ productName: 'X', quantity: 1, unitPrice: D(100), discountAmount: D(0), product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null } }] },
    }),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice: jest.fn().mockResolvedValue(stamped),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async (data) => ({ id: 'cfdi1', ...data })),
    ...over,
  }
}

describe('issueCfdiForOrder', () => {
  it('happy path: validates, stamps, stores XML/PDF, persists STAMPED', async () => {
    const deps = makeDeps()
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('UUID-1')
    expect(deps.storeArtifact).toHaveBeenCalledTimes(2) // xml + pdf
    const persisted = (deps.persistCfdi as jest.Mock).mock.calls[0][0]
    expect(persisted.status).toBe('STAMPED')
    expect(persisted.xmlUrl).toMatch(/\.xml$/)
  })

  it('idempotent: returns the existing STAMPED Cfdi without calling the PAC', async () => {
    const existing = { id: 'c0', status: 'STAMPED', uuid: 'OLD' }
    const deps = makeDeps({ findExistingCfdi: jest.fn().mockResolvedValue(existing) })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('OLD')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('validation failure: never calls the PAC, persists VALIDATION_FAILED with reasons', async () => {
    const deps = makeDeps()
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor: { ...receptor, rfc: 'BAD' }, sandbox: true }, deps)
    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons && res.reasons.length).toBeGreaterThan(0)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('PAC error: persists STAMP_FAILED with the error', async () => {
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({ name: 'facturapi', createInvoice: jest.fn().mockRejectedValue(new Error('SAT down')), downloadXml: jest.fn(), downloadPdf: jest.fn() } as any),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMP_FAILED')
    const persisted = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
    expect(persisted.status).toBe('STAMP_FAILED')
    expect(persisted.lastError).toMatch(/SAT down/)
  })
})
