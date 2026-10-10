// tests/unit/services/fiscal/cfdiReplacement.service.test.ts
//
// Sustitución de una factura equivocada (CFDI 4.0, TipoRelacion 04 + cancelación motivo 01).
//
// 🔴 Lo que estas pruebas protegen, y es lo que hace peligrosa esta operación: son DOS documentos
// fiscales en dos llamadas distintas al PAC. Entre timbrar la sustituta y cancelar la original hay
// una ventana en la que el proceso puede morir; si esa ventana no deja rastro durable, el negocio
// se queda con DOS facturas vivas por la misma venta y nadie sabe cuál vale.

jest.mock('../../../../src/utils/prismaClient', () => ({ default: {} }))
jest.mock('../../../../src/config/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() }))

import { Prisma } from '@prisma/client'
import { replaceCfdi, siguienteLlaveDeSustitucion } from '../../../../src/services/fiscal/cfdiReplacement.service'
import { claimWhere, loadOrderForCfdiFromDb } from '../../../../src/services/fiscal/cfdi.service'
import { CONFIG, orden, producto, renglon } from './fixtures/ivaPorProductoGoldenOrders'
import type { ReplaceCfdiDeps } from '../../../../src/services/fiscal/cfdiReplacement.service'
import { ProviderHttpError } from '../../../../src/services/fiscal/providers/facturapi.provider'
import { ConflictError } from '../../../../src/errors/AppError'

const D = (n: number) => new Prisma.Decimal(n)

const emisor = { id: 'e1', provider: 'FACTURAPI', providerKeyEnc: null, csdStatus: 'ACTIVE', serie: 'A' }

/** La factura equivocada: se timbró por $125 cuando el cliente pagó $135. */
const original = {
  id: 'cfdi-orig',
  venueId: 'v1',
  fiscalEmisorId: 'e1',
  orderId: 'o1',
  isGlobal: false,
  status: 'STAMPED',
  uuid: 'UUID-ORIG',
  facturapiId: 'fa-orig',
  serie: 'A',
  folio: '14',
  idempotencyKey: 'cfdi-order-o1',
  receptorRfc: 'EKU9003173C9',
  receptorNombre: 'ESCUELA KEMPER URGATE SA DE CV',
  receptorRegimen: '601',
  receptorCp: '64000',
  usoCfdi: 'G03',
  totalCents: 12500,
  // C2 ronda 1 (M5): la versión del timbre; sin ella la intención de cancelar se anotaba con versión `undefined`.
  attempts: 1,
  fiscalEmisor: emisor,
}

/** La orden YA corregida: el documento que se va a timbrar vale exactamente lo cobrado. */
function bundle(over: Record<string, any> = {}) {
  return {
    venueId: 'v1',
    venueSlug: 'testarudo',
    venueType: 'RESTAURANT',
    emisor,
    facturacionEnabled: true,
    autofacturaEnabled: true,
    paymentMethod: 'CASH',
    metodoPago: 'PUE',
    subtotalCents: 13500,
    taxCents: 0,
    totalCents: 13500,
    paidCents: 13500,
    order: {
      clasificacion: 'TODO_16',
      renglonesOrigen: [],
      venueType: 'RESTAURANT',
      tipAmount: D(0),
      pricesIncludeIva: true,
      items: [
        {
          productName: 'Capuchino',
          quantity: 1,
          unitPrice: D(135),
          discountAmount: D(0),
          product: { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null },
        },
      ],
    },
    ...over,
  }
}

const timbrada = {
  providerInvoiceId: 'fa-sub',
  uuid: 'UUID-SUB',
  serie: 'A',
  folio: '16',
  totalCents: 13500,
  stampedAt: new Date(),
  status: 'valid' as const,
}

function makeDeps(over: Partial<ReplaceCfdiDeps> = {}): ReplaceCfdiDeps {
  const deps: ReplaceCfdiDeps = {
    loadCfdi: jest.fn().mockResolvedValue(original),
    findSustituta: jest.fn().mockResolvedValue(null),
    loadOrderForCfdi: jest.fn().mockResolvedValue(bundle()),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice: jest.fn().mockResolvedValue(timbrada),
      // C2 · T5 ronda 1 (M3): un comprobante con sus totales; sin ellos no hay `xmlConceptos` (nunca se inventan).
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante SubTotal="100.00" Total="116.00"/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
      cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
    } as any),
    reserveCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi-sub', ...data })),
    // 🔴 Simula el upsert REAL: la fila ya existe con los importes de la reserva anterior y el
    // guardado escribe encima. Un mock que devuelve sólo `data` esconde justo el defecto que este
    // archivo tiene que cazar (la fila quedándose con el importe viejo del intento fallido).
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi-sub', totalCents: 12500, subtotalCents: 12500, ...data })),
    // Como el dep real: escribe sólo las URLs y devuelve la fila COMPLETA (findUnique).
    persistArtifacts: jest
      .fn()
      .mockImplementation(async (_llave, urls) => ({ id: 'cfdi-sub', uuid: 'UUID-SUB', status: 'STAMPED', ...urls })),
    claimCfdi: jest.fn().mockResolvedValue(true),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    updateCfdi: jest.fn().mockImplementation(async (id, data) => ({ ...original, id, ...data })),
    // C2: la cancelación anota su intención, toma el único envío, relee el token y sólo consulta si el intento ya está abierto.
    anotarIntencion: jest.fn().mockResolvedValue({ estado: 'ANOTADA', intento: 1 }),
    tomarEnvio: jest.fn().mockResolvedValue(new Date('2026-10-05T12:00:00Z')),
    dueno: jest.fn().mockResolvedValue(true),
    refresh: jest.fn(async (c: any) => c),
    ...over,
  }
  const tx = {
    $queryRaw: jest.fn().mockResolvedValue([{ venueId: 'v1', organizationId: 'org1' }]),
    $executeRaw: jest.fn().mockResolvedValue(1),
    cfdi: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(({ where }) => (where.id === original.id ? deps.loadCfdi(where.id) : deps.findSustituta(original.id))),
      updateMany: jest.fn(async ({ where, data }) => {
        if (data.status === 'STAMPED') return { count: (await deps.persistCfdi(data, where)) ? 1 : 0 }
        return { count: 1 }
      }),
    },
  }
  deps.runInTransaction ??= async work => work(tx as any)
  return deps
}

const params = { cfdiId: 'cfdi-orig', sandbox: true, expectedVenueId: 'v1' }

function providerDe(deps: ReplaceCfdiDeps) {
  return (deps.resolveProvider as jest.Mock).mock.results[0]?.value
}

describe('replaceCfdi — camino feliz', () => {
  beforeEach(() => jest.clearAllMocks())

  it('timbra la sustituta con relación 04 al UUID de la original y pide cancelar con motivo 01', async () => {
    const deps = makeDeps()
    const res = await replaceCfdi(params, deps)

    expect(res.status).toBe('REPLACED')
    expect(res.sustituta.uuid).toBe('UUID-SUB')

    const provider = providerDe(deps)
    const invoiceParams = provider.createInvoice.mock.calls[0][0]
    expect(invoiceParams.relation).toEqual({ tipoRelacion: '04', relatedUuids: ['UUID-ORIG'] })

    const cancelParams = provider.cancelInvoice.mock.calls[0][0]
    expect(cancelParams.motivo).toBe('01')
    expect(cancelParams.substituteUuid).toBe('UUID-SUB')
    expect(cancelParams.providerInvoiceId).toBe('fa-orig')
  })

  it('conserva emisor y receptor de la ORIGINAL (no los re-deriva de la orden)', async () => {
    const deps = makeDeps()
    await replaceCfdi(params, deps)

    const invoiceParams = providerDe(deps).createInvoice.mock.calls[0][0]
    expect(invoiceParams.receptor).toMatchObject({
      rfc: 'EKU9003173C9',
      razonSocial: 'ESCUELA KEMPER URGATE SA DE CV',
      regimenFiscal: '601',
      codigoPostal: '64000',
      usoCfdi: 'G03',
    })
    const reservada = (deps.reserveCfdi as jest.Mock).mock.calls[0][0]
    expect(reservada.fiscalEmisorId).toBe('e1')
    expect(reservada.receptorRfc).toBe('EKU9003173C9')
  })

  // 🔴 H24 (Codex, ronda 1 del plan de correo): el receptor se reconstruía SIN correo y la factura corregida nunca le llegaba
  // al cliente. La sustituta va al mismo correo que la original.
  it('la sustituta conserva el correo que el receptor dio al facturar la original', async () => {
    const conCorreo = { ...original, entrada: { params: { receptor: { email: 'finanzas@cliente.mx' } } } }
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue(conCorreo) })
    await replaceCfdi(params, deps)

    expect(providerDe(deps).createInvoice.mock.calls[0][0].receptor.email).toBe('finanzas@cliente.mx')
  })

  it('usa la llave cfdi-order-<id>-r1 y la estampa como external_id', async () => {
    const deps = makeDeps()
    await replaceCfdi(params, deps)

    const reservada = (deps.reserveCfdi as jest.Mock).mock.calls[0][0]
    expect(reservada.idempotencyKey).toBe('cfdi-order-o1-r1')
    expect(providerDe(deps).createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1-r1#1')
  })

  it('el importe timbrado es el CORREGIDO, tomado de la orden actual', async () => {
    const deps = makeDeps()
    await replaceCfdi(params, deps)
    const items = providerDe(deps).createInvoice.mock.calls[0][0].items
    expect(items).toHaveLength(1)
    expect(items[0].unitPriceCents).toBe(13500)
  })
})

describe('replaceCfdi — durabilidad', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 reserva la sustituta (con replacesCfdiId) ANTES de llamar al PAC', async () => {
    const orden: string[] = []
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockImplementation(async data => {
        orden.push('reserva')
        return { id: 'cfdi-sub', ...data }
      }),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockImplementation(async () => {
          orden.push('pac')
          return timbrada
        }),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
      } as any),
    })
    await replaceCfdi(params, deps)

    expect(orden).toEqual(['reserva', 'pac'])
    const reservada = (deps.reserveCfdi as jest.Mock).mock.calls[0][0]
    expect(reservada.replacesCfdiId).toBe('cfdi-orig')
    expect(reservada.status).toBe('STAMPING')
  })

  it('persiste la identidad del timbre, y los archivos van por un camino que no toca el estado', async () => {
    const deps = makeDeps()
    const res = await replaceCfdi(params, deps)
    const calls = (deps.persistCfdi as jest.Mock).mock.calls.map(c => c[0])
    expect(calls[0]).toMatchObject({ status: 'STAMPED', uuid: 'UUID-SUB' })
    expect(calls[0].xmlUrl ?? null).toBeNull()
    expect((deps.persistArtifacts as jest.Mock).mock.calls[0][1].xmlUrl).toMatch(/\.xml$/)
    // La fila devuelta conserva el timbre Y gana las URLs.
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    expect(res.sustituta.xmlUrl).toMatch(/\.xml$/)
  })

  it('un fallo al bajar los archivos NO invalida el timbre ni frena la cancelación', async () => {
    const deps = makeDeps({ storeArtifact: jest.fn().mockRejectedValue(new Error('storage caído')) })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(providerDe(deps).cancelInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('replaceCfdi — la cancelación NUNCA se da por hecha', () => {
  beforeEach(() => jest.clearAllMocks())

  it('el PAC contesta pending ⇒ REQUESTED, y la original NO queda CANCELLED', async () => {
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }),
      } as any),
    })
    const res = await replaceCfdi(params, deps)

    expect(res.cancelStatus).toBe('REQUESTED')
    expect(res.cancelPendiente).toBe(true)
    // C2 (dorada que cambia a propósito): el motivo 01 y el sustituto se escriben en la INTENCIÓN (antes del PAC); el «en trámite» del
    // PAC sólo acusa el intento. La original sigue vigente ante el SAT: nada la marca CANCELLED.
    expect(deps.anotarIntencion).toHaveBeenCalledWith('cfdi-orig', 1, { motivo: '01', substituteUuid: 'UUID-SUB' })
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update).toEqual({ cancelAcusadaAt: expect.any(Date) })
  })

  // C2 (dorada que cambia a propósito): un rechazo CONCLUYENTE llega del PAC como error con su código de cancelación (C2-25), no como un
  // `rejected` en la respuesta del POST (eso queda EN DUDA y lo decide la consulta).
  it('un rechazo del receptor se reporta y la sustituta sigue timbrada', async () => {
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest
          .fn()
          .mockRejectedValue(new ProviderHttpError(400, 'invoice_cancellation_not_allowed', 'El receptor no permite la cancelación')),
      } as any),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.cancelStatus).toBe('REJECTED')
    expect(res.cancelPendiente).toBe(true)
    expect(res.sustituta.uuid).toBe('UUID-SUB')
  })

  // C2 (dorada que cambia a propósito): el PAC que no contesta ya no «truena» la cancelación: la intención quedó anotada y enviada, así que
  // la original queda REQUESTED y EN DUDA (sólo se consulta, nunca se reenvía sola). La sustituta no se pierde.
  it('si el PAC no contesta la cancelación, la sustituta no se pierde: se reporta pendiente (en duda)', async () => {
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockRejectedValue(new Error('PAC caído')),
      } as any),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    expect(res.cancelStatus).toBe('REQUESTED')
    expect(res.cancelPendiente).toBe(true)
    expect(deps.updateCfdi).not.toHaveBeenCalled()
  })

  it('si la cancelación TRUENA antes del PAC (p. ej. la base), la sustituta no se pierde: se reporta pendiente sin estado', async () => {
    const deps = makeDeps({ anotarIntencion: jest.fn().mockRejectedValue(new Error('connection terminated')) })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    expect(res.cancelStatus).toBeNull()
    expect(res.cancelPendiente).toBe(true)
    expect(providerDe(deps).cancelInvoice).not.toHaveBeenCalled()
  })

  // C2 ronda 2 (N3): hermano de M8 en la rama genérica. Si la consulta previa al PAC falla (M1), el intento ya quedó cerrado
  // («no se llegó a enviar»): el resultado tiene que describir la original RELEÍDA y decir el aviso, como aviso (no como error).
  it('🔴 N3: la consulta previa falla dentro de la sustitución ⇒ original releída (REJECTED), `cancelAviso` con su texto, warn y no error', async () => {
    const cerrada = { ...original, cancelStatus: 'REJECTED', cancelIntento: 1, lastError: 'No se llegó a enviar la cancelación…' }
    const loadCfdi = jest.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValue(cerrada)
    const deps = makeDeps({
      loadCfdi,
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        // C2 · T5 ronda 1: un comprobante con sus totales (sin ellos no hay `xmlConceptos` y eso se registra como error, que aquí no toca).
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante SubTotal="100.00" Total="116.00"/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        getCancellationStatus: jest.fn().mockRejectedValue(new Error('connect ETIMEDOUT')),
        cancelInvoice: jest.fn(),
      } as any),
    })
    const log = jest.requireMock('../../../../src/config/logger') as { error: jest.Mock; warn: jest.Mock }
    log.error.mockClear()
    log.warn.mockClear()
    const res = await replaceCfdi(params, deps)
    expect(res).toMatchObject({
      status: 'REPLACED',
      cancelStatus: 'REJECTED',
      cancelPendiente: true,
      original: { cancelStatus: 'REJECTED' },
    })
    expect(res.cancelAviso).toMatch(/no se envió nada/)
    expect(providerDe(deps).cancelInvoice).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
  })

  it('🔴 N3: un error cualquiera tras el timbre ⇒ también la original RELEÍDA (no la foto de antes de timbrar)', async () => {
    const releida = { ...original, cancelStatus: 'REQUESTED', cancelIntento: 1 }
    const loadCfdi = jest.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValue(releida)
    const deps = makeDeps({ loadCfdi, tomarEnvio: jest.fn().mockRejectedValue(new Error('connection terminated')) })
    const res = await replaceCfdi(params, deps)
    expect(res).toMatchObject({ cancelStatus: 'REQUESTED', cancelPendiente: true, original: { cancelStatus: 'REQUESTED' } })
  })

  // C2 ronda 1 (M8): con el conflicto, el resultado describe la original RELEÍDA (`vigente`), no la foto de antes de timbrar.
  it('M8: con el ConflictError, el cancelStatus del resultado sale de la original releída', async () => {
    const loadCfdi = jest
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, cancelStatus: 'REJECTED', lastError: 'El receptor rechazó…' })
    const deps = makeDeps({
      loadCfdi,
      anotarIntencion: jest.fn().mockResolvedValue({ conflicto: 'Esta factura tiene la nota de crédito A-3 vigente; …' }),
    })
    expect(await replaceCfdi(params, deps)).toMatchObject({
      cancelStatus: 'REJECTED',
      cancelPendiente: true,
      original: { cancelStatus: 'REJECTED' },
    })
  })

  // 🔴 M6 (pre-flight C2, decisión G4): el `ConflictError` de la intención (documentos relacionados vivos, u otra cancelación en trámite
  // con otro motivo) NO es «el PAC no contestó»: se devuelve con su texto y se registra como aviso, no como error.
  it('🔴 M6: la original tiene una nota de crédito viva ⇒ la sustituta queda timbrada y el resultado trae el texto del conflicto', async () => {
    const texto = 'Esta factura tiene la nota de crédito A-3 vigente; el SAT exige cancelar primero lo relacionado.'
    const deps = makeDeps({ anotarIntencion: jest.fn().mockResolvedValue({ conflicto: texto }) })
    const log = jest.requireMock('../../../../src/config/logger') as { error: jest.Mock; warn: jest.Mock }
    log.error.mockClear()
    log.warn.mockClear()
    const res = await replaceCfdi(params, deps)
    expect(res).toMatchObject({ status: 'REPLACED', cancelPendiente: true, cancelConflicto: texto })
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    expect(providerDe(deps).cancelInvoice).not.toHaveBeenCalled()
    expect(log.error).not.toHaveBeenCalled()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('A-3'))
  })
})

describe('replaceCfdi — no se timbra un segundo documento equivocado', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 barrera de dinero: si el documento corregido no cuadra con lo cobrado, NO toca el PAC', async () => {
    const deps = makeDeps({ loadOrderForCfdi: jest.fn().mockResolvedValue(bundle({ paidCents: 14000 })) })
    const res = await replaceCfdi(params, deps)

    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons?.join(' ')).toMatch(/no coincide con lo cobrado/)
    expect(deps.reserveCfdi).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'VALIDATION_FAILED', attempts: 0, protocoloIva: 1 }),
      expect.anything(),
    )
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('6b, barrera de dinero: el documento corregido del R5 sumado como el PAC da $67.49 contra $67.50 ⇒ NO toca el PAC', async () => {
    const producto = { satProductKey: '90101500', satUnitKey: 'E48', objetoImp: '02', taxRate: D(0.16), category: null }
    const r5 = bundle({
      subtotalCents: 5819,
      taxCents: 931,
      totalCents: 6750,
      paidCents: 6750,
      order: {
        ...bundle().order,
        items: [
          { productName: 'CAPUCCINO', quantity: 1, unitPrice: D(65), discountAmount: D(2.33), product: producto },
          { productName: 'Deslactosada (CAPUCCINO)', quantity: 1, unitPrice: D(5), discountAmount: D(0.17), product: producto },
        ],
      },
    })
    const deps = makeDeps({ loadOrderForCfdi: jest.fn().mockResolvedValue(r5) })
    const res = await replaceCfdi(params, deps)

    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons?.join(' ')).toContain('El total de la factura corregida ($67.49) no coincide con lo cobrado ($67.50)')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('sobre seguro: una orden que no se puede reconstruir NO se sustituye', async () => {
    const deps = makeDeps({
      loadOrderForCfdi: jest.fn().mockResolvedValue(bundle({ unsupportedReasons: ['La cuenta lleva una promoción'] })),
    })
    const res = await replaceCfdi(params, deps)

    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons).toContain('La cuenta lleva una promoción')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('una validación D1 fallida (CSD vencido) tampoco llega al PAC', async () => {
    const deps = makeDeps({
      loadOrderForCfdi: jest.fn().mockResolvedValue(bundle({ emisor: { ...emisor, csdStatus: 'EXPIRED' } })),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('VALIDATION_FAILED')
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('un fallo del PAC al timbrar deja STAMP_FAILED y NO cancela la original', async () => {
    const cancelInvoice = jest.fn()
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockRejectedValue(new Error('timbre rechazado')),
        cancelInvoice,
      } as any),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('STAMP_FAILED')
    expect(cancelInvoice).not.toHaveBeenCalled()
    expect((deps.persistCfdi as jest.Mock).mock.calls[0][0].status).toBe('STAMP_FAILED')
  })
})

describe('replaceCfdi — reanudar y concurrencia', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 con una sustituta YA timbrada no vuelve a timbrar: reanuda la cancelación', async () => {
    const sustituta = { id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', facturapiId: 'fa-sub', replacesCfdiId: 'cfdi-orig' }
    const deps = makeDeps({ findSustituta: jest.fn().mockResolvedValue(sustituta) })
    const res = await replaceCfdi(params, deps)

    expect(res.status).toBe('REPLACED')
    expect(providerDe(deps).createInvoice).not.toHaveBeenCalled()
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
    expect(providerDe(deps).cancelInvoice).toHaveBeenCalledTimes(1)
    expect(providerDe(deps).cancelInvoice.mock.calls[0][0].substituteUuid).toBe('UUID-SUB')
  })

  // C2 · T10 ronda 1 (I-2): «Terminar la sustitución» en la fila de la original vuelve a llamar a esta ruta cuando la cancelación de la
  // original no salió (`cancelAviso`: quedó REJECTED) o no se pudo pedir (`cancelConflicto`: sin cancelación). Con la sustituta YA
  // timbrada, NUNCA se timbra otra: sólo se reanuda la cancelación de la original, con motivo 01 y el UUID de la que ya existe.
  it.each([
    [
      'la cancelación de la original no salió (REJECTED, `cancelAviso`)',
      { cancelStatus: 'REJECTED', cancelIntento: 1, lastError: 'No se llegó a enviar…' },
    ],
    ['la cancelación de la original no se pudo pedir (sin cancelación, `cancelConflicto`)', { cancelStatus: null }],
  ])(
    'control — I-2: %s ⇒ reanuda SÓLO la cancelación (motivo 01 + UUID de la sustituta); nunca timbra una segunda',
    async (_caso, estado) => {
      const sustituta = { id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', facturapiId: 'fa-sub', replacesCfdiId: 'cfdi-orig' }
      const deps = makeDeps({
        loadCfdi: jest.fn().mockResolvedValue({ ...original, ...estado }),
        findSustituta: jest.fn().mockResolvedValue(sustituta),
      })
      const res = await replaceCfdi(params, deps)

      expect(res).toMatchObject({ status: 'REPLACED', sustituta: { id: 'cfdi-sub', uuid: 'UUID-SUB' } })
      expect(providerDe(deps).createInvoice).not.toHaveBeenCalled()
      expect(deps.reserveCfdi).not.toHaveBeenCalled()
      expect(deps.claimCfdi).not.toHaveBeenCalled()
      expect(deps.loadOrderForCfdi).not.toHaveBeenCalled()
      expect(deps.anotarIntencion).toHaveBeenCalledWith('cfdi-orig', 1, { motivo: '01', substituteUuid: 'UUID-SUB' })
      expect(providerDe(deps).cancelInvoice).toHaveBeenCalledTimes(1)
      expect(providerDe(deps).cancelInvoice.mock.calls[0][0]).toMatchObject({ motivo: '01', substituteUuid: 'UUID-SUB' })
    },
  )

  it('con una sustitución EN VUELO (STAMPING fresca) corta con 409 y no toca el PAC', async () => {
    const deps = makeDeps({
      findSustituta: jest
        .fn()
        .mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPING', updatedAt: new Date(), replacesCfdiId: 'cfdi-orig' }),
    })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/en proceso/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('un intento fallido se RECLAMA antes de reintentar; quien pierde el reclamo recibe 409', async () => {
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({ id: 'cfdi-sub', status: 'STAMP_FAILED', replacesCfdiId: 'cfdi-orig' }),
      claimCfdi: jest.fn().mockResolvedValue(false),
    })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/en proceso/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  // C2 · T10 (M4 de la T3): una sustituta HEREDADA ya terminada (cancelada, o con su cancelación pendiente) no se reclama nunca (D21): antes
  // contestaba para siempre «Sustitución en proceso para esta factura», que es falso. Ahora dice qué pasó y a quién acudir; nada se timbra.
  it.each([
    ['CANCELLED', /se canceló antes de este sistema/],
    ['CANCEL_REQUESTED', /tiene una cancelación pendiente de antes de este sistema/],
  ])(
    '🔴 T10 (M4): sustituta heredada %s ⇒ 409 que dice qué pasó y manda a soporte (nunca «en proceso»), sin reclamar ni tocar el PAC',
    async (status, texto) => {
      const deps = makeDeps({
        findSustituta: jest.fn().mockResolvedValue({
          id: 'cfdi-sub',
          status,
          protocoloIva: null,
          serie: 'A',
          folio: '15',
          replacesCfdiId: 'cfdi-orig',
          venueId: 'v1',
        }),
        claimCfdi: jest.fn().mockResolvedValue(false),
      })
      const err = await replaceCfdi(params, deps).catch(e => e)
      expect(err).toBeInstanceOf(ConflictError)
      expect(err.message).toMatch(texto)
      expect(err.message).toMatch(/A-15/)
      expect(err.message).toMatch(/soporte/)
      expect(err.message).not.toMatch(/en proceso/)
      expect(deps.claimCfdi).not.toHaveBeenCalled()
      expect(deps.resolveProvider).not.toHaveBeenCalled()
    },
  )

  it('si gana el reclamo, reintenta el timbrado sobre la MISMA fila', async () => {
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({
        id: 'cfdi-sub',
        status: 'STAMP_FAILED',
        attempts: 2,
        idempotencyKey: 'cfdi-order-o1-r1',
        replacesCfdiId: 'cfdi-orig',
        venueId: 'v1',
      }),
      claimCfdi: jest.fn().mockResolvedValue(true),
    })
    // Este conector NO sabe consultar por external_id (versión anterior): se sigue sin él.
    const res = await replaceCfdi(params, deps)
    expect(deps.claimCfdi).toHaveBeenCalledWith('cfdi-sub', expect.arrayContaining(['STAMPING', 'STAMP_FAILED']), 2)
    expect(res.status).toBe('REPLACED')
    expect(deps.reserveCfdi).not.toHaveBeenCalled() // la fila ya existe
  })

  it('una carrera en la reserva (P2002) no produce un segundo documento', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', {
      code: 'P2002',
      clientVersion: 'x',
      meta: { target: ['idempotencyKey'] },
    })
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(p2002),
      findSustituta: jest
        .fn()
        .mockResolvedValueOnce(null) // primera mirada: no hay
        .mockResolvedValueOnce(null) // reserva bajo transacción
        .mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPING', updatedAt: new Date(), replacesCfdiId: 'cfdi-orig' }),
    })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/en proceso/i)
    expect(providerDe(deps)?.createInvoice).toBeUndefined()
  })
})

describe('replaceCfdi — guardas', () => {
  beforeEach(() => jest.clearAllMocks())

  it('rechaza una factura de otro negocio como si no existiera (aislamiento)', async () => {
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, venueId: 'OTRO' }) })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/not found/i)
  })

  it('rechaza sustituir una factura que no está timbrada', async () => {
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, status: 'STAMP_FAILED' }) })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/timbrada/i)
  })

  it('rechaza sustituir una factura ya cancelada', async () => {
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, status: 'CANCELLED' }) })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/cancelada|timbrada/i)
  })

  it('rechaza sustituir una factura GLOBAL por este camino', async () => {
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, isGlobal: true, orderId: null }) })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/global/i)
  })

  it('🔴 rechaza si el emisor de la orden ya NO es el de la factura original', async () => {
    const deps = makeDeps({
      loadOrderForCfdi: jest.fn().mockResolvedValue(bundle({ emisor: { ...emisor, id: 'e2' } })),
    })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/emisor/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('rechaza si la orden ya no se puede cargar', async () => {
    const deps = makeDeps({ loadOrderForCfdi: jest.fn().mockResolvedValue(null) })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/not found|no se pudo/i)
  })

  // C2 · Tarea 3 (+ G4 del controlador): la sustitución no EMPIEZA sobre una original con cancelación en trámite, ni sobre una con
  // notas de crédito vivas (si no, la sustituta se timbraría y LUEGO la guarda C2-6 rechazaría cancelar la original: dos ingresos
  // vivos por la misma venta). Las dos se revisan en el `capture` de la emisión, bajo el candado de la orden.
  /** `runInTransaction` de makeDeps hace `work(tx)`: con la identidad devuelve el MISMO tx que usará la sustitución. */
  const txDe = (deps: ReplaceCfdiDeps) => deps.runInTransaction!(async (tx: any) => tx) as Promise<any>

  // T10 (M2 de la T3), cambio A PROPÓSITO: «en trámite ante el SAT» es la cancelación ACUSADA; la fila del caso lo dice ahora.
  it('🔴 T3: original con cancelación en trámite ⇒ 409 con su texto, sin reservar sustituta ni tocar el PAC', async () => {
    const enTramite = { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: new Date(), cancelAcusadaAt: new Date() }
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, ...enTramite }) })
    const err = await replaceCfdi(params, deps).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.message).toBe('Esta factura tiene una cancelación en trámite ante el SAT; espera a que se resuelva antes de sustituirla.')
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('🔴 T10 (M2 de la T3): con la cancelación sólo ANOTADA (nunca se envió) el 409 no dice «en trámite ante el SAT»', async () => {
    const anotada = { cancelStatus: 'REQUESTED', cancelIntento: 1, cancelEnviadaAt: null, cancelAcusadaAt: null }
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, ...anotada }) })
    const err = await replaceCfdi(params, deps).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.message).toBe('La cancelación de esta factura se está enviando al SAT; espera a que se resuelva antes de sustituirla.')
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('🔴 G4: original con una nota de crédito viva ⇒ 409 con el texto de C2-6, sin reservar sustituta ni tocar el PAC', async () => {
    const deps = makeDeps()
    const tx = await txDe(deps)
    tx.cfdi.findFirst.mockImplementation(async ({ where }: any) =>
      where.type === 'EGRESO' ? { serie: 'NC', folio: '7', uuid: 'UUID-NC', status: 'STAMPED' } : null,
    )
    const err = await replaceCfdi(params, deps).catch(e => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect(err.message).toBe('Esta factura tiene la nota de crédito NC-7 vigente; el SAT exige cancelar primero lo relacionado.')
    // La MISMA búsqueda que la cancelación: egresos vivos que apuntan a ESTA original (o heredados, por su orden).
    const busqueda = tx.cfdi.findFirst.mock.calls.map((c: any) => c[0].where).find((w: any) => w.type === 'EGRESO')
    expect(busqueda).toMatchObject({
      id: { not: 'cfdi-orig' },
      OR: [{ entrada: { path: ['originalCfdiId'], equals: 'cfdi-orig' } }, { orderId: 'o1', protocoloIva: null }],
    })
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  it('control — una cancelación RECHAZADA y sin notas vivas no estorba: la sustitución se timbra', async () => {
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, cancelStatus: 'REJECTED' }) })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(providerDe(deps).createInvoice).toHaveBeenCalledTimes(1)
  })
})

describe('siguienteLlaveDeSustitucion', () => {
  it('primera sustitución: -r1', () => {
    expect(siguienteLlaveDeSustitucion('cfdi-order-o1', 'o1')).toBe('cfdi-order-o1-r1')
  })

  it('sustituir una sustituta encadena: -r2', () => {
    expect(siguienteLlaveDeSustitucion('cfdi-order-o1-r1', 'o1')).toBe('cfdi-order-o1-r2')
  })

  it('sin llave previa cae a una determinista por orden', () => {
    expect(siguienteLlaveDeSustitucion(null, 'o1')).toBe('cfdi-order-o1-r1')
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// Hallazgos de la auditoría de Codex (22-sep). Cada uno reproduce el escenario que
// describió, con el código real y sus dependencias simuladas.
// ──────────────────────────────────────────────────────────────────────────────

describe('replaceCfdi — P1/P2 de la auditoría', () => {
  beforeEach(() => jest.clearAllMocks())

  // P1-1 · El reclamo tiene que ser EXCLUSIVO: dos reintentos leen la misma fila fallida y los dos
  // llaman a claimCfdi con la MISMA versión. Sin versión en el predicado, ambos ganan y timbran.
  it('🔴 reclama con la VERSIÓN que leyó, no sólo por estado', async () => {
    const previa = {
      id: 'cfdi-sub',
      status: 'STAMP_FAILED',
      attempts: 3,
      idempotencyKey: 'cfdi-order-o1-r1',
      replacesCfdiId: 'cfdi-orig',
      venueId: 'v1',
    }
    const deps = makeDeps({ findSustituta: jest.fn().mockResolvedValue(previa) })
    await replaceCfdi(params, deps)
    expect(deps.claimCfdi).toHaveBeenCalledWith('cfdi-sub', expect.any(Array), 3)
  })

  // P1-2 · Un timeout tras el timbrado deja STAMP_FAILED con el documento YA emitido. Re-timbrar sin
  // preguntarle al PAC produce un TERCER documento fiscal por la misma venta.
  it('🔴 antes de re-timbrar un intento reclamado le pregunta al PAC por su external_id', async () => {
    const findByExternalId = jest.fn().mockResolvedValue({
      providerInvoiceId: 'fa-sub',
      uuid: 'UUID-SUB',
      serie: 'A',
      folio: '16',
      status: 'valid',
      stampedAt: new Date(),
    })
    const createInvoice = jest.fn().mockResolvedValue(timbrada)
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({
        id: 'cfdi-sub',
        status: 'STAMP_FAILED',
        attempts: 1,
        idempotencyKey: 'cfdi-order-o1-r1',
        replacesCfdiId: 'cfdi-orig',
        venueId: 'v1',
      }),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        findByExternalId,
        createInvoice,
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
      } as any),
    })
    const res = await replaceCfdi(params, deps)

    expect(findByExternalId).toHaveBeenCalledWith('cfdi-order-o1-r1')
    expect(createInvoice).not.toHaveBeenCalled() // el documento ya existía: NO se timbra otro
    expect(res.status).toBe('REPLACED')
    expect(res.sustituta.uuid).toBe('UUID-SUB')
  })

  it('si el PAC no contesta al reconciliar, NO timbra a ciegas', async () => {
    const createInvoice = jest.fn().mockResolvedValue(timbrada)
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({
        id: 'cfdi-sub',
        status: 'STAMP_FAILED',
        attempts: 1,
        idempotencyKey: 'cfdi-order-o1-r1',
        replacesCfdiId: 'cfdi-orig',
        venueId: 'v1',
      }),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        findByExternalId: jest.fn().mockRejectedValue(new Error('PAC caído')),
        createInvoice,
      } as any),
    })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/en proceso/i)
    expect(createInvoice).not.toHaveBeenCalled()
  })

  // P1-4 · Mientras bajan los archivos, otra petición cancela la factura. El segundo guardado NO
  // puede reescribir la vigencia fiscal: resucitaría un documento cancelado.
  it('🔴 guardar los archivos NO reescribe el estado fiscal', async () => {
    const deps = makeDeps()
    await replaceCfdi(params, deps)
    expect(deps.persistArtifacts).toHaveBeenCalledTimes(1)
    const [, artefactos] = (deps.persistArtifacts as jest.Mock).mock.calls[0]
    // C2 · T5: los archivos llevan también los conceptos del XML (evidencia, no estado fiscal).
    expect(Object.keys(artefactos).sort()).toEqual(['pdfUrl', 'taxBreakdown', 'xmlConceptos', 'xmlUrl'])
    // Y el único persistCfdi del camino feliz es el del TIMBRE.
    expect((deps.persistCfdi as jest.Mock).mock.calls).toHaveLength(1)
  })

  it('el orden real es: persistir el timbre ANTES de bajar los archivos', async () => {
    const orden: string[] = []
    const deps = makeDeps({
      persistCfdi: jest.fn().mockImplementation(async data => {
        orden.push(`persist:${data.status}`)
        return { id: 'cfdi-sub', ...data }
      }),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockImplementation(async () => {
          orden.push('downloadXml')
          return Buffer.from('<Comprobante/>')
        }),
        downloadPdf: jest.fn().mockImplementation(async () => {
          orden.push('downloadPdf')
          return Buffer.from('%PDF')
        }),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
      } as any),
    })
    await replaceCfdi(params, deps)
    expect(orden[0]).toBe('persist:STAMPED')
    expect(orden.slice(1).sort()).toEqual(['downloadPdf', 'downloadXml'])
  })

  // P2-6 · Entre la reserva fallida y el reintento, la cuenta se corrigió. Lo que se timbró vale
  // $150; si la fila conserva los $135 de la reserva, la base miente sobre un documento fiscal.
  it('🔴 al reintentar, la fila guarda el importe que SE TIMBRÓ, no el de la reserva vieja', async () => {
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({
        id: 'cfdi-sub',
        status: 'STAMP_FAILED',
        attempts: 1,
        idempotencyKey: 'cfdi-order-o1-r1',
        replacesCfdiId: 'cfdi-orig',
        venueId: 'v1',
        totalCents: 12500,
        subtotalCents: 12500,
      }),
      loadOrderForCfdi: jest.fn().mockResolvedValue(bundle()), // la cuenta corregida: $135
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        findByExternalId: jest.fn().mockResolvedValue(null),
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
      } as any),
    })
    await replaceCfdi(params, deps)
    const [guardada, where] = (deps.persistCfdi as jest.Mock).mock.calls.find(([data]) => data.status === 'STAMPING')!
    expect(where).toMatchObject({ id: 'cfdi-sub', attempts: 2, status: 'STAMPING' })
    expect((deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0].totalCents).toBeUndefined()
    expect(guardada.totalCents).toBe(13500)
    expect(guardada.subtotalCents).toBe(13500)
  })

  // P2-7 · Una nota de crédito (EGRESO) también tiene orderId y puede estar STAMPED. Sustituirla
  // reconstruiría la factura de VENTA: un documento que no corresponde al que se relaciona.
  it('🔴 rechaza sustituir una NOTA DE CRÉDITO (EGRESO) por este camino', async () => {
    const deps = makeDeps({ loadCfdi: jest.fn().mockResolvedValue({ ...original, type: 'EGRESO' }) })
    await expect(replaceCfdi(params, deps)).rejects.toThrow(/nota de crédito|egreso/i)
    expect(deps.resolveProvider).not.toHaveBeenCalled()
  })

  // P2-5 · Repetir el POST después de una sustitución COMPLETA no es un error: es el mismo cliente
  // que perdió la respuesta. Tiene que contestar lo mismo, no 409.
  it('🔴 repetir el POST de una sustitución YA terminada devuelve el mismo resultado, no 409', async () => {
    const deps = makeDeps({
      loadCfdi: jest
        .fn()
        .mockResolvedValue({ ...original, status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelSubstituteUuid: 'UUID-SUB' }),
      findSustituta: jest
        .fn()
        .mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', venueId: 'v1', replacesCfdiId: 'cfdi-orig' }),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.cancelPendiente).toBe(false)
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    // No vuelve a pedir la cancelación de algo ya cancelado.
    expect(providerDe(deps)?.cancelInvoice).toBeUndefined()
  })

  it('cancelación concurrente: al perder CAS relee la original y no deja pendiente una cancelación confirmada', async () => {
    const loadCfdi = jest.fn().mockResolvedValue(original)
    const deps = makeDeps({
      loadCfdi,
      findSustituta: jest
        .fn()
        .mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', venueId: 'v1', replacesCfdiId: original.id }),
      updateCfdi: jest.fn().mockImplementation(async () => {
        loadCfdi.mockResolvedValue({ ...original, status: 'CANCELLED', cancelStatus: 'ACCEPTED' })
        return null
      }),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.cancelStatus).toBe('ACCEPTED')
    expect(res.cancelPendiente).toBe(false)
    expect(res.original.status).toBe('CANCELLED')
  })

  // P2-5b · Al reanudar, la original se RELEE: entre una corrida y otra pudo cambiar de estado.
  it('al reanudar la cancelación relee la original en vez de usar la foto vieja', async () => {
    const loadCfdi = jest
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, cancelStatus: 'REQUESTED' })
    const deps = makeDeps({
      loadCfdi,
      findSustituta: jest
        .fn()
        .mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', venueId: 'v1', replacesCfdiId: 'cfdi-orig' }),
    })
    await replaceCfdi(params, deps)
    expect(loadCfdi).toHaveBeenCalledTimes(2)
  })
})

// El predicado del reclamo, probado DIRECTO. Las pruebas de concurrencia de arriba deciden el
// ganador con un mock (`claimCfdi: true/false`), así que no ejercitan el predicado — que es
// justo donde estaba el defecto P1-1 (dos reintentos ganando los dos).
describe('claimWhere — el predicado del reclamo', () => {
  it('exige id, un estado admitido Y la versión exacta que se leyó', () => {
    expect(claimWhere('c1', ['STAMPING', 'STAMP_FAILED'], 7)).toEqual({
      id: 'c1',
      status: { in: ['STAMPING', 'STAMP_FAILED'] },
      attempts: 7,
    })
  })

  it('🔴 la versión NUNCA puede quedar fuera del predicado', () => {
    const w = claimWhere('c1', ['STAMPING'], 0)
    // `attempts: undefined` en Prisma significa «sin filtro» — sería volver al defecto.
    expect(w.attempts).toBe(0)
    expect(Object.prototype.hasOwnProperty.call(w, 'attempts')).toBe(true)
  })
})

it('sustituir una autofactura sigue siendo acción del personal y permite efectivo con autofactura apagada', async () => {
  const deps = makeDeps({
    loadCfdi: jest.fn().mockResolvedValue({ ...original, flow: 'AUTOFACTURA_A' }),
    loadOrderForCfdi: jest.fn().mockResolvedValue(bundle({ autofacturaEnabled: false })),
  })
  expect((await replaceCfdi(params, deps)).status).toBe('REPLACED')
  expect(deps.loadOrderForCfdi).toHaveBeenCalledWith('o1', { permitirEfectivo: true }, expect.anything())
})

// B3a ronda final F1 (Codex final #1): la sustitución lee los importes del MISMO cargador, con el subtotal BRUTO del escritor nativo.
it('🔴 F1: sustituir dos de $100 con IVA aparte y $20 de cuenta (cobro $208.80, cero ajustes) guarda lo que dirá el XML y timbra', async () => {
  const pieza = (nombre: string) =>
    renglon({ id: `oi-${nombre}`, productName: nombre, unitPrice: D(100), total: D(100), product: producto({ name: nombre }) })
  const venta = orden(208.8, {
    subtotal: D(200), // como lo guarda el escritor nativo: antes del descuento
    taxAmount: D(28.8), // 32.00 − D16
    total: D(208.8),
    discountAmount: D(20),
    contratoDePrecio: 'IVA_APARTE',
    orderDiscounts: [
      {
        amount: D(20),
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { 'oi-A': 1000, 'oi-B': 1000 } },
      },
    ],
    items: [pieza('A'), pieza('B')],
  })
  const db = {
    order: { findUnique: jest.fn().mockResolvedValue(venta) },
    merchantFiscalConfig: { findUnique: jest.fn().mockResolvedValue(CONFIG) },
    fiscalEmisor: { findMany: jest.fn().mockResolvedValue([]) },
    orderDiscount: { findMany: jest.fn().mockResolvedValue([]) },
  } as any
  const deps = makeDeps({ loadOrderForCfdi: (id, opts) => loadOrderForCfdiFromDb(id, opts, db) })

  const res = await replaceCfdi(params, deps)

  expect(res.reasons ?? []).toEqual([])
  expect(res.status).toBe('REPLACED')
  const reservada = (deps.reserveCfdi as jest.Mock).mock.calls[0][0]
  expect([reservada.subtotalCents, reservada.taxCents, reservada.totalCents]).toEqual([18000, 2880, 20880])
  expect(providerDe(deps).createInvoice.mock.calls[0][0].items.map((i: any) => i.discountCents)).toEqual([1000, 1000])
})

// Ronda de la ola (3) (preocupaciones del dashboard, `task-OFD-report.md`): «Terminar la sustitución» no podía decir la verdad en dos casos
// porque la respuesta no traía el dato. Dos campos aditivos, con la MISMA regla que `cancelCfdi`:
//   - `enDuda`: la cancelación de la original quedó EN DUDA (el POST no tuvo respuesta clara) — sólo cuando es verdad;
//   - `cancelIntentoNuevo`: ESTA petición anotó un intento nuevo de cancelar la original. `false` ⇒ el `cancelStatus` que se devuelve (p. ej.
//     el REJECTED de antes) NO es de esta petición.
describe('replaceCfdi — ronda de la ola (3): `enDuda` y `cancelIntentoNuevo`', () => {
  beforeEach(() => jest.clearAllMocks())
  const conCancelacion = (cancelInvoice: jest.Mock, over: Partial<ReplaceCfdiDeps> = {}) =>
    makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice,
      } as any),
      ...over,
    })

  it('🔴 (a) el PAC no contesta el POST ⇒ REQUESTED con `enDuda: true` (como `cancelCfdi`), y el intento es de esta petición', async () => {
    const res = await replaceCfdi(params, conCancelacion(jest.fn().mockRejectedValue(new Error('PAC caído'))))
    expect(res).toMatchObject({
      status: 'REPLACED',
      cancelStatus: 'REQUESTED',
      cancelPendiente: true,
      enDuda: true,
      cancelIntentoNuevo: true,
    })
  })
  it('control — (a) el PAC acusa («pending») ⇒ sin `enDuda`', async () => {
    const res = await replaceCfdi(params, conCancelacion(jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null })))
    expect(res.cancelStatus).toBe('REQUESTED')
    expect(res).not.toHaveProperty('enDuda')
  })
  it('🔴 (b) falla ANTES de anotar y la original traía un REJECTED de un intento anterior ⇒ `cancelIntentoNuevo: false` (ese rechazo es viejo)', async () => {
    const rechazadaAntes = { ...original, cancelStatus: 'REJECTED', cancelIntento: 1, lastError: 'El receptor rechazó la cancelación.' }
    const deps = makeDeps({
      loadCfdi: jest.fn().mockResolvedValue(rechazadaAntes),
      anotarIntencion: jest.fn().mockRejectedValue(new Error('connection terminated')),
    })
    const res = await replaceCfdi(params, deps)
    expect(res).toMatchObject({ status: 'REPLACED', cancelStatus: 'REJECTED', cancelPendiente: true, cancelIntentoNuevo: false })
    expect(res).not.toHaveProperty('enDuda')
  })
  it('🔴 (b) anotó y el PAC rechazó al momento ⇒ REJECTED con `cancelIntentoNuevo: true` (ese rechazo SÍ es de esta petición)', async () => {
    const rechazo = new ProviderHttpError(400, 'invoice_cancellation_not_allowed', 'El receptor no permite la cancelación')
    const res = await replaceCfdi(params, conCancelacion(jest.fn().mockRejectedValue(rechazo)))
    expect(res).toMatchObject({ cancelStatus: 'REJECTED', cancelIntentoNuevo: true })
  })
  it('🔴 (b) la consulta previa falla DESPUÉS de anotar (`cancelAviso`) ⇒ `cancelIntentoNuevo: true`', async () => {
    const cerrada = { ...original, cancelStatus: 'REJECTED', cancelIntento: 1, lastError: 'No se llegó a enviar la cancelación…' }
    const deps = makeDeps({
      loadCfdi: jest.fn().mockResolvedValueOnce(original).mockResolvedValueOnce(original).mockResolvedValue(cerrada),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<Comprobante/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        getCancellationStatus: jest.fn().mockRejectedValue(new Error('ECONNRESET')),
        cancelInvoice: jest.fn(),
      } as any),
    })
    const res = await replaceCfdi(params, deps)
    expect(res).toMatchObject({ cancelStatus: 'REJECTED', cancelAviso: expect.any(String), cancelIntentoNuevo: true })
  })
  it.each([
    ['un conflicto (nota viva) impide anotar', { conflicto: 'Esta factura tiene la nota de crédito A-3 vigente…' }],
    ['ya había un intento abierto (MISMA_EN_TRAMITE)', { estado: 'MISMA_EN_TRAMITE', intento: 1 }],
  ])('🔴 (b) %s ⇒ `cancelIntentoNuevo: false`', async (_n, intencion) => {
    const res = await replaceCfdi(params, makeDeps({ anotarIntencion: jest.fn().mockResolvedValue(intencion) }))
    expect(res.cancelIntentoNuevo).toBe(false)
  })
  it('🔴 (b) camino feliz (aceptada) ⇒ `cancelIntentoNuevo: true`', async () => {
    const res = await replaceCfdi(params, makeDeps())
    expect(res).toMatchObject({ cancelPendiente: false, cancelIntentoNuevo: true })
  })
})
