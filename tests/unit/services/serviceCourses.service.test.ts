import { prismaMock } from '../../__helpers__/setup'
import {
  getVenueServiceCourses,
  putVenueServiceCourses,
  putOrganizationServiceCourses,
  getOrganizationServiceCourses,
} from '@/services/service-courses/serviceCourse.service'
import { venueHasFeatureAccess, organizationHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { DEFAULT_SERVICE_COURSES } from '@/services/service-courses/serviceCourseContract'

jest.mock('@/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn(), organizationHasFeatureAccess: jest.fn() }))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const courses = [DEFAULT_SERVICE_COURSES[0], { id: 'coffee', label: 'Café', kind: 'STANDARD' }]
const org = { id: 'org-a', name: 'La Mesa', serviceCourses: courses, serviceCoursesRevision: 3 }
const venue = { id: 'venue-a', name: 'Roma', organizationId: 'org-a', organization: org, settings: null }
const actor = { staffId: 'staff-a' }

describe('service courses: tenant-scoped reads, Pro and atomic revisions', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    ;(organizationHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.venue.findUnique.mockResolvedValue(venue)
    prismaMock.organization.findUnique.mockResolvedValue(org)
    prismaMock.venueSettings.findUnique.mockResolvedValue(null)
    prismaMock.venueSettings.create.mockResolvedValue({ serviceCourses: courses, serviceCoursesRevision: 1 })
    prismaMock.venueSettings.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.organization.updateMany.mockResolvedValue({ count: 1 })
    prismaMock.venue.count.mockResolvedValue(2)
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'org-a' }])
    prismaMock.$transaction.mockImplementation(async (cb: any) => cb(prismaMock))
  })
  it('returns the current venue and effective inherited list without listing other venues', async () => {
    const result = await getVenueServiceCourses('venue-a')
    expect(result).toMatchObject({
      venueId: 'venue-a',
      organizationId: 'org-a',
      source: 'ORGANIZATION',
      courses,
      revision: 'o:3:v:0',
      enabled: true,
    })
    expect(prismaMock.venue.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'venue-a' } }))
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
  })
  it('a missing tenant is not treated as a default catalog', async () => {
    prismaMock.venue.findUnique.mockResolvedValue(null)
    await expect(getVenueServiceCourses('missing')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('keeps a visible Free read, but refuses every write before a transaction', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    expect(await getVenueServiceCourses('venue-a')).toMatchObject({ enabled: false })
    await expect(putVenueServiceCourses('venue-a', { expectedRevision: 'o:3:v:0', courses }, actor)).rejects.toMatchObject({
      statusCode: 403,
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
  it('cannot customize from an obsolete organization list', async () => {
    await expect(putVenueServiceCourses('venue-a', { expectedRevision: 'o:2:v:0', courses }, actor)).rejects.toMatchObject({
      statusCode: 409,
      code: 'SERVICE_COURSES_STALE',
      details: { currentRevision: 'o:3:v:0' },
    })
    expect(prismaMock.venueSettings.create).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })
  it('starts a complete override and audits only after commit', async () => {
    await putVenueServiceCourses('venue-a', { expectedRevision: 'o:3:v:0', courses }, actor)
    expect(prismaMock.venueSettings.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ venueId: 'venue-a', serviceCourses: courses, serviceCoursesRevision: 1 }),
      }),
    )
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({ staffId: 'staff-a', venueId: 'venue-a', action: 'SERVICE_COURSES_UPDATED' }),
    )
  })
  it('restores inheritance with CAS, without deleting the settings row or resetting its revision', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ serviceCourses: courses, serviceCoursesRevision: 4 })
    await putVenueServiceCourses('venue-a', { expectedRevision: 'v:4', courses: null }, actor)
    expect(prismaMock.venueSettings.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { venueId: 'venue-a', serviceCoursesRevision: 4 },
        data: expect.objectContaining({ serviceCoursesRevision: { increment: 1 } }),
      }),
    )
    expect(prismaMock.venueSettings.delete).not.toHaveBeenCalled()
  })
  it('does not overwrite the winner of a simultaneous local save', async () => {
    prismaMock.venueSettings.findUnique.mockResolvedValue({ serviceCourses: courses, serviceCoursesRevision: 4 })
    prismaMock.venueSettings.updateMany.mockResolvedValue({ count: 0 })
    await expect(putVenueServiceCourses('venue-a', { expectedRevision: 'v:4', courses }, actor)).rejects.toMatchObject({ statusCode: 409 })
    expect(logAction).not.toHaveBeenCalled()
  })
  it('checks organization access to the capability rather than selecting an arbitrary branch', async () => {
    const result = await getOrganizationServiceCourses('org-a')
    expect(organizationHasFeatureAccess).toHaveBeenCalledWith('org-a', 'TABLE_SERVICE')
    expect(result).toMatchObject({ organizationId: 'org-a', revision: 'o:3', enabled: true })
    expect(prismaMock.venue.findMany).not.toHaveBeenCalled()
  })
  it('rejects Free organization writes and foreign/missing organizations', async () => {
    ;(organizationHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    await expect(putOrganizationServiceCourses('org-a', { expectedRevision: 'o:3', courses }, actor)).rejects.toMatchObject({
      statusCode: 403,
    })
    prismaMock.organization.findUnique.mockResolvedValue(null)
    await expect(getOrganizationServiceCourses('org-b')).rejects.toMatchObject({ statusCode: 404 })
  })
  it('guards the shared save with the organization revision and scopes the audit to the organization', async () => {
    await putOrganizationServiceCourses('org-a', { expectedRevision: 'o:3', courses }, actor)
    expect(prismaMock.organization.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-a', serviceCoursesRevision: 3 } }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ organizationId: 'org-a', venueId: null }))
  })
  it('validation does not consume a revision or begin a transaction', async () => {
    await expect(putVenueServiceCourses('venue-a', { expectedRevision: 'o:3:v:0', courses: [] }, actor)).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})
