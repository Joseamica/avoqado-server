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
    // Por default este proceso gana el reclamo del intento (la carrera se prueba aparte)
    claimCfdi: jest.fn().mockResolvedValue(true),
    // Como el dep real: escribe sólo las URLs (jamás el estado) y devuelve la fila completa.
    persistArtifacts: jest.fn().mockImplementation(async (_llave, urls) => ({ id: 'cfdi1', uuid: 'UUID-1', status: 'STAMPED', ...urls })),
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
    // El TIMBRE se persiste una vez; las URLs van por `persistArtifacts`, que nunca toca el estado
    // fiscal (si no, una cancelación ocurrida durante la descarga se revertiría — Codex P1-4).
    const calls = (deps.persistCfdi as jest.Mock).mock.calls.map(c => c[0])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ status: 'STAMPED', uuid: 'UUID-1' })
    expect(calls[0].xmlUrl ?? null).toBeNull()
    const [llave, urls] = (deps.persistArtifacts as jest.Mock).mock.calls[0]
    expect(llave).toBe('cfdi-order-o1')
    expect(Object.keys(urls).sort()).toEqual(['pdfUrl', 'xmlUrl'])
    expect(urls.xmlUrl).toMatch(/\.xml$/)
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

  // Testarudo 21-sep-2026: se timbraron facturas por MENOS de lo cobrado (extras ignorados). El motor
  // ya carga los extras; esta barrera es la red de seguridad para cualquier otra deriva de datos.
  it('BARRERA de dinero: si el total de la factura ≠ lo pagado, NO llama al PAC y persiste VALIDATION_FAILED con la razón', async () => {
    const deps = makeDeps()
    const base = await (makeDeps().loadOrderForCfdi as jest.Mock)('o1')
    deps.loadOrderForCfdi = jest.fn().mockResolvedValue({ ...base, paidCents: 12180 }) // cobró 121.80, la factura dice 116.00
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons?.join(' ')).toMatch(/\$116\.00.*\$121\.80/)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
    expect((deps.persistCfdi as jest.Mock).mock.calls[0][0].status).toBe('VALIDATION_FAILED')
  })

  it('SOBRE SEGURO: una orden con unsupportedReasons NO llama al PAC y responde VALIDATION_FAILED con esa razón', async () => {
    const deps = makeDeps()
    const base = await (makeDeps().loadOrderForCfdi as jest.Mock)('o1')
    deps.loadOrderForCfdi = jest.fn().mockResolvedValue({
      ...base,
      paidCents: 12600, // ≠ documento (11600) a propósito: el cargo por servicio quedó fuera del documento
      unsupportedReasons: ['La cuenta lleva cargo por servicio; la facturación de cargos por servicio llega en la siguiente versión.'],
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons?.join(' ')).toMatch(/cargo por servicio/)
    expect(res.reasons?.join(' ')).not.toMatch(/no coincide con lo cobrado/) // la razón del sobre no se apila con el desajuste
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('BARRERA de dinero: con paidCents == totalCents timbra normal (control positivo)', async () => {
    const deps = makeDeps()
    const base = await (makeDeps().loadOrderForCfdi as jest.Mock)('o1')
    deps.loadOrderForCfdi = jest.fn().mockResolvedValue({ ...base, paidCents: 11600 })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
  })

  it('BARRERA de dinero: compara el DOCUMENTO que se manda (conceptos como los calcula el PAC), no los agregados de la orden', async () => {
    // Orden NET (precios sin IVA): concepto 100 + 16% = 116 al PAC. Si la orden dice total 120 y se
    // cobraron 120, los agregados cuadran pero el documento diría 116: no se timbra.
    const deps = makeDeps()
    const base = await (makeDeps().loadOrderForCfdi as jest.Mock)('o1')
    deps.loadOrderForCfdi = jest.fn().mockResolvedValue({
      ...base,
      subtotalCents: 10345,
      taxCents: 1655,
      totalCents: 12000,
      paidCents: 12000,
      order: { ...base.order, pricesIncludeIva: false }, // items: 1 × 100 neto, tasa 0.16
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons?.join(' ')).toMatch(/\$116\.00.*\$120\.00/)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('tenant isolation: un CFDI ya STAMPED de OTRO venue no se devuelve por idempotencia (404), y no se toca el PAC', async () => {
    const deps = makeDeps({
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'cfdiA', status: 'STAMPED', venueId: 'venueA', pdfUrl: 'https://x/a.pdf' }),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'venueB' }, deps)).rejects.toThrow(
      /not found/,
    )
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

// ─── Recuperación de intentos (R1-R3) — Codex v4, y el incidente real de Laura ──────────────────
// Sin esto: (R1) dos procesos podían seguir sobre el mismo intento fallido y timbrar dos veces;
// (R2) un STAMP_FAILED que en realidad fue un timeout DESPUÉS del timbre se re-timbraba a ciegas;
// (R3) un fallo al bajar el XML/PDF dejaba la fila en STAMPING SIN identificadores — el CFDI existía
// en el PAC y nosotros no sabíamos ni su UUID (pasó el 21-sep con la factura de Laura, 13 minutos).
describe('issueCfdiForOrder — recuperación de intentos', () => {
  const P2002 = Object.assign(new Error('unique'), { code: 'P2002', name: 'PrismaClientKnownRequestError' })
  const asPrisma = (e: any) => Object.setPrototypeOf(e, Prisma.PrismaClientKnownRequestError.prototype)

  it('R1: el reintento de un intento fallido se RECLAMA atómicamente; quien pierde la carrera no llama al PAC', async () => {
    const claimCfdi = jest.fn().mockResolvedValue(false) // otro proceso se lo llevó
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(asPrisma(P2002)),
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMP_FAILED', attempts: 7, updatedAt: new Date() }),
      claimCfdi,
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)).rejects.toThrow(/en proceso/)
    // El reclamo lleva la VERSIÓN leída (`attempts`): sin ella, dos reintentos ganan los dos.
    expect(claimCfdi).toHaveBeenCalledWith('c1', expect.any(Array), 7)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('R1: quien GANA el claim sí procede a timbrar', async () => {
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(asPrisma(P2002)),
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMP_FAILED', updatedAt: new Date() }),
      claimCfdi: jest.fn().mockResolvedValue(true),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.status).toBe('STAMPED')
  })

  it('R2: antes de re-timbrar un intento reclamado se PREGUNTA al PAC por external_id; si ya existe, se completa sin volver a timbrar', async () => {
    const createInvoice = jest.fn()
    const provider = {
      name: 'facturapi',
      createInvoice,
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
      findByExternalId: jest
        .fn()
        .mockResolvedValue({ providerInvoiceId: 'fa-ya', uuid: 'UUID-YA', serie: 'F', folio: '9', status: 'valid', stampedAt: new Date() }),
    }
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(asPrisma(P2002)),
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMP_FAILED', updatedAt: new Date() }),
      claimCfdi: jest.fn().mockResolvedValue(true),
      resolveProvider: jest.fn().mockReturnValue(provider as any),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(provider.findByExternalId).toHaveBeenCalledWith('cfdi-order-o1')
    expect(createInvoice).not.toHaveBeenCalled() // ← nunca se timbra dos veces
    expect(res.status).toBe('STAMPED')
    expect(res.cfdi.uuid).toBe('UUID-YA')
  })

  it('R2: un documento CANCELADO en el PAC no se «completa» ni se re-timbra: queda para revisión', async () => {
    const provider = {
      name: 'facturapi',
      createInvoice: jest.fn(),
      downloadXml: jest.fn(),
      downloadPdf: jest.fn(),
      findByExternalId: jest
        .fn()
        .mockResolvedValue({ providerInvoiceId: 'fa-x', uuid: 'U', serie: 'F', folio: '1', status: 'canceled', stampedAt: new Date() }),
    }
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(asPrisma(P2002)),
      findExistingCfdi: jest.fn().mockResolvedValue({ id: 'c1', status: 'STAMP_FAILED', updatedAt: new Date() }),
      claimCfdi: jest.fn().mockResolvedValue(true),
      resolveProvider: jest.fn().mockReturnValue(provider as any),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)).rejects.toThrow(/cancelad/i)
    expect(provider.createInvoice).not.toHaveBeenCalled()
  })

  it('R3: el timbre se persiste ANTES de bajar los archivos; si la descarga falla, la fila queda STAMPED con uuid y folio', async () => {
    const provider = {
      name: 'facturapi',
      createInvoice: jest.fn().mockResolvedValue({
        providerInvoiceId: 'fa1',
        uuid: 'UUID-1',
        serie: 'F',
        folio: '2',
        totalCents: 11600,
        stampedAt: new Date(),
        status: 'valid' as const,
      }),
      downloadXml: jest.fn().mockRejectedValue(new Error('fetch failed')), // el caso de Laura
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    }
    const deps = makeDeps({ resolveProvider: jest.fn().mockReturnValue(provider as any) })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)

    expect(res.status).toBe('STAMPED')
    const persistidos = (deps.persistCfdi as jest.Mock).mock.calls.map(c => c[0])
    // el PRIMER persist tras timbrar ya trae los identificadores, sin esperar a los archivos
    const primero = persistidos.find(d => d.status === 'STAMPED')
    expect(primero).toMatchObject({ facturapiId: 'fa1', uuid: 'UUID-1', folio: '2' })
    expect(primero.xmlUrl ?? null).toBeNull()
    expect(res.cfdi.uuid).toBe('UUID-1')
  })

  it('R3: con los archivos OK, el resultado final trae las dos URLs', async () => {
    const deps = makeDeps()
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true }, deps)
    expect(res.cfdi.xmlUrl).toMatch(/\.xml$/)
    expect(res.cfdi.pdfUrl).toMatch(/\.pdf$/)
  })
})
