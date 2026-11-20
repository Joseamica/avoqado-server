jest.mock('@/services/support/access.service', () => ({ resolveHelpAccess: jest.fn().mockResolvedValue({ fingerprint: 'access-one' }) }))
jest.mock('@/services/support/link.service', () => ({ assertSupportPrincipal: jest.fn() }))
import prisma from '@/utils/prismaClient'
import { isSupportAccessLost, readSupportContext } from '@/services/support/context.service'
import { ForbiddenError } from '@/errors/AppError'
import { assertSupportPrincipal } from '@/services/support/link.service'
import { resolveHelpAccess } from '@/services/support/access.service'
import type { SupportConversation } from '@prisma/client'
const now = new Date(),
  expiresAt = new Date(now.getTime() + 60_000)
const conv = {
  id: 'conversation',
  generation: 1,
  mode: 'PERSONAL',
  phone: '+525566778899',
  receiverId: 'receiver',
  staffId: 'staff',
  linkId: 'link',
  orgId: 'org',
  venueId: 'venue',
  app: 'dashboard',
} as SupportConversation
beforeEach(() => {
  ;(prisma.supportWhatsappLink.findUnique as jest.Mock).mockResolvedValue({
    id: 'link',
    staffId: 'staff',
    phone: conv.phone,
    expiresAt,
    verifiedAt: now,
  })
})
it('revalidates the personal link and principal before resolving fresh venue access', async () => {
  expect(await readSupportContext(conv, [], now)).toMatchObject({
    context: { staffId: 'staff', orgId: 'org', venueId: 'venue' },
    access: { fingerprint: 'access-one' },
  })
  expect(assertSupportPrincipal).toHaveBeenCalledWith('staff', now, prisma)
})
it.each([{ id: 'reassigned' }, { phone: '+525500000001' }, { staffId: 'other' }, { expiresAt: now }])(
  'rejects a replaced, expired or foreign link %j',
  async patch => {
    ;(prisma.supportWhatsappLink.findUnique as jest.Mock).mockResolvedValue({
      id: 'link',
      staffId: 'staff',
      phone: conv.phone,
      expiresAt,
      verifiedAt: now,
      ...patch,
    })
    await expect(readSupportContext(conv, [], now)).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_REVOKED' })
    expect(resolveHelpAccess).not.toHaveBeenCalled()
  },
)
it('public context never borrows the old personal identity; CLOSED never authorizes', async () => {
  expect(await readSupportContext({ ...conv, mode: 'PUBLIC' }, [], now)).toMatchObject({ context: null, access: null })
  expect(prisma.supportWhatsappLink.findUnique).not.toHaveBeenCalled()
  await expect(readSupportContext({ ...conv, mode: 'CLOSED' }, [], now)).rejects.toMatchObject({ code: 'SUPPORT_ACCESS_REVOKED' })
})
it('a changed app or access changes the fingerprint even if the message still exists', async () => {
  const first = await readSupportContext(conv, [], now)
  const second = await readSupportContext({ ...conv, app: 'android' }, [], now)
  expect(first.fingerprint).not.toBe(second.fingerprint)
  ;(resolveHelpAccess as jest.Mock).mockResolvedValueOnce({ fingerprint: 'access-two' })
  expect((await readSupportContext(conv, [], now)).fingerprint).not.toBe(first.fingerprint)
})
// T-F5: the offer after an answer (T-F3b) is gone, and so is its exception: any pending question changes the fingerprint, also
// one that still carries the old afterAnswer mark.
it('a pending question changes the fingerprint, also one with the old afterAnswer mark (T-F5)', async () => {
  const pending = (selectionOptions: object) =>
    ({ ...conv, pendingSelection: 'VERSION', selectionOptions, selectionExpiresAt: expiresAt }) as SupportConversation
  const none = (await readSupportContext({ ...conv, pendingSelection: null, selectionOptions: null, selectionExpiresAt: null }, [], now))
    .fingerprint
  expect((await readSupportContext(pending({ topic: 't', items: [] }), [], now)).fingerprint).not.toBe(none)
  expect((await readSupportContext(pending({ topic: 't', items: [], afterAnswer: true }), [], now)).fingerprint).not.toBe(none)
})

// The worker's rule, moved here so the worker and checkDataDelivery share it (Task 7): what it recognizes does not change.
it.each([
  new ForbiddenError('x', 'SUPPORT_ACCESS_REVOKED'),
  new Error('User cmstaff has no access to venue cmvenue'),
  new Error('Venue cmvenue not found'),
])('isSupportAccessLost: %s', err => expect(isSupportAccessLost(err)).toBe(true))
it.each([new Error('connect ECONNREFUSED'), new Error('SUPPORT_BATCH_FAILED'), 'has no access to venue', null])(
  'isSupportAccessLost lets %s through',
  err => expect(isSupportAccessLost(err)).toBe(false),
)
