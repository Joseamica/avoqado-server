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
import { claimWhere } from '../../../../src/services/fiscal/cfdi.service'
import type { ReplaceCfdiDeps } from '../../../../src/services/fiscal/cfdiReplacement.service'

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
  return {
    loadCfdi: jest.fn().mockResolvedValue(original),
    findSustituta: jest.fn().mockResolvedValue(null),
    loadOrderForCfdi: jest.fn().mockResolvedValue(bundle()),
    resolveProvider: jest.fn().mockReturnValue({
      name: 'facturapi',
      createInvoice: jest.fn().mockResolvedValue(timbrada),
      downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
      downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
      cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
    } as any),
    reserveCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi-sub', ...data })),
    // 🔴 Simula el upsert REAL: la fila ya existe con los importes de la reserva anterior y el
    // guardado escribe encima. Un mock que devuelve sólo `data` esconde justo el defecto que este
    // archivo tiene que cazar (la fila quedándose con el importe viejo del intento fallido).
    persistCfdi: jest.fn().mockImplementation(async data => ({ id: 'cfdi-sub', totalCents: 12500, subtotalCents: 12500, ...data })),
    // Como el dep real: escribe sólo las URLs y devuelve la fila COMPLETA (findUnique).
    persistArtifacts: jest.fn().mockImplementation(async (_llave, urls) => ({ id: 'cfdi-sub', uuid: 'UUID-SUB', status: 'STAMPED', ...urls })),
    claimCfdi: jest.fn().mockResolvedValue(true),
    storeArtifact: jest.fn().mockImplementation(async (_b, path) => `https://cdn/${path}`),
    updateCfdi: jest.fn().mockImplementation(async (id, data) => ({ ...original, id, ...data })),
    ...over,
  }
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

  it('usa la llave cfdi-order-<id>-r1 y la estampa como external_id', async () => {
    const deps = makeDeps()
    await replaceCfdi(params, deps)

    const reservada = (deps.reserveCfdi as jest.Mock).mock.calls[0][0]
    expect(reservada.idempotencyKey).toBe('cfdi-order-o1-r1')
    expect(providerDe(deps).createInvoice.mock.calls[0][0].externalId).toBe('cfdi-order-o1-r1')
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
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
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
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'pending', cancelledAt: null }),
      } as any),
    })
    const res = await replaceCfdi(params, deps)

    expect(res.cancelStatus).toBe('REQUESTED')
    expect(res.cancelPendiente).toBe(true)
    const update = (deps.updateCfdi as jest.Mock).mock.calls[0][1]
    expect(update.status).toBe('STAMPED') // sigue vigente ante el SAT
    expect(update.cancelSubstituteUuid).toBe('UUID-SUB')
  })

  it('un rechazo del receptor se reporta y la sustituta sigue timbrada', async () => {
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'rejected', cancelledAt: null }),
      } as any),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.cancelStatus).toBe('REJECTED')
    expect(res.cancelPendiente).toBe(true)
    expect(res.sustituta.uuid).toBe('UUID-SUB')
  })

  it('si la cancelación TRUENA, la sustituta no se pierde: se reporta pendiente', async () => {
    const deps = makeDeps({
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockRejectedValue(new Error('PAC caído')),
      } as any),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    expect(res.cancelStatus).toBeNull()
    expect(res.cancelPendiente).toBe(true)
  })
})

describe('replaceCfdi — no se timbra un segundo documento equivocado', () => {
  beforeEach(() => jest.clearAllMocks())

  it('🔴 barrera de dinero: si el documento corregido no cuadra con lo cobrado, NO toca el PAC', async () => {
    const deps = makeDeps({ loadOrderForCfdi: jest.fn().mockResolvedValue(bundle({ paidCents: 14000 })) })
    const res = await replaceCfdi(params, deps)

    expect(res.status).toBe('VALIDATION_FAILED')
    expect(res.reasons?.join(' ')).toMatch(/no coincide con lo cobrado/)
    expect(deps.reserveCfdi).not.toHaveBeenCalled()
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

  it('con una sustitución EN VUELO (STAMPING fresca) corta con 409 y no toca el PAC', async () => {
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPING', updatedAt: new Date(), replacesCfdiId: 'cfdi-orig' }),
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

  it('si gana el reclamo, reintenta el timbrado sobre la MISMA fila', async () => {
    const deps = makeDeps({
      findSustituta: jest
        .fn()
        .mockResolvedValue({ id: 'cfdi-sub', status: 'STAMP_FAILED', attempts: 2, idempotencyKey: 'cfdi-order-o1-r1', replacesCfdiId: 'cfdi-orig', venueId: 'v1' }),
      claimCfdi: jest.fn().mockResolvedValue(true),
    })
    // Este conector NO sabe consultar por external_id (versión anterior): se sigue sin él.
    const res = await replaceCfdi(params, deps)
    expect(deps.claimCfdi).toHaveBeenCalledWith('cfdi-sub', expect.arrayContaining(['STAMPING', 'STAMP_FAILED']), 2)
    expect(res.status).toBe('REPLACED')
    expect(deps.reserveCfdi).not.toHaveBeenCalled() // la fila ya existe
  })

  it('una carrera en la reserva (P2002) no produce un segundo documento', async () => {
    const p2002 = new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: 'x', meta: { target: ['idempotencyKey'] } })
    const deps = makeDeps({
      reserveCfdi: jest.fn().mockRejectedValue(p2002),
      findSustituta: jest
        .fn()
        .mockResolvedValueOnce(null) // primera mirada: no hay
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
    const previa = { id: 'cfdi-sub', status: 'STAMP_FAILED', attempts: 3, idempotencyKey: 'cfdi-order-o1-r1', replacesCfdiId: 'cfdi-orig', venueId: 'v1' }
    const deps = makeDeps({ findSustituta: jest.fn().mockResolvedValue(previa) })
    await replaceCfdi(params, deps)
    expect(deps.claimCfdi).toHaveBeenCalledWith('cfdi-sub', expect.any(Array), 3)
  })

  // P1-2 · Un timeout tras el timbrado deja STAMP_FAILED con el documento YA emitido. Re-timbrar sin
  // preguntarle al PAC produce un TERCER documento fiscal por la misma venta.
  it('🔴 antes de re-timbrar un intento reclamado le pregunta al PAC por su external_id', async () => {
    const findByExternalId = jest.fn().mockResolvedValue({
      providerInvoiceId: 'fa-sub', uuid: 'UUID-SUB', serie: 'A', folio: '16', status: 'valid', stampedAt: new Date(),
    })
    const createInvoice = jest.fn().mockResolvedValue(timbrada)
    const deps = makeDeps({
      findSustituta: jest.fn().mockResolvedValue({ id: 'cfdi-sub', status: 'STAMP_FAILED', attempts: 1, idempotencyKey: 'cfdi-order-o1-r1', replacesCfdiId: 'cfdi-orig', venueId: 'v1' }),
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        findByExternalId,
        createInvoice,
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
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
      findSustituta: jest.fn().mockResolvedValue({ id: 'cfdi-sub', status: 'STAMP_FAILED', attempts: 1, idempotencyKey: 'cfdi-order-o1-r1', replacesCfdiId: 'cfdi-orig', venueId: 'v1' }),
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
    expect(Object.keys(artefactos).sort()).toEqual(['pdfUrl', 'xmlUrl'])
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
          return Buffer.from('<xml/>')
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
        id: 'cfdi-sub', status: 'STAMP_FAILED', attempts: 1, idempotencyKey: 'cfdi-order-o1-r1',
        replacesCfdiId: 'cfdi-orig', venueId: 'v1', totalCents: 12500, subtotalCents: 12500,
      }),
      loadOrderForCfdi: jest.fn().mockResolvedValue(bundle()), // la cuenta corregida: $135
      resolveProvider: jest.fn().mockReturnValue({
        name: 'facturapi',
        findByExternalId: jest.fn().mockResolvedValue(null),
        createInvoice: jest.fn().mockResolvedValue(timbrada),
        downloadXml: jest.fn().mockResolvedValue(Buffer.from('<xml/>')),
        downloadPdf: jest.fn().mockResolvedValue(Buffer.from('%PDF')),
        cancelInvoice: jest.fn().mockResolvedValue({ status: 'accepted', cancelledAt: new Date() }),
      } as any),
    })
    await replaceCfdi(params, deps)
    const guardada = (deps.persistCfdi as jest.Mock).mock.calls.at(-1)[0]
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
      loadCfdi: jest.fn().mockResolvedValue({ ...original, status: 'CANCELLED', cancelStatus: 'ACCEPTED', cancelSubstituteUuid: 'UUID-SUB' }),
      findSustituta: jest.fn().mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', venueId: 'v1', replacesCfdiId: 'cfdi-orig' }),
    })
    const res = await replaceCfdi(params, deps)
    expect(res.status).toBe('REPLACED')
    expect(res.cancelPendiente).toBe(false)
    expect(res.sustituta.uuid).toBe('UUID-SUB')
    // No vuelve a pedir la cancelación de algo ya cancelado.
    expect(providerDe(deps)?.cancelInvoice).toBeUndefined()
  })

  // P2-5b · Al reanudar, la original se RELEE: entre una corrida y otra pudo cambiar de estado.
  it('al reanudar la cancelación relee la original en vez de usar la foto vieja', async () => {
    const loadCfdi = jest
      .fn()
      .mockResolvedValueOnce(original)
      .mockResolvedValue({ ...original, cancelStatus: 'REQUESTED' })
    const deps = makeDeps({
      loadCfdi,
      findSustituta: jest.fn().mockResolvedValue({ id: 'cfdi-sub', status: 'STAMPED', uuid: 'UUID-SUB', venueId: 'v1', replacesCfdiId: 'cfdi-orig' }),
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
