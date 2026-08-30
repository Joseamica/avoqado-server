/**
 * Autorizar horas extra — el camino de ESCRITURA.
 *
 * Decisión del founder (29-ago-2026): las horas extra NO se pagan por el solo hecho de que el
 * reloj las midiera. Alguien con `attendance:manage` las autoriza, y sólo lo autorizado entra
 * al reparto doble/triple del art. 67 y 68.
 *
 * 🔴 Tres cosas sostienen esto, y cada una tiene su prueba:
 *
 *  1. **Los minutos MEDIDOS los pone el servidor**, recalculando la rejilla. Si vinieran del
 *     cliente, bastaría con decir "medí 8 h" para autorizarse 8 h que nadie trabajó.
 *  2. **No se puede autorizar más de lo medido.** Autorizar de MENOS sí: es la autorización
 *     parcial, y es el caso normal («se quedó 2 h, le apruebo 1»).
 *  3. **La membresía tiene que ser de ESTE negocio.** El `staffVenueId` llega del cliente.
 */
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'
import { buildAttendanceGrid } from './attendance.dashboard.service'

export interface ApproveOvertimeInput {
  venueId: string
  staffVenueId: string
  /** Día civil del TURNO, YYYY-MM-DD en fecha del negocio. */
  date: string
  /** Minutos a autorizar. 0 = revisado y NO autorizado. */
  minutesApproved: number
  /** Quién autoriza — sale de `authContext.userId`, nunca del cuerpo. */
  approvedById: string
  note?: string
}

export interface OvertimeApprovalResult {
  staffVenueId: string
  date: string
  minutesApproved: number
  minutesMeasured: number
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/

export async function approveOvertime(input: ApproveOvertimeInput): Promise<OvertimeApprovalResult> {
  const { venueId, staffVenueId, date, minutesApproved, approvedById, note } = input

  // Validar ANTES de tocar la base ni recalcular la rejilla: una fecha absurda no debe costar
  // una consulta (misma regla que el reporte de puntualidad).
  if (!FECHA.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) {
    throw new BadRequestError('Fecha inválida')
  }
  if (!Number.isInteger(minutesApproved) || minutesApproved < 0) {
    throw new BadRequestError('Los minutos autorizados deben ser un número entero de 0 o más')
  }

  // El `staffVenueId` llega del cliente: sin esta comprobación, un negocio podría autorizarle
  // horas a un empleado de otro.
  const membership = await prisma.staffVenue.findFirst({
    where: { id: staffVenueId, venueId },
    select: { id: true, staffId: true },
  })
  if (!membership) throw new NotFoundError('Persona no encontrada en este negocio')

  // 🔴 Lo medido lo calcula el SERVIDOR, con la misma rejilla que alimenta el reporte y la
  // nómina. Nunca llega del cliente.
  const { cells } = await buildAttendanceGrid(venueId, date, date)
  const celda = cells.find(c => c.staffVenueId === staffVenueId && c.date === date)
  const minutesMeasured = celda?.overtimeMinutes ?? 0

  if (minutesMeasured <= 0) {
    throw new BadRequestError('Ese día no hay horas extra que autorizar')
  }
  if (minutesApproved > minutesMeasured) {
    throw new BadRequestError(`No puedes autorizar más de lo trabajado: se midieron ${minutesMeasured} minutos`)
  }

  const fila = {
    staffVenueId,
    venueId,
    date,
    minutesApproved,
    minutesMeasured,
    approvedById,
    approvedAt: new Date(),
    note: note ?? null,
  }

  // Una autorización por persona y día: volver a autorizar CORRIGE, no acumula.
  await prisma.overtimeApproval.upsert({
    where: { staffVenueId_date: { staffVenueId, date } },
    create: fila,
    update: {
      minutesApproved,
      minutesMeasured,
      approvedById,
      approvedAt: fila.approvedAt,
      note: fila.note,
    },
  })

  // Fuera de cualquier transacción y sin encadenar el await al resultado: si la bitácora
  // truena, la autorización no puede caerse con ella (regla del repo).
  //
  // El `Promise.resolve(...)` no es adorno: `logAction` es fire-and-forget por contrato, pero
  // envolverlo así funciona igual si devuelve una promesa o si devuelve `undefined`, y cierra
  // la puerta a un rechazo sin manejar el día que alguien cambie su firma.
  void Promise.resolve(
    logAction({
      action: 'OVERTIME_APPROVED',
      entity: 'OvertimeApproval',
      entityId: `${staffVenueId}|${date}`,
      staffId: approvedById,
      venueId,
      data: {
        staffVenueId,
        staffId: membership.staffId,
        date,
        minutesApproved,
        minutesMeasured,
        note: note ?? null,
      },
    }),
  ).catch(() => {
    /* logAction ya registra su propio fallo; aquí sólo se evita un rechazo sin manejar */
  })

  return { staffVenueId, date, minutesApproved, minutesMeasured }
}
