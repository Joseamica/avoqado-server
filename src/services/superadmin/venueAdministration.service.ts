import { Prisma, StaffRole, VenueOperationalRole, VenueStatus, VenueType } from '@prisma/client'
import { z } from 'zod'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { getValidTransitions } from '@/services/dashboard/superadmin.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { socketManager } from '@/communication/sockets/managers/socketManager'
import { SocketEventType } from '@/communication/sockets/types'
import {
  updateVenueProfileBody,
  updateVenueOrganizationBody,
  updateVenueOwnerBody,
  updateVenueStatusBody,
  UpdateVenueProfileInput,
  UpdateVenueOrganizationInput,
  UpdateVenueOwnerInput,
  UpdateVenueStatusInput,
} from '@/schemas/superadmin/venueAdministration.schema'

const venueSelect = {
  id: true,
  organizationId: true,
  name: true,
  slug: true,
  type: true,
  address: true,
  city: true,
  state: true,
  country: true,
  zipCode: true,
  phone: true,
  email: true,
  website: true,
  latitude: true,
  longitude: true,
  language: true,
  timezone: true,
  currency: true,
  entityType: true,
  rfc: true,
  legalName: true,
  fiscalRegime: true,
  status: true,
  kycStatus: true,
  suspensionReason: true,
  updatedAt: true,
  operationalRole: true,
  active: true,
} satisfies Prisma.VenueSelect
const organizationSelect = {
  id: true,
  name: true,
  email: true,
  phone: true,
  taxId: true,
  billingEmail: true,
  updatedAt: true,
} satisfies Prisma.OrganizationSelect
const ownerSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  phone: true,
  updatedAt: true,
} satisfies Prisma.StaffSelect

type Delta = Record<string, { from: Prisma.InputJsonValue | null; to: Prisma.InputJsonValue | null }>
const stale = () =>
  new ConflictError(
    'Los datos cambiaron desde que abriste la ficha. Actualiza la información antes de guardar.',
    'VENUE_ADMINISTRATION_STALE',
  )

function parseInput<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new BadRequestError(parsed.error.issues.map(issue => issue.message).join(' '))
  return parsed.data
}

function assertRevision(updatedAt: Date, expected: string) {
  if (updatedAt.getTime() !== new Date(expected).getTime()) throw stale()
}

function nextRevision(updatedAt: Date) {
  // A second edit in the same millisecond must still invalidate the previous form.
  return new Date(Math.max(Date.now(), updatedAt.getTime() + 1))
}

function delta(before: object, changes: object): Delta {
  const previous = before as Record<string, unknown>
  const result: Delta = {}
  for (const [key, value] of Object.entries(changes)) {
    const from = Prisma.Decimal.isDecimal(previous[key]) ? Number(previous[key]) : previous[key]
    if (value !== undefined && from !== value)
      result[key] = { from: from as Prisma.InputJsonValue | null, to: value as Prisma.InputJsonValue | null }
  }
  return result
}

async function readVenue(tx: Prisma.TransactionClient, venueId: string) {
  const venue = await tx.venue.findUnique({ where: { id: venueId }, select: venueSelect })
  if (!venue) throw new NotFoundError('El negocio no existe.')
  return venue
}

async function findOwner(tx: Prisma.TransactionClient, venueId: string) {
  for (const role of [StaffRole.OWNER, StaffRole.ADMIN]) {
    const membership = await tx.staffVenue.findFirst({
      where: { venueId, role, active: true, staff: { active: true } },
      select: { id: true, role: true, staff: { select: ownerSelect } },
      orderBy: [{ startDate: 'asc' }, { id: 'asc' }],
    })
    if (membership) return membership
  }
  return null
}

async function lockVenue(tx: Prisma.TransactionClient, venueId: string) {
  // The shared record may be edited only while its link to this venue is locked.
  await tx.$queryRaw(Prisma.sql`SELECT id FROM "Venue" WHERE id = ${venueId} FOR UPDATE`)
  return readVenue(tx, venueId)
}

function mutationError(error: unknown): never {
  const failure = error as { code?: string; meta?: { code?: string } } | null
  const code = failure?.code
  const sqlState = failure?.meta?.code
  if (code === 'P2034' || (code === 'P2010' && (sqlState === '40001' || sqlState === '40P01'))) throw stale()
  if (code === 'P2002') throw new ConflictError('El identificador público ya está en uso. Elige otro.', 'VENUE_SLUG_TAKEN')
  throw error
}

function notify(venueId: string) {
  try {
    socketManager.broadcastToRole(StaffRole.SUPERADMIN, SocketEventType.SUPERADMIN_VENUE_UPDATED, { id: venueId })
  } catch (error) {
    logger.warn('No se pudo notificar la actualización administrativa del negocio.', { venueId, error })
  }
}

export async function getVenueAdministration(venueId: string) {
  const venue = await readVenue(prisma, venueId)
  const [organization, organizationVenueCount, membership] = await Promise.all([
    prisma.organization.findUnique({ where: { id: venue.organizationId }, select: organizationSelect }),
    prisma.venue.count({ where: { organizationId: venue.organizationId } }),
    findOwner(prisma, venueId),
  ])
  if (!organization) throw new NotFoundError('La organización del negocio no existe.')
  const ownerVenueCount = membership ? await prisma.staffVenue.count({ where: { staffId: membership.staff.id, active: true } }) : 0
  const { operationalRole: _operationalRole, active: _active, ...publicVenue } = venue
  return {
    venue: {
      ...publicVenue,
      latitude: venue.latitude === null ? null : Number(venue.latitude),
      longitude: venue.longitude === null ? null : Number(venue.longitude),
      updatedAt: venue.updatedAt.toISOString(),
    },
    organization: { ...organization, updatedAt: organization.updatedAt.toISOString(), venueCount: organizationVenueCount },
    owner: membership
      ? { ...membership.staff, updatedAt: membership.staff.updatedAt.toISOString(), role: membership.role, venueCount: ownerVenueCount }
      : null,
    allowedStatusTransitions: getValidTransitions(venue.status),
  }
}

export async function updateVenueProfile(venueId: string, input: UpdateVenueProfileInput, actorId: string) {
  const parsed = parseInput(updateVenueProfileBody, input)
  try {
    const result = await prisma.$transaction(
      async tx => {
        const venue = await lockVenue(tx, venueId)
        assertRevision(venue.updatedAt, parsed.expectedUpdatedAt)
        if (venue.operationalRole === VenueOperationalRole.CEDIS && parsed.changes.type && parsed.changes.type !== VenueType.OTHER) {
          throw new BadRequestError('Un centro de distribución debe conservar el giro Otro.')
        }
        const changes = delta(venue, parsed.changes)
        if (changes.slug && !parsed.confirmSlugChange) {
          throw new BadRequestError('Cambiar el identificador público invalida los enlaces anteriores. Confirma el cambio para continuar.')
        }
        if (Object.keys(changes).length) {
          const updated = await tx.venue.updateMany({
            where: { id: venueId, updatedAt: venue.updatedAt },
            data: { ...parsed.changes, updatedAt: nextRevision(venue.updatedAt) },
          })
          if (updated.count !== 1) throw stale()
        }
        return { organizationId: venue.organizationId, changes }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    if (Object.keys(result.changes).length) {
      void logAction({
        staffId: actorId,
        venueId,
        organizationId: result.organizationId,
        action: 'SUPERADMIN_VENUE_PROFILE_UPDATED',
        entity: 'Venue',
        entityId: venueId,
        data: { changes: result.changes },
      })
      notify(venueId)
    }
    return getVenueAdministration(venueId)
  } catch (error) {
    mutationError(error)
  }
}

export async function updateVenueOrganization(venueId: string, input: UpdateVenueOrganizationInput, actorId: string) {
  const parsed = parseInput(updateVenueOrganizationBody, input)
  try {
    const result = await prisma.$transaction(
      async tx => {
        const venue = await lockVenue(tx, venueId)
        if (venue.organizationId !== parsed.expectedOrganizationId) throw stale()
        const organization = await tx.organization.findUnique({ where: { id: venue.organizationId }, select: organizationSelect })
        if (!organization) throw new NotFoundError('La organización del negocio no existe.')
        assertRevision(organization.updatedAt, parsed.expectedUpdatedAt)
        const changes = delta(organization, parsed.changes)
        const venueCount = await tx.venue.count({ where: { organizationId: organization.id } })
        if (Object.keys(changes).length) {
          const updated = await tx.organization.updateMany({
            where: { id: organization.id, updatedAt: organization.updatedAt, venues: { some: { id: venueId } } },
            data: { ...parsed.changes, updatedAt: nextRevision(organization.updatedAt) },
          })
          if (updated.count !== 1) throw stale()
        }
        return { organizationId: organization.id, changes, venueCount }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    if (Object.keys(result.changes).length) {
      void logAction({
        staffId: actorId,
        venueId,
        organizationId: result.organizationId,
        action: 'SUPERADMIN_VENUE_ORGANIZATION_UPDATED',
        entity: 'Organization',
        entityId: result.organizationId,
        data: { changes: result.changes, venueCount: result.venueCount },
      })
      notify(venueId)
    }
    return getVenueAdministration(venueId)
  } catch (error) {
    mutationError(error)
  }
}

export async function updateVenueOwner(venueId: string, input: UpdateVenueOwnerInput, actorId: string) {
  const parsed = parseInput(updateVenueOwnerBody, input)
  try {
    const result = await prisma.$transaction(
      async tx => {
        const venue = await lockVenue(tx, venueId)
        const membership = await findOwner(tx, venueId)
        if (!membership || membership.staff.id !== parsed.expectedOwnerId) throw stale()
        await tx.$queryRaw(Prisma.sql`SELECT id FROM "StaffVenue" WHERE id = ${membership.id} AND "venueId" = ${venueId} FOR UPDATE`)
        assertRevision(membership.staff.updatedAt, parsed.expectedUpdatedAt)
        const changes = delta(membership.staff, parsed.changes)
        const venueCount = await tx.staffVenue.count({ where: { staffId: membership.staff.id, active: true } })
        if (Object.keys(changes).length) {
          const updated = await tx.staff.updateMany({
            where: {
              id: membership.staff.id,
              updatedAt: membership.staff.updatedAt,
              active: true,
              venues: { some: { id: membership.id, venueId, role: membership.role, active: true } },
            },
            data: { ...parsed.changes, updatedAt: nextRevision(membership.staff.updatedAt) },
          })
          if (updated.count !== 1) throw stale()
        }
        return { ownerId: membership.staff.id, organizationId: venue.organizationId, changes, venueCount }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    if (Object.keys(result.changes).length) {
      void logAction({
        staffId: actorId,
        venueId,
        organizationId: result.organizationId,
        action: 'SUPERADMIN_VENUE_OWNER_UPDATED',
        entity: 'Staff',
        entityId: result.ownerId,
        data: { changes: result.changes, venueCount: result.venueCount },
      })
      notify(venueId)
    }
    return getVenueAdministration(venueId)
  } catch (error) {
    mutationError(error)
  }
}

export async function updateVenueStatus(venueId: string, input: UpdateVenueStatusInput, actorId: string) {
  const parsed = parseInput(updateVenueStatusBody, input)
  try {
    const result = await prisma.$transaction(
      async tx => {
        const venue = await lockVenue(tx, venueId)
        assertRevision(venue.updatedAt, parsed.expectedUpdatedAt)
        if (!getValidTransitions(venue.status).includes(parsed.status))
          throw new BadRequestError('La transición de estado no está permitida para este negocio.')
        const isActivating = parsed.status === VenueStatus.ACTIVE
        const isSuspending = parsed.status === VenueStatus.SUSPENDED || parsed.status === VenueStatus.ADMIN_SUSPENDED
        const isClosing = parsed.status === VenueStatus.CLOSED
        if ((isSuspending || isClosing) && !parsed.reason) throw new BadRequestError('Escribe el motivo de la suspensión o cierre.')
        const data = {
          status: parsed.status,
          ...(isActivating ? { active: true, suspensionReason: null } : {}),
          ...(isSuspending || isClosing ? { active: false, suspensionReason: parsed.reason! } : {}),
        }
        const updated = await tx.venue.updateMany({
          where: { id: venueId, updatedAt: venue.updatedAt, status: venue.status },
          data: { ...data, statusChangedAt: new Date(), statusChangedBy: actorId, updatedAt: nextRevision(venue.updatedAt) },
        })
        if (updated.count !== 1) throw stale()
        return { organizationId: venue.organizationId, changes: delta(venue, data) }
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    )
    void logAction({
      staffId: actorId,
      venueId,
      organizationId: result.organizationId,
      action: 'SUPERADMIN_VENUE_STATUS_UPDATED',
      entity: 'Venue',
      entityId: venueId,
      data: { changes: result.changes, ...(parsed.reason ? { reason: parsed.reason } : {}) },
    })
    notify(venueId)
    return getVenueAdministration(venueId)
  } catch (error) {
    mutationError(error)
  }
}
