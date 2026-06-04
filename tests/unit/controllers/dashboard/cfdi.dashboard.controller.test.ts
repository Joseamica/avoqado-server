// tests/unit/controllers/dashboard/cfdi.dashboard.controller.test.ts

const mockIssue = jest.fn()
jest.mock('../../../../src/services/fiscal/cfdi.service', () => ({
  issueCfdiForOrder: (...a: any[]) => mockIssue(...a),
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

import { issueCfdiForOrderController } from '../../../../src/controllers/dashboard/cfdi.dashboard.controller'

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
  beforeEach(() => jest.clearAllMocks())

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
