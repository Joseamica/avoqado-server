// tests/unit/services/fiscal/cfdiRefacturar.service.test.ts
//
// Testarudo, 24-sep-2026. Dos defectos que se veían como «Facturar dice éxito y no sale nada»:
//   1. La A-14 se canceló en el SAT, pero Avoqado se quedó con la solicitud «en trámite» para siempre:
//      sólo se le preguntaba al PAC al PEDIR la cancelación, nunca después.
//   2. Una venta sólo podía tener UNA factura en toda su vida (llave `cfdi-order-<orden>`). «Facturar»
//      devolvía la factura vieja con 201 — a otra razón social, o después de cancelarla — y la pantalla
//      lo celebraba como éxito.
jest.mock('../../../../src/utils/prismaClient', () => ({ default: {} }))
jest.mock('../../../../src/services/fiscal/fiscalProvider.factory', () => ({ resolveFiscalProvider: jest.fn() }))
jest.mock('../../../../src/config/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }))

import { Prisma } from '@prisma/client'
import {
  issueCfdiForOrder,
  IssueCfdiDeps,
  refreshPendingCancellation,
  RefreshCancellationDeps,
  syncPendingCancellations,
  llaveDeEmision,
} from '../../../../src/services/fiscal/cfdi.service'

const D = (n: number) => new Prisma.Decimal(n)
const receptor = {
  rfc: 'EKU9003173C9',
  razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
  regimenFiscal: '601',
  codigoPostal: '64000',
  usoCfdi: 'G03',
}

function makeP2002(): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'x' })
}

function fila(over: Record<string, any>) {
  return {
    id: 'c-a14',
    venueId: 'v1',
    fiscalEmisorId: 'e1',
    orderId: 'o1',
    type: 'INGRESO',
    isGlobal: false,
    status: 'STAMPED',
    cancelStatus: null,
    idempotencyKey: 'cfdi-order-o1',
    serie: 'A',
    folio: '14',
    uuid: 'UUID-A14',
    facturapiId: 'fa-a14',
    attempts: 1,
    createdAt: new Date('2026-09-21T18:01:00Z'),
    updatedAt: new Date('2026-09-21T18:07:00Z'),
    ...over,
  }
}

function makeIssueDeps(over: Partial<IssueCfdiDeps> = {}): IssueCfdiDeps & { createInvoice: jest.Mock } {
  const createInvoice = jest.fn().mockResolvedValue({
    providerInvoiceId: 'fa-nueva',
    uuid: 'UUID-NUEVA',
    serie: 'A',
    folio: '17',
    totalCents: 11600,
    stampedAt: new Date(),
    status: 'valid',
  })
  const deps: IssueCfdiDeps = {
    findExistingCfdi: jest.fn().mockResolvedValue(null),
    findOrderInvoices: jest.fn().mockResolvedValue([]),
    refreshPendingCancellation: jest.fn().mockImplementation(async (c: any) => c),
    reserveCfdi: jest.fn().mockResolvedValue({}),
    claimCfdi: jest.fn().mockResolvedValue(true),
    persistArtifacts: jest.fn().mockImplementation(async (_llave, urls) => ({ id: 'nueva', ...urls })),
    loadOrderForCfdi: jest.fn().mockResolvedValue({
      venueId: 'v1',
      venueSlug: 'demo',
      venueType: 'RESTAURANT',
      emisor: { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'A' },
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
    } as any),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice,
      findByExternalId: jest.fn().mockResolvedValue(null),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'nueva', ...data })),
    ...over,
  }
  return Object.assign(deps, { createInvoice })
}

// ─── llaveDeEmision ────────────────────────────────────────────────────────────

describe('llaveDeEmision — la llave de la SIGUIENTE factura de una venta', () => {
  it('sin facturas previas es la de siempre (las pruebas y datos viejos no cambian)', () => {
    expect(llaveDeEmision('o1', [])).toBe('cfdi-order-o1')
  })

  it('si la última emisión quedó CANCELADA, estrena generación: -n2, luego -n3', () => {
    expect(llaveDeEmision('o1', [fila({ status: 'CANCELLED' })])).toBe('cfdi-order-o1-n2')
    expect(
      llaveDeEmision('o1', [fila({ status: 'CANCELLED' }), fila({ id: 'b', status: 'CANCELLED', idempotencyKey: 'cfdi-order-o1-n2' })]),
    ).toBe('cfdi-order-o1-n3')
  })

  it('un intento fallido de la última generación se REUSA (el reclamo/reintento de siempre)', () => {
    expect(
      llaveDeEmision('o1', [fila({ status: 'CANCELLED' }), fila({ id: 'b', status: 'STAMP_FAILED', idempotencyKey: 'cfdi-order-o1-n2' })]),
    ).toBe('cfdi-order-o1-n2')
  })

  it('las llaves de SUSTITUCIÓN (-r1) no cuentan como generación de emisión', () => {
    expect(
      llaveDeEmision('o1', [fila({ status: 'CANCELLED' }), fila({ id: 'r', status: 'CANCELLED', idempotencyKey: 'cfdi-order-o1-r1' })]),
    ).toBe('cfdi-order-o1-n2')
  })
})

// ─── issueCfdiForOrder: una venta que ya tuvo factura ─────────────────────────

describe('issueCfdiForOrder — venta con facturas previas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('con una factura VIGENTE no timbra y dice que ya existía (antes: 201 «éxito» con la vieja)', async () => {
    const deps = makeIssueDeps({ findOrderInvoices: jest.fn().mockResolvedValue([fila({})]) })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.alreadyIssued).toBe(true)
    expect(res.cfdi.id).toBe('c-a14')
    expect(deps.createInvoice).not.toHaveBeenCalled()
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
  })

  it('con la cancelación EN TRÁMITE, primero le pregunta al PAC; si sigue en trámite, no timbra (409)', async () => {
    const pendiente = fila({ cancelStatus: 'REQUESTED' })
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([pendiente]),
      refreshPendingCancellation: jest.fn().mockResolvedValue(pendiente),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(
      /A-14.*en trámite/,
    )
    expect(deps.refreshPendingCancellation).toHaveBeenCalledWith(pendiente, { sandbox: true })
    expect(deps.createInvoice).not.toHaveBeenCalled()
  })

  it('CASO TESTARUDO: la A-14 ya quedó cancelada en el SAT ⇒ se entera y timbra la nueva con otra llave', async () => {
    const pendiente = fila({ cancelStatus: 'REQUESTED' })
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([pendiente]),
      refreshPendingCancellation: jest.fn().mockResolvedValue({ ...pendiente, status: 'CANCELLED', cancelStatus: 'CANCELLED' }),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.alreadyIssued).toBeFalsy()
    expect(deps.createInvoice).toHaveBeenCalledTimes(1)
    expect(deps.createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1-n2')
    expect((deps.reserveCfdi as jest.Mock).mock.calls[0][0].idempotencyKey).toBe('cfdi-order-o1-n2')
    expect((deps.persistCfdi as jest.Mock).mock.calls[0][0]).toMatchObject({ status: 'STAMPED', idempotencyKey: 'cfdi-order-o1-n2' })
  })

  it('a OTRA razón social tras cancelar: el receptor nuevo es el que se timbra', async () => {
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([fila({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })]),
    })
    const otro = { ...receptor, rfc: 'XIA190128J61', razonSocial: 'XENON INDUSTRIAL ARTICLES' }
    await issueCfdiForOrder({ orderId: 'o1', receptor: otro, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect((deps.persistCfdi as jest.Mock).mock.calls[0][0]).toMatchObject({ receptorRfc: 'XIA190128J61' })
  })

  it('si la sustituta (-r1) es la vigente, ésa es la factura de la venta', async () => {
    const deps = makeIssueDeps({
      findOrderInvoices: jest
        .fn()
        .mockResolvedValue([
          fila({ status: 'CANCELLED', cancelStatus: 'CANCELLED' }),
          fila({ id: 'c-r1', idempotencyKey: 'cfdi-order-o1-r1', folio: '15' }),
        ]),
    })
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.alreadyIssued).toBe(true)
    expect(res.cfdi.id).toBe('c-r1')
    expect(deps.createInvoice).not.toHaveBeenCalled()
  })

  it('un intento en curso de OTRA llave (sustitución timbrando) bloquea con 409, nunca timbra en paralelo', async () => {
    const deps = makeIssueDeps({
      findOrderInvoices: jest
        .fn()
        .mockResolvedValue([
          fila({ status: 'CANCELLED', cancelStatus: 'CANCELLED' }),
          fila({ id: 'c-r1', status: 'STAMPING', idempotencyKey: 'cfdi-order-o1-r1', updatedAt: new Date() }),
        ]),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/en proceso/)
    expect(deps.createInvoice).not.toHaveBeenCalled()
  })

  it('aislamiento: una factura de la orden que es de OTRO negocio ⇒ «not found», sin fuga', async () => {
    const deps = makeIssueDeps({ findOrderInvoices: jest.fn().mockResolvedValue([fila({ venueId: 'v-otro' })]) })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/not found/)
  })

  it('si preguntar al PAC falla, NO se da por cancelada: se trata como en trámite', async () => {
    const pendiente = fila({ cancelStatus: 'REQUESTED' })
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([pendiente]),
      refreshPendingCancellation: jest.fn().mockRejectedValue(new Error('fetch failed')),
    })
    await expect(issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)).rejects.toThrow(/en trámite/)
    expect(deps.createInvoice).not.toHaveBeenCalled()
  })

  it('reintento de la generación -n2 que falló: reclama la fila y usa la MISMA llave', async () => {
    const fallida = fila({ id: 'c-n2', status: 'STAMP_FAILED', idempotencyKey: 'cfdi-order-o1-n2', attempts: 1 })
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([fila({ status: 'CANCELLED', cancelStatus: 'CANCELLED' }), fallida]),
      reserveCfdi: jest.fn().mockRejectedValue(makeP2002()),
      findExistingCfdi: jest.fn().mockImplementation(async (llave: string) => (llave === 'cfdi-order-o1-n2' ? fallida : null)),
    })
    await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(deps.claimCfdi).toHaveBeenCalledWith('c-n2', expect.any(Array), 1)
    expect(deps.createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1-n2')
  })

  it('REGRESIÓN: sin facturas previas todo sigue igual (llave de siempre)', async () => {
    const deps = makeIssueDeps()
    const res = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect(res.status).toBe('STAMPED')
    expect(res.alreadyIssued).toBeFalsy()
    expect(deps.createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1')
  })
})

// ─── ¿Quién factura el efectivo? (founder, 24-sep-2026) ───────────────────────
// El interruptor «Facturar ventas en efectivo» gobierna la AUTOFACTURA del cliente (QR) y la global; el
// dueño/personal que factura una venta desde Pedidos lo hace a propósito y no lo necesita.

describe('issueCfdiForOrder — permitir efectivo según quién factura', () => {
  it('el PERSONAL (STAFF_B, o sin flujo) pide permitir efectivo', async () => {
    const deps = makeIssueDeps()
    await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1', flow: 'STAFF_B' }, deps)
    expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o1', { permitirEfectivo: true })
    ;(deps.loadOrderForCfdi as jest.Mock).mockClear()
    await issueCfdiForOrder(
      { orderId: 'o2', receptor, sandbox: true, expectedVenueId: 'v1' },
      makeIssueDeps({ loadOrderForCfdi: deps.loadOrderForCfdi }),
    )
    expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o2', { permitirEfectivo: true })
  })

  it('la AUTOFACTURA del cliente NO: respeta el interruptor del negocio', async () => {
    const deps = makeIssueDeps()
    await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1', flow: 'AUTOFACTURA_A' }, deps)
    expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o1', { permitirEfectivo: false })
  })
})

// ─── refreshPendingCancellation ───────────────────────────────────────────────

function refreshDeps(estado: { status: string; cancelledAt: Date | null }, over: Partial<RefreshCancellationDeps> = {}) {
  const getCancellationStatus = jest.fn().mockResolvedValue(estado)
  const deps: RefreshCancellationDeps = {
    resolveProvider: jest.fn().mockReturnValue({ name: 'facturapi', getCancellationStatus } as any),
    loadEmisor: jest.fn().mockResolvedValue({ id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE' }),
    applyCancelOutcome: jest
      .fn()
      .mockImplementation(async (_id: string, data: any) => ({ ...fila({ cancelStatus: 'REQUESTED' }), ...data })),
    logAction: jest.fn().mockResolvedValue(undefined),
    ...over,
  }
  return Object.assign(deps, { getCancellationStatus })
}

describe('refreshPendingCancellation', () => {
  beforeEach(() => jest.clearAllMocks())

  it('CASO A-14: el PAC dice cancelada ⇒ CANCELLED en los dos campos, con bitácora', async () => {
    const cuando = new Date('2026-09-21T18:09:00Z')
    const deps = refreshDeps({ status: 'canceled', cancelledAt: cuando })
    const r = await refreshPendingCancellation(fila({ cancelStatus: 'REQUESTED' }), { sandbox: false }, deps)
    expect(deps.getCancellationStatus).toHaveBeenCalledWith('fa-a14')
    const [id, data] = (deps.applyCancelOutcome as jest.Mock).mock.calls[0]
    expect(id).toBe('c-a14')
    expect(data).toMatchObject({ status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelledAt: cuando })
    expect(r.status).toBe('CANCELLED')
    expect(deps.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CFDI_CANCEL_CONFIRMED', entityId: 'c-a14', venueId: 'v1' }),
    )
  })

  it('sigue en trámite ⇒ no escribe nada', async () => {
    const deps = refreshDeps({ status: 'pending', cancelledAt: null })
    const antes = fila({ cancelStatus: 'REQUESTED' })
    const r = await refreshPendingCancellation(antes, { sandbox: false }, deps)
    expect(deps.applyCancelOutcome).not.toHaveBeenCalled()
    expect(r).toBe(antes)
  })

  it('el PAC dice que NO hay cancelación (none/expired/rejected) ⇒ REJECTED, sigue vigente, con la razón', async () => {
    for (const status of ['none', 'expired', 'rejected']) {
      const deps = refreshDeps({ status, cancelledAt: null })
      await refreshPendingCancellation(fila({ cancelStatus: 'REQUESTED' }), { sandbox: false }, deps)
      const data = (deps.applyCancelOutcome as jest.Mock).mock.calls[0][1]
      expect([status, data.cancelStatus, data.status]).toEqual([status, 'REJECTED', 'STAMPED'])
      expect(data.lastError).toMatch(/vigente/)
      expect(deps.logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_CANCEL_NOT_APPLIED' }))
    }
  })

  it('sin fecha del PAC, no inventa `cancelledAt`', async () => {
    const deps = refreshDeps({ status: 'canceled', cancelledAt: null })
    await refreshPendingCancellation(fila({ cancelStatus: 'REQUESTED' }), { sandbox: false }, deps)
    expect((deps.applyCancelOutcome as jest.Mock).mock.calls[0][1]).not.toHaveProperty('cancelledAt')
  })

  it('una fila que ya no está en trámite no se consulta', async () => {
    const deps = refreshDeps({ status: 'canceled', cancelledAt: null })
    await refreshPendingCancellation(fila({ cancelStatus: null }), { sandbox: false }, deps)
    expect(deps.getCancellationStatus).not.toHaveBeenCalled()
  })

  it('si otra petición ya la resolvió (CAS perdido) no escribe bitácora duplicada', async () => {
    const deps = refreshDeps({ status: 'canceled', cancelledAt: null }, { applyCancelOutcome: jest.fn().mockResolvedValue(null) })
    const antes = fila({ cancelStatus: 'REQUESTED' })
    const r = await refreshPendingCancellation(antes, { sandbox: false }, deps)
    expect(deps.logAction).not.toHaveBeenCalled()
    expect(r).toBe(antes)
  })
})

// ─── syncPendingCancellations (el barrido del job) ────────────────────────────

describe('syncPendingCancellations', () => {
  it('refresca cada pendiente y un fallo no detiene a las demás', async () => {
    const refresh = jest
      .fn()
      .mockRejectedValueOnce(new Error('PAC caído'))
      .mockResolvedValueOnce({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })
    const findPending = jest
      .fn()
      .mockResolvedValue([fila({ id: 'a', cancelStatus: 'REQUESTED' }), fila({ id: 'b', cancelStatus: 'REQUESTED' })])
    const tally = await syncPendingCancellations({ sandbox: false, now: new Date() }, { findPending, refresh })
    expect(refresh).toHaveBeenCalledTimes(2)
    expect(tally).toEqual({ revisadas: 2, resueltas: 1, siguenEnTramite: 0, errores: 1 })
  })
})
