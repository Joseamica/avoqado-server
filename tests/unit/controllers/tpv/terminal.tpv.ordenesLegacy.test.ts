/**
 * «Órdenes» de la TPV es legacy (founder, 25-sep, 20-oct y 20-nov, D34): «para ordering se usa Mesas y Cobrar».
 *
 * El SERVIDOR la apaga SIEMPRE en el armado de ajustes, aunque la terminal la tenga guardada prendida: así también la pierden
 * las TPV viejas, que no se actualizan pronto. El resto de los botones del inicio no cambia.
 */
import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { getTerminalConfig } from '@/controllers/tpv/terminal.tpv.controller'

// Same mock set as terminal.tpv.planInfo.test.ts — isolate tpvSettings assembly.
jest.mock('@/lib/providerDeviceCompatibility', () => ({
  isProviderCompatibleWithBrand: jest.fn().mockReturnValue(true),
}))

jest.mock('@/services/superadmin/merchantAccount.service', () => ({
  decryptCredentials: jest.fn(),
}))

jest.mock('@/services/superadmin/angelpayUserAccount.service', () => ({
  getAngelPayUserAccountForTerminal: jest.fn().mockResolvedValue(null),
  getAngelPayUserAccountsForTerminal: jest.fn().mockResolvedValue([]),
}))

jest.mock('@/services/organization-payment-config.service', () => ({
  getEffectivePaymentConfig: jest.fn().mockResolvedValue(null),
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const venueId = 'venue-123'
const serialNumber = 'SN-PAX-1'

const paxTerminal = {
  id: 'term-1',
  serialNumber,
  brand: 'PAX',
  model: 'A910S',
  status: 'ACTIVE',
  venueId,
  assignedMerchantIds: [],
  config: {},
  venue: { id: venueId, name: 'V', type: 'RESTAURANT', timezone: 'America/Mexico_City' },
}

function makeRes(): Response & { __status: number; __body: any } {
  const res: any = { __status: 0, __body: null }
  res.status = jest.fn((code: number) => {
    res.__status = code
    return res
  })
  res.json = jest.fn((body: any) => {
    res.__body = body
    return res
  })
  return res
}

const makeReq = () => ({ params: { serialNumber } }) as unknown as Request

describe('GET /tpv/terminals/:serialNumber/config — «Órdenes» siempre apagada (D34)', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(paxTerminal)
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
  })

  async function ajustes(): Promise<Record<string, unknown>> {
    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getTerminalConfig(makeReq(), res, next)
    expect(next).not.toHaveBeenCalled()
    return res.__body.data.tpvSettings
  }

  it('una terminal que la tiene guardada PRENDIDA (y sin Cobrar ni Mesas) recibe showOrderManagement=false', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      ...paxTerminal,
      config: { settings: { showOrderManagement: true, showCheckout: false, restaurantModeEnabled: false } },
    })
    const s = await ajustes()
    expect(s.showOrderManagement).toBe(false)
  })

  it('sin ajuste guardado también sale apagada (el campo SIEMPRE viaja: la TPV lo toma como prendido si falta)', async () => {
    const s = await ajustes()
    expect(s).toHaveProperty('showOrderManagement', false)
  })

  it('regresión: Cobrar, Pago rápido y Mesas guardados se respetan tal cual', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      ...paxTerminal,
      config: { settings: { showOrderManagement: true, showCheckout: false, showQuickPayment: false, restaurantModeEnabled: true } },
    })
    const s = await ajustes()
    expect(s.showCheckout).toBe(false)
    expect(s.showQuickPayment).toBe(false)
    expect(s.restaurantModeEnabled).toBe(true)
  })

  it('regresión: sin ajustes guardados, Cobrar y Pago rápido siguen prendidos por default', async () => {
    const s = await ajustes()
    expect(s.showCheckout).toBe(true)
    expect(s.showQuickPayment).toBe(true)
  })
})
