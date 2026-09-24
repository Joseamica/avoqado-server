/**
 * Aislamiento entre negocios en las facturas (hallado al inventariar los caminos de Stripe, 21-sep-2026).
 *
 * `GET …/invoices/:invoiceId/download` y `POST …/invoices/:invoiceId/retry` recibían el id de la factura
 * de la URL y lo mandaban a Stripe SIN comprobar que fuera del cliente de Stripe de ESE negocio. Con el
 * id de una factura ajena, un administrador obtenía su PDF (datos fiscales y montos de otro negocio) o
 * disparaba el cobro a la tarjeta del otro negocio.
 */
const mockRetrieve = jest.fn()
const mockPay = jest.fn()
jest.mock('stripe', () =>
  jest.fn().mockImplementation(() => ({
    invoices: { retrieve: mockRetrieve, pay: mockPay },
  })),
)
jest.mock('../../../src/utils/prismaClient', () => ({ __esModule: true, default: {} }))
jest.mock('../../../src/config/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }))

import { getInvoicePdfUrl, retryInvoicePayment } from '../../../src/services/stripe.service'

beforeEach(() => {
  mockRetrieve.mockReset()
  mockPay.mockReset().mockResolvedValue({ id: 'in_1', status: 'paid', amount_paid: 100 })
  process.env.STRIPE_SECRET_KEY = 'sk_test_x'
})

describe('una factura de OTRO negocio no se entrega ni se cobra', () => {
  it('🔴 descarga: la factura de otro cliente responde 404 y no entrega el PDF', async () => {
    mockRetrieve.mockResolvedValue({ id: 'in_1', customer: 'cus_otro', invoice_pdf: 'https://pay.stripe.com/x.pdf' })

    await expect(getInvoicePdfUrl('in_1', 'cus_mio')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('🔴 reintento: la factura de otro cliente responde 404 y NO se cobra', async () => {
    mockRetrieve.mockResolvedValue({ id: 'in_1', customer: 'cus_otro', status: 'open' })

    await expect(retryInvoicePayment('in_1', 'cus_mio')).rejects.toMatchObject({ statusCode: 404 })
    expect(mockPay).not.toHaveBeenCalled()
  })

  it('la factura propia se descarga (cliente como id)', async () => {
    mockRetrieve.mockResolvedValue({ id: 'in_1', customer: 'cus_mio', invoice_pdf: 'https://pay.stripe.com/x.pdf' })

    await expect(getInvoicePdfUrl('in_1', 'cus_mio')).resolves.toBe('https://pay.stripe.com/x.pdf')
  })

  it('la factura propia se reintenta (cliente expandido como objeto)', async () => {
    mockRetrieve.mockResolvedValue({ id: 'in_1', customer: { id: 'cus_mio' }, status: 'open' })

    await expect(retryInvoicePayment('in_1', 'cus_mio')).resolves.toMatchObject({ status: 'paid' })
    expect(mockPay).toHaveBeenCalledWith('in_1')
  })
})
