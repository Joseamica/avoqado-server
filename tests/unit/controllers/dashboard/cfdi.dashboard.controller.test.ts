// tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts

const mockIssue = jest.fn()
const mockCancel = jest.fn()
const mockGetStatus = jest.fn()
jest.mock('../../../../src/services/fiscal/cfdi.service', () => ({
  issueCfdiForOrder: (...a: any[]) => mockIssue(...a),
  cancelCfdi: (...a: any[]) => mockCancel(...a),
  getCfdiStatus: (...a: any[]) => mockGetStatus(...a),
}))

const mockGetFiscalConfig = jest.fn()
const mockUpsertEmisor = jest.fn()
const mockUpsertMerchantFiscalConfig = jest.fn()
jest.mock('../../../../src/services/fiscal/fiscalConfig.service', () => ({
  getFiscalConfig: (...a: any[]) => mockGetFiscalConfig(...a),
  upsertEmisor: (...a: any[]) => mockUpsertEmisor(...a),
  upsertMerchantFiscalConfig: (...a: any[]) => mockUpsertMerchantFiscalConfig(...a),
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
  cancelCfdiController,
  getCfdiStatusController,
  getFiscalConfigController,
  upsertEmisorController,
  upsertMerchantFiscalConfigController,
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

  it('passes expectedVenueId from authContext to the service', async () => {
    mockCancel.mockResolvedValue({ cancelStatus: 'REQUESTED', cancelledAt: null, cfdi: { id: 'c1' } })

    const res = mockRes()
    await cancelCfdiController(cancelReq({ authContext: { venueId: 'myVenue' } }), res)

    expect(mockCancel).toHaveBeenCalledWith(expect.objectContaining({ expectedVenueId: 'myVenue', cfdiId: 'c1', motivo: '02' }))
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

  it('passes expectedVenueId from authContext to the service', async () => {
    mockGetStatus.mockResolvedValue({ id: 'c1' })

    const res = mockRes()
    await getCfdiStatusController(statusReq({ authContext: { venueId: 'tenantVenue' } }), res)

    expect(mockGetStatus).toHaveBeenCalledWith(expect.objectContaining({ cfdiId: 'c1', expectedVenueId: 'tenantVenue' }))
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

  it('passes venueId from authContext to the service', async () => {
    mockGetFiscalConfig.mockResolvedValue({ emisores: [], merchantConfigs: [] })

    const res = mockRes()
    await getFiscalConfigController(fiscalConfigReq({ authContext: { venueId: 'myVenue' } }), res)

    expect(mockGetFiscalConfig).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'myVenue' }))
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

  it('passes authContext.venueId (not path :venueId) to the service', async () => {
    mockUpsertEmisor.mockResolvedValue({ id: 'e1' })

    const res = mockRes()
    await upsertEmisorController(emisorReq({ params: { venueId: 'path-v1' }, authContext: { venueId: 'auth-v1' } }), res)

    expect(mockUpsertEmisor).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'auth-v1' }))
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

  it('passes authContext.venueId (not path :venueId) to the service', async () => {
    mockUpsertMerchantFiscalConfig.mockResolvedValue({ id: 'mc1' })

    const res = mockRes()
    await upsertMerchantFiscalConfigController(
      merchantConfigReq({ params: { venueId: 'path-v1' }, authContext: { venueId: 'auth-v1' } }),
      res,
    )

    expect(mockUpsertMerchantFiscalConfig).toHaveBeenCalledWith(expect.objectContaining({ venueId: 'auth-v1' }))
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
