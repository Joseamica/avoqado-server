import type { Request, Response } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'

jest.mock('@/services/access/basePlan.service', () => ({ getVenuePlanInfo: jest.fn(async () => undefined) }))
jest.mock('@/services/dashboard/receiptLayout/devicePayload.service', () => ({
  ...jest.requireActual('@/services/dashboard/receiptLayout/devicePayload.service'),
  getDeviceReceiptPayloadWithStatus: jest.fn(async () => ({ payload: {}, status: 'ok' })),
}))

beforeEach(() => {
  prismaMock.terminal.findMany.mockResolvedValue([])
  prismaMock.venueSettings.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
})

async function settings() {
  const res = { json: jest.fn() } as unknown as Response
  const next = jest.fn()
  await getVenueTpvSettings({ params: { venueId: 'c123456789012345678901234' }, headers: {} } as unknown as Request, res, next)
  expect(next).not.toHaveBeenCalled()
  return (res.json as jest.Mock).mock.calls[0][0]
}

describe('tpvSettings exchangesEnabled', () => {
  it.each([
    ['CLOTHING', null, true],
    ['RESTAURANT', null, false],
    ['CLOTHING', false, false],
    ['RESTAURANT', true, true],
  ])('resolves %s with setting %s as %s', async (type, exchangesEnabled, expected) => {
    prismaMock.venue.findUnique.mockResolvedValue({ type })
    prismaMock.venueSettings.findUnique.mockResolvedValue({ exchangesEnabled })
    expect((await settings()).data.exchangesEnabled).toBe(expected)
  })

  it('a failed venue lookup yields exchangesEnabled false and still returns the settings', async () => {
    prismaMock.venue.findUnique.mockRejectedValue(new Error('lookup unavailable'))
    expect(await settings()).toMatchObject({
      success: true,
      data: { exchangesEnabled: false, terminals: [], settings: null, managerPinOverrideEnabled: false },
    })
  })

  it('keeps an explicit setting when the venue type is unavailable', async () => {
    prismaMock.venue.findUnique.mockRejectedValue(new Error('lookup unavailable'))
    prismaMock.venueSettings.findUnique.mockResolvedValue({ exchangesEnabled: true, managerPinOverrideEnabled: true })
    expect((await settings()).data).toMatchObject({ exchangesEnabled: true, managerPinOverrideEnabled: true })
  })
})
