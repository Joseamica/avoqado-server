import type { NextFunction, Request, Response } from 'express'

import { prismaMock } from '@tests/__helpers__/setup'
import { getTerminalConfig, updateTpvSettings } from '@/controllers/tpv/terminal.tpv.controller'
import { isCashReconciliationEnabled } from '@/services/access/cashReconciliationAccess.service'

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

jest.mock('@/services/access/basePlan.service', () => ({
  getVenuePlanInfo: jest.fn().mockResolvedValue({ tier: 'PRO', grandfathered: false, exempt: false }),
}))

jest.mock('@/services/access/cashReconciliationAccess.service', () => ({
  isCashReconciliationEnabled: jest.fn(),
}))

jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  moduleService: { isModuleEnabled: jest.fn().mockResolvedValue(false) },
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
}))

const venueId = 'venue-cash-reconciliation'
const serialNumber = 'SN-CASH-1'

const terminal = {
  id: 'terminal-cash-1',
  serialNumber,
  brand: 'PAX',
  model: 'A910S',
  status: 'ACTIVE',
  venueId,
  assignedMerchantIds: [],
  config: { settings: {} },
  configOverrides: null,
  venue: {
    id: venueId,
    name: 'Venue cash',
    type: 'RESTAURANT',
    timezone: 'America/Mexico_City',
    organizationId: null,
  },
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

describe('terminal cash reconciliation contract', () => {
  beforeEach(() => {
    prismaMock.terminal.findFirst.mockResolvedValue(terminal)
    prismaMock.terminal.update.mockResolvedValue({})
    prismaMock.venueSettings.findUnique.mockResolvedValue({ enableShifts: true })
    ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValue(false)
  })

  it('returns the effective flag at data root, outside mutable tpvSettings', async () => {
    ;(isCashReconciliationEnabled as jest.Mock).mockResolvedValue(true)
    prismaMock.terminal.findFirst.mockResolvedValue({
      ...terminal,
      config: { settings: { cashReconciliationEnabled: false } },
      configOverrides: { cashReconciliationEnabled: false },
    })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await getTerminalConfig({ params: { serialNumber } } as unknown as Request, res, next)

    expect(next).not.toHaveBeenCalled()
    expect(isCashReconciliationEnabled).toHaveBeenCalledWith(venueId)
    expect(res.__status).toBe(200)
    expect(res.__body.data.cashReconciliationEnabled).toBe(true)
    expect(res.__body.data.tpvSettings).not.toHaveProperty('cashReconciliationEnabled')
  })

  it('returns false without changing any existing terminal-config fields when access is disabled', async () => {
    const res = makeRes()
    await getTerminalConfig(
      { params: { serialNumber } } as unknown as Request,
      res,
      jest.fn() as unknown as NextFunction,
    )

    expect(res.__status).toBe(200)
    expect(res.__body.data.cashReconciliationEnabled).toBe(false)
    expect(res.__body.data.terminal.serialNumber).toBe(serialNumber)
    expect(res.__body.data.merchantAccounts).toEqual([])
    expect(res.__body.data.tpvSettings.enableShifts).toBe(true)
  })

  it('never persists a device-provided or stale cash-reconciliation flag in terminal JSON', async () => {
    prismaMock.terminal.findFirst.mockResolvedValue({
      ...terminal,
      config: { settings: { showTipScreen: true, cashReconciliationEnabled: true } },
      configOverrides: { showTipScreen: true, cashReconciliationEnabled: true },
    })

    const res = makeRes()
    const next = jest.fn() as NextFunction
    await updateTpvSettings(
      {
        params: { serialNumber },
        body: { showTipScreen: false, cashReconciliationEnabled: true },
      } as unknown as Request,
      res,
      next,
    )

    expect(next).not.toHaveBeenCalled()
    expect(res.__status).toBe(200)
    const write = prismaMock.terminal.update.mock.calls[0][0].data
    expect(write.config.settings).not.toHaveProperty('cashReconciliationEnabled')
    expect(write.configOverrides).not.toHaveProperty('cashReconciliationEnabled')
    expect(res.__body.data).not.toHaveProperty('cashReconciliationEnabled')
  })
})
