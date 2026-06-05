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
import { logAction } from '../../../../src/services/dashboard/activity-log.service'
import { autofacturaController, getAutofacturaStatusController } from '../../../../src/controllers/public/cfdi.public.controller'

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

  it('returns 409 when a STAMPED cfdi already exists for the order', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue({ id: 'existing-cfdi', status: 'STAMPED' })

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await autofacturaController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith({ error: 'Esta cuenta ya fue facturada.' })
    expect(mockIssueCfdi).not.toHaveBeenCalled()
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
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false })
  })

  it('returns autofacturaAvailable:false when facturación is on but autofactura is disabled', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue(makeBundle({ autofacturaEnabled: false }))

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false })
  })

  it('returns autofacturaAvailable:false when no emisor is resolvable (loadOrder returns null)', async () => {
    mockFindReceipt.mockResolvedValue(makeReceipt())
    mockFindCfdi.mockResolvedValue(null)
    mockLoadOrder.mockResolvedValue(null) // no payment / no merchant config / venue mismatch

    const req = makeReq({ accessKey: 'key-abc' })
    const res = makeRes()

    await getAutofacturaStatusController(req as any, res as any)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi: null, autofacturaAvailable: false })
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
