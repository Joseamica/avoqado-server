/**
 * La TPV NO hereda la «Foto de entrada» del negocio (encargo b0c1a1, 15-nov; Codex r1 #1 y r2 #1-#2).
 *
 * VenueSettings.requireClockInPhoto manda en el POS (ANDROID, WINDOWS, iOS). La TPV devuelve TODOS sus ajustes al guardar
 * uno, así que un valor heredado se le pegaba como propio o la apagaba; por eso sigue sólo con su ajuste por terminal.
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

describe('GET /tpv/terminals/:serialNumber/config — requireClockInPhoto es sólo de la terminal', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(paxTerminal)
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
  })

  async function fotoDeEntrada(): Promise<boolean> {
    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getTerminalConfig(makeReq(), res, next)
    expect(next).not.toHaveBeenCalled()
    return res.__body.data.tpvSettings.requireClockInPhoto
  }

  it('el interruptor del negocio prendido NO prende la foto en una terminal que la tiene apagada', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, requireClockInPhoto: true })
    expect(await fotoDeEntrada()).toBe(false)
  })

  it('regresión PlayTelecom: la terminal que la tiene prendida la sigue pidiendo', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...paxTerminal, config: { settings: { requireClockInPhoto: true } } })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
    expect(await fotoDeEntrada()).toBe(true)
  })
})
