import prisma from '../../utils/prismaClient'

/**
 * Preferencia global «Anuncios de Avoqado por correo», por persona. Vive sólo en
 * `Staff.announcementEmailOptOutAt`: NotificationPreference no se lee ni se escribe aquí.
 */
export async function isAnnouncementEmailOn(staffId: string): Promise<boolean> {
  const staff = await prisma.staff.findUnique({ where: { id: staffId }, select: { announcementEmailOptOutAt: true } })
  return !!staff && staff.announcementEmailOptOutAt === null
}

/** Idempotente: apagar dos veces conserva la primera fecha; prender la borra. */
export async function setAnnouncementEmailOn(staffId: string, on: boolean): Promise<void> {
  if (on) {
    await prisma.staff.updateMany({
      where: { id: staffId, announcementEmailOptOutAt: { not: null } },
      data: { announcementEmailOptOutAt: null },
    })
  } else {
    await prisma.staff.updateMany({
      where: { id: staffId, announcementEmailOptOutAt: null },
      data: { announcementEmailOptOutAt: new Date() },
    })
  }
}
