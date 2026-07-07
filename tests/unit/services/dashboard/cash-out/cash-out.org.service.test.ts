/**
 * Unit tests (mock-first) — cash-out ORG aggregation service.
 * Proves: listVenueIdsForOrg resolves the org's active venue ids (gated);
 * listWithdrawalsForOrg unions across those venue ids; generateOrgDispersionReport
 * aggregates REQUESTED withdrawals across the org's venues, totals net, and marks
 * them REPORTED atomically.
 */
jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venue: { findMany: jest.fn() },
    venueModule: { findFirst: jest.fn() },
    cashOutWithdrawal: { findMany: jest.fn() },
    staff: { findMany: jest.fn() },
    $transaction: jest.fn(),
  },
}))
jest.mock('@/services/modules/module.service', () => ({
  __esModule: true,
  MODULE_CODES: { SERIALIZED_INVENTORY: 'SERIALIZED_INVENTORY' },
  moduleService: { isModuleEnabled: jest.fn(), isModuleEnabledForOrganization: jest.fn() },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { moduleService } from '@/services/modules/module.service'
import { listVenueIdsForOrg, listWithdrawalsForOrg, generateOrgDispersionReport } from '@/services/dashboard/cash-out/cash-out.org.service'

const p = prisma as unknown as {
  venue: { findMany: jest.Mock }
  venueModule: { findFirst: jest.Mock }
  cashOutWithdrawal: { findMany: jest.Mock }
  staff: { findMany: jest.Mock }
  $transaction: jest.Mock
}

const mockModuleService = moduleService as unknown as {
  isModuleEnabled: jest.Mock
  isModuleEnabledForOrganization: jest.Mock
}

beforeEach(() => {
  jest.clearAllMocks()
  mockModuleService.isModuleEnabledForOrganization.mockResolvedValue(true)
})

describe('cash-out org service — listVenueIdsForOrg', () => {
  it('lists active venue ids for the org', async () => {
    p.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])

    const ids = await listVenueIdsForOrg('org1')

    expect(ids).toEqual(['v1', 'v2'])
    expect(p.venue.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { organizationId: 'org1', active: true }, select: { id: true } }),
    )
  })

  it('rejects when the org has cash-out disabled (no org module, no venue module)', async () => {
    mockModuleService.isModuleEnabledForOrganization.mockResolvedValue(false)
    p.venueModule.findFirst.mockResolvedValue(null)

    await expect(listVenueIdsForOrg('org1')).rejects.toThrow(/Cash Out/)
  })
})

describe('cash-out org service — listWithdrawalsForOrg', () => {
  it('returns [] when the org has no active venues', async () => {
    p.venue.findMany.mockResolvedValue([])

    const result = await listWithdrawalsForOrg('org1')

    expect(result).toEqual([])
    expect(p.cashOutWithdrawal.findMany).not.toHaveBeenCalled()
  })

  it('unions withdrawals across the org venue ids and enriches promoter + venue name', async () => {
    // First venue.findMany call resolves the org's venue ids; second resolves venue names.
    p.venue.findMany.mockResolvedValueOnce([{ id: 'v1' }, { id: 'v2' }]).mockResolvedValueOnce([
      { id: 'v1', name: 'Sucursal Centro' },
      { id: 'v2', name: 'Sucursal Norte' },
    ])
    p.cashOutWithdrawal.findMany.mockResolvedValue([
      { id: 'w1', folio: 'CO-1', staffId: 's1', venueId: 'v1', clabe: '0', netAmount: new Prisma.Decimal(10) },
    ])
    p.staff.findMany.mockResolvedValue([{ id: 's1', firstName: 'Ana', lastName: 'López' }])

    const result = await listWithdrawalsForOrg('org1')

    expect(p.cashOutWithdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: { in: ['v1', 'v2'] } }) }),
    )
    expect(result).toEqual([expect.objectContaining({ id: 'w1', promoterName: 'Ana López', venueName: 'Sucursal Centro' })])
  })
})

describe('cash-out org service — generateOrgDispersionReport', () => {
  it('aggregates dispersion across the org venues and totals net', async () => {
    p.venue.findMany.mockResolvedValue([{ id: 'v1' }, { id: 'v2' }])
    const tx = {
      cashOutWithdrawal: {
        findMany: jest.fn().mockResolvedValue([{ id: 'w1', folio: 'F1', staffId: 's1', clabe: '0', netAmount: new Prisma.Decimal(10) }]),
        updateMany: jest.fn(),
      },
      staff: { findMany: jest.fn().mockResolvedValue([{ id: 's1', firstName: 'A', lastName: 'B' }]) },
    }
    p.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))

    const rep = await generateOrgDispersionReport('org1', {}, { staffId: 'admin' })

    expect(tx.cashOutWithdrawal.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ venueId: { in: ['v1', 'v2'] }, status: 'REQUESTED' }) }),
    )
    expect(tx.cashOutWithdrawal.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: ['w1'] } }, data: expect.objectContaining({ status: 'REPORTED' }) }),
    )
    expect(rep.orgId).toBe('org1')
    expect(rep.count).toBe(1)
    expect(rep.totalNet).toBe('10')
    expect(rep.rows[0]).toMatchObject({ withdrawalId: 'w1', folio: 'F1', promoterName: 'A B', netAmount: '10' })
  })

  it('returns an empty report (no transaction work) when the org has no active venues', async () => {
    p.venue.findMany.mockResolvedValue([])

    const rep = await generateOrgDispersionReport('org1', {}, { staffId: 'admin' })

    expect(rep).toEqual({ orgId: 'org1', rows: [], totalNet: '0', count: 0 })
    expect(p.$transaction).not.toHaveBeenCalled()
  })

  it('returns an empty report (and marks nothing) when no withdrawals are REQUESTED', async () => {
    p.venue.findMany.mockResolvedValue([{ id: 'v1' }])
    const tx = {
      cashOutWithdrawal: { findMany: jest.fn().mockResolvedValue([]), updateMany: jest.fn() },
      staff: { findMany: jest.fn() },
    }
    p.$transaction.mockImplementation(async (fn: (t: typeof tx) => unknown) => fn(tx))

    const rep = await generateOrgDispersionReport('org1', {}, { staffId: 'admin' })

    expect(rep.count).toBe(0)
    expect(rep.rows).toEqual([])
    expect(tx.cashOutWithdrawal.updateMany).not.toHaveBeenCalled()
  })
})
