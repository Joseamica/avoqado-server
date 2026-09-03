jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { error: jest.fn(), warn: jest.fn(), info: jest.fn(), debug: jest.fn() },
}))

jest.mock('@/services/customer/consent.service')
jest.mock('@/utils/customerActionToken')
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    customerCaptureToken: { findUnique: jest.fn(), updateMany: jest.fn() },
    customer: { updateMany: jest.fn() },
  },
}))

import {
  getCustomerUnsubscribePage,
  postCustomerUnsubscribe,
  getBirthdateCapturePage,
  postBirthdateCapture,
} from '@/controllers/public/customerEmail.public.controller'
import * as consentSvc from '@/services/customer/consent.service'
import * as tokenUtil from '@/utils/customerActionToken'
import prisma from '@/utils/prismaClient'

const mockRevoke = consentSvc.revokeMarketingConsent as jest.Mock
const mockVerifyUnsub = tokenUtil.verifyCustomerUnsubscribeToken as jest.Mock
const mockVerifyCapture = tokenUtil.verifyBirthdateCaptureToken as jest.Mock
const mockTokenFindUnique = (prisma as any).customerCaptureToken.findUnique as jest.Mock
const mockTokenUpdateMany = (prisma as any).customerCaptureToken.updateMany as jest.Mock
const mockCustomerUpdateMany = (prisma as any).customer.updateMany as jest.Mock

function mockRes() {
  const res: any = {}
  res.statusCode = 200
  res.body = ''
  res.status = jest.fn((c: number) => {
    res.statusCode = c
    return res
  })
  res.type = jest.fn(() => res)
  res.send = jest.fn((b: string) => {
    res.body = b
    return res
  })
  return res
}

// asyncHandler doesn't return its promise (matches Express), so let the
// handler's async chain settle before asserting.
const flush = () => new Promise(resolve => setImmediate(resolve))

const UNSUB_DATA = { customerId: 'cust1', venueId: 'venueA' }
const CAPTURE_DATA = { customerId: 'cust1', venueId: 'venueA', tokenHash: 'hash1' }

beforeEach(() => {
  jest.clearAllMocks()
})

describe('POST /customers/unsubscribe — idempotencia y llamada al service', () => {
  it('(a) llama a revokeMarketingConsent con channel ONE_CLICK_UNSUBSCRIBE y responde 200 aunque ya estuviera revocado', async () => {
    mockVerifyUnsub.mockReturnValue(UNSUB_DATA)
    mockRevoke.mockResolvedValue(undefined) // el service es idempotente: no truena en la segunda baja
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/unsubscribe?token=good',
      ip: '1.2.3.4',
      get: () => 'UA',
    }
    const res = mockRes()

    await postCustomerUnsubscribe(req, res, jest.fn())
    await flush()

    expect(mockRevoke).toHaveBeenCalledWith(
      expect.objectContaining({ venueId: 'venueA', customerId: 'cust1', channel: 'ONE_CLICK_UNSUBSCRIBE' }),
    )
    expect(res.statusCode).toBe(200)
  })

  it('(b) token inválido ⇒ 400 y NUNCA llama al service', async () => {
    mockVerifyUnsub.mockReturnValue(null)
    const req: any = { query: { token: 'bad' }, originalUrl: '/x', ip: '1.2.3.4', get: () => undefined }
    const res = mockRes()

    await postCustomerUnsubscribe(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(mockRevoke).not.toHaveBeenCalled()
  })
})

describe('GET /customers/unsubscribe — nunca muta', () => {
  it('(c) NO llama al service (no muta)', async () => {
    mockVerifyUnsub.mockReturnValue(UNSUB_DATA)
    const req: any = { query: { token: 'good' }, originalUrl: '/api/v1/public/customers/unsubscribe?token=good' }
    const res = mockRes()

    await getCustomerUnsubscribePage(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(200)
    expect(mockRevoke).not.toHaveBeenCalled()
  })
})

describe('POST /customers/birthdate — consumo atómico y no-sobrescribir', () => {
  it('(d) replay (updateMany del token → count 0) ⇒ 400 y NO escribe birthDate', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    mockTokenUpdateMany.mockResolvedValue({ count: 0 })
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/birthdate?token=good',
      body: { birthdate: '1999-12-31' },
    }
    const res = mockRes()

    await postBirthdateCapture(req, res, jest.fn())
    await flush()

    expect(mockTokenUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tokenHash: 'hash1', consumedAt: null }) }),
    )
    expect(res.statusCode).toBe(400)
    expect(mockCustomerUpdateMany).not.toHaveBeenCalled()
  })

  it('(e) customer que YA tiene birthDate (updateMany del customer → count 0) ⇒ 409 "ya está registrado" y el token QUEDA consumido', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    mockTokenUpdateMany.mockResolvedValue({ count: 1 }) // el token SÍ se consumió
    mockCustomerUpdateMany.mockResolvedValue({ count: 0 }) // pero el customer ya tenía birthDate
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/birthdate?token=good',
      body: { birthdate: '1999-12-31' },
    }
    const res = mockRes()

    await postBirthdateCapture(req, res, jest.fn())
    await flush()

    expect(mockTokenUpdateMany).toHaveBeenCalled() // el token quedó consumido (se llamó, count:1)
    // Aislamiento de tenant: el WHERE de la escritura debe filtrar por venueId, no sólo por id —
    // si un edit futuro lo deja caer, esta prueba debe fallar (ver Task 3: "prueba que pasa por
    // el motivo equivocado"). Se afirma la FORMA del where, no sólo que se llamó.
    expect(mockCustomerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'cust1', venueId: 'venueA', birthDate: null }),
      }),
    )
    expect(res.statusCode).toBe(409)
    expect(res.body).toContain('ya está registrado')
  })

  it('(f) fecha mal formada ("31/12/1999") ⇒ 400 y no toca el token ni al customer', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/birthdate?token=good',
      body: { birthdate: '31/12/1999' },
    }
    const res = mockRes()

    await postBirthdateCapture(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(mockTokenUpdateMany).not.toHaveBeenCalled()
    expect(mockCustomerUpdateMany).not.toHaveBeenCalled()
  })

  // Hallazgo #3 de la ronda final: el regex sólo comprueba el FORMATO — un calendario
  // imposible ('2026-13-45') o un rollover silencioso ('2026-02-30' → marzo-2) pasaba el
  // regex, quemaba el token, y luego reventaba en Prisma con Invalid Date. El fix compara
  // el ISO reconstruido contra el string de entrada ANTES de tocar el token.
  it('(g) mes/día fuera de calendario ("2026-13-45") ⇒ 400 y el token NO se consume', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/birthdate?token=good',
      body: { birthdate: '2026-13-45' },
    }
    const res = mockRes()

    await postBirthdateCapture(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(mockTokenUpdateMany).not.toHaveBeenCalled()
    expect(mockCustomerUpdateMany).not.toHaveBeenCalled()
  })

  it('(h) fecha con rollover silencioso ("2026-02-30" → marzo) ⇒ 400 y el token NO se consume', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/birthdate?token=good',
      body: { birthdate: '2026-02-30' },
    }
    const res = mockRes()

    await postBirthdateCapture(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(mockTokenUpdateMany).not.toHaveBeenCalled()
    expect(mockCustomerUpdateMany).not.toHaveBeenCalled()
  })

  it('(i) fecha real ("1990-05-10") sigue funcionando: consume el token y escribe birthDate', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    mockTokenUpdateMany.mockResolvedValue({ count: 1 })
    mockCustomerUpdateMany.mockResolvedValue({ count: 1 })
    const req: any = {
      query: { token: 'good' },
      originalUrl: '/api/v1/public/customers/birthdate?token=good',
      body: { birthdate: '1990-05-10' },
    }
    const res = mockRes()

    await postBirthdateCapture(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(200)
    expect(mockTokenUpdateMany).toHaveBeenCalled()
    expect(mockCustomerUpdateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ birthDate: new Date('1990-05-10T00:00:00.000Z') }),
      }),
    )
  })
})

describe('GET /customers/birthdate — sólo muestra el formulario con token vigente', () => {
  it('token inválido ⇒ 400, no consulta la base', async () => {
    mockVerifyCapture.mockReturnValue(null)
    const req: any = { query: { token: 'bad' }, originalUrl: '/x' }
    const res = mockRes()

    await getBirthdateCapturePage(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
    expect(mockTokenFindUnique).not.toHaveBeenCalled()
  })

  it('token verifica pero la fila ya fue consumida ⇒ 400', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    mockTokenFindUnique.mockResolvedValue({ consumedAt: new Date(), expiresAt: new Date(Date.now() + 100000) })
    const req: any = { query: { token: 'good' }, originalUrl: '/x' }
    const res = mockRes()

    await getBirthdateCapturePage(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(400)
  })

  it('token vigente y fila sin consumir ⇒ 200 con el formulario de fecha', async () => {
    mockVerifyCapture.mockReturnValue(CAPTURE_DATA)
    mockTokenFindUnique.mockResolvedValue({ consumedAt: null, expiresAt: new Date(Date.now() + 100000) })
    const req: any = { query: { token: 'good' }, originalUrl: '/api/v1/public/customers/birthdate?token=good' }
    const res = mockRes()

    await getBirthdateCapturePage(req, res, jest.fn())
    await flush()

    expect(res.statusCode).toBe(200)
    expect(res.body).toContain('type="date"')
    expect(res.body).toContain('<form method="POST"')
  })
})
