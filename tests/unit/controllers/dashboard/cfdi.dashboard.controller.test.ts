// tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts

const mockIssue = jest.fn()
const mockCancel = jest.fn()
const mockGetStatus = jest.fn()
const mockListCfdis = jest.fn()
jest.mock('../../../../src/services/fiscal/cfdi.service', () => ({
  issueCfdiForOrder: (...a: any[]) => mockIssue(...a),
  cancelCfdi: (...a: any[]) => mockCancel(...a),
  getCfdiStatus: (...a: any[]) => mockGetStatus(...a),
  listCfdisForVenue: (...a: any[]) => mockListCfdis(...a),
}))

// resolveRequestVenueId: real implementation (priority: URL param → x-venue-id header → token).
// We mock the whole module so prisma/logger side-effects don't leak into unit tests,
// but expose the real resolveRequestVenueId logic so venue-resolution tests are meaningful.
jest.mock('../../../../src/middlewares/checkPermission.middleware', () => ({
  resolveRequestVenueId: (req: any, authContext: any) => {
    const fromParams = req.params?.venueId
    if (fromParams) return fromParams
    const fromHeader = req.headers?.['x-venue-id']
    if (typeof fromHeader === 'string' && fromHeader.length > 0) return fromHeader
    return authContext?.venueId
  },
}))

const mockSearchSatCatalog = jest.fn()
jest.mock('../../../../src/services/fiscal/satCatalogLookup.service', () => ({
  searchSatCatalog: (...a: any[]) => mockSearchSatCatalog(...a),
}))

const mockIssueGlobal = jest.fn()
jest.mock('../../../../src/services/fiscal/cfdiGlobal.service', () => ({
  issueGlobalForEmisor: (...a: any[]) => mockIssueGlobal(...a),
}))

// Mock prisma for tenant guards (triggerGlobalCfdiController + listCfdisController).
// prismaClient uses `export default prisma` (ESM default) so jest needs __esModule:true.
const mockPrismaFiscalEmisorFindFirst = jest.fn()
const mockPrismaVenueFindUnique = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    fiscalEmisor: { findFirst: (...a: any[]) => mockPrismaFiscalEmisorFindFirst(...a) },
    venue: { findUnique: (...a: any[]) => mockPrismaVenueFindUnique(...a) },
    cfdi: { findUnique: jest.fn(), upsert: jest.fn() },
  },
}))

const mockGetFiscalConfig = jest.fn()
const mockUpsertEmisor = jest.fn()
const mockUpsertMerchantFiscalConfig = jest.fn()
jest.mock('../../../../src/services/fiscal/fiscalConfig.service', () => ({
  getFiscalConfig: (...a: any[]) => mockGetFiscalConfig(...a),
  upsertEmisor: (...a: any[]) => mockUpsertEmisor(...a),
  upsertMerchantFiscalConfig: (...a: any[]) => mockUpsertMerchantFiscalConfig(...a),
}))

const mockProvisionEmisor = jest.fn()
const mockUploadEmisorCsd = jest.fn()
jest.mock('../../../../src/services/fiscal/fiscalOnboarding.service', () => ({
  provisionEmisor: (...a: any[]) => mockProvisionEmisor(...a),
  uploadEmisorCsd: (...a: any[]) => mockUploadEmisorCsd(...a),
}))

const mockLogAction = jest.fn()
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({
  logAction: (...a: any[]) => mockLogAction(...a),
}))

jest.mock('../../../../src/config/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}))

jest.mock('../../../../src/config/env', () => ({
  env: { NODE_ENV: 'test' },
}))

import {
  issueCfdiForOrderController,
  listCfdisController,
  cancelCfdiController,
  getCfdiStatusController,
  getFiscalConfigController,
  upsertEmisorController,
  upsertMerchantFiscalConfigController,
  provisionEmisorController,
  uploadEmisorCsdController,
  triggerGlobalCfdiController,
  searchSatCatalogController,
} from '../../../../src/controllers/dashboard/cfdi.dashboard.controller'

// ==========================================
// HELPERS
// ==========================================

function mockRes() {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res
}

function mockReq(overrides: Partial<any> = {}): any {
  return {
    params: { orderId: 'o1', venueId: 'v1' },
    body: {
      rfc: 'XAXX010101000',
      razonSocial: 'Público General',
      regimenFiscal: '616',
      codigoPostal: '83240',
      usoCfdi: 'S01',
    },
    ...overrides,
  }
}

// ==========================================
// TESTS
// ==========================================

describe('issueCfdiForOrderController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 201 with cfdi fields on STAMPED status', async () => {
    mockIssue.mockResolvedValue({
      status: 'STAMPED',
      cfdi: {
        id: 'c1',
        uuid: 'U1',
        serie: 'F',
        folio: '2',
        status: 'STAMPED',
        xmlUrl: 'https://example.com/cfdi.xml',
        pdfUrl: 'https://example.com/cfdi.pdf',
      },
    })

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        cfdi: expect.objectContaining({ uuid: 'U1', serie: 'F', folio: '2' }),
      }),
    )
    // ActivityLog: CFDI_ISSUED must fire on STAMPED
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_ISSUED', entity: 'Cfdi', entityId: 'c1' }))
  })

  it('does NOT call logAction on VALIDATION_FAILED', async () => {
    mockIssue.mockResolvedValue({
      status: 'VALIDATION_FAILED',
      reasons: ['RFC inválido'],
      cfdi: { id: 'c1' },
    })

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(422)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('does NOT call logAction on STAMP_FAILED', async () => {
    mockIssue.mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: { id: 'c1', lastError: 'SAT service unavailable' },
    })

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 422 with reasons on VALIDATION_FAILED status', async () => {
    mockIssue.mockResolvedValue({
      status: 'VALIDATION_FAILED',
      reasons: ['RFC inválido', 'Uso de CFDI no corresponde al régimen'],
      cfdi: { id: 'c1' },
    })

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'No se pudo facturar',
        reasons: expect.arrayContaining(['RFC inválido']),
      }),
    )
  })

  it('returns 502 on STAMP_FAILED status', async () => {
    mockIssue.mockResolvedValue({
      status: 'STAMP_FAILED',
      cfdi: { id: 'c1', lastError: 'SAT service unavailable' },
    })

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        error: 'El PAC rechazó el timbrado',
      }),
    )
  })

  it('returns 404 when the service throws an order-not-found error', async () => {
    mockIssue.mockRejectedValue(new Error('Order o1 not found or has no fiscal emisor configured'))

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Orden no encontrada o sin emisor fiscal configurado' }))
  })

  it('returns 500 on unexpected errors', async () => {
    mockIssue.mockRejectedValue(new Error('Connection refused'))

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al facturar' }))
  })

  it('returns 403 when the service throws "Facturación no habilitada para este merchant"', async () => {
    mockIssue.mockRejectedValue(new Error('Facturación no habilitada para este merchant'))

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Facturación no habilitada para este merchant' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 403 when the service throws "Autofactura no habilitada para este merchant"', async () => {
    mockIssue.mockRejectedValue(new Error('Autofactura no habilitada para este merchant'))

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(403)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Autofactura no habilitada para este merchant' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 409 when the service throws "CFDI en proceso para esta orden" (concurrent in-flight)', async () => {
    mockIssue.mockRejectedValue(new Error('CFDI en proceso para esta orden'))

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'CFDI en proceso para esta orden' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('calls issueCfdiForOrder with the correct receptor and orderId', async () => {
    mockIssue.mockResolvedValue({
      status: 'STAMPED',
      cfdi: { id: 'c1', uuid: 'U1', serie: 'F', folio: '2', status: 'STAMPED', xmlUrl: 'x', pdfUrl: 'p' },
    })

    const res = mockRes()
    await issueCfdiForOrderController(mockReq(), res)

    expect(mockIssue).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'o1',
        receptor: expect.objectContaining({ rfc: 'XAXX010101000' }),
        flow: 'STAFF_B',
      }),
    )
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// cancelCfdiController
// ──────────────────────────────────────────────────────────────────────────────

function cancelReq(overrides: Partial<any> = {}): any {
  return {
    params: { cfdiId: 'c1', venueId: 'v1' },
    body: { motivo: '02' },
    authContext: { venueId: 'v1' },
    ...overrides,
  }
}

describe('cancelCfdiController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with cancelStatus on successful cancel', async () => {
    mockCancel.mockResolvedValue({
      cancelStatus: 'ACCEPTED',
      cancelledAt: new Date('2026-01-01'),
      cfdi: { id: 'c1' },
    })

    const res = mockRes()
    await cancelCfdiController(cancelReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        cancelStatus: 'ACCEPTED',
        cfdiId: 'c1',
      }),
    )
    // ActivityLog: CFDI_CANCELLED must fire on success
    expect(mockLogAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'CFDI_CANCELLED', entity: 'Cfdi', entityId: 'c1' }))
  })

  it('returns 409 when the cfdi is not STAMPED', async () => {
    mockCancel.mockRejectedValue(new Error('Solo se puede cancelar un CFDI timbrado (STAMPED)'))

    const res = mockRes()
    await cancelCfdiController(cancelReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/timbrad/i) }))
  })

  it('returns 409 when motivo 01 is sent without a substituteUuid', async () => {
    mockCancel.mockRejectedValue(new Error('El motivo 01 requiere el UUID de sustitución'))

    const res = mockRes()
    await cancelCfdiController(cancelReq({ body: { motivo: '01' } }), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/motivo|sustituci/i) }))
  })

  it('returns 404 when the cfdi is not found (tenant isolation)', async () => {
    mockCancel.mockRejectedValue(new Error('CFDI c1 not found'))

    const res = mockRes()
    await cancelCfdiController(cancelReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'CFDI no encontrado' }))
  })

  it('returns 500 on unexpected errors', async () => {
    mockCancel.mockRejectedValue(new Error('Connection refused'))

    const res = mockRes()
    await cancelCfdiController(cancelReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al cancelar el CFDI' }))
  })

  it('resolves expectedVenueId from URL :venueId (URL wins over authContext)', async () => {
    // cancelReq sets params.venueId = 'v1'. resolveRequestVenueId returns 'v1' (URL wins).
    mockCancel.mockResolvedValue({ cancelStatus: 'REQUESTED', cancelledAt: null, cfdi: { id: 'c1' } })

    const res = mockRes()
    await cancelCfdiController(cancelReq({ authContext: { venueId: 'myVenue' } }), res)

    // params.venueId='v1' wins over authContext.venueId='myVenue'
    expect(mockCancel).toHaveBeenCalledWith(expect.objectContaining({ expectedVenueId: 'v1', cfdiId: 'c1', motivo: '02' }))
  })

  it('falls back to authContext.venueId when req.params has no venueId', async () => {
    mockCancel.mockResolvedValue({ cancelStatus: 'REQUESTED', cancelledAt: null, cfdi: { id: 'c1' } })

    const res = mockRes()
    await cancelCfdiController(cancelReq({ params: { cfdiId: 'c1' /* no venueId */ }, authContext: { venueId: 'token-venue' } }), res)

    expect(mockCancel).toHaveBeenCalledWith(expect.objectContaining({ expectedVenueId: 'token-venue' }))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getCfdiStatusController
// ──────────────────────────────────────────────────────────────────────────────

function statusReq(overrides: Partial<any> = {}): any {
  return {
    params: { cfdiId: 'c1', venueId: 'v1' },
    authContext: { venueId: 'v1' },
    ...overrides,
  }
}

describe('getCfdiStatusController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with the cfdi on success', async () => {
    const cfdi = { id: 'c1', uuid: 'U1', status: 'STAMPED', cancelStatus: null }
    mockGetStatus.mockResolvedValue(cfdi)

    const res = mockRes()
    await getCfdiStatusController(statusReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ cfdi })
  })

  it('returns 404 when the cfdi is not found (tenant isolation)', async () => {
    mockGetStatus.mockRejectedValue(new Error('CFDI c1 not found'))

    const res = mockRes()
    await getCfdiStatusController(statusReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'CFDI no encontrado' }))
  })

  it('returns 500 on unexpected errors', async () => {
    mockGetStatus.mockRejectedValue(new Error('DB connection failed'))

    const res = mockRes()
    await getCfdiStatusController(statusReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al consultar el CFDI' }))
  })

  it('resolves expectedVenueId from URL :venueId (URL wins over authContext)', async () => {
    // statusReq sets params.venueId = 'v1'. resolveRequestVenueId returns 'v1' (URL wins).
    mockGetStatus.mockResolvedValue({ id: 'c1' })

    const res = mockRes()
    await getCfdiStatusController(statusReq({ authContext: { venueId: 'tenantVenue' } }), res)

    // params.venueId='v1' wins over authContext.venueId='tenantVenue'
    expect(mockGetStatus).toHaveBeenCalledWith(expect.objectContaining({ cfdiId: 'c1', expectedVenueId: 'v1' }))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// getFiscalConfigController
// ──────────────────────────────────────────────────────────────────────────────

function fiscalConfigReq(overrides: Partial<any> = {}): any {
  return {
    params: { venueId: 'v1' },
    authContext: { venueId: 'v1' },
    ...overrides,
  }
}

describe('getFiscalConfigController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with emisores and merchantConfigs on success', async () => {
    mockGetFiscalConfig.mockResolvedValue({
      emisores: [{ id: 'e1', rfc: 'EKU9003173C9' }],
      merchantConfigs: [{ id: 'mc1', facturacionEnabled: true }],
    })

    const res = mockRes()
    await getFiscalConfigController(fiscalConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        emisores: expect.arrayContaining([expect.objectContaining({ id: 'e1' })]),
        merchantConfigs: expect.arrayContaining([expect.objectContaining({ id: 'mc1' })]),
      }),
    )
  })

  it('resolves venueId from URL :venueId (URL wins over authContext)', async () => {
    // fiscalConfigReq sets params.venueId = 'v1'. resolveRequestVenueId returns 'v1' (URL wins).
    mockGetFiscalConfig.mockResolvedValue({ emisores: [], merchantConfigs: [] })

    const res = mockRes()
    await getFiscalConfigController(fiscalConfigReq({ authContext: { venueId: 'myVenue' } }), res)

    // params.venueId='v1' wins over authContext.venueId='myVenue'
    expect(mockGetFiscalConfig).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'v1' }))
  })

  it('returns 500 on unexpected errors', async () => {
    mockGetFiscalConfig.mockRejectedValue(new Error('DB error'))

    const res = mockRes()
    await getFiscalConfigController(fiscalConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al obtener la configuración fiscal' }))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// upsertEmisorController
// ──────────────────────────────────────────────────────────────────────────────

function emisorReq(overrides: Partial<any> = {}): any {
  return {
    params: { venueId: 'v1' },
    body: {
      rfc: 'EKU9003173C9',
      legalName: 'Empresa Ejemplo SA de CV',
      regimenFiscal: '601',
      lugarExpedicion: '64000',
    },
    authContext: { venueId: 'v1' },
    ...overrides,
  }
}

describe('upsertEmisorController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with the emisor on success (create)', async () => {
    mockUpsertEmisor.mockResolvedValue({ id: 'e1', rfc: 'EKU9003173C9', csdStatus: 'NONE' })

    const res = mockRes()
    await upsertEmisorController(emisorReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emisor: expect.objectContaining({ id: 'e1' }) }))
    // ActivityLog: FISCAL_EMISOR_UPSERTED must fire on success
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FISCAL_EMISOR_UPSERTED', entity: 'FiscalEmisor', entityId: 'e1' }),
    )
  })

  it('returns 200 with the emisor on success (update with emisorId)', async () => {
    mockUpsertEmisor.mockResolvedValue({ id: 'e1', rfc: 'EKU9003173C9', csdStatus: 'NONE' })

    const res = mockRes()
    await upsertEmisorController(emisorReq({ params: { venueId: 'v1', emisorId: 'e1' } }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(mockUpsertEmisor).toHaveBeenCalledWith(expect.objectContaining({ emisorId: 'e1' }))
  })

  it('resolves venue from URL :venueId (not authContext) when the path param is present', async () => {
    // resolveRequestVenueId priority: URL param → x-venue-id header → token.
    // When the URL has :venueId, that wins — matching the venue the checkPermission already verified.
    mockUpsertEmisor.mockResolvedValue({ id: 'e1' })

    const res = mockRes()
    await upsertEmisorController(emisorReq({ params: { venueId: 'path-v1' }, authContext: { venueId: 'auth-v1' } }), res)

    expect(mockUpsertEmisor).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'path-v1' }))
  })

  it('falls back to authContext.venueId when req.params has no venueId', async () => {
    mockUpsertEmisor.mockResolvedValue({ id: 'e1' })

    const res = mockRes()
    await upsertEmisorController(emisorReq({ params: { emisorId: 'e1' }, authContext: { venueId: 'token-venue' } }), res)

    expect(mockUpsertEmisor).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'token-venue' }))
  })

  it('returns 404 when the service throws not found (tenant mismatch)', async () => {
    mockUpsertEmisor.mockRejectedValue(new Error('Emisor e1 not found'))

    const res = mockRes()
    await upsertEmisorController(emisorReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Emisor no encontrado' }))
  })

  it('returns 500 on unexpected errors', async () => {
    mockUpsertEmisor.mockRejectedValue(new Error('DB connection failed'))

    const res = mockRes()
    await upsertEmisorController(emisorReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al guardar el emisor fiscal' }))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// upsertMerchantFiscalConfigController
// ──────────────────────────────────────────────────────────────────────────────

function merchantConfigReq(overrides: Partial<any> = {}): any {
  return {
    params: { venueId: 'v1' },
    body: {
      merchantAccountId: 'ma1',
      fiscalEmisorId: 'e1',
      facturacionEnabled: true,
      autofacturaEnabled: false,
      includeInGlobal: true,
    },
    authContext: { venueId: 'v1' },
    ...overrides,
  }
}

describe('upsertMerchantFiscalConfigController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with the config on success', async () => {
    mockUpsertMerchantFiscalConfig.mockResolvedValue({ id: 'mc1', facturacionEnabled: true })

    const res = mockRes()
    await upsertMerchantFiscalConfigController(merchantConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ id: 'mc1' }) }))
    // ActivityLog: MERCHANT_FISCAL_CONFIG_UPSERTED must fire on success
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'MERCHANT_FISCAL_CONFIG_UPSERTED', entity: 'MerchantFiscalConfig', entityId: 'mc1' }),
    )
  })

  it('resolves venue from URL :venueId (not authContext) when the path param is present', async () => {
    mockUpsertMerchantFiscalConfig.mockResolvedValue({ id: 'mc1' })

    const res = mockRes()
    await upsertMerchantFiscalConfigController(
      merchantConfigReq({ params: { venueId: 'path-v1' }, authContext: { venueId: 'auth-v1' } }),
      res,
    )

    expect(mockUpsertMerchantFiscalConfig).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'path-v1' }))
  })

  it('returns 409 when the service throws XOR violation', async () => {
    mockUpsertMerchantFiscalConfig.mockRejectedValue(
      new Error('Debe especificar exactamente un merchant (merchantAccountId o ecommerceMerchantId)'),
    )

    const res = mockRes()
    await upsertMerchantFiscalConfigController(merchantConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/merchant/i) }))
  })

  it('returns 404 when the service throws merchant not found (tenant mismatch)', async () => {
    mockUpsertMerchantFiscalConfig.mockRejectedValue(new Error('Merchant not found'))

    const res = mockRes()
    await upsertMerchantFiscalConfigController(merchantConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Comercio o emisor no encontrado' }))
  })

  it('returns 404 when the service throws emisor not found (tenant mismatch)', async () => {
    mockUpsertMerchantFiscalConfig.mockRejectedValue(new Error('Emisor e1 not found'))

    const res = mockRes()
    await upsertMerchantFiscalConfigController(merchantConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Comercio o emisor no encontrado' }))
  })

  it('returns 500 on unexpected errors', async () => {
    mockUpsertMerchantFiscalConfig.mockRejectedValue(new Error('DB connection failed'))

    const res = mockRes()
    await upsertMerchantFiscalConfigController(merchantConfigReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al guardar la configuración de facturación' }))
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// provisionEmisorController
// ──────────────────────────────────────────────────────────────────────────────

function provisionReq(overrides: Partial<any> = {}): any {
  return {
    params: { venueId: 'v1', emisorId: 'e1' },
    body: {},
    authContext: { venueId: 'v1', userId: 'u1' },
    ...overrides,
  }
}

describe('provisionEmisorController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with the emisor on success', async () => {
    mockProvisionEmisor.mockResolvedValue({ id: 'e1', providerOrgId: 'org1', csdStatus: 'NONE' })

    const res = mockRes()
    await provisionEmisorController(provisionReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emisor: expect.objectContaining({ id: 'e1', providerOrgId: 'org1' }) }))
  })

  it('writes ActivityLog with FISCAL_EMISOR_PROVISIONED on success', async () => {
    mockProvisionEmisor.mockResolvedValue({ id: 'e1', providerOrgId: 'org1', csdStatus: 'NONE' })

    const res = mockRes()
    await provisionEmisorController(provisionReq(), res)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FISCAL_EMISOR_PROVISIONED', entity: 'FiscalEmisor', entityId: 'e1' }),
    )
    // Security: CSD material must NOT appear in the log data
    const logCall = (mockLogAction as jest.Mock).mock.calls[0][0]
    expect(JSON.stringify(logCall.data)).not.toMatch(/password|cer|key|sk_live|sk_test/i)
  })

  it('resolves venue from URL :venueId when present, for the service expectedVenueId', async () => {
    // resolveRequestVenueId: URL param wins. checkPermission already verified access to this venue.
    mockProvisionEmisor.mockResolvedValue({ id: 'e1', providerOrgId: 'org1' })

    const res = mockRes()
    await provisionEmisorController(
      provisionReq({ params: { venueId: 'path-v1', emisorId: 'e1' }, authContext: { venueId: 'auth-v1', userId: 'u1' } }),
      res,
    )

    expect(mockProvisionEmisor).toHaveBeenCalledWith(expect.objectContaining({ expectedVenueId: 'path-v1' }))
  })

  it('returns 404 when service throws not found (tenant mismatch)', async () => {
    mockProvisionEmisor.mockRejectedValue(new Error('Emisor e1 not found'))

    const res = mockRes()
    await provisionEmisorController(provisionReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Emisor no encontrado' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 500 on unexpected errors', async () => {
    mockProvisionEmisor.mockRejectedValue(new Error('facturapi network error'))

    const res = mockRes()
    await provisionEmisorController(provisionReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al provisionar el emisor fiscal' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

// ──────────────────────────────────────────────────────────────────────────────
// uploadEmisorCsdController
// ──────────────────────────────────────────────────────────────────────────────

function csdReq(overrides: Partial<any> = {}): any {
  return {
    params: { venueId: 'v1', emisorId: 'e1' },
    body: { cerBase64: 'AA==', keyBase64: 'BB==', password: 'secretpw' },
    authContext: { venueId: 'v1', userId: 'u1' },
    ...overrides,
  }
}

describe('uploadEmisorCsdController', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with the emisor on success', async () => {
    mockUploadEmisorCsd.mockResolvedValue({ id: 'e1', csdStatus: 'ACTIVE', csdExpiresAt: new Date('2030-01-01') })

    const res = mockRes()
    await uploadEmisorCsdController(csdReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ emisor: expect.objectContaining({ id: 'e1', csdStatus: 'ACTIVE' }) }))
  })

  it('writes ActivityLog with FISCAL_CSD_UPLOADED on success — no CSD secrets in data', async () => {
    const expiresAt = new Date('2030-01-01')
    mockUploadEmisorCsd.mockResolvedValue({ id: 'e1', csdStatus: 'ACTIVE', csdExpiresAt: expiresAt })

    const res = mockRes()
    await uploadEmisorCsdController(csdReq(), res)

    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'FISCAL_CSD_UPLOADED', entity: 'FiscalEmisor', entityId: 'e1' }),
    )
    // Security: CSD password/key must NEVER appear in the log
    const logCall = (mockLogAction as jest.Mock).mock.calls[0][0]
    expect(JSON.stringify(logCall.data)).not.toMatch(/password|cerBase64|keyBase64/i)
  })

  it('resolves venue from URL :venueId when present, for the service expectedVenueId', async () => {
    // resolveRequestVenueId: URL param wins. checkPermission already verified access to this venue.
    mockUploadEmisorCsd.mockResolvedValue({ id: 'e1', csdStatus: 'ACTIVE', csdExpiresAt: null })

    const res = mockRes()
    await uploadEmisorCsdController(
      csdReq({ params: { venueId: 'path-v1', emisorId: 'e1' }, authContext: { venueId: 'auth-v1', userId: 'u1' } }),
      res,
    )

    expect(mockUploadEmisorCsd).toHaveBeenCalledWith(expect.objectContaining({ expectedVenueId: 'path-v1' }))
  })

  it('returns 404 on not found (tenant mismatch)', async () => {
    mockUploadEmisorCsd.mockRejectedValue(new Error('Emisor e1 not found'))

    const res = mockRes()
    await uploadEmisorCsdController(csdReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Emisor no encontrado' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 409 when emisor not yet provisioned', async () => {
    mockUploadEmisorCsd.mockRejectedValue(new Error('El emisor debe provisionarse antes de subir el CSD'))

    const res = mockRes()
    await uploadEmisorCsdController(csdReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: expect.stringMatching(/provision/i) }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 500 on unexpected errors', async () => {
    mockUploadEmisorCsd.mockRejectedValue(new Error('facturapi upload failed'))

    const res = mockRes()
    await uploadEmisorCsdController(csdReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al subir el CSD del emisor fiscal' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

// ==========================================
// triggerGlobalCfdiController
// ==========================================

describe('triggerGlobalCfdiController', () => {
  function globalReq(overrides: Partial<any> = {}): any {
    return {
      params: { venueId: 'v1', emisorId: 'e1' },
      body: {},
      authContext: { venueId: 'v1', userId: 'u1' },
      ...overrides,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
    // Default: emisor belongs to the venue (tenant guard passes)
    mockPrismaFiscalEmisorFindFirst.mockResolvedValue({ id: 'e1' })
  })

  it('returns 201 with cfdi fields and calls logAction on STAMPED', async () => {
    mockIssueGlobal.mockResolvedValue({
      status: 'STAMPED',
      cfdi: {
        id: 'cfdi-g1',
        uuid: 'GLOBAL-UUID-1',
        serie: null,
        folio: '1',
        globalPeriod: { periodicidad: '04', meses: '05', anio: 2026 },
        pdfUrl: 'https://cdn/cfdi.pdf',
      },
      period: { meses: '05', anio: 2026, satPeriodicidad: '04' },
      candidateCount: 3,
    })

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(201)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        cfdi: expect.objectContaining({ uuid: 'GLOBAL-UUID-1', globalPeriod: expect.objectContaining({ meses: '05' }) }),
      }),
    )
    expect(mockLogAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CFDI_GLOBAL_ISSUED',
        entity: 'Cfdi',
        entityId: 'cfdi-g1',
        staffId: 'u1',
        venueId: 'v1',
      }),
    )
  })

  it('returns 200 with NOTHING_TO_INVOICE message when no candidates in period', async () => {
    mockIssueGlobal.mockResolvedValue({ status: 'NOTHING_TO_INVOICE' })

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'NOTHING_TO_INVOICE', message: expect.stringContaining('No hay') }),
    )
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 409 when SKIPPED (inactive CSD)', async () => {
    mockIssueGlobal.mockResolvedValue({ status: 'SKIPPED', reason: 'CSD inactivo' })

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 422 on VALIDATION_FAILED', async () => {
    mockIssueGlobal.mockResolvedValue({ status: 'VALIDATION_FAILED', reasons: ['El código postal no es válido'] })

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(422)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ reasons: expect.arrayContaining(['El código postal no es válido']) }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 502 on STAMP_FAILED', async () => {
    mockIssueGlobal.mockResolvedValue({ status: 'STAMP_FAILED', cfdi: { lastError: 'PAC timeout' } })

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'El PAC rechazó el timbrado de la factura global' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 404 when the emisor does not belong to the caller venue (foreign emisor guard)', async () => {
    // Tenant guard returns null → 404
    mockPrismaFiscalEmisorFindFirst.mockResolvedValue(null)

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(404)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Emisor fiscal no encontrado' }))
    // Service must NOT be called for a foreign emisor
    expect(mockIssueGlobal).not.toHaveBeenCalled()
    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 500 on unexpected error from issueGlobalForEmisor', async () => {
    mockIssueGlobal.mockRejectedValue(new Error('Database connection failed'))

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al generar la factura global' }))
  })

  it('returns 409 when issueGlobalForEmisor throws "Global en proceso" (concurrent in-flight)', async () => {
    mockIssueGlobal.mockRejectedValue(new Error('Global en proceso para este emisor y periodo'))

    const res = mockRes()
    await triggerGlobalCfdiController(globalReq(), res)

    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Global en proceso para este emisor y periodo' }))
    expect(mockLogAction).not.toHaveBeenCalled()
  })
})

// ==========================================
// searchSatCatalogController
// ==========================================

describe('searchSatCatalogController', () => {
  function satReq(overrides: Partial<any> = {}): any {
    return {
      params: { venueId: 'v1' },
      query: { type: 'product', q: 'restaurante' },
      authContext: { venueId: 'v1' },
      ...overrides,
    }
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
  })

  it('returns 200 with { results } for type=product', async () => {
    mockSearchSatCatalog.mockResolvedValue({
      results: [{ key: '90101500', description: 'Servicio de restaurante' }],
    })

    const res = mockRes()
    await searchSatCatalogController(satReq({ query: { type: 'product', q: 'restaurante' } }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      results: [{ key: '90101500', description: 'Servicio de restaurante' }],
    })
    expect(mockSearchSatCatalog).toHaveBeenCalledWith({ type: 'product', q: 'restaurante' })
  })

  it('returns 200 with { results } for type=unit', async () => {
    mockSearchSatCatalog.mockResolvedValue({
      results: [{ key: 'E48', description: 'Unidad de servicio' }],
    })

    const res = mockRes()
    await searchSatCatalogController(satReq({ query: { type: 'unit', q: 'servicio' } }), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({
      results: [{ key: 'E48', description: 'Unidad de servicio' }],
    })
  })

  it('returns 200 with empty results array when no matches', async () => {
    mockSearchSatCatalog.mockResolvedValue({ results: [] })

    const res = mockRes()
    await searchSatCatalogController(satReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith({ results: [] })
  })

  it('does NOT call logAction (this is a READ)', async () => {
    mockSearchSatCatalog.mockResolvedValue({ results: [] })

    const res = mockRes()
    await searchSatCatalogController(satReq(), res)

    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 502 when service throws a facturapi provider error', async () => {
    mockSearchSatCatalog.mockRejectedValue(new Error('facturapi: upstream catalog error'))

    const res = mockRes()
    await searchSatCatalogController(satReq(), res)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith({ error: 'No se pudo consultar el catálogo SAT' })
  })

  it('returns 502 when service throws an error matching /catalog/i', async () => {
    mockSearchSatCatalog.mockRejectedValue(new Error('catalog service unavailable'))

    const res = mockRes()
    await searchSatCatalogController(satReq(), res)

    expect(res.status).toHaveBeenCalledWith(502)
    expect(res.json).toHaveBeenCalledWith({ error: 'No se pudo consultar el catálogo SAT' })
  })

  it('returns 500 on unexpected errors not matching the provider pattern', async () => {
    mockSearchSatCatalog.mockRejectedValue(new Error('Database connection refused'))

    const res = mockRes()
    await searchSatCatalogController(satReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith({ error: 'Error interno al consultar el catálogo SAT' })
  })
})

// ==========================================
// listCfdisController
// ==========================================

describe('listCfdisController', () => {
  const VENUE_ID = 'venue-xyz'

  function listReq(overrides: Partial<any> = {}): any {
    return {
      params: { venueId: VENUE_ID },
      query: { page: 1, pageSize: 20 },
      authContext: { venueId: VENUE_ID },
      ...overrides,
    }
  }

  const SAMPLE_RESULT = {
    cfdis: [
      {
        id: 'c1',
        type: 'INGRESO',
        status: 'STAMPED',
        flow: 'STAFF_B',
        isGlobal: false,
        orderId: 'o1',
        receptorRfc: 'XAXX010101000',
        receptorNombre: 'Público en General',
        serie: 'F',
        folio: '1',
        uuid: 'uuid-1',
        subtotalCents: 10000,
        taxCents: 1600,
        totalCents: 11600,
        stampedAt: new Date('2026-06-01T19:00:00.000Z'),
        createdAt: new Date('2026-06-01T19:00:00.000Z'),
        cancelStatus: null,
        xmlUrl: 'https://example.com/cfdi.xml',
        pdfUrl: 'https://example.com/cfdi.pdf',
        globalPeriod: null,
      },
    ],
    total: 1,
    page: 1,
    pageSize: 20,
  }

  beforeEach(() => {
    jest.clearAllMocks()
    mockLogAction.mockResolvedValue(undefined)
    // Default: venue exists with Mexico timezone
    mockPrismaVenueFindUnique.mockResolvedValue({ timezone: 'America/Mexico_City' })
    mockListCfdis.mockResolvedValue(SAMPLE_RESULT)
  })

  it('returns 200 with { cfdis, total, page, pageSize } on success', async () => {
    const res = mockRes()
    await listCfdisController(listReq(), res)

    expect(res.status).toHaveBeenCalledWith(200)
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        cfdis: expect.any(Array),
        total: 1,
        page: 1,
        pageSize: 20,
      }),
    )
  })

  it('resolves venue from URL :venueId when present (URL wins over authContext — regression test)', async () => {
    // This is the core fix: a SUPERADMIN or multi-venue OWNER browsing a venue that differs
    // from their token venue must operate on the URL venue, not the stale JWT venue.
    // checkPermission (which runs before this controller) already verified access to
    // the URL venue via resolveRequestVenueId + resolveUserRoleForVenue, so using
    // the URL venue here is safe — no cross-venue escalation is possible.
    const req = listReq({
      params: { venueId: 'url-venue-id' },
      authContext: { venueId: 'token-venue-id' }, // stale JWT venue (e.g. after venue-switch)
    })

    const res = mockRes()
    await listCfdisController(req, res)

    // URL venue must win
    expect(mockListCfdis).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'url-venue-id' }))
    const callArg = mockListCfdis.mock.calls[0][0]
    expect(callArg.venueId).not.toBe('token-venue-id')
  })

  it('falls back to authContext.venueId when req.params has no venueId', async () => {
    const req = listReq({
      params: {}, // no venueId in params
      authContext: { venueId: 'token-venue-id' },
    })

    const res = mockRes()
    await listCfdisController(req, res)

    expect(mockListCfdis).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'token-venue-id' }))
  })

  it('uses x-venue-id header when params has no venueId and header is present', async () => {
    const req = listReq({
      params: {},
      headers: { 'x-venue-id': 'header-venue-id' },
      authContext: { venueId: 'token-venue-id' },
    })

    const res = mockRes()
    await listCfdisController(req, res)

    expect(mockListCfdis).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'header-venue-id' }))
  })

  it('passes venue timezone from DB to the service', async () => {
    mockPrismaVenueFindUnique.mockResolvedValue({ timezone: 'America/Monterrey' })

    const res = mockRes()
    await listCfdisController(listReq(), res)

    expect(mockListCfdis).toHaveBeenCalledWith(expect.objectContaining({ venueTimezone: 'America/Monterrey' }))
  })

  it('falls back to America/Mexico_City when venue is not found', async () => {
    mockPrismaVenueFindUnique.mockResolvedValue(null)

    const res = mockRes()
    await listCfdisController(listReq(), res)

    expect(mockListCfdis).toHaveBeenCalledWith(expect.objectContaining({ venueTimezone: 'America/Mexico_City' }))
  })

  it('does NOT call logAction (this is a READ)', async () => {
    const res = mockRes()
    await listCfdisController(listReq(), res)

    expect(mockLogAction).not.toHaveBeenCalled()
  })

  it('returns 500 with Spanish message on unexpected error', async () => {
    mockListCfdis.mockRejectedValue(new Error('DB connection refused'))

    const res = mockRes()
    await listCfdisController(listReq(), res)

    expect(res.status).toHaveBeenCalledWith(500)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ error: 'Error interno al listar los CFDIs' }))
  })

  it('passes query filters to the service', async () => {
    const req = listReq({
      query: {
        status: 'STAMPED',
        flow: 'STAFF_B',
        isGlobal: false,
        receptorRfc: 'XAXX',
        from: '2026-06-01',
        to: '2026-06-30',
        page: 2,
        pageSize: 10,
      },
      authContext: { venueId: VENUE_ID },
    })

    const res = mockRes()
    await listCfdisController(req, res)

    expect(mockListCfdis).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'STAMPED',
        flow: 'STAFF_B',
        isGlobal: false,
        receptorRfc: 'XAXX',
        from: '2026-06-01',
        to: '2026-06-30',
        page: 2,
        pageSize: 10,
      }),
    )
  })
})
