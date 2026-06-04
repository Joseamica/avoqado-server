import { resolvePlanNotificationTarget } from '../../../../src/services/access/planNotification.service'
import prisma from '../../../../src/utils/prismaClient'

jest.mock('../../../../src/utils/prismaClient', () => ({
  __esModule: true,
  default: { venue: { findUnique: jest.fn() } },
}))

const mockVenue = (overrides: any) => (prisma.venue.findUnique as jest.Mock).mockResolvedValueOnce(overrides)

describe('resolvePlanNotificationTarget', () => {
  it('prefers venue.email and reads venue.language', async () => {
    mockVenue({
      id: 'v1',
      name: 'Bar',
      email: 'bar@x.com',
      language: 'en',
      organization: { email: 'org@x.com' },
      staff: [],
    })
    expect(await resolvePlanNotificationTarget('v1')).toEqual({
      email: 'bar@x.com',
      locale: 'en',
      venueName: 'Bar',
      ownerName: null,
    })
  })

  it('falls back to owner Staff email, defaults locale to es', async () => {
    mockVenue({
      id: 'v1',
      name: 'Bar',
      email: null,
      language: 'es',
      organization: { email: null },
      staff: [{ role: 'OWNER', staff: { email: 'owner@x.com', firstName: 'Ana', lastName: 'P' } }],
    })
    const t = await resolvePlanNotificationTarget('v1')
    expect(t.email).toBe('owner@x.com')
    expect(t.locale).toBe('es')
    expect(t.ownerName).toBe('Ana P')
  })

  it('falls back to org.email when no venue/owner email', async () => {
    mockVenue({
      id: 'v1',
      name: 'Bar',
      email: null,
      language: 'es',
      organization: { email: 'org@x.com' },
      staff: [],
    })
    expect((await resolvePlanNotificationTarget('v1')).email).toBe('org@x.com')
  })

  it('returns null email when nothing available', async () => {
    mockVenue({ id: 'v1', name: 'Bar', email: null, language: 'es', organization: { email: null }, staff: [] })
    expect((await resolvePlanNotificationTarget('v1')).email).toBeNull()
  })
})
