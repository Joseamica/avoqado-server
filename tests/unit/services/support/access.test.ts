jest.mock('@/services/access/access.service', () => ({ getUserAccess: jest.fn() }))
jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(), venueHasCommissionsAccess: jest.fn() }))
jest.mock('@/services/modules/module.service', () => ({ moduleService: { isModuleEnabled: jest.fn() } }))
jest.mock('@/mcp/scope', () => ({ isActiveSuperAdmin: jest.fn().mockResolvedValue(false) }))
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { getUserAccess } from '@/services/access/access.service'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { resolveHelpAccess, listSupportVenues } from '@/services/support/access.service'

const db = prisma as any
const context = { staffId: 'staff', orgId: 'org', venueId: 'venue' }
beforeEach(() => {
  db.staff.findUnique.mockResolvedValue({ active: true })
  db.staffOrganization.findUnique.mockResolvedValue({ isActive: true, leftAt: null })
  db.venue.findUnique.mockResolvedValue({ organizationId: 'org' })
  ;(getUserAccess as jest.Mock).mockResolvedValue({
    organizationId: 'org',
    corePermissions: ['menu:read'],
    whiteLabelEnabled: false,
    featureAccess: {},
  })
  ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
})
it('public help does not manufacture account access; a paid feature is not granted by getUserAccess', async () => {
  expect(await resolveHelpAccess(null)).toBeNull()
  const access = await resolveHelpAccess(context, [{ featureCode: 'CFDI', gateKind: 'FEATURE' }])
  expect(access?.permissions).toEqual(['menu:read'])
  expect(access?.features.CFDI.included).toBe(false)
})
it('removal from the organization wins even if the venue assignment remains; foreign venue is rejected', async () => {
  db.staffOrganization.findUnique.mockResolvedValueOnce({ isActive: false, leftAt: null })
  await expect(resolveHelpAccess(context)).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_REVOKED' })
  db.venue.findUnique.mockResolvedValueOnce({ organizationId: 'other' })
  await expect(resolveHelpAccess(context)).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_REVOKED' })
})
it('permission changes are re-read and change the fingerprint', async () => {
  const first = await resolveHelpAccess(context)
  ;(getUserAccess as jest.Mock).mockResolvedValueOnce({
    organizationId: 'org',
    corePermissions: [],
    whiteLabelEnabled: false,
    featureAccess: {},
  })
  const second = await resolveHelpAccess(context)
  expect(first?.fingerprint).not.toBe(second?.fingerprint)
})
it('venue discovery clamps to 100, counts independently and preserves stable order', async () => {
  db.venue.findMany.mockResolvedValue([])
  db.venue.count.mockResolvedValue(357)
  const result = await listSupportVenues('staff', { limit: 10000, search: 'local' })
  expect(result).toEqual({ items: [], total: 357, nextCursor: null })
  expect(db.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 101, orderBy: [{ name: 'asc' }, { id: 'asc' }] }))
})

it('core activation is independent of paid entitlement and participates in the delivery fingerprint', async () => {
  const gates = [{ activationKey: 'enableShifts' }]
  db.venueSettings.findUnique.mockResolvedValueOnce({ enableShifts: false })
  const off = await resolveHelpAccess(context, gates)
  db.venueSettings.findUnique.mockResolvedValueOnce({ enableShifts: true })
  const on = await resolveHelpAccess(context, gates)
  expect(off?.activations).toEqual({ enableShifts: false })
  expect(on?.activations).toEqual({ enableShifts: true })
  expect(off?.features).toEqual({})
  expect(off?.fingerprint).not.toBe(on?.fingerprint)
  expect(venueHasFeatureAccess).not.toHaveBeenCalled()
})
it('an undeclared or unreadable activation is unknown/disabled, never implicitly enabled', async () => {
  db.venueSettings.findUnique.mockResolvedValue({ madeUpSwitch: true })
  expect(await resolveHelpAccess(context, [{ activationKey: 'madeUpSwitch' }])).toMatchObject({ activations: { madeUpSwitch: false } })
  db.venueSettings.findUnique.mockResolvedValue(null)
  expect(await resolveHelpAccess(context, [{ activationKey: 'enableShifts' }])).toMatchObject({ activations: { enableShifts: false } })
})
it('resolveHelpAccess returns the role of that venue, and its fingerprint is the same hash as before', async () => {
  ;(getUserAccess as jest.Mock).mockResolvedValueOnce({
    organizationId: 'org',
    role: 'CASHIER',
    corePermissions: ['menu:read'],
    whiteLabelEnabled: false,
    featureAccess: {},
  })
  const access = await resolveHelpAccess(context, [{ featureCode: 'CFDI', gateKind: 'FEATURE' }])
  expect(access?.role).toBe('CASHIER')
  // sha256 del MISMO JSON de hoy, sin `role`: la fase 1 compara esta huella
  const before = { ...context, permissions: ['menu:read'], features: { CFDI: { included: false, enabled: false } }, activations: {} }
  const json = JSON.stringify({ ...before, whiteLabel: false, featureAccess: {} })
  expect(access?.fingerprint).toBe(crypto.createHash('sha256').update(json).digest('hex'))
})
