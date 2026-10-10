import express from 'express'
import request from 'supertest'
import { prismaMock } from '../../__helpers__/setup'
import routes from '@/routes/dashboard/serviceCourse.routes'
import * as courses from '@/services/service-courses/serviceCourse.service'

jest.mock('@/services/service-courses/serviceCourse.service', () => ({
  getVenueServiceCourses: jest.fn(),
  putVenueServiceCourses: jest.fn(),
  getOrganizationServiceCourses: jest.fn(),
  putOrganizationServiceCourses: jest.fn(),
}))
jest.mock('@/services/access/rolVigente', () => ({
  esSuperadminReal: jest.fn().mockResolvedValue(false),
  esSuperadminDeLaSesion: jest.fn().mockResolvedValue(false),
}))
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, res: any, next: any) => {
    if (!req.get('x-test-user')) return res.status(401).json({ success: false })
    req.authContext = { userId: req.get('x-test-user'), orgId: 'org-a', role: 'OWNER' }
    next()
  },
}))
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (permission: string) => (req: any, res: any, next: any) => {
    if (!req.get('x-test-permissions')?.split(',').includes(permission)) return res.status(403).json({ required: permission })
    next()
  },
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: () => (req: any, res: any, next: any) => {
    if (req.get('x-test-free')) return res.status(403).json({ featureCode: 'TABLE_SERVICE' })
    next()
  },
}))

const app = express().use(express.json()).use(routes)
app.use((error: any, _req: any, res: any, _next: any) => res.status(error.statusCode ?? 500).json({ code: error.code }))

describe('service course routes: canonical scope and permission boundaries', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    ;(courses.getVenueServiceCourses as jest.Mock).mockResolvedValue({ enabled: false })
    ;(courses.getOrganizationServiceCourses as jest.Mock).mockResolvedValue({ organizationId: 'org-a' })
    ;(courses.putVenueServiceCourses as jest.Mock).mockResolvedValue({ revision: 'v:1' })
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'membership' })
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  })
  it('requires authentication before returning any catalog', async () => {
    expect((await request(app).get('/venues/venue-a/service-courses')).status).toBe(401)
    expect(courses.getVenueServiceCourses).not.toHaveBeenCalled()
  })
  it('allows a Free read only with settings:read, scoped to the route venue', async () => {
    const response = await request(app)
      .get('/venues/venue-a/service-courses')
      .set('x-test-user', 'staff')
      .set('x-test-permissions', 'settings:read')
    expect(response.status).toBe(200)
    expect(response.body.data.enabled).toBe(false)
    expect(courses.getVenueServiceCourses).toHaveBeenCalledWith('venue-a')
  })
  it('settings:read does not grant settings:manage', async () => {
    const response = await request(app)
      .put('/venues/venue-a/service-courses')
      .set('x-test-user', 'staff')
      .set('x-test-permissions', 'settings:read')
      .send({})
    expect(response.status).toBe(403)
    expect(courses.putVenueServiceCourses).not.toHaveBeenCalled()
  })
  it('Free cannot write even with settings:manage', async () => {
    expect(
      (
        await request(app)
          .put('/venues/venue-a/service-courses')
          .set('x-test-user', 'staff')
          .set('x-test-permissions', 'settings:manage')
          .set('x-test-free', '1')
          .send({})
      ).status,
    ).toBe(403)
    expect(courses.putVenueServiceCourses).not.toHaveBeenCalled()
  })
  it('does not accept another organization merely from an OWNER token', async () => {
    const response = await request(app).get('/organizations/org-b/service-courses').set('x-test-user', 'staff')
    expect(response.status).toBe(403)
    expect(courses.getOrganizationServiceCourses).not.toHaveBeenCalled()
  })
  it('a venue OWNER cannot write organization settings without active StaffOrganization ownership', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'venue-owner' })
    expect((await request(app).put('/organizations/org-a/service-courses').set('x-test-user', 'staff').send({})).status).toBe(403)
    expect(courses.putOrganizationServiceCourses).not.toHaveBeenCalled()
  })
  it('allows a current organization OWNER in the target organization', async () => {
    expect((await request(app).get('/organizations/org-a/service-courses').set('x-test-user', 'staff')).status).toBe(200)
    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: 'org-a',
          staffId: 'staff',
          isActive: true,
          role: 'OWNER',
          staff: { active: true },
        }),
      }),
    )
  })
})
