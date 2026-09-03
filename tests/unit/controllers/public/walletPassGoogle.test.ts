/**
 * La entrega de la tarjeta de Google: un 302 a la pantalla de «Guardar» de Google.
 *
 * 🔴 Espejo exacto del aislamiento de Apple: el cliente TIENE que pertenecer a ese
 * venue. El slug es público — sin ese filtro, el slug de un negocio más un customerId
 * ajeno emitiría una tarjeta con la marca equivocada y filtraría que ese cliente existe.
 */
jest.mock('@/services/wallet/googleWalletPass.service', () => ({
  buildSaveJwt: jest.fn(),
}))

import { downloadGooglePass } from '@/controllers/public/walletPass.public.controller'
import { buildSaveJwt } from '@/services/wallet/googleWalletPass.service'
import { prismaMock } from '../../../__helpers__/setup'

const jwtMock = buildSaveJwt as jest.Mock

function res() {
  return { redirect: jest.fn(), setHeader: jest.fn(), send: jest.fn() } as any
}

describe('GET /public/venues/:venueSlug/wallet/google/:customerId', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.venue.findFirst.mockResolvedValue({ id: 'v1', name: 'Testarudo Café' } as any)
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'c1' } as any)
    jwtMock.mockResolvedValue('JWT-FALSO')
  })

  it('manda al cliente a la pantalla de guardar de Google', async () => {
    const r = res()
    await downloadGooglePass({ params: { venueSlug: 'testarudo', customerId: 'c1' } } as any, r, jest.fn())
    expect(r.redirect).toHaveBeenCalledWith(302, 'https://pay.google.com/gp/v/save/JWT-FALSO')
  })

  it('🔴 un cliente de OTRO negocio no recibe tarjeta', async () => {
    prismaMock.customer.findFirst.mockResolvedValue(null)
    const next = jest.fn()
    await downloadGooglePass({ params: { venueSlug: 'testarudo', customerId: 'ajeno' } } as any, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
    expect(jwtMock).not.toHaveBeenCalled()
  })

  it('el filtro del cliente va por venueId, no sólo por id', async () => {
    await downloadGooglePass({ params: { venueSlug: 'testarudo', customerId: 'c1' } } as any, res(), jest.fn())
    expect(prismaMock.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ id: 'c1', venueId: 'v1' }) }),
    )
  })

  it('negocio inexistente → 404', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    const next = jest.fn()
    await downloadGooglePass({ params: { venueSlug: 'no-existe', customerId: 'c1' } } as any, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
  })

  it('🔴 sin Google configurado responde 404 entendible, no un 500', async () => {
    jwtMock.mockResolvedValue(null)
    const next = jest.fn()
    await downloadGooglePass({ params: { venueSlug: 'testarudo', customerId: 'c1' } } as any, res(), next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 404 }))
  })
})
