import { withIssueTransaction } from '../../../__helpers__/issue-cfdi-transaction'
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
  sincronizarCancelacionExterna,
  SincronizarExternaDeps,
  syncPendingCancellations,
  tocaRevisarCancelaciones,
  llaveDeEmision,
  ENVIO_TERMINADO_MS,
} from '../../../../src/services/fiscal/cfdi.service'
import { ConflictError } from '../../../../src/errors/AppError'

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
    reserveCfdi: jest.fn().mockImplementation(async data => ({ id: 'nueva', ...data })),
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
      paidCents: 11600,
      order: {
        clasificacion: 'TODO_16',
        renglonesOrigen: [],
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
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
    } as any),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'nueva', ...data })),
    ...over,
  }
  return Object.assign(withIssueTransaction(deps), { createInvoice })
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

  // C2 · T10 ronda 1 (M3, cambia A PROPÓSITO): el texto depende del estado derivado; esta fila es un LEGADO acusado (`cancelIntento: 0`, el
  // default de la columna en producción). Sin el número, la fila se leería «anotada» y diría «se está enviando».
  it('con la cancelación EN TRÁMITE, primero le pregunta al PAC; si sigue en trámite, no timbra (409)', async () => {
    const pendiente = fila({ cancelStatus: 'REQUESTED', cancelIntento: 0 })
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
    expect(deps.createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1-n2#1')
    expect((deps.reserveCfdi as jest.Mock).mock.calls[0][0].idempotencyKey).toBe('cfdi-order-o1-n2')
    expect((deps.persistCfdi as jest.Mock).mock.calls[0][0]).toMatchObject({ status: 'STAMPED' })
    expect((deps.persistCfdi as jest.Mock).mock.calls[0][1]).toMatchObject({ idempotencyKey: 'cfdi-order-o1-n2', attempts: 1 })
  })

  it('a OTRA razón social tras cancelar: el receptor nuevo es el que se timbra', async () => {
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([fila({ status: 'CANCELLED', cancelStatus: 'CANCELLED' })]),
    })
    const otro = { ...receptor, rfc: 'XIA190128J61', razonSocial: 'XENON INDUSTRIAL ARTICLES' }
    await issueCfdiForOrder({ orderId: 'o1', receptor: otro, sandbox: true, expectedVenueId: 'v1' }, deps)
    expect((deps.reserveCfdi as jest.Mock).mock.calls[0][0]).toMatchObject({ receptorRfc: 'XIA190128J61' })
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
    const pendiente = fila({ cancelStatus: 'REQUESTED', cancelIntento: 0 }) // T10 ronda 1 (M3): legado acusado, ver arriba
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
    expect(deps.createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1#1')
  })
})

// ─── ¿Quién factura el efectivo? (founder, 24-sep-2026) ───────────────────────
// El interruptor «Facturar ventas en efectivo» gobierna la AUTOFACTURA del cliente (QR) y la global; el
// dueño/personal que factura una venta desde Pedidos lo hace a propósito y no lo necesita.

describe('issueCfdiForOrder — permitir efectivo según quién factura', () => {
  it('el PERSONAL (STAFF_B, o sin flujo) pide permitir efectivo', async () => {
    const deps = makeIssueDeps()
    await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1', flow: 'STAFF_B' }, deps)
    expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o1', { permitirEfectivo: true }, expect.anything())
    ;(deps.loadOrderForCfdi as jest.Mock).mockClear()
    await issueCfdiForOrder(
      { orderId: 'o2', receptor, sandbox: true, expectedVenueId: 'v1' },
      makeIssueDeps({ loadOrderForCfdi: deps.loadOrderForCfdi }),
    )
    expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o2', { permitirEfectivo: true }, expect.anything())
  })

  it('la AUTOFACTURA del cliente NO: respeta el interruptor del negocio', async () => {
    const deps = makeIssueDeps()
    await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1', flow: 'AUTOFACTURA_A' }, deps)
    expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o1', { permitirEfectivo: false }, expect.anything())
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
    now: () => new Date(),
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

  // C2 (dorada que cambia a propósito, Codex C2-11/C2-29): con el intento ya ACUSADO, «sigue en trámite» no escribe nada; sin acuse, se
  // acusa (probado en cfdiCancel.service.test.ts).
  const acusadaHace = (min: number) => {
    const t = new Date(Date.now() - min * 60_000)
    return { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelRequestedAt: t, cancelEnviadaAt: t, cancelAcusadaAt: t }
  }
  it('sigue en trámite (intento ya acusado) ⇒ no escribe nada', async () => {
    const deps = refreshDeps({ status: 'pending', cancelledAt: null })
    const antes = fila(acusadaHace(90))
    const r = await refreshPendingCancellation(antes, { sandbox: false }, deps)
    expect(deps.applyCancelOutcome).not.toHaveBeenCalled()
    expect(r).toBe(antes)
  })

  // C2 (dorada que cambia a propósito): el cierre negativo sólo corre con el envío TERMINADO (acusado o en duda) y nunca toca `status`
  // (sigue STAMPED porque la escritura no lo cambia, y el `where` de `aplicarCancelacion` lo exige).
  it('el PAC dice que NO hay cancelación (none/expired/rejected) sobre un intento acusado ⇒ REJECTED, sigue vigente, con la razón', async () => {
    for (const status of ['none', 'expired', 'rejected']) {
      const deps = refreshDeps({ status, cancelledAt: null })
      await refreshPendingCancellation(fila(acusadaHace(90)), { sandbox: false }, deps)
      const data = (deps.applyCancelOutcome as jest.Mock).mock.calls[0][1]
      expect([status, data.cancelStatus, data.status ?? 'sin cambio']).toEqual([status, 'REJECTED', 'sin cambio'])
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
    // C2 (dorada que cambia a propósito, C2-7): el resultado gana `cursor` (página no llena ⇒ vuelve al principio).
    expect(tally).toEqual({ revisadas: 2, resueltas: 1, siguenEnTramite: 0, errores: 1, cursor: null })
  })

  // full-testing 24-sep: una factura que el PAC no reconocía se reintentaba cada 5 min escribiendo `error:`.
  // Se reintenta igual (no se pierde), pero como aviso: no es una caída.
  it('un fallo al consultar una fila se registra como warn, no como error', async () => {
    const log = jest.requireMock('../../../../src/config/logger') as { error: jest.Mock; warn: jest.Mock }
    log.error.mockClear()
    log.warn.mockClear()
    const refresh = jest.fn().mockRejectedValue(new Error('El campo id no es válido'))
    const findPending = jest.fn().mockResolvedValue([fila({ id: 'x', cancelStatus: 'REQUESTED' })])
    const tally = await syncPendingCancellations({ sandbox: true, now: new Date() }, { findPending, refresh })
    expect(tally.errores).toBe(1)
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('no se pudo consultar la cancelación de x'))
    expect(log.error).not.toHaveBeenCalled()
  })
})

// ─── sincronizarCancelacionExterna (webhook: la cancelaron por fuera) ─────────
// El caso A-14: la factura se canceló desde el portal de Facturapi y Avoqado la seguía mostrando «Timbrada».

function externaDeps(estado: { status: string; cancelledAt: Date | null }, over: Partial<SincronizarExternaDeps> = {}) {
  const getCancellationStatus = jest.fn().mockResolvedValue(estado)
  const deps: SincronizarExternaDeps = {
    resolveProvider: jest.fn().mockReturnValue({ name: 'facturapi', getCancellationStatus } as any),
    loadEmisor: jest.fn().mockResolvedValue({ id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE' }),
    applyExternalCancel: jest.fn().mockImplementation(async (_id: string, data: any) => ({ ...fila({}), ...data })),
    logAction: jest.fn().mockResolvedValue(undefined),
    ...over,
  }
  return Object.assign(deps, { getCancellationStatus })
}

describe('sincronizarCancelacionExterna', () => {
  it('el PAC dice cancelada ⇒ CANCELLED con la fecha del PAC y bitácora marcada como externa', async () => {
    const cuando = new Date('2026-09-24T18:00:00Z')
    const deps = externaDeps({ status: 'canceled', cancelledAt: cuando })
    const r = await sincronizarCancelacionExterna(fila({}), { sandbox: false }, deps)

    expect(deps.getCancellationStatus).toHaveBeenCalledWith('fa-a14')
    const [id, data] = (deps.applyExternalCancel as jest.Mock).mock.calls[0]
    expect(id).toBe('c-a14')
    expect(data).toEqual({ status: 'CANCELLED', cancelStatus: 'CANCELLED', cancelledAt: cuando })
    expect(r.status).toBe('CANCELLED')
    expect(deps.logAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'CFDI_CANCEL_CONFIRMED', entityId: 'c-a14', data: expect.objectContaining({ origen: 'EXTERNA' }) }),
    )
  })

  it('aceptada por el receptor ⇒ también cancelada (cancelStatus ACCEPTED)', async () => {
    const deps = externaDeps({ status: 'accepted', cancelledAt: null })
    await sincronizarCancelacionExterna(fila({}), { sandbox: false }, deps)
    expect((deps.applyExternalCancel as jest.Mock).mock.calls[0][1]).toEqual({ status: 'CANCELLED', cancelStatus: 'ACCEPTED' })
  })

  // No la pedimos nosotros: «pendiente» o «sin cancelación» no dicen nada de nuestra factura. No se escribe.
  it('pendiente / sin cancelación / rechazada ⇒ no escribe nada', async () => {
    for (const status of ['pending', 'verifying', 'none', 'rejected', 'expired']) {
      const deps = externaDeps({ status, cancelledAt: null })
      const antes = fila({})
      const r = await sincronizarCancelacionExterna(antes, { sandbox: false }, deps)
      expect([status, (deps.applyExternalCancel as jest.Mock).mock.calls.length]).toEqual([status, 0])
      expect(r).toBe(antes)
    }
  })

  it('una fila que no está timbrada, o con cancelación en trámite, no se consulta', async () => {
    for (const f of [fila({ status: 'CANCELLED' }), fila({ cancelStatus: 'REQUESTED' }), fila({ facturapiId: null })]) {
      const deps = externaDeps({ status: 'canceled', cancelledAt: null })
      await sincronizarCancelacionExterna(f, { sandbox: false }, deps)
      expect(deps.getCancellationStatus).not.toHaveBeenCalled()
    }
  })

  it('si otra petición ya la resolvió (CAS perdido), no escribe bitácora', async () => {
    const deps = externaDeps({ status: 'canceled', cancelledAt: null }, { applyExternalCancel: jest.fn().mockResolvedValue(null) })
    await sincronizarCancelacionExterna(fila({}), { sandbox: false }, deps)
    expect(deps.logAction).not.toHaveBeenCalled()
  })
})

// ─── El barrido como RED DE SEGURIDAD (el webhook es la vía principal) ────────
// Decisión del founder (24-sep): no preguntar al PAC cada 5 min. El barrido corre 1×hora y sólo mira las
// cancelaciones que llevan más de una hora en trámite: si el webhook ya avisó, no queda nada que mirar.

describe('barrido de cancelaciones: una vez por hora, sólo las de más de 1 h', () => {
  it('pide sólo las cancelaciones pedidas hace más de una hora', async () => {
    const ahora = new Date('2026-09-24T12:00:00Z')
    const findPending = jest.fn().mockResolvedValue([])
    await syncPendingCancellations({ sandbox: false, now: ahora }, { findPending, refresh: jest.fn() })
    // C2 (dorada que cambia a propósito, C2-7): `findPending(cutoff, cursor)`; sin cursor, desde el principio.
    expect(findPending).toHaveBeenCalledWith(new Date('2026-09-24T11:00:00Z'), null)
  })

  it('toca revisar en la primera pasada y después sólo cuando ya pasó una hora', () => {
    const t0 = Date.parse('2026-09-24T12:00:00Z')
    expect(tocaRevisarCancelaciones(null, t0)).toBe(true)
    expect(tocaRevisarCancelaciones(t0, t0 + 5 * 60_000)).toBe(false)
    expect(tocaRevisarCancelaciones(t0, t0 + 59 * 60_000)).toBe(false)
    expect(tocaRevisarCancelaciones(t0, t0 + 60 * 60_000)).toBe(true)
  })
})

// ─── C2 · Tarea 10, ronda 1 (M3): refacturar con la cancelación de la anterior pedida ⇒ ConflictError con código y texto según el estado
describe('C2 · T10 ronda 1 (M3) — refacturar: `ConflictError(…, CFDI_CANCEL_PENDING)` y el texto según en qué va la cancelación', () => {
  beforeEach(() => jest.clearAllMocks())
  const T0 = new Date('2026-10-05T18:00:00.000Z')
  afterEach(() => jest.useRealTimers())
  const refacturar = async (anterior: Record<string, any>, ahora: Date) => {
    jest.useFakeTimers({ now: ahora, doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] })
    const pendiente = fila({ cancelStatus: 'REQUESTED', ...anterior })
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue([pendiente]),
      refreshPendingCancellation: jest.fn().mockResolvedValue(pendiente),
    })
    const err = await issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps).then(
      () => null,
      (e: unknown) => e,
    )
    expect(deps.createInvoice).not.toHaveBeenCalled()
    return err as any
  }
  it('🔴 en trámite (acusada) ⇒ ConflictError con código CFDI_CANCEL_PENDING y el texto de siempre', async () => {
    const err = await refacturar({ cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: T0 }, T0)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err).toMatchObject({ statusCode: 409, code: 'CFDI_CANCEL_PENDING' })
    expect(err.message).toBe(
      'La cancelación de la factura A-14 sigue en trámite ante el SAT; en cuanto quede cancelada podrás volver a facturar esta venta.',
    )
  })
  it('🔴 enviándose (token reciente, sin acuse) ⇒ «se está enviando al SAT», nunca «en trámite ante el SAT»', async () => {
    const err = await refacturar({ cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: null }, new Date(T0.getTime() + 30_000))
    expect(err).toMatchObject({ code: 'CFDI_CANCEL_PENDING' })
    expect(err.message).toBe(
      'La cancelación de la factura A-14 se está enviando al SAT; en cuanto quede cancelada podrás volver a facturar esta venta.',
    )
  })
  it('🔴 en duda (pasado el umbral, sin acuse) ⇒ «en duda… hasta 24 horas»', async () => {
    const err = await refacturar(
      { cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: null },
      new Date(T0.getTime() + ENVIO_TERMINADO_MS + 1_000),
    )
    expect(err).toMatchObject({ code: 'CFDI_CANCEL_PENDING' })
    expect(err.message).toBe(
      'La cancelación de la factura A-14 está en duda: la estamos confirmando con el SAT (puede tardar hasta 24 horas). En cuanto quede cancelada podrás volver a facturar esta venta.',
    )
  })
  it('🔴 un legado (`cancelIntento: 0`) y el estado heredado CANCEL_REQUESTED dicen «en trámite», con el código', async () => {
    expect((await refacturar({ cancelIntento: 0 }, T0)).message).toMatch(/A-14 sigue en trámite ante el SAT/)
    const heredada = await refacturar({ status: 'CANCEL_REQUESTED', cancelStatus: null }, T0)
    expect(heredada).toMatchObject({ code: 'CFDI_CANCEL_PENDING' })
    expect(heredada.message).toMatch(/A-14 sigue en trámite ante el SAT/)
  })
})

// C2 · OF-2 (T10 N-2, `task-10-rereview-1.md`): la original A sigue vigente junto a su sustituta B TIMBRADA. La venta ya está facturada con
// B: se contesta con B (antes: con A, la más vieja, y el texto mandaba a «Corregir importe», que la fila de A no ofrece). Hermano: A con la
// cancelación en trámite + B timbrada decía «en cuanto quede cancelada podrás volver a facturar esta venta», falso (sigue facturada con B).
describe('C2 · OF-2 (T10 N-2) — refacturar con la original vigente y su sustituta TIMBRADA', () => {
  beforeEach(() => jest.clearAllMocks())
  const T0 = new Date('2026-10-05T18:00:00.000Z')
  const sustituta = (over: Record<string, any> = {}) =>
    fila({ id: 'c-b', idempotencyKey: 'cfdi-order-o1-r1', folio: '15', uuid: 'UUID-B', replacesCfdiId: 'c-a14', ...over })
  const refacturar = (facturas: any[]) => {
    const deps = makeIssueDeps({
      findOrderInvoices: jest.fn().mockResolvedValue(facturas),
      refreshPendingCancellation: jest.fn().mockImplementation(async (c: any) => c),
    })
    return { deps, res: issueCfdiForOrder({ orderId: 'o1', receptor, sandbox: true, expectedVenueId: 'v1' }, deps) }
  }

  it('🔴 A vigente (cancelación rechazada) + B timbrada ⇒ alreadyIssued con B, y dice cuál original sigue vigente', async () => {
    const { deps, res } = refacturar([fila({ cancelStatus: 'REJECTED' }), sustituta()])
    const r = await res
    expect(r.alreadyIssued).toBe(true)
    expect(r.cfdi.id).toBe('c-b')
    expect(r.originalVigente).toMatchObject({ id: 'c-a14', serie: 'A', folio: '14', cancelStatus: 'REJECTED' })
    expect(deps.createInvoice).not.toHaveBeenCalled()
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
  })

  it('🔴 A con la cancelación EN TRÁMITE + B timbrada ⇒ alreadyIssued con B (nunca «podrás volver a facturar»)', async () => {
    const enTramite = fila({ cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: T0 })
    const { deps, res } = refacturar([enTramite, sustituta()])
    const r = await res
    expect(r.alreadyIssued).toBe(true)
    expect(r.cfdi.id).toBe('c-b')
    expect(r.originalVigente).toMatchObject({ id: 'c-a14', cancelStatus: 'REQUESTED' })
    expect(deps.refreshPendingCancellation).toHaveBeenCalledTimes(1)
    expect(deps.createInvoice).not.toHaveBeenCalled()
  })

  // Ronda de la ola (review-OF m2, cambia A PROPÓSITO): la sustituta B se está cancelando y la original A sigue vigente ⇒ la venta ESTÁ
  // facturada con A (se cancele o no B): `alreadyIssued` con A, no un 409 `CFDI_CANCEL_PENDING` (que el dashboard titulaba «la factura
  // anterior todavía no queda cancelada» y la autofactura pasaba tal cual al cliente final, con folios).
  it('🔴 m2: la SUSTITUTA con la cancelación en trámite y A vigente ⇒ alreadyIssued con A (y cuál sustituta se está cancelando)', async () => {
    const { deps, res } = refacturar([
      fila({}),
      sustituta({ cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: T0 }),
    ])
    const r = await res
    expect(r).toMatchObject({ status: 'STAMPED', alreadyIssued: true, cfdi: { id: 'c-a14' } })
    expect(r.sustitutaEnCancelacion).toMatchObject({ id: 'c-b', folio: '15', cancelStatus: 'REQUESTED' })
    expect(r.originalVigente).toBeUndefined()
    expect(deps.createInvoice).not.toHaveBeenCalled()
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
  })
  it('🔴 m2: ídem con la cancelación de A TAMBIÉN en trámite ⇒ alreadyIssued con A, nunca el 409', async () => {
    const enTramite = { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: T0 }
    const r = await refacturar([fila(enTramite), sustituta(enTramite)]).res
    expect(r).toMatchObject({ alreadyIssued: true, cfdi: { id: 'c-a14' }, sustitutaEnCancelacion: { id: 'c-b' } })
  })
  it('control — sin sustituta, la cancelación en trámite de la única factura sigue siendo el 409 `CFDI_CANCEL_PENDING`', async () => {
    const err: any = await refacturar([
      fila({ cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: T0, cancelAcusadaAt: T0 }),
    ]).res.then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(ConflictError)
    expect(err).toMatchObject({ code: 'CFDI_CANCEL_PENDING' })
    expect(err.message).toBe(
      'La cancelación de la factura A-14 sigue en trámite ante el SAT; en cuanto quede cancelada podrás volver a facturar esta venta.',
    )
  })

  it('control — con A cancelada, B es la única vigente: alreadyIssued con B y sin original vigente', async () => {
    const r = await refacturar([fila({ status: 'CANCELLED', cancelStatus: 'CANCELLED' }), sustituta()]).res
    expect(r.cfdi.id).toBe('c-b')
    expect(r.originalVigente).toBeUndefined()
  })

  it('control — la sustituta todavía NO timbrada no cuenta: la venta sigue facturada con A', async () => {
    const r = await refacturar([fila({}), sustituta({ status: 'STAMP_FAILED' })]).res
    expect(r.alreadyIssued).toBe(true)
    expect(r.cfdi.id).toBe('c-a14')
    expect(r.originalVigente).toBeUndefined()
  })
})
