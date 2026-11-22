import { registerServiceCourseTools } from '@/mcp/tools/serviceCourses'
import { prismaMock } from '../../__helpers__/setup'
import type { McpScope } from '@/mcp/scope'
import * as courses from '@/services/service-courses/serviceCourse.service'
import { DEFAULT_SERVICE_COURSES } from '@/services/service-courses/serviceCourseContract'

jest.mock('@/services/service-courses/serviceCourse.service', () => ({
  getVenueServiceCourses: jest.fn(),
  getOrganizationServiceCourses: jest.fn(),
  putVenueServiceCourses: jest.fn(),
  putOrganizationServiceCourses: jest.fn(),
  setKitchenRelease: jest.fn(),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))
const scope = (over: Partial<McpScope> = {}): McpScope => ({
  staffId: 'staff',
  activeOrg: 'org-a',
  allowedVenueIds: ['venue-a'],
  scopes: ['mcp:read', 'mcp:write'],
  perVenueAccess: new Map([['venue-a', { role: 'OWNER', corePermissions: ['settings:read', 'settings:manage'] } as any]]),
  ...over,
})
function handlers(over: Partial<McpScope> = {}) {
  const result: Record<string, (input: any) => Promise<any>> = {}
  registerServiceCourseTools(
    {
      tool: (name: string, _description: string, _schema: any, handle: any) => {
        result[name] = handle
      },
    } as any,
    scope(over),
  )
  return result
}
describe('customer MCP service courses', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    const read = { organizationId: 'org-a', enabled: true, courses: DEFAULT_SERVICE_COURSES, revision: 'o:1:v:0' }
    ;(courses.getVenueServiceCourses as jest.Mock).mockResolvedValue(read)
    ;(courses.getOrganizationServiceCourses as jest.Mock).mockResolvedValue(read)
    ;(courses.putVenueServiceCourses as jest.Mock).mockResolvedValue({ ...read, revision: 'v:1' })
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'owner' })
  })
  it('does not read a venue outside the connected scope', async () => {
    await expect(handlers().service_courses({ venueId: 'foreign' })).rejects.toThrow(/not in your scope/)
    expect(courses.getVenueServiceCourses).not.toHaveBeenCalled()
  })
  it('does not use the token highest role to access another organization', async () => {
    await expect(handlers().service_courses({ organizationId: 'org-b' })).rejects.toThrow(/Reconecta/)
    expect(courses.getOrganizationServiceCourses).not.toHaveBeenCalled()
  })
  it('requires active organization ownership, not venue OWNER', async () => {
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    await expect(handlers().service_courses({ organizationId: 'org-a' })).rejects.toThrow(/propietario/)
  })
  it('a read-only OAuth connection cannot save even with confirmation', async () => {
    await expect(
      handlers({ scopes: ['mcp:read'] }).configure_service_courses({
        venueId: 'venue-a',
        courses: DEFAULT_SERVICE_COURSES,
        expectedRevision: 'o:1:v:0',
        confirm: true,
      }),
    ).rejects.toThrow(/solo lectura/)
    expect(courses.putVenueServiceCourses).not.toHaveBeenCalled()
  })
  it('preview is bounded/validated and never changes the shared or venue list', async () => {
    const response = await handlers().configure_service_courses({
      venueId: 'venue-a',
      courses: DEFAULT_SERVICE_COURSES,
      expectedRevision: 'o:1:v:0',
    })
    expect(response.content[0].text).toContain('requiresConfirmation')
    expect(courses.putVenueServiceCourses).not.toHaveBeenCalled()
    expect(courses.putOrganizationServiceCourses).not.toHaveBeenCalled()
  })
  it('D17: «La cocina puede liberar» primero enseña el cambio y sólo con confirm lo guarda, con el actor del MCP', async () => {
    ;(courses.getVenueServiceCourses as jest.Mock).mockResolvedValue({
      organizationId: 'org-a',
      venueName: 'Flautas',
      enabled: true,
      kitchenCanRelease: false,
    })
    ;(courses.setKitchenRelease as jest.Mock).mockResolvedValue({ venueName: 'Flautas', kitchenCanRelease: true })
    const preview = await handlers().configure_kitchen_release({ venueId: 'venue-a', enabled: true })
    expect(preview.content[0].text).toContain('requiresConfirmation')
    expect(preview.content[0].text).toContain('Sólo la caja libera tiempos → La cocina puede liberar tiempos')
    expect(courses.setKitchenRelease).not.toHaveBeenCalled()
    await handlers().configure_kitchen_release({ venueId: 'venue-a', enabled: true, confirm: true })
    expect(courses.setKitchenRelease).toHaveBeenCalledWith('venue-a', true, { staffId: 'staff', source: 'customer-mcp' })
  })
  it('D17: el interruptor no se toca fuera del alcance ni sin Pro', async () => {
    await expect(handlers().configure_kitchen_release({ venueId: 'foreign', enabled: true, confirm: true })).rejects.toThrow(
      /not in your scope/,
    )
    ;(courses.getVenueServiceCourses as jest.Mock).mockResolvedValue({ organizationId: 'org-a', enabled: false, kitchenCanRelease: false })
    await expect(handlers().configure_kitchen_release({ venueId: 'venue-a', enabled: true, confirm: true })).rejects.toThrow(/Pro/)
    expect(courses.setKitchenRelease).not.toHaveBeenCalled()
  })
  it('confirmed save passes revision, target and authenticated actor to the same dashboard service', async () => {
    await handlers().configure_service_courses({
      venueId: 'venue-a',
      courses: DEFAULT_SERVICE_COURSES,
      expectedRevision: 'o:1:v:0',
      confirm: true,
    })
    expect(courses.putVenueServiceCourses).toHaveBeenCalledWith(
      'venue-a',
      { courses: DEFAULT_SERVICE_COURSES, expectedRevision: 'o:1:v:0' },
      { staffId: 'staff', source: 'customer-mcp' },
    )
  })
})
