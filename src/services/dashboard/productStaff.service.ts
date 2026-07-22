import { BadRequestError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'

export interface ProductStaffResult {
  productId: string
  staffVenueIds: string[]
  staff: Array<{ staffVenueId: string; staffId: string }>
  explicit: boolean
}

async function requireAppointmentProduct(venueId: string, productId: string) {
  const product = await prisma.product.findFirst({
    where: { id: productId, venueId, type: 'APPOINTMENTS_SERVICE' },
    select: { id: true },
  })
  if (!product) throw new BadRequestError('El servicio de citas no pertenece a este establecimiento')
  return product
}

export async function getProductStaff(venueId: string, productId: string): Promise<ProductStaffResult> {
  await requireAppointmentProduct(venueId, productId)
  const rows = await prisma.productStaff.findMany({
    where: { productId, venueId },
    select: { staffVenueId: true, staffVenue: { select: { staffId: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  })
  return {
    productId,
    staffVenueIds: rows.map(row => row.staffVenueId),
    staff: rows.map(row => ({ staffVenueId: row.staffVenueId, staffId: row.staffVenue.staffId })),
    explicit: rows.length > 0,
  }
}

export async function replaceProductStaff(
  venueId: string,
  productId: string,
  staffVenueIds: string[],
  actorId: string,
): Promise<ProductStaffResult> {
  await requireAppointmentProduct(venueId, productId)
  const uniqueIds = [...new Set(staffVenueIds)]
  const members =
    uniqueIds.length === 0
      ? []
      : await prisma.staffVenue.findMany({
          where: { id: { in: uniqueIds }, venueId, active: true, staff: { active: true } },
          select: { id: true, staffId: true },
        })

  if (members.length !== uniqueIds.length) {
    throw new BadRequestError('Uno o mas profesionistas no son miembros activos de este establecimiento')
  }

  const memberById = new Map(members.map(member => [member.id, member]))
  const orderedMembers = uniqueIds.map(id => memberById.get(id)!)

  await prisma.$transaction(async tx => {
    await tx.productStaff.deleteMany({ where: { productId, venueId } })
    if (orderedMembers.length > 0) {
      await tx.productStaff.createMany({
        data: orderedMembers.map(member => ({ productId, staffVenueId: member.id, venueId })),
      })
    }
  })

  void logAction({
    staffId: actorId,
    venueId,
    action: 'SERVICE_STAFF_UPDATED',
    entity: 'Product',
    entityId: productId,
  })

  return {
    productId,
    staffVenueIds: uniqueIds,
    staff: orderedMembers.map(member => ({ staffVenueId: member.id, staffId: member.staffId })),
    explicit: uniqueIds.length > 0,
  }
}
