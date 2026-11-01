/**
 * Los ajustes que lee el POS (`GET /mobile/venues/:venueId/gift-cards/settings`, 1b S1): lo de la 1a intacto, más qué sabe
 * hacer este servidor (`capacidades`) y si el negocio ya activó alguna tarjeta (`tieneTarjetas`).
 */
jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSettings.service'),
  getGiftCardSettings: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardSurface.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSurface.service'),
  estadoDeVentaDeTarjetas: jest.fn(),
  negocioHaActivadoTarjetas: jest.fn(),
}))

import type { Request, Response } from 'express'
import { getSettings } from '@/controllers/shared/giftCardSale.controller'
import { getGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import { estadoDeVentaDeTarjetas, negocioHaActivadoTarjetas } from '@/services/giftCards/giftCardSurface.service'

const m = (f: unknown) => f as jest.Mock

const AJUSTES = {
  enabled: true,
  suggestedAmounts: [500, 1000, 2000],
  minAmount: 100,
  maxAmount: 10000,
  validityMonths: 24,
  termsVersion: '2026-10-14',
  topePorOperacion: 70000,
  llavesConfiguradas: true,
  updatedAt: null,
}
const VENTA = { sellable: true, code: null, message: null, howToEnable: null, operationLimit: 70000 }

async function pedir() {
  const res = { json: jest.fn() } as unknown as Response
  await getSettings({ params: { venueId: 'v1' } } as unknown as Request, res)
  return m(res.json).mock.calls[0][0]
}

beforeEach(() => {
  jest.clearAllMocks()
  m(getGiftCardSettings).mockResolvedValue(AJUSTES)
  m(estadoDeVentaDeTarjetas).mockResolvedValue(VENTA)
})

describe('getSettings', () => {
  it.each([true, false])('los ajustes del POS dicen sus capacidades y si el negocio activó tarjetas (%s)', async activo => {
    m(negocioHaActivadoTarjetas).mockResolvedValue(activo)
    const body = await pedir()
    expect(negocioHaActivadoTarjetas).toHaveBeenCalledWith('v1')
    expect(body.success).toBe(true)
    expect(body.data.capacidades).toEqual(['ENTREGA', 'PAGE_TOKEN', 'TELEFONO'])
    expect(body.data.tieneTarjetas).toBe(activo)
    // Lo de la 1a no cambia.
    expect(body.data).toMatchObject({ ...AJUSTES, sale: VENTA })
  })
})
