import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { venueHasFeatureAccess, organizationHasFeatureAccess } from '@/services/access/basePlan.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import {
  DEFAULT_SERVICE_COURSES,
  MAX_SERVICE_COURSES,
  MAX_SERVICE_COURSE_LABEL,
  resolveServiceCourses,
  serviceCourseCatalogSchema,
} from './serviceCourseContract'

const savedSelect = { serviceCourses: true, serviceCoursesRevision: true } as const
const venueSelect = {
  id: true,
  name: true,
  organizationId: true,
  organization: { select: { id: true, name: true, ...savedSelect } },
  settings: { select: savedSelect },
} as const
type Actor = { staffId: string; ipAddress?: string; userAgent?: string; source?: string }
export type SaveServiceCoursesInput = { expectedRevision: string; courses: unknown }

function validateSave(input: SaveServiceCoursesInput, allowInheritance: boolean) {
  if (!input || typeof input.expectedRevision !== 'string' || !/^(?:o:\d+(?::v:\d+)?|v:\d+)$/.test(input.expectedRevision)) {
    throw new BadRequestError('Recarga los tiempos antes de guardar: falta la revisión', 'SERVICE_COURSES_REVISION_REQUIRED')
  }
  if (input.courses === null && allowInheritance) return null
  const parsed = serviceCourseCatalogSchema.safeParse(input.courses)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues[0]?.message, 'SERVICE_COURSES_INVALID', parsed.error.flatten())
  return parsed.data
}

function stale(revision: string): never {
  throw new ConflictError(
    'Los tiempos cambiaron mientras los editabas. Recarga la configuración para revisar los cambios.',
    'SERVICE_COURSES_STALE',
    { currentRevision: revision },
  )
}

function requireEnabled(enabled: boolean) {
  if (!enabled) throw new ForbiddenError('Los tiempos de servicio requieren Pro o acceso a Mesas.', 'FEATURE_ACCESS_REQUIRED')
}

export async function getVenueServiceCourses(venueId: string) {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: venueSelect })
  if (!venue) throw new NotFoundError('No encontramos esta sucursal')
  return {
    schemaVersion: 1,
    venueId,
    venueName: venue.name,
    organizationId: venue.organizationId,
    organizationName: venue.organization.name,
    ...resolveServiceCourses(venue.organization, venue.settings),
    enabled: await venueHasFeatureAccess(venueId, 'TABLE_SERVICE'),
  }
}

export async function getOrganizationServiceCourses(organizationId: string) {
  const organization = await prisma.organization.findUnique({
    where: { id: organizationId },
    select: { id: true, name: true, ...savedSelect },
  })
  if (!organization) throw new NotFoundError('No encontramos esta organización')
  const [enabled, totalVenues, inheritingVenues] = await Promise.all([
    organizationHasFeatureAccess(organizationId, 'TABLE_SERVICE'),
    prisma.venue.count({ where: { organizationId } }),
    prisma.venue.count({
      where: { organizationId, OR: [{ settings: null }, { settings: { serviceCourses: { equals: Prisma.DbNull } } }] },
    }),
  ])
  return {
    schemaVersion: 1,
    organizationId,
    organizationName: organization.name,
    source: organization.serviceCourses == null ? 'DEFAULT' : 'ORGANIZATION',
    revision: `o:${organization.serviceCoursesRevision}`,
    courses: serviceCourseCatalogSchema.parse(organization.serviceCourses ?? DEFAULT_SERVICE_COURSES),
    limits: { maxCourses: MAX_SERVICE_COURSES, maxLabelLength: MAX_SERVICE_COURSE_LABEL },
    enabled,
    totalVenues,
    inheritingVenues,
  }
}

export async function putVenueServiceCourses(venueId: string, input: SaveServiceCoursesInput, actor: Actor) {
  const courses = validateSave(input, true)
  const current = await getVenueServiceCourses(venueId)
  requireEnabled(current.enabled)
  const result = await prisma.$transaction(async tx => {
    // Organization first. A shared-list edit cannot slip between copying it and saving
    // the override. The venue lock serializes the initially absent Settings row too.
    await tx.$queryRaw`SELECT id FROM "Organization" WHERE id = ${current.organizationId} FOR SHARE`
    const locked =
      await tx.$queryRaw`SELECT id FROM "Venue" WHERE id = ${venueId} AND "organizationId" = ${current.organizationId} FOR UPDATE`
    if (!Array.isArray(locked) || locked.length === 0) throw new NotFoundError('No encontramos esta sucursal')
    const organization = await tx.organization.findUnique({ where: { id: current.organizationId }, select: savedSelect })
    const settings = await tx.venueSettings.findUnique({ where: { venueId }, select: savedSelect })
    const effective = resolveServiceCourses(organization, settings)
    if (effective.revision !== input.expectedRevision) stale(effective.revision)
    const json = courses === null ? Prisma.DbNull : (courses as Prisma.InputJsonValue)
    if (settings) {
      const updated = await tx.venueSettings.updateMany({
        where: { venueId, serviceCoursesRevision: effective.venueRevision },
        data: { serviceCourses: json, serviceCoursesRevision: { increment: 1 } },
      })
      if (updated.count !== 1) stale(effective.revision)
    } else {
      await tx.venueSettings.create({ data: { venueId, serviceCourses: json, serviceCoursesRevision: 1 } })
    }
    return {
      ...current,
      ...resolveServiceCourses(organization, { serviceCourses: courses, serviceCoursesRevision: effective.venueRevision + 1 }),
    }
  })
  await logAction({
    ...actor,
    venueId,
    organizationId: current.organizationId,
    action: courses === null ? 'SERVICE_COURSES_INHERITED' : 'SERVICE_COURSES_UPDATED',
    entity: 'VenueSettings',
    entityId: venueId,
    data: { revision: result.revision, courses, source: actor.source ?? 'dashboard' },
  })
  return result
}

export async function putOrganizationServiceCourses(organizationId: string, input: SaveServiceCoursesInput, actor: Actor) {
  const courses = validateSave(input, false)!
  const current = await getOrganizationServiceCourses(organizationId)
  requireEnabled(current.enabled)
  if (input.expectedRevision !== current.revision) stale(current.revision)
  const revision = Number(current.revision.slice(2))
  const updated = await prisma.organization.updateMany({
    where: { id: organizationId, serviceCoursesRevision: revision },
    data: { serviceCourses: courses as Prisma.InputJsonValue, serviceCoursesRevision: { increment: 1 } },
  })
  if (updated.count !== 1) {
    const latest = await prisma.organization.findUnique({ where: { id: organizationId }, select: savedSelect })
    if (!latest) throw new NotFoundError('No encontramos esta organización')
    stale(`o:${latest.serviceCoursesRevision}`)
  }
  const result = { ...current, source: 'ORGANIZATION', courses, revision: `o:${revision + 1}` }
  await logAction({
    ...actor,
    venueId: null,
    organizationId,
    action: 'SERVICE_COURSES_UPDATED',
    entity: 'Organization',
    entityId: organizationId,
    data: { revision: result.revision, courses, source: actor.source ?? 'dashboard' },
  })
  return result
}
