import { Prisma } from '@prisma/client'
import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { OperatingHours } from './reservationSettings.service'
import { logAction } from './activity-log.service'

export interface StaffScheduleExceptionInput {
  startDate: string
  endDate: string
  kind: 'OFF' | 'HOURS'
  startTime?: string
  endTime?: string
  note?: string
}

export interface ReplaceStaffScheduleInput {
  weekly: OperatingHours | null
  exceptions: StaffScheduleExceptionInput[]
}

export interface StaffScheduleResult extends ReplaceStaffScheduleInput {
  staffVenueId: string
}

async function requireStaffVenue(venueId: string, staffVenueId: string) {
  const member = await prisma.staffVenue.findFirst({
    where: { id: staffVenueId, venueId },
    include: { staff: { select: { active: true } } },
  })
  if (!member) throw new BadRequestError('El profesionista no pertenece a este establecimiento')
  return member
}

export async function getStaffSchedule(venueId: string, staffVenueId: string): Promise<StaffScheduleResult> {
  await requireStaffVenue(venueId, staffVenueId)
  const [schedule, exceptions] = await Promise.all([
    prisma.staffSchedule.findUnique({ where: { staffVenueId }, select: { weekly: true } }),
    prisma.staffScheduleException.findMany({
      where: { staffVenueId, venueId },
      select: { startDate: true, endDate: true, kind: true, startTime: true, endTime: true, note: true },
      orderBy: [{ startDate: 'asc' }, { endDate: 'asc' }, { id: 'asc' }],
    }),
  ])

  return {
    staffVenueId,
    weekly: (schedule?.weekly as unknown as OperatingHours | undefined) ?? null,
    exceptions: exceptions.map(exception => ({
      startDate: exception.startDate,
      endDate: exception.endDate,
      kind: exception.kind as 'OFF' | 'HOURS',
      ...(exception.startTime !== null && { startTime: exception.startTime }),
      ...(exception.endTime !== null && { endTime: exception.endTime }),
      ...(exception.note !== null && { note: exception.note }),
    })),
  }
}

export async function replaceStaffSchedule(
  venueId: string,
  staffVenueId: string,
  input: ReplaceStaffScheduleInput,
  actorId: string,
): Promise<StaffScheduleResult> {
  const member = await requireStaffVenue(venueId, staffVenueId)

  await prisma.$transaction(async tx => {
    if (input.weekly === null) {
      await tx.staffSchedule.deleteMany({ where: { staffVenueId: member.id, venueId: member.venueId } })
    } else {
      await tx.staffSchedule.upsert({
        where: { staffVenueId: member.id },
        create: { staffVenueId: member.id, venueId: member.venueId, weekly: input.weekly as unknown as Prisma.InputJsonValue },
        update: { venueId: member.venueId, weekly: input.weekly as unknown as Prisma.InputJsonValue },
      })
    }

    await tx.staffScheduleException.deleteMany({ where: { staffVenueId: member.id, venueId: member.venueId } })
    if (input.exceptions.length > 0) {
      await tx.staffScheduleException.createMany({
        data: input.exceptions.map(exception => ({
          staffVenueId: member.id,
          venueId: member.venueId,
          startDate: exception.startDate,
          endDate: exception.endDate,
          kind: exception.kind,
          startTime: exception.startTime,
          endTime: exception.endTime,
          note: exception.note,
        })),
      })
    }
  })

  void logAction({
    staffId: actorId,
    venueId: member.venueId,
    action: 'STAFF_SCHEDULE_UPDATED',
    entity: 'StaffVenue',
    entityId: member.id,
  })

  return { staffVenueId: member.id, weekly: input.weekly, exceptions: input.exceptions }
}
