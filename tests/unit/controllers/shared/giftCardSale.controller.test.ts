/**
 * Los ajustes que lee el POS (`GET /mobile/venues/:venueId/gift-cards/settings`, 1b S1): lo de la 1a intacto, más qué sabe
 * hacer este servidor (`capacidades`) y si el negocio ya activó alguna tarjeta (`tieneTarjetas`).
 */
jest.mock('@/services/giftCards/giftCardSettings.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSettings.service'),
  getGiftCardSettings: jest.fn(),
  updateGiftCardSettings: jest.fn(),
}))
jest.mock('@/services/giftCards/giftCardSurface.service', () => ({
  ...jest.requireActual('@/services/giftCards/giftCardSurface.service'),
  estadoDeVentaDeTarjetas: jest.fn(),
  estadoParaPrender: jest.fn(),
  negocioHaActivadoTarjetas: jest.fn(),
}))

import type { Request, Response } from 'express'
import { getSettings, turnOn } from '@/controllers/shared/giftCardSale.controller'
import { getGiftCardSettings, updateGiftCardSettings } from '@/services/giftCards/giftCardSettings.service'
import { estadoDeVentaDeTarjetas, estadoParaPrender, negocioHaActivadoTarjetas } from '@/services/giftCards/giftCardSurface.service'

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

describe('getSettings: ¿se pueden prender?', () => {
  const PUEDE = { allowed: true, code: null, message: null, howToEnable: null }

  it('apagadas, trae si se pueden prender: `sale` sólo dice que están apagadas', async () => {
    m(getGiftCardSettings).mockResolvedValue({ ...AJUSTES, enabled: false })
    m(estadoParaPrender).mockResolvedValue(PUEDE)
    expect((await pedir()).data.prender).toEqual(PUEDE)
  })

  it('prendidas, no consulta nada de más y va en null', async () => {
    expect((await pedir()).data.prender).toBeNull()
    expect(estadoParaPrender).not.toHaveBeenCalled()
  })

  // Codex r2: es un campo de más. Si su consulta falla, abrir la hoja no se cae para quien sólo iba a consultar un saldo.
  it('🔴 si falla la consulta de prender, la lectura sigue: prender va en null y lo demás intacto', async () => {
    m(getGiftCardSettings).mockResolvedValue({ ...AJUSTES, enabled: false })
    m(estadoParaPrender).mockRejectedValue(new Error('base caída'))
    m(negocioHaActivadoTarjetas).mockResolvedValue(true)
    const body = await pedir()
    expect(body.success).toBe(true)
    expect(body.data).toMatchObject({
      enabled: false,
      sale: VENTA,
      capacidades: ['ENTREGA', 'PAGE_TOKEN', 'TELEFONO'],
      tieneTarjetas: true,
      prender: null,
    })
  })
})

describe('turnOn (prender desde el POS)', () => {
  async function prender() {
    const res = { json: jest.fn() } as unknown as Response
    const req = { params: { venueId: 'v1' }, body: { aceptaTerminos: true, enabled: false, minAmount: 1 }, authContext: { userId: 's1' } }
    await turnOn(req as unknown as Request, res)
    return m(res.json).mock.calls[0][0]
  }

  it('prende con los términos aceptados, a nombre de quien tocó, y responde igual que el GET', async () => {
    m(negocioHaActivadoTarjetas).mockResolvedValue(false)
    const body = await prender()
    expect(m(updateGiftCardSettings).mock.calls).toEqual([['v1', { enabled: true, aceptaTerminos: true }, 's1']])
    expect(body).toEqual(await pedir())
    expect(body.data.enabled).toBe(true)
  })

  it('si el servicio rechaza, no responde éxito: el error sigue su camino', async () => {
    m(updateGiftCardSettings).mockRejectedValue(new Error('sin llaves'))
    const res = { json: jest.fn() } as unknown as Response
    const req = { params: { venueId: 'v1' }, body: { aceptaTerminos: true }, authContext: { userId: 's1' } }
    await expect(turnOn(req as unknown as Request, res)).rejects.toThrow('sin llaves')
    expect(res.json).not.toHaveBeenCalled()
  })
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
