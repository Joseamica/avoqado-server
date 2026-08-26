import { ForbiddenError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'

/**
 * El interruptor de asistencia, del lado del servidor.
 *
 * Apagar asistencia apaga DE VERDAD: la gente deja de poder checar, no sólo desaparece una
 * sección (igual que Square y Toast). Lo decide el servidor porque los aparatos no leen
 * ajustes del venue — pero sí muestran el mensaje de un 4xx, así que esto apaga la función
 * en Android, iOS y TPV sin recompilar nada.
 *
 * 🔴 Independiente de `enableShifts` (turnos de CAJA). Son rieles distintos.
 */

export class AttendanceDisabledError extends ForbiddenError {
  constructor() {
    super('El control de asistencia está apagado para este negocio. Pide a un administrador que lo active.', 'ATTENDANCE_DISABLED')
  }
}

export async function assertAttendanceEnabled(venueId: string): Promise<void> {
  const settings = await prisma.venueSettings.findUnique({
    where: { venueId },
    select: { attendanceEnabled: true },
  })
  // Sin fila de ajustes = prendido. Los negocios existentes venían checando sin interruptor
  // y no se les puede apagar el reloj por una migración.
  if (settings && settings.attendanceEnabled === false) {
    throw new AttendanceDisabledError()
  }
}
