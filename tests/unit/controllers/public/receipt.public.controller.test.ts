jest.mock('@/services/tpv/digitalReceipt.tpv.service', () => ({
  __esModule: true,
  ...jest.requireActual('@/services/tpv/digitalReceipt.tpv.service'),
  getDigitalReceiptByAccessKey: jest.fn(),
}))

import { getPublicReceipt } from '@/controllers/public/receipt.public.controller'
import { getDigitalReceiptByAccessKey } from '@/services/tpv/digitalReceipt.tpv.service'

/**
 * D21: la página HTML vieja del recibo (los QR impresos por ANDROID e iOS entre el 22-jul y el 4-ago-2026) ya no se pinta:
 * el navegador se va a la página nueva del DASHBOARD. La cara JSON, de la que esa página saca los datos, no cambia.
 */
describe('GET /public/receipt/:accessKey', () => {
  const recibo = { id: 'r1', accessKey: 'k1', paymentId: 'p1', status: 'SENT', dataSnapshot: { payment: { id: 'p1' } } }
  const frontendOriginal = process.env.FRONTEND_URL

  const pedir = async (accept: string | undefined) => {
    const res: any = { redirect: jest.fn(), json: jest.fn(), send: jest.fn(), setHeader: jest.fn(), status: jest.fn(() => res) }
    const next = jest.fn()
    await getPublicReceipt({ params: { accessKey: 'k1' }, get: () => accept } as any, res, next)
    return { res, next }
  }

  beforeEach(() => {
    process.env.FRONTEND_URL = 'https://panel.test'
    ;(getDigitalReceiptByAccessKey as jest.Mock).mockReset().mockResolvedValue(recibo)
  })
  afterAll(() => {
    process.env.FRONTEND_URL = frontendOriginal
  })

  it('🔴 el navegador (QR escaneado) se va a la página nueva del DASHBOARD y ya no recibe el HTML viejo', async () => {
    const { res, next } = await pedir('text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')

    expect(res.redirect).toHaveBeenCalledWith(302, 'https://panel.test/receipts/public/k1')
    expect(res.send).not.toHaveBeenCalled()
    expect(res.json).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  it('sin Accept (antes caía al HTML viejo) también se va a la página nueva', async () => {
    const { res } = await pedir(undefined)

    expect(res.redirect).toHaveBeenCalledWith(302, 'https://panel.test/receipts/public/k1')
  })

  it.each(['application/json', 'application/json, text/plain, */*', '*/*'])(
    'la página nueva (Accept «%s») sigue recibiendo el JSON de siempre',
    async accept => {
      const { res } = await pedir(accept)

      expect(res.redirect).not.toHaveBeenCalled()
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: expect.objectContaining({ id: 'r1', accessKey: 'k1', paymentId: 'p1', status: 'SENT', dataSnapshot: recibo.dataSnapshot }),
      })
    },
  )

  it('un recibo que no existe sigue dando «no encontrado», sin redirigir', async () => {
    ;(getDigitalReceiptByAccessKey as jest.Mock).mockResolvedValue(null)
    const { res, next } = await pedir('text/html')

    expect(res.redirect).not.toHaveBeenCalled()
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
  })
})
