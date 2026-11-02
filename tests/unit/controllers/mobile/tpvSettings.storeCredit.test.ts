import type { Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

jest.mock('@/services/access/basePlan.service', () => ({ getVenuePlanInfo: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/receiptLayout/devicePayload.service', () => ({
  ...jest.requireActual('@/services/dashboard/receiptLayout/devicePayload.service'),
  getDeviceReceiptPayloadWithStatus: jest.fn(async () => ({ payload: {}, status: 'ok' })),
}))

const LLAVE = 'c'.repeat(64)
const guardadas = { code: process.env.GIFT_CARD_CODE_KEY, hmac: process.env.GIFT_CARD_HMAC_KEY }

beforeEach(() => {
  prismaMock.terminal.findMany.mockResolvedValue([])
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
})
afterEach(() => {
  if (guardadas.code === undefined) delete process.env.GIFT_CARD_CODE_KEY
  else process.env.GIFT_CARD_CODE_KEY = guardadas.code
  if (guardadas.hmac === undefined) delete process.env.GIFT_CARD_HMAC_KEY
  else process.env.GIFT_CARD_HMAC_KEY = guardadas.hmac
})

async function settings() {
  const res = { json: jest.fn() } as unknown as Response
  const next = jest.fn()
  await getVenueTpvSettings({ params: { venueId: 'c123456789012345678901234' }, headers: {} } as unknown as Request, res, next)
  expect(next).not.toHaveBeenCalled()
  return (res.json as jest.Mock).mock.calls[0][0]
}

describe('tpvSettings: saldo a favor (campos nuevos y opcionales para el POS)', () => {
  it('trae storeCreditOnly del ajuste y storeCreditAvailable verdadero con las dos llaves', async () => {
    process.env.GIFT_CARD_CODE_KEY = LLAVE
    process.env.GIFT_CARD_HMAC_KEY = LLAVE
    prismaMock.venueSettings.findUnique.mockResolvedValue({ storeCreditOnly: true })
    expect((await settings()).data).toMatchObject({ storeCreditOnly: true, storeCreditAvailable: true })
    expect(prismaMock.venueSettings.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ select: expect.objectContaining({ storeCreditOnly: true }) }),
    )
  })

  it('🔴 D-1: prendido pero SIN llaves, la app recibe el valor EFECTIVO (false): no filtra opciones por un saldo que no se puede dar', async () => {
    delete process.env.GIFT_CARD_CODE_KEY
    delete process.env.GIFT_CARD_HMAC_KEY
    prismaMock.venueSettings.findUnique.mockResolvedValue({ storeCreditOnly: true })
    expect((await settings()).data).toMatchObject({ storeCreditOnly: false, storeCreditAvailable: false })
  })

  it('sin fila de ajustes y sin llaves: storeCreditOnly false y storeCreditAvailable false (nada se rompe)', async () => {
    delete process.env.GIFT_CARD_CODE_KEY
    delete process.env.GIFT_CARD_HMAC_KEY
    expect((await settings()).data).toMatchObject({ storeCreditOnly: false, storeCreditAvailable: false })
  })
})
