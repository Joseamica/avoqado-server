/**
 * Asistencia — lectura y validación de checadas desde el dashboard del negocio.
 *
 * El motor del checador ya existe y lo consumen la TPV, Android e iOS
 * (`services/tpv/time-entry.tpv.service.ts`): marcar entrada y salida con PIN, los
 * descansos, la foto y el GPS. Este servicio NO reimplementa nada de eso — solo abre
 * la lectura y la aprobación al dueño de un negocio normal, que hasta ahora únicamente
 * existían en el panel de organización, detrás del acceso white-label.
 *
 * Lo único que aporta es el acotamiento por venue. Las funciones que se reusan reciben
 * `staffId` / `timeEntryId` sueltos porque nacieron dentro de una sesión de terminal ya
 * atada a su venue; expuestas por HTTP, ese id llega del cliente y hay que comprobarlo.
 */
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'
import { getCurrentlyClockedInStaff, getStaffTimeSummary, getTimeEntries } from '../tpv/time-entry.tpv.service'
import type { TimeEntryStatus } from '@prisma/client'

export type TimeEntryValidationDecision = 'APPROVED' | 'REJECTED'

export interface VenueTimeEntriesQuery {
  staffId?: string
  startDate?: string
  endDate?: string
  status?: TimeEntryStatus
  limit?: number
  offset?: number
}

/** Checadas del negocio. `getTimeEntries` ya filtra por venueId, así que basta con pasarlo. */
export async function getVenueTimeEntries(venueId: string, query: VenueTimeEntriesQuery = {}) {
  return getTimeEntries({ venueId, ...query })
}

/** Quién está dentro en este momento. Ya viene acotado al venue. */
export async function getVenueActiveStaff(venueId: string) {
  return getCurrentlyClockedInStaff(venueId)
}

/**
 * Horas de una persona en un rango.
 *
 * `getStaffTimeSummary` recibe sólo `staffId`, sin venue: sin esta comprobación previa,
 * un negocio podría pedir el resumen de un empleado de otro negocio pasando su id.
 */
export async function getVenueStaffTimeSummary(venueId: string, staffId: string, startDate: string, endDate: string) {
  const membership = await prisma.staffVenue.findFirst({
    where: { staffId, venueId },
    select: { id: true },
  })

  if (!membership) {
    throw new NotFoundError('Ese empleado no pertenece a este negocio')
  }

  return getStaffTimeSummary({ staffId, startDate, endDate })
}

/**
 * Aprobar o rechazar una checada.
 *
 * Equivale a `organizationDashboard.validateTimeEntry`, pero acotado por venue en vez de
 * por organización, y sin el depósito bancario: ese campo es del flujo de promotores de
 * PlayTelecom y no significa nada para un negocio normal.
 */
export async function validateVenueTimeEntry(
  venueId: string,
  timeEntryId: string,
  validatedById: string,
  status: TimeEntryValidationDecision,
  note?: string,
) {
  if (status !== 'APPROVED' && status !== 'REJECTED') {
    throw new BadRequestError('La validación sólo puede ser APPROVED o REJECTED')
  }

  const timeEntry = await prisma.timeEntry.findFirst({
    where: { id: timeEntryId, venueId },
    select: { id: true, staffId: true },
  })

  if (!timeEntry) {
    throw new NotFoundError('Checada no encontrada en este negocio')
  }

  const updated = await prisma.timeEntry.update({
    where: { id: timeEntryId },
    data: {
      validationStatus: status,
      validatedBy: validatedById,
      validatedAt: new Date(),
      validationNote: note || null,
    },
  })

  logAction({
    staffId: validatedById,
    venueId,
    action: `TIME_ENTRY_${status}`,
    entity: 'TimeEntry',
    entityId: timeEntryId,
    data: { note: note || null },
  })

  return updated
}
