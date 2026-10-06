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

  it('cancelación anterior EN TRÁMITE ⇒ 409 con el mensaje (antes caía en 500)', async () => {
    const msg =
      'La cancelación de la factura A-14 sigue en trámite ante el SAT; en cuanto quede cancelada podrás volver a facturar esta venta.'
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockIssueCfdi.mockRejectedValue(new Error(msg))

    const res = makeRes()
    await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: msg })
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

it.each([
  'La factura de esta venta se está procesando; intenta de nuevo en unos minutos.',
  'La venta está incluida en una factura global.',
])('autofactura conserva el 409 tipado: %s', async message => {
  mockFindReceipt.mockResolvedValue(makeReceipt())
  mockFindCfdi.mockResolvedValue(null)
  mockIssueCfdi.mockRejectedValue(new ConflictError(message))
  const res = makeRes()
  await autofacturaController(makeReq({ accessKey: 'key-abc' }) as any, res as any)
  expect(res.status).toHaveBeenCalledWith(409)
  expect(res.json).toHaveBeenCalledWith({ error: message })
})

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
