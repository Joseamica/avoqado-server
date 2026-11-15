/**
 * Terminal TPV controller — «Foto de Entrada» del negocio llega a la TPV (encargo b0c1a1, 15-nov).
 *
 * El interruptor del negocio (VenueSettings.requireClockInPhoto) se suma al de cada terminal (Terminal.config): prendido
 * en el negocio, toda terminal pide la selfie; apagado, cada terminal sigue como esté. Así la TPV publicada lo obedece sin
 * recompilarse y PlayTelecom (que lo prende por terminal) no cambia.
 */
import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { getTerminalConfig, updateTpvSettings } from '@/controllers/tpv/terminal.tpv.controller'

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

async function fotoDeEntrada(): Promise<boolean> {
  const res = makeRes()
  const next = jest.fn() as NextFunction
  await getTerminalConfig(makeReq(), res, next)
  expect(next).not.toHaveBeenCalled()
  expect(res.__status).toBe(200)
  return res.__body.data.tpvSettings.requireClockInPhoto
}

describe('GET /tpv/terminals/:serialNumber/config — requireClockInPhoto', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(paxTerminal)
    prismaMock.venueFeature.findMany.mockResolvedValue([])
    prismaMock.venue.findUnique.mockResolvedValue({ seatCapExempt: false, status: 'ACTIVE' })
  })

  it('prendida en el negocio ⇒ la terminal la pide aunque su ajuste propio esté apagado', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, requireClockInPhoto: true })
    expect(await fotoDeEntrada()).toBe(true)
  })

  it('regresión PlayTelecom: apagada en el negocio, la terminal que la tiene prendida sigue pidiéndola', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({ ...paxTerminal, config: { settings: { requireClockInPhoto: true } } })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, requireClockInPhoto: false })
    expect(await fotoDeEntrada()).toBe(true)
  })

  it('regresión: apagada en los dos lados (o sin fila de ajustes) ⇒ no la pide', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true, requireClockInPhoto: false })
    expect(await fotoDeEntrada()).toBe(false)
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    expect(await fotoDeEntrada()).toBe(false)
  })
})

// Codex r1 #1: la TPV manda TODOS sus ajustes al guardar cualquiera; si el negocio la tenía prendida, el `true` que la
// terminal recibió heredado no se puede quedar guardado como suyo (al apagarla en el negocio seguiría pidiendo foto).
describe('PUT /tpv/terminals/:serialNumber/settings — la foto heredada del negocio no se pega a la terminal', () => {
  const deviceTerminal = {
    id: 'term-1',
    config: { settings: { requireClockInPhoto: false } },
    configOverrides: null as any,
    venueId,
    venue: { organizationId: null },
  }
  const makePutReq = (body: Record<string, any>) =>
    ({ params: { serialNumber }, body, authContext: { userId: 'staff-1', venueId, role: 'MANAGER' } }) as unknown as Request
  const guardado = () => (prismaMock.terminal.update.mock.calls[0][0] as any).data.config.settings

  beforeEach(() => {
    jest.clearAllMocks()
    prismaMock.terminal.update.mockResolvedValue({})
    prismaMock.terminal.findFirst.mockResolvedValue(deviceTerminal)
  })

  it('negocio prendido: el `true` que devuelve la terminal no reemplaza su ajuste propio (apagado)', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ requireClockInPhoto: true })
    const res = makeRes()
    await updateTpvSettings(makePutReq({ showTipScreen: false, requireClockInPhoto: true }), res, jest.fn() as NextFunction)
    expect(res.__status).toBe(200)
    expect(guardado().requireClockInPhoto).toBe(false)
    expect(guardado().showTipScreen).toBe(false)
  })

  it('regresión PlayTelecom: negocio apagado, la terminal sí puede cambiar su propia foto', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ requireClockInPhoto: false })
    const res = makeRes()
    await updateTpvSettings(makePutReq({ requireClockInPhoto: true }), res, jest.fn() as NextFunction)
    expect(res.__status).toBe(200)
    expect(guardado().requireClockInPhoto).toBe(true)
  })
})
