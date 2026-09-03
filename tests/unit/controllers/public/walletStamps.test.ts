/**
 * La franja de sellos que Google descarga para pintarla en la tarjeta.
 *
 * 🔴 Pública porque la piden los servidores de Google, que no tienen sesión. El
 * aislamiento no lo da un token: la imagen no lleva NINGÚN dato del cliente — sólo
 * sellos dibujados— y la llave de la URL es el `serialNumber`, un uuid aleatorio que
 * no sirve para sellar a nadie. El `qrToken` jamás viaja aquí.
 */
jest.mock('@/services/wallet/stampStripPng', () => ({
  stampStripPng: jest.fn(() => Buffer.from('PNG-FALSO')),
}))
jest.mock('@/services/wallet/remotePng', () => ({
  fetchDecodedPng: jest.fn().mockResolvedValue(null),
}))

import { getStampStrip } from '@/controllers/public/walletStamps.public.controller'
import { stampStripPng } from '@/services/wallet/stampStripPng'
import { prismaMock } from '../../../__helpers__/setup'

function res() {
  return { setHeader: jest.fn(), send: jest.fn(), status: jest.fn().mockReturnThis() } as any
}

const PASE = { id: 'wp-1', venueId: 'v1', customerId: 'c1', serialNumber: 'AVQ-1111', revision: 3 }

describe('GET /public/wallet/stamps/:serialNumber/:revision.png', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.walletCardDesign.findUnique.mockResolvedValue(null)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ stampsRequired: 7, stampRewardLabel: 'Un café gratis' })
    prismaMock.stampCard.findFirst.mockResolvedValue({ stampsEarned: 3, stampsRequired: 7 })
    prismaMock.stampReward.count.mockResolvedValue(0)
  })

  it('devuelve el PNG de la franja con los sellos del cliente', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(PASE as any)
    const r = res()
    await getStampStrip({ params: { serialNumber: 'AVQ-1111', revision: '3' } } as any, r, jest.fn())

    expect(r.setHeader).toHaveBeenCalledWith('Content-Type', 'image/png')
    expect(r.send).toHaveBeenCalledWith(Buffer.from('PNG-FALSO'))
    expect(stampStripPng).toHaveBeenCalledWith(expect.objectContaining({ earned: 3, required: 7 }))
  })

  it('🔴 la respuesta NO lleva el qrToken ni nada del cliente', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(PASE as any)
    const r = res()
    await getStampStrip({ params: { serialNumber: 'AVQ-1111', revision: '3' } } as any, r, jest.fn())

    const cabeceras = JSON.stringify(r.setHeader.mock.calls)
    expect(cabeceras).not.toContain('qrToken')
    expect(cabeceras).not.toContain('c1')
  })

  it('un serial que no existe pasa el error al manejador, no revienta', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    const next = jest.fn()
    await getStampStrip({ params: { serialNumber: 'AVQ-NO', revision: '1' } } as any, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
  })

  it('🔴 el Cache-Control es corto, no "immutable": el endpoint sirve el estado ACTUAL, no un retrato de la revisión pedida', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(PASE as any)
    const r = res()
    await getStampStrip({ params: { serialNumber: 'AVQ-1111', revision: '3' } } as any, r, jest.fn())
    expect(r.setHeader).toHaveBeenCalledWith('Cache-Control', 'public, max-age=300')
  })

  it('🔴 sirve la franja aunque la revisión pedida sea vieja: Google puede pedir una URL cacheada', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(PASE as any)
    const r = res()
    await getStampStrip({ params: { serialNumber: 'AVQ-1111', revision: '1' } } as any, r, jest.fn())
    expect(r.send).toHaveBeenCalled()
  })

  it('un pase desactivado no sirve imagen', async () => {
    prismaMock.walletPass.findFirst.mockResolvedValue(null)
    const next = jest.fn()
    await getStampStrip({ params: { serialNumber: 'AVQ-1111', revision: '3' } } as any, res(), next)
    expect(prismaMock.walletPass.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ active: true }) }),
    )
    expect(next).toHaveBeenCalled()
  })
})
