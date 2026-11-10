const mockResolve = jest.fn()
jest.mock('@/services/dashboard/paymentLink.service', () => ({
  getPaymentLinkByShortCode: (...a: unknown[]) => mockResolve(...a),
}))
const mockLogger = { warn: jest.fn(), error: jest.fn(), info: jest.fn(), debug: jest.fn() }
jest.mock('@/config/logger', () => ({ __esModule: true, default: mockLogger }))

import { resolvePaymentLink } from '@/controllers/public/paymentLink.public.controller'
import { NotFoundError } from '@/errors/AppError'

const res = () => {
  const r: any = {}
  r.status = jest.fn().mockReturnValue(r)
  r.json = jest.fn().mockReturnValue(r)
  return r
}

const LIGA = { shortCode: 'abc12345', title: 'Clase muestra', amount: 1000, currency: 'MXN', venue: { name: 'Estudio', slug: 'estudio' } }

beforeEach(() => jest.clearAllMocks())

describe('GET /public/payment-links/:shortCode — campo bancoPrueba', () => {
  it('la respuesta trae el campo nuevo bancoPrueba: true', async () => {
    mockResolve.mockResolvedValue(LIGA)
    const r = res()
    await resolvePaymentLink({ params: { shortCode: 'abc12345' } } as any, r)
    expect(r.json.mock.calls[0][0].data.bancoPrueba).toBe(true)
  })

  it('regresión: todos los campos de antes siguen iguales (el nuevo sólo se suma)', async () => {
    mockResolve.mockResolvedValue(LIGA)
    const r = res()
    await resolvePaymentLink({ params: { shortCode: 'abc12345' } } as any, r)
    expect(r.status).not.toHaveBeenCalled()
    expect(r.json).toHaveBeenCalledWith({ success: true, data: { ...LIGA, bancoPrueba: true } })
    expect(mockResolve).toHaveBeenCalledWith('abc12345')
  })

  it('regresión: una liga que no existe sigue en 404 y sin el campo nuevo', async () => {
    mockResolve.mockRejectedValue(new NotFoundError('Liga de pago no encontrada'))
    const r = res()
    await resolvePaymentLink({ params: { shortCode: 'nope' } } as any, r)
    expect(r.status).toHaveBeenCalledWith(404)
    expect(r.json).toHaveBeenCalledWith({ success: false, error: 'Liga de pago no encontrada' })
  })
})
