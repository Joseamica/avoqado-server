import { ConflictError } from '../../../../src/errors/AppError'
// tests/unit/controllers/public/cfdi.public.controller.test.ts
//
// Unit tests for the public autofactura controller (Flow A).
// All external dependencies (prisma, issueCfdiForOrder, logAction) are mocked.
// Mock pattern mirrors loadOrderForCfdi.test.ts: jest.mock on the module path,
// then import after mocking.

import { Request, Response } from 'express'

// ── Mocks (must be declared before any imports that use them) ─────────────────

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    digitalReceipt: { findUnique: jest.fn() },
    cfdi: { findFirst: jest.fn() },
  },
}))

jest.mock('../../../../src/services/fiscal/cfdi.service', () => ({
  __esModule: true,
  issueCfdiForOrder: jest.fn(),
  loadOrderForCfdiFromDb: jest.fn(),
}))

jest.mock('../../../../src/services/whatsapp.service', () => ({
  __esModule: true,
  sendCfdiWhatsApp: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  __esModule: true,
  logAction: jest.fn().mockResolvedValue(undefined),
}))

jest.mock('../../../../src/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

// Mock env so sandbox=true in tests (NODE_ENV !== 'production')
jest.mock('../../../../src/config/env', () => ({
  __esModule: true,
  env: { NODE_ENV: 'test' },
}))

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import prisma from '../../../../src/utils/prismaClient'
import { issueCfdiForOrder, loadOrderForCfdiFromDb } from '../../../../src/services/fiscal/cfdi.service'
import { motivoNoCuadra } from '../../../../src/services/fiscal/reglaDelPac'
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import logger from '../../../../src/config/logger'
import { sendCfdiWhatsApp } from '../../../../src/services/whatsapp.service'
import {
  autofacturaController,
  getAutofacturaStatusController,
  sendCfdiWhatsAppController,
} from '../../../../src/controllers/public/cfdi.public.controller'

// ── Typed mock helpers ────────────────────────────────────────────────────────

const mockFindReceipt = prisma.digitalReceipt.findUnique as jest.Mock
const mockFindCfdi = prisma.cfdi.findFirst as jest.Mock
const mockIssueCfdi = issueCfdiForOrder as jest.Mock
const mockLoadOrder = loadOrderForCfdiFromDb as jest.Mock
const mockLogAction = logAction as jest.Mock

/**
 * Builds a LoadedOrderBundle-shaped object for the GET status availability
 * check. Only the two merchant flags matter for `autofacturaAvailable`; the
 * rest are filled minimally so the controller's `!!bundle && ...` is truthy.
 */
function makeBundle(overrides: { facturacionEnabled?: boolean; autofacturaEnabled?: boolean } = {}) {
  return {
    facturacionEnabled: overrides.facturacionEnabled ?? true,
    autofacturaEnabled: overrides.autofacturaEnabled ?? true,
  }
}

// ── Test fixtures ─────────────────────────────────────────────────────────────

/** Builds a DigitalReceipt row as returned by prisma.digitalReceipt.findUnique */
function makeReceipt(overrides: { paymentStatus?: string; createdAt?: Date } = {}) {
  return {
    payment: {
      orderId: 'order-1',
      order: {
        id: 'order-1',
        venueId: 'venue-1',
        paymentStatus: overrides.paymentStatus ?? 'PAID',
        createdAt: overrides.createdAt ?? new Date(), // current month by default
      },
    },
  }
}

/**
 * Una tabla `Cfdi` de mentira que SÍ aplica el `where` (igualdad) y el orden por fecha: así la prueba mide QUÉ documento
 * elige el controlador, no la forma de su consulta.
 */
function tablaCfdi(filas: Record<string, any>[]) {
  mockFindCfdi.mockImplementation(async ({ where = {}, orderBy }: any) => {
    const cumple = (f: Record<string, any>) => Object.entries(where).every(([k, v]) => f[k] === v)
    const desc = orderBy?.createdAt === 'desc'
    return [...filas].filter(cumple).sort((a, b) => (desc ? b.createdAt - a.createdAt : 0))[0] ?? null
  })
}

/** La venta con su factura (vieja) y una NOTA de crédito timbrada después por una devolución. */
const facturaYNota = [
  {
    orderId: 'order-1',
    type: 'INGRESO',
    status: 'STAMPED',
    uuid: 'FACTURA',
    serie: 'F',
    folio: '1',
    pdfUrl: 'https://s/f.pdf',
    createdAt: new Date('2026-10-01T10:00:00Z'),
  },
  {
    orderId: 'order-1',
    type: 'EGRESO',
    status: 'STAMPED',
    uuid: 'NOTA',
    serie: 'NC',
    folio: '7',
    pdfUrl: 'https://s/nc.pdf',
    createdAt: new Date('2026-10-01T12:00:00Z'),
  },
]

/** Builds a successful IssueCfdiResult */
function makeStampedResult() {
  return {
    status: 'STAMPED' as const,
    cfdi: {
      id: 'cfdi-1',
      uuid: 'UUID-1234',
      serie: 'F',
      folio: '1',
      pdfUrl: 'https://storage/cfdi/UUID-1234.pdf',
      xmlUrl: 'https://storage/cfdi/UUID-1234.xml',
    },
  }
}

/** Minimal receptor body (passes schema validation) */
const receptor = {
  rfc: 'XAXX010101000',
  razonSocial: 'Público en General',
  regimenFiscal: '616',
  codigoPostal: '06600',
  usoCfdi: 'S01',
  email: 'cliente@example.com',
}

/** Creates a mock Express Request */
function makeReq(params: { accessKey: string }, body: Record<string, any> = receptor): Partial<Request> {
  return { params, body } as any
}

/** Creates a mock Express Response with jest spies */
function makeRes(): Partial<Response> & { status: jest.Mock; json: jest.Mock } {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  }
  return res as any
}

// ── Setup / teardown ──────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks()
})

// ── POST /receipt/:accessKey/cfdi tests ───────────────────────────────────────

describe('autofacturaController (POST /receipt/:accessKey/cfdi)', () => {
  it('happy path — returns 200 with cfdi fields and calls logAction with staffId:null + flow:AUTOFACTURA_A', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null) // no existing STAMPED cfdi
    mockIssueCfdi.mockResolvedValue(makeStampedResult())

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      cfdi: {
        uuid: 'UUID-1234',
        serie: 'F',
        folio: '1',
        pdfUrl: 'https://storage/cfdi/UUID-1234.pdf',
        xmlUrl: 'https://storage/cfdi/UUID-1234.xml',
      },
    })

    // Activity log must be called with staffId:null and flow:AUTOFACTURA_A
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        staffId: null,
        action: 'CFDI_ISSUED',
        entity: 'Cfdi',
        data: expect.objectContaining({
          flow: 'AUTOFACTURA_A',
          accessKey: 'key-abc',
          orderId: 'order-1',
          uuid: 'UUID-1234',
        }),
      }),
    )
  })

  it('returns 404 when receipt is not found', async () => {
    mockFindReceipt.mockResolvedValue(null)

    const req = makeReq({ accessKey: 'bad-key' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Recibo no encontrado' })
    // Service must never be called
    expect(mockIssueCfdi).not.toHaveBeenCalled()
  })

  it('returns 409 when order paymentStatus is not PAID', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt({ paymentStatus: 'PENDING' }))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'La cuenta aún no está pagada.' })
    expect(mockIssueCfdi).not.toHaveBeenCalled()
  })

  it('returns 409 when order createdAt is in a prior month', async () => {
    // Use fake timers: freeze "now" in July 2026, ticket from June 2026
    jest.useFakeTimers()
    jest.setSystemTime(new Date('2026-07-15T12:00:00.000Z'))

    // June ticket (prior month)
    const juneDateUtc = new Date('2026-06-10T19:00:00.000Z') // 1pm CDST = 19:00 UTC
    mockFindReceipt.mockResolvedValue(makeReceipt({ createdAt: juneDateUtc }))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Solo puedes facturar tickets del mes en curso.' })
    expect(mockIssueCfdi).not.toHaveBeenCalled()

    jest.useRealTimers()
  })

  it('🔴 H19: una NOTA de crédito timbrada no cuenta como «ya facturada»: la venta se factura', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    tablaCfdi([{ ...facturaYNota[1] }])
    mockIssueCfdi.mockResolvedValue(makeStampedResult())

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(mockIssueCfdi).toHaveBeenCalledTimes(1)
    expect(res.status).toHaveBeenCalledWith(200)
  })

  it('returns 403 when issueCfdiForOrder throws /no habilitada/ (autofactura disabled)', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new Error('Autofactura no habilitada para este comercio'))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith({ error: 'La facturación no está disponible para esta cuenta.' })
  })

  it('returns 422 with reasons when service returns VALIDATION_FAILED', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockResolvedValue({
      status: 'VALIDATION_FAILED',
      cfdi: { id: 'cfdi-draft' },
      reasons: ['RFC inválido para persona moral', 'Régimen fiscal no aplica'],
    })

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith({
      error: 'No se pudo facturar',
      reasons: ['RFC inválido para persona moral', 'Régimen fiscal no aplica'],
    })
    // No activity log on validation failure
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('🔴 I-1: bloqueo fiscal (2 × NET $1.04, IVA $0.17 c/u, cobro $2.42): el 422 público NO lleva los motivos del comercio, que van al log', async () => {
    const motivo = motivoNoCuadra(241, 242)
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockResolvedValue({ status: 'VALIDATION_FAILED', cfdi: { id: 'cfdi-draft' }, reasons: [motivo] })
    mockLoadOrder.mockResolvedValue({ ...makeBundle(), unsupportedReasons: [motivo] })

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith({
      error: 'No se pudo facturar',
      code: 'FISCAL_BLOCK',
      message: 'Esta cuenta no se puede facturar en línea. Pide tu factura directamente al negocio.',
    })
    expect(JSON.stringify((res.json as jest.Mock).mock.calls)).not.toContain(motivo)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('bloqueo fiscal'),
      expect.objectContaining({ orderId: 'order-1', venueId: expect.any(String), motivos: [motivo] }),
    )
  })

  it('returns 502 when service returns STAMP_FAILED', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: { id: 'cfdi-failed' },
    })

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith({ error: 'El SAT rechazó el timbrado' })
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 404 when issueCfdiForOrder throws /not found/ (tenant isolation)', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new Error('Order order-1 not found'))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Recibo no encontrado' })
  })

  it('returns 409 when issueCfdiForOrder throws "CFDI en proceso" (concurrent in-flight slot reservation)', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new Error('CFDI en proceso para esta orden'))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'CFDI en proceso para esta orden' })
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  // C2 · T10 ronda 1 (M3, cambia A PROPÓSITO): el servicio lanza `ConflictError(texto, 'CFDI_CANCEL_PENDING')`; la respuesta gana `code`
  // (aditivo) y el 409 sale del código, no de la regex del texto (aquí el texto ni dice «en trámite»).
  it('🔴 M3: cancelación anterior pendiente ⇒ 409 con el mensaje y `code: CFDI_CANCEL_PENDING`', async () => {
    const msg =
      'La cancelación de la factura A-14 está en duda: la estamos confirmando con el SAT (puede tardar hasta 24 horas). En cuanto quede cancelada podrás volver a facturar esta venta.'
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new ConflictError(msg, 'CFDI_CANCEL_PENDING'))

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    // Ronda de la ola (2), cambia A PROPÓSITO: el cliente final no lee folios ni el estado interno de la cancelación; el código se conserva.
    expect(res.json).toHaveBeenCalledWith({
      error: 'La factura anterior de esta cuenta se está cancelando. Intenta de nuevo más tarde.',
      code: 'CFDI_CANCEL_PENDING',
    })
    expect(JSON.stringify(res.json.mock.calls)).not.toContain('A-14')
  })

  it('🔴 M3: un Error suelto que dice «en trámite» ya no se adivina como 409 (se mapea por código)', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new Error('algo sigue en trámite'))
    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    expect(res.status).toHaveBeenCalledWith(500)
  })

  it('el servicio dice que la venta YA tenía factura (carrera) ⇒ 409 «ya fue facturada», sin CFDI_ISSUED', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockResolvedValue({ status: 'STAMPED', alreadyIssued: true, cfdi: { id: 'c1', uuid: 'U1', serie: 'A', folio: '14' } })

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Esta cuenta ya fue facturada.' })
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  // C2 · OF-2 (T10 N-2): A con la cancelación en trámite + su sustituta B timbrada. Antes el servicio lanzaba «…podrás volver a facturar
  // esta venta» (falso: sigue facturada con B) y el cliente final lo leía aquí. Ahora el servicio contesta `alreadyIssued` con B y la
  // autofactura dice lo neutro, sin nombrar la factura interna que falta cancelar.
  it('control — ya facturada con la sustituta y la original pendiente ⇒ 409 «ya fue facturada», sin datos de la original', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockResolvedValue({
      status: 'STAMPED',
      alreadyIssued: true,
      cfdi: { id: 'cb', uuid: 'UB', serie: 'A', folio: '15' },
      originalVigente: { id: 'ca', uuid: 'UA', serie: 'A', folio: '14', cancelStatus: 'REQUESTED' },
    })

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Esta cuenta ya fue facturada.' })
  })

  // Ronda de la ola (review-OF m2): la sustituta se está cancelando y la original sigue vigente. Antes el cliente final leía el 409 interno
  // («La cancelación de la factura A-15… a la que ésta sustituye»); ahora el servicio contesta `alreadyIssued` con la original ⇒ lo neutro.
  it('control — m2: ya facturada con la original y la sustituta en cancelación ⇒ 409 «ya fue facturada», sin folios ni motivos internos', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockResolvedValue({
      status: 'STAMPED',
      alreadyIssued: true,
      cfdi: { id: 'ca', uuid: 'UA', serie: 'A', folio: '14' },
      sustitutaEnCancelacion: { id: 'cb', uuid: 'UB', serie: 'A', folio: '15', cancelStatus: 'REQUESTED' },
    })

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Esta cuenta ya fue facturada.' })
  })

  it('returns 500 for unexpected errors', async () => {
    mockFindReceipt.mockRejectedValue(new Error('Database connection lost'))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno al generar el CFDI' })
  })
})

// ── GET /receipt/:accessKey/cfdi tests ────────────────────────────────────────

describe('getAutofacturaStatusController (GET /receipt/:accessKey/cfdi)', () => {
  it('🔴 H19: con una nota de crédito más nueva, el estado muestra la FACTURA de la venta', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    tablaCfdi(facturaYNota)
    mockLoadOrder.mockResolvedValue(makeBundle())

    const res = makeRes()
    await getAutofacturaStatusController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json.mock.calls[0][0].cfdi.uuid).toBe('FACTURA')
  })

  it('returns 200 with cfdi + autofacturaAvailable:true when a STAMPED cfdi exists and the merchant has it enabled', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue({
      uuid: 'UUID-1234',
      status: 'STAMPED',
      serie: 'F',
      folio: '1',
      pdfUrl: 'https://storage/cfdi/UUID-1234.pdf',
    })
    mockLoadOrder.mockResolvedValue(makeBundle())

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      cfdi: {
        uuid: 'UUID-1234',
        status: 'STAMPED',
        serie: 'F',
        folio: '1',
        pdfUrl: 'https://storage/cfdi/UUID-1234.pdf',
      },
      autofacturaAvailable: true,
    })
  })

  it('returns autofacturaAvailable:false when the order is outside the safe envelope (unsupportedReasons), even with both flags on', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue({ ...makeBundle(), unsupportedReasons: ['La cuenta lleva una promoción; …'] })

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    // B3a ronda final F3 (y ajuste 4): campo NUEVO y opcional con el TIPO de bloqueo, sin los motivos internos; los de antes no cambian.
    expect(res.json).toHaveBeenCalledWith({
      cfdi: null,
      autofacturaAvailable: false,
      autofacturaUnavailable: { kind: 'FISCAL_BLOCK' },
    })
  })

  it('returns 200 with cfdi:null + autofacturaAvailable:true when no cfdi exists yet but the merchant allows self-invoicing', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue(makeBundle())

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: true })
  })

  // ── Regression: the merchant on/off decision must reach the receipt so the
  //    widget can HIDE the CTA instead of showing-then-403. ───────────────────
  it('returns autofacturaAvailable:false when the merchant has facturación disabled', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue(makeBundle({ facturacionEnabled: false }))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'DISABLED' } })
  })

  it('returns autofacturaAvailable:false when facturación is on but autofactura is disabled', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue(makeBundle({ autofacturaEnabled: false }))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'DISABLED' } })
  })

  it('returns autofacturaAvailable:false when no emisor is resolvable (loadOrder returns null)', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue(null) // no payment / no merchant config / venue mismatch

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'DISABLED' } })
  })

  // B3a ronda final F3 (Codex final #3) y ajuste 4: el comercio SÍ habilitó la autofactura, pero esta venta no se puede timbrar exacta.
  // Antes el GET sólo decía `false` y el recibo escondía el panel sin explicación; ahora dice que es un bloqueo FISCAL. Los motivos
  // NO viajan a este GET público (están escritos para el comercio: «factúrala con tu contador»): se quedan en el log del servidor y
  // el comercio los ve en su dashboard (422 al facturar, `lastError` del intento).
  it('🔴 F3: 2 × $1.04 con IVA aparte (cobro $2.42, el PAC da $2.41): con los dos interruptores prendidos, el GET dice el bloqueo fiscal SIN los motivos, que van al log', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    // El motivo exacto que el cargador real da para esta venta (`loadOrderForCfdi.test.ts`, «F3: 2 × $1.04»).
    mockLoadOrder.mockResolvedValue({ ...makeBundle(), unsupportedReasons: [motivoNoCuadra(241, 242)] })

    const res = makeRes()
    await getAutofacturaStatusController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false, autofacturaUnavailable: { kind: 'FISCAL_BLOCK' } })
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain('$2.41')
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('autofactura'),
      expect.objectContaining({ orderId: 'order-1', motivos: [motivoNoCuadra(241, 242)] }),
    )
  })

  it('returns 404 when receipt is not found', async () => {
    mockFindReceipt.mockResolvedValue(null)

    const req = makeReq({ accessKey: 'no-such-key' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith({ error: 'Recibo no encontrado' })
    // Availability must not be probed when there's no order
    expect(mockLoadOrder).not.toHaveBeenCalled()
  })
})

// C2 · T10: la cancelación en trámite se dice en el recibo (sólo lectura; el GET ya exige facturación + autofactura).
describe('getAutofacturaStatusController — C2 · T10 · `cancelacionEnTramite`', () => {
  const timbrada = { uuid: 'UUID-1234', status: 'STAMPED', serie: 'F', folio: '1', pdfUrl: 'https://storage/cfdi/UUID-1234.pdf' }
  it('🔴 la factura tiene `cancelStatus: REQUESTED` ⇒ `cancelacionEnTramite: true`; el `cancelStatus` no viaja en el objeto público', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue({ ...timbrada, cancelStatus: 'REQUESTED' })
    mockLoadOrder.mockResolvedValue(makeBundle())
    const res = makeRes()
    await getAutofacturaStatusController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: timbrada, autofacturaAvailable: true, cancelacionEnTramite: true })
    expect(mockFindCfdi.mock.calls[0][0].select).toMatchObject({ cancelStatus: true })
  })
  it('🔴 sin cancelación pedida (o rechazada) no viaja el campo (ni el `cancelStatus`)', async () => {
    for (const cancelStatus of [null, 'REJECTED']) {
      mockFindReceipt.mockResolvedValue(makeReceipt())
      mockFindCfdi.mockResolvedValue({ ...timbrada, cancelStatus })
      mockLoadOrder.mockResolvedValue(makeBundle())
      const res = makeRes()
      await getAutofacturaStatusController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
      expect(res.json).toHaveBeenCalledWith({ cfdi: timbrada, autofacturaAvailable: true })
    }
  })
})

// Ronda de la ola (2), cambia A PROPÓSITO: sólo los 409 NEUTROS pasan tal cual; «incluida en una factura global» (con su folio) pasa a lo neutro.
it.each(['La factura de esta venta se está procesando; intenta de nuevo en unos minutos.', 'CFDI en proceso para esta orden'])(
  'autofactura conserva el 409 tipado: %s',
  async message => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new ConflictError(message))
    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: message })
  },
)

describe('sendCfdiWhatsAppController (POST /receipt/:accessKey/cfdi/whatsapp)', () => {
  it('🔴 H19: con una nota de crédito más nueva, por WhatsApp va la FACTURA, no la nota', async () => {
    mockFindReceipt.mockResolvedValue({ payment: { order: { id: 'order-1', venue: { name: 'Testarudo' } } } })
    tablaCfdi(facturaYNota)

    const res = makeRes()
    await sendCfdiWhatsAppController({ params: { accessKey: 'key-abc' }, body: { phone: '+525512345678' } } as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(sendCfdiWhatsApp).toHaveBeenCalledWith('+525512345678', expect.objectContaining({ folio: 'F-1' }))
  })
})

// Ronda de la ola (2) (regla desde B3a: la autofactura pública NUNCA enseña motivos internos ni folios al cliente final). Lo que el dueño lee
// en su dashboard no cambia: esto es sólo lo que ve quien abre el recibo.
describe('ronda de la ola (2) — la autofactura no enseña motivos internos ni folios', () => {
  const NEUTRO = {
    error: 'No se pudo facturar',
    code: 'FISCAL_BLOCK',
    message: 'Esta cuenta no se puede facturar en línea. Pide tu factura directamente al negocio.',
  }
  const facturar = async () => {
    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    return res
  }
  beforeEach(() => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
  })

  it.each([
    [
      'la exclusión por global (con su folio)',
      'Esta venta ya está incluida en la factura global G-31; para facturarla aparte primero hay que cancelar esa global.',
    ],
    ['la cancelada en el PAC', 'Esta cuenta ya tiene una factura cancelada en el PAC; revísala antes de volver a facturar.'],
    ['la revisión de soporte', 'La entrada fiscal de esta factura requiere revisión de soporte.'],
    // Ronda de la ola (4) (review-OF-rereview-1 I1, cambia A PROPÓSITO): 409 `{ error }` neutro, no 422 `FISCAL_BLOCK`. El panel desplegado
    // pinta el 409 como tarjeta con `error`; con el 422 sólo cerraba el formulario y esperaba la tarjeta del GET, que para estos casos no sale.
  ])('🔴 %s ⇒ 409 con el texto neutro (tarjeta en el panel); el motivo va al log', async (_n, motivo) => {
    mockIssueCfdi.mockRejectedValue(new ConflictError(motivo))
    const res = await facturar()
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: NEUTRO.message })
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('motivo interno'), expect.objectContaining({ motivo }))
  })

  // Ronda de la ola (4) (I1, cambia A PROPÓSITO): lo que bloquea NO está en los motivos del sobre (el GET dice «disponible») ⇒ 409 neutro.
  it('🔴 422 con motivos del COMERCIO (CSD, conceptos, forma de pago) ⇒ 409 neutro, aunque traiga uno del receptor', async () => {
    const internos = [
      'El sello digital (CSD) del emisor no está activo. No se puede facturar.',
      'Concepto 1 ("Pan") sin clave de producto SAT (ClaveProdServ).',
      'La forma de pago no está definida para este CFDI.',
    ]
    for (const r of internos) {
      mockIssueCfdi.mockResolvedValue({
        status: 'VALIDATION_FAILED',
        cfdi: { id: 'd' },
        reasons: [r, 'El RFC del receptor no tiene un formato válido.'],
      })
      const res = await facturar()
      expect(res.status).toHaveBeenCalledWith(409)
      expect(res.json).toHaveBeenCalledWith({ error: NEUTRO.message })
    }
  })
  it('control — ronda (4): lo que bloquea SÍ está en los motivos del sobre (el GET también lo dice) ⇒ sigue el 422 FISCAL_BLOCK', async () => {
    const motivo = motivoNoCuadra(241, 242)
    mockIssueCfdi.mockResolvedValue({
      status: 'VALIDATION_FAILED',
      cfdi: { id: 'd' },
      reasons: [motivo, 'La forma de pago no está definida para este CFDI.'],
    })
    mockLoadOrder.mockResolvedValue({ ...makeBundle(), unsupportedReasons: [motivo] })
    const res = await facturar()
    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith(NEUTRO)
  })
  // Ronda de la ola (4) (m-a): el nombre del PRODUCTO no puede hacer pasar un motivo de concepto por uno del receptor.
  it.each([
    'Concepto 1 ("Régimen keto") sin clave de producto SAT (ClaveProdServ).',
    'Concepto 2 ("Café RFC") sin clave de unidad SAT (ClaveUnidad).',
    'Concepto 3: ObjetoImp 02 (sí objeto de impuesto) pero sin impuesto trasladado.',
  ])('🔴 m-a: «%s» sola ⇒ 409 neutro, nunca tal cual', async r => {
    mockIssueCfdi.mockResolvedValue({ status: 'VALIDATION_FAILED', cfdi: { id: 'd' }, reasons: [r] })
    const res = await facturar()
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: NEUTRO.message })
  })
  it('control — 422 sólo con motivos del RECEPTOR (los corrige el cliente) ⇒ pasan tal cual', async () => {
    const reasons = [
      'El RFC del receptor no tiene un formato válido.',
      'Falta el Uso del CFDI.',
      'El código postal del receptor debe tener 5 dígitos.',
    ]
    mockIssueCfdi.mockResolvedValue({ status: 'VALIDATION_FAILED', cfdi: { id: 'd' }, reasons })
    const res = await facturar()
    expect(res.json).toHaveBeenCalledWith({ error: 'No se pudo facturar', reasons })
  })

  it('🔴 502 con un error del PAC que NO es del receptor (certificado del emisor, red) ⇒ sin `message`', async () => {
    for (const lastError of ['El certificado del emisor está vencido.', 'fetch failed', 'Facturapi HTTP 500']) {
      mockIssueCfdi.mockResolvedValue({ status: 'STAMP_FAILED', cfdi: { id: 'f', lastError } })
      const res = await facturar()
      expect(res.status).toHaveBeenCalledWith(502)
      expect(res.json).toHaveBeenCalledWith({ error: 'El SAT rechazó el timbrado' })
    }
  })
  it('control — 502 con el error del RECEPTOR ⇒ el texto (sin el prefijo) para que lo corrija', async () => {
    mockIssueCfdi.mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: { id: 'f', lastError: 'Validación de timbrado: El RFC del receptor no se encuentra en la lista de RFC inscritos.' },
    })
    const res = await facturar()
    expect(res.json).toHaveBeenCalledWith({
      error: 'El SAT rechazó el timbrado',
      message: 'El RFC del receptor no se encuentra en la lista de RFC inscritos.',
    })
  })

  // m2 del GET: la sustituta B (más nueva) tiene su cancelación pedida y la original A sigue vigente ⇒ la venta está facturada con A.
  const original = {
    id: 'id-A',
    orderId: 'order-1',
    type: 'INGRESO',
    status: 'STAMPED',
    uuid: 'A',
    serie: 'A',
    folio: '14',
    pdfUrl: 'https://s/a.pdf',
    cancelStatus: null,
    replacesCfdiId: null,
    createdAt: new Date('2026-10-01T10:00:00Z'),
  }
  const sustituta = {
    ...original,
    id: 'id-B',
    uuid: 'B',
    folio: '15',
    pdfUrl: 'https://s/b.pdf',
    replacesCfdiId: 'id-A',
    createdAt: new Date('2026-10-01T12:00:00Z'),
  }
  it('🔴 GET · m2: la sustituta en cancelación y la original vigente ⇒ enseña la ORIGINAL, sin «cancelación en trámite» ni campos internos', async () => {
    tablaCfdi([original, { ...sustituta, cancelStatus: 'REQUESTED' }])
    mockLoadOrder.mockResolvedValue(makeBundle())
    const res = makeRes()
    await getAutofacturaStatusController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    const body = res.json.mock.calls[0][0]
    expect(body.cfdi.uuid).toBe('A')
    expect(body).not.toHaveProperty('cancelacionEnTramite')
    expect(body.cfdi).not.toHaveProperty('replacesCfdiId')
    expect(body.cfdi).not.toHaveProperty('cancelStatus')
  })
  it('control — GET · la original en cancelación y la sustituta timbrada ⇒ enseña la sustituta (la más nueva), como siempre', async () => {
    tablaCfdi([{ ...original, cancelStatus: 'REQUESTED' }, sustituta])
    mockLoadOrder.mockResolvedValue(makeBundle())
    const res = makeRes()
    await getAutofacturaStatusController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    expect(res.json.mock.calls[0][0].cfdi.uuid).toBe('B')
    expect(res.json.mock.calls[0][0]).not.toHaveProperty('cancelacionEnTramite')
  })
  it('🔴 WhatsApp · m2: manda la ORIGINAL (A-14), no la sustituta que se está cancelando', async () => {
    mockFindReceipt.mockResolvedValue({ payment: { order: { id: 'order-1', venue: { name: 'Testarudo' } } } })
    tablaCfdi([original, { ...sustituta, cancelStatus: 'REQUESTED' }])
    const res = makeRes()
    await sendCfdiWhatsAppController({ params: { accessKey: 'key-abc' }, body: { phone: '+525512345678' } } as any, res as any)
    expect(sendCfdiWhatsApp).toHaveBeenCalledWith('+525512345678', expect.objectContaining({ folio: 'A-14' }))
  })
})

// Ronda QA (hermanos): el timbre de la autofactura quedó EN DUDA (el PAC no contestó claro). El cliente final no ve «fetch failed» ni «El SAT
// rechazó», ni se le invita a reintentar a ciegas: 409 `{ error }` (tarjeta del panel) con un texto neutro.
describe('autofactura — ronda QA (hermanos): timbre en duda', () => {
  const enDuda = {
    id: 'f',
    status: 'STAMP_FAILED',
    protocoloIva: 1,
    enviadoAt: new Date(),
    falloDefinitivo: false,
    lastError: 'fetch failed',
  }
  beforeEach(() => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
  })
  it('🔴 en duda ⇒ 409 con el texto neutro y `code: TIMBRE_EN_DUDA`, sin «fetch failed» ni «rechazó»', async () => {
    mockIssueCfdi.mockResolvedValue({ status: 'STAMP_FAILED', cfdi: enDuda })
    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({
      error: 'Tu factura se está procesando. Vuelve a abrir este recibo en unos minutos para descargarla.',
      code: 'TIMBRE_EN_DUDA',
    })
  })
  it('control — un rechazo definitivo sigue siendo el 502 de siempre', async () => {
    mockIssueCfdi.mockResolvedValue({ status: 'STAMP_FAILED', cfdi: { ...enDuda, falloDefinitivo: true } })
    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith({ error: 'El SAT rechazó el timbrado' })
  })
})
