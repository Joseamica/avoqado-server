// tests/unit/services/fiscal/cfdi.service.test.ts
import { Prisma } from '@prisma/client'
import { issueCfdiForOrder, IssueCfdiDeps } from '../../../../src/services/fiscal/cfdi.service'

/** Helper: build a realistic P2002 unique-violation error as Prisma would throw. */
function makeP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed on the fields: (`idempotencyKey`)', {
    code: 'P2002',
    clientVersion: 'x',
    meta: { target: ['idempotencyKey'] },
  })
}

const D = (n: number) => new Prisma.Decimal(n)
// Use a real individual RFC for the happy-path/default service tests.
// XAXX010101000 ("Público en General") is only valid on the global CFDI; individual issuance blocks it.
const receptor = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '64000',
  usoCfdi: 'G03',
}

function makeDeps(over: Partial<IssueCfdiDeps> = {}): IssueCfdiDeps {
  const stamped = {
    providerInvoiceId: 'fa1',
    uuid: 'UUID-1',
    serie: 'F',
    folio: '2',
    totalCents: 11600,
    stampedAt: new Date(),
    status: 'valid' as const,
  }
  return {
    findExistingCfdi: jest.fn().mockResolvedValue(null),
    // By default, reservation succeeds (no conflict)
    reserveCfdi: jest.fn().mockResolvedValue({}),
    loadOrderForCfdi: jest.fn().mockResolvedValue({
      venueId: 'v1',
      venueSlug: 'demo',
      venueType: 'RESTAURANT',
      emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
      facturacionEnabled: true,
      autofacturaEnabled: true,
      paymentMethod: 'CASH',
      metodoPago: 'PUE',
      subtotalCents: 10000,
      taxCents: 1600,
      totalCents: 11600,
      order: {
        venueType: 'RESTAURANT',
        tipAmount: D(0),
        items: [
          {
            productName: 'X',
            quantity: 1,
            unitPrice: D(100),
            discountAmount: D(0),
            product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
          },
        ],
      },
    }),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice: jest.fn().mockResolvedValue(stamped),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi1', ...data })),
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

  it('passes externalId = idempotencyKey to createInvoice so the PAC stamps external_id', async () => {
    const createInvoice = jest.fn().mockResolvedValue({
      providerInvoiceId: 'fa1',
      uuid: 'UUID-1',
      serie: 'F',
      folio: '2',
      totalCents: 11600,
      stampedAt: new Date(),
      status: 'valid' as const,
    })
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice,
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
      } as any),
    })
    await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(createInvoice).toHaveBeenCalledTimes(1)
    const invoiceParams = createInvoice.mock.calls[0][0]
    // externalId must equal the idempotencyKey built from orderId
    expect(invoiceParams.externalId).toBe('cfdi-order-o1')
  })

  it('REGRESSION: a GROSS (IVA-included) order stamps tax_included so the CFDI total == what was paid', async () => {
    // The over-invoicing bug: TPV orders carry IVA-included prices (taxAmount=0). The PAC must be told
    // the price already includes IVA, otherwise it adds 16% on top and the CFDI total exceeds the ticket.
    const createInvoice = jest.fn().mockResolvedValue({
      providerInvoiceId: 'fa1',
      uuid: 'UUID-1',
      serie: 'F',
      folio: '2',
      totalCents: 11600,
      stampedAt: new Date(),
      status: 'valid' as const,
    })
    const deps = makeDeps({
      loadOrderForCfdi: jest.fn().mockResolvedValue({
        venueId: 'v1',
        venueSlug: 'demo',
        venueType: 'RESTAURANT',
        emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
        facturacionEnabled: true,
        autofacturaEnabled: true,
        paymentMethod: 'CASH',
        metodoPago: 'PUE',
        // derived gross breakdown: 116 paid → 100 base + 16 IVA
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        order: {
          venueType: 'RESTAURANT',
          tipAmount: D(0),
          pricesIncludeIva: true, // ← gross convention
          items: [
            {
              productName: 'X',
              quantity: 1,
              unitPrice: D(116), // IVA-included price the customer paid
              discountAmount: D(0),
              product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
            },
          ],
        },
      }),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice,
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
      } as any),
    })

    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')

    const sentItem = createInvoice.mock.calls[0][0].items[0]
    expect(sentItem.taxIncluded).toBe(true) // PAC keeps the gross → stamped total stays 116, not 134.56
    expect(sentItem.unitPriceCents).toBe(11600) // sends the IVA-included price the customer actually paid
    // and the persisted row records the real split (taxCents ≠ 0), cuadra al centavo
    const persisted = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
    expect(persisted.subtotalCents + persisted.taxCents).toBe(persisted.totalCents)
    expect(persisted.totalCents).toBe(11600)
  })

  it('idempotent: returns the existing STAMPED Cfdi without calling the PAC', async () => {
    const existing = { id: 'c0', status: 'STAMPED', uuid: 'OLD' }
    const deps = makeDeps({ findExistingCfdi: jest.fn().mockResolvedValue(existing) })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('OLD')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('tenant isolation: rejects an order whose venue ≠ expectedVenueId, never calls the PAC', async () => {
    const deps = makeDeps() // loadOrderForCfdi returns venueId 'v1'
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'OTHER' }, deps)).rejects.toThrow(/not found/)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
    expect(deps.persistCfdi).not.toHaveBeenCalled()
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
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockRejectedValue(new Error('SAT down')),
        downloadXml: jest.fn(),
        downloadPdf: jest.fn(),
      } as any),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMP_FAILED')
    const persisted = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
    expect(persisted.status).toBe('STAMP_FAILED')
    expect(persisted.lastError).toMatch(/SAT down/)
  })

  // ── Merchant gating tests ──────────────────────────────────────────────────

  it('rejects when facturacionEnabled is false, never calls the PAC', async () => {
    const deps = makeDeps({
      loadOrderForCfdi: jest.fn().mockResolvedValue({
        venueId: 'v1',
        venueSlug: 'demo',
        venueType: 'RESTAURANT',
        emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
        facturacionEnabled: false,
        autofacturaEnabled: false,
        paymentMethod: 'CASH',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        order: { venueType: 'RESTAURANT', tipAmount: D(0), items: [] },
      }),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)).rejects.toThrow(/no habilitada/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
    expect(deps.persistCfdi).not.toHaveBeenCalled()
  })

  it('rejects AUTOFACTURA_A flow when autofacturaEnabled is false, never calls the PAC', async () => {
    const deps = makeDeps({
      loadOrderForCfdi: jest.fn().mockResolvedValue({
        venueId: 'v1',
        venueSlug: 'demo',
        venueType: 'RESTAURANT',
        emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'F' },
        facturacionEnabled: true,
        autofacturaEnabled: false,
        paymentMethod: 'CASH',
        metodoPago: 'PUE',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        order: { venueType: 'RESTAURANT', tipAmount: D(0), items: [] },
      }),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, flow: 'AUTOFACTURA_A' }, deps)).rejects.toThrow(
      /Autofactura no habilitada/i,
    )
    expect(deps.resolveProvider).not.toHaveBeenCalled()
    expect(deps.persistCfdi).not.toHaveBeenCalled()
  })

  it('proceeds to STAMPED for AUTOFACTURA_A when both flags are enabled', async () => {
    const autofacturaReceptor = {
      rfc: 'EKU9003173C9',
      razonSocial: 'ESCUELA KEMPER',
      regimenFiscal: '601',
      codigoPostal: '64000',
      usoCfdi: 'G03',
    }
    const deps = makeDeps()
    // default makeDeps has facturacionEnabled:true, autofacturaEnabled:true
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor: autofacturaReceptor, sandbox: true, flow: 'AUTOFACTURA_A' }, deps)
    expect(res.status).toBe('STAMPED')
    expect(deps.resolveProvider).toHaveBeenCalled()
  })

  // ── Concurrent double-stamp reservation tests ──────────────────────────────

  it('concurrent in-flight (fresh STAMPING): P2002 + recent STAMPING → rejects with /en proceso/, never calls PAC', async () => {
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'c0', status: 'STAMPING', updatedAt: new Date() }),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)).rejects.toThrow(/en proceso/)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('stale STAMPING (crashed mid-stamp): P2002 + STAMPING older than TTL → reclaims and proceeds to STAMPED', async () => {
    const stale = new Date(Date.now() - 5 * 60_000) // 5 min ago (> 3 min TTL)
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'c0', status: 'STAMPING', updatedAt: stale }),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED') // not permanently locked
    expect(deps.resolveProvider).toHaveBeenCalled()
  })

  it('concurrent already succeeded (STAMPED): P2002 + existing STAMPED → returns that STAMPED without calling PAC', async () => {
    const alreadyStamped = { id: 'c0', status: 'STAMPED', uuid: 'ALREADY-UUID' }
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
      findExistingCfdi: jest.fn().mockResolvedValue(alreadyStamped),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('ALREADY-UUID')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('retry after terminal failure (STAMP_FAILED): P2002 + existing STAMP_FAILED → proceeds to stamp (PAC called)', async () => {
    const failedRow = { id: 'c0', status: 'STAMP_FAILED' }
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
      findExistingCfdi: jest.fn().mockResolvedValue(failedRow),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    // Should proceed all the way to STAMPED on retry
    expect(res.status).toBe('STAMPED')
    expect(deps.resolveProvider).toHaveBeenCalled()
  })
})
