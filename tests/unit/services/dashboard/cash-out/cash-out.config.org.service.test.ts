/**
 * Unit tests (mock-first) — cash-out ORG-scoped config service.
 * Proves: the org-level isolation gate (org module OR any venue module) AND that
 * org-scoped rate/day rows are always written with venueId: null.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    organizationModule: { findFirst: jest.fn() },
    venueModule: { findFirst: jest.fn() },
    cashOutCommissionRate: { findMany: jest.fn() },
    cashOutScheduleDay: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn(), isModuleEnabledForOrganization: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import {
  assertCashOutEnabledForOrg,
  listCommissionRatesForOrg,
  replaceCommissionRatesForOrg,
  setActiveDaysForOrg,
} from '@/services/dashboard/cash-out/cash-out.config.service'

const p = prisma as unknown as {
  organizationModule: { findFirst: jest.Mock }
  venueModule: { findFirst: jest.Mock }
  cashOutCommissionRate: { findMany: jest.Mock }
  cashOutScheduleDay: { findMany: jest.Mock }
  $transaction: jest.Mock
}

const mockModuleService = moduleService as unknown as {
  isModuleEnabled: jest.Mock
  isModuleEnabledForOrganization: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
})

describe('cash-out config service — org-level isolation gate', () => {
  it('throws CashOutModuleDisabledError when module disabled for org', async () => {
    mockModuleService.isModuleEnabledForOrganization.mockResolvedValue(false)
    p.venueModule.findFirst.mockResolvedValue(null)
    await expect(assertCashOutEnabledForOrg('org1')).rejects.toThrow(/Cash Out/)
  })
})

describe('cash-out config service — listCommissionRatesForOrg', () => {
  it('lists only org-level active rates', async () => {
    mockModuleService.isModuleEnabledForOrganization.mockResolvedValue(true)
    p.cashOutCommissionRate.findMany.mockResolvedValue([{ id: 'r1' }])
    const rows = await listCommissionRatesForOrg('org1')
    expect(p.cashOutCommissionRate.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { orgId: 'org1', venueId: null, active: true } }),
    )
    expect(rows).toEqual([{ id: 'r1' }])
  })
})

describe('cash-out config service — replaceCommissionRatesForOrg', () => {
  it('replaces org rates atomically as org rows', async () => {
    mockModuleService.isModuleEnabledForOrganization.mockResolvedValue(true)
    const tx = { cashOutCommissionRate: { updateMany: jest.fn(), createMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) } }
    p.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
    await replaceCommissionRatesForOrg('org1', [{ saleType: 'LINEA_NUEVA', minCount: 1, maxCount: null, amount: 10 }], { staffId: 's1' })
    expect(tx.cashOutCommissionRate.updateMany).toHaveBeenCalledWith({
      where: { orgId: 'org1', venueId: null, active: true },
      data: { active: false },
    })
    expect(tx.cashOutCommissionRate.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ orgId: 'org1', venueId: null, saleType: 'LINEA_NUEVA' })] }),
    )
  })
})

describe('cash-out config service — setActiveDaysForOrg', () => {
  it('replaces org active-days as org rows', async () => {
    mockModuleService.isModuleEnabledForOrganization.mockResolvedValue(true)
    const tx = { cashOutScheduleDay: { deleteMany: jest.fn(), createMany: jest.fn() } }
    p.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))
    await setActiveDaysForOrg('org1', ['2026-07-06'], { staffId: 's1' })
    expect(tx.cashOutScheduleDay.deleteMany).toHaveBeenCalledWith({ where: { orgId: 'org1', venueId: null } })
    expect(tx.cashOutScheduleDay.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ orgId: 'org1', venueId: null })] }),
    )
  })
})
