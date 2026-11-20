import prisma from '@/utils/prismaClient'
import { assertSupportPrincipal } from '@/services/support/link.service'
import { listSupportVenues } from '@/services/support/access.service'
import { motivoDeConcesionInvalidada } from '@/utils/passwordChangeGuard'

const now = new Date()
function transaction() {
  return {
    staff: { findUnique: jest.fn().mockResolvedValue({ active: true, lastPasswordReset: null, sessionsRevokedAt: null }) },
    staffVenue: { findFirst: jest.fn().mockResolvedValue(null) },
    venue: {
      count: jest.fn().mockResolvedValue(1),
      findMany: jest.fn().mockResolvedValue([{ id: 'venue', name: 'Fixture', organizationId: 'org' }]),
    },
  }
}
beforeEach(() => {
  ;(prisma.staff.findUnique as jest.Mock).mockRejectedValue(new Error('No hay segunda conexión disponible'))
})
it('identity and strict credential cut use the supplied transaction connection', async () => {
  const tx = transaction()
  await expect((assertSupportPrincipal as any)('staff', now, tx)).resolves.toBeUndefined()
  expect(tx.staff.findUnique).toHaveBeenCalled()
  expect(prisma.staff.findUnique).not.toHaveBeenCalled()
})
it('the strict cut reads uncommitted transaction state without populating the shared cache', async () => {
  const tx = transaction()
  tx.staff.findUnique.mockResolvedValue({ active: true, lastPasswordReset: now, sessionsRevokedAt: null })
  expect(await (motivoDeConcesionInvalidada as any)('staff', new Date(now.getTime() - 1), tx)).toBe('PASSWORD_CHANGED')
  expect(tx.staff.findUnique).toHaveBeenCalled()
  expect(prisma.staff.findUnique).not.toHaveBeenCalled()
})
it('venue discovery and superadmin checks share the supplied connection and retain bounded scope', async () => {
  const tx = transaction()
  expect(await (listSupportVenues as any)('staff', { limit: 10 }, tx)).toMatchObject({ total: 1, items: [{ id: 'venue' }] })
  expect(tx.staffVenue.findFirst).toHaveBeenCalled()
  expect(tx.venue.findMany).toHaveBeenCalledWith(expect.objectContaining({ take: 11 }))
  expect(prisma.staff.findUnique).not.toHaveBeenCalled()
})
