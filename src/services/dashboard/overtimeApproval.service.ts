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
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '../../errors/AppError'
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
  /**
   * La revisión (`updatedAt`) de la autorización que quien firma tenía ENFRENTE.
   *
   * 🔴 Obligatoria para CORREGIR una autorización que ya existe. Sin ella, dos gerentes que
   * miran los mismos minutos pendientes escriben los dos con éxito y gana el último, sin que
   * el primero se entere de que su pantalla estaba vieja (hallazgo #3 de Codex, 29-ago-2026).
   * Para la PRIMERA autorización del día no hace falta: no hay nada que pisar.
   */
  expectedUpdatedAt?: string
  /**
   * La huella de la jornada que el gerente TENÍA ENFRENTE al firmar. Si al llegar aquí las
   * checadas ya son otras, la firma se rechaza en vez de estamparse sobre lo nuevo.
   */
  expectedSourceFingerprint?: string
  /**
   * Por dónde entró la autorización. `'customer-mcp'` cuando la firma un agente.
   *
   * 🔴 Se marca en el ASIENTO QUE YA EXISTE, no en uno nuevo (hallazgo #12 de Codex): llamar
   * a `auditMcpWrite` además del `logAction` del servicio duplicaría el evento funcional, y
   * quien audite vería dos autorizaciones donde hubo una. Lo que faltaba era saber por qué
   * canal entró, no un segundo registro.
   */
  source?: 'customer-mcp'
}

export interface OvertimeApprovalResult {
  staffVenueId: string
  date: string
  minutesApproved: number
  minutesMeasured: number
}

const FECHA = /^\d{4}-\d{2}-\d{2}$/

export async function approveOvertime(input: ApproveOvertimeInput): Promise<OvertimeApprovalResult> {
  const { venueId, staffVenueId, date, minutesApproved, approvedById, note, expectedUpdatedAt, source } = input
  const { expectedSourceFingerprint } = input

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

  // 🔴 SEPARACIÓN DE FUNCIONES: nadie firma sus propias horas extra (founder, 30-ago-2026,
  // cerrando la pregunta que dejó abierta la auditoría de Codex). Un gerente que se autoriza
  // a sí mismo vacía de sentido la autorización — si puedes aprobarte, no controla nada.
  // Es por PERSONA, no por rol: un ADMIN tampoco puede autorizarse. Las suyas las firma otro.
  //
  // Va ANTES de recalcular la rejilla: rechazar no debe costar la consulta cara.
  if (membership.staffId === approvedById) {
    throw new ForbiddenError('No puedes autorizar tus propias horas extra: tiene que firmarlas otra persona')
  }

  // 🔴 Lo medido lo calcula el SERVIDOR, con la misma rejilla que alimenta el reporte y la
  // nómina. Nunca llega del cliente.
  const { cells } = await buildAttendanceGrid(venueId, date, date)
  const celda = cells.find(c => c.staffVenueId === staffVenueId && c.date === date)
  const minutesMeasured = celda?.overtimeMinutes ?? 0
  // La huella de la jornada que se está firmando: si mañana las checadas cambian, esta
  // autorización deja de valer aunque el total coincida (hallazgo #4 de Codex).
  const sourceFingerprint = celda?.overtimeFingerprint ?? null

  // 🔴 Se firma la jornada que el gerente VIO, no la que haya en este instante. Sin esto, un
  // cambio de checada entre que abre el panel y toca «Autorizar» quedaba firmado con la huella
  // NUEVA: la autorización nacía «vigente» sobre unas horas que nadie revisó — justo lo que la
  // huella existía para impedir (2ª auditoría de Codex, 30-ago-2026, P1 #3).
  // 🔴 La huella es OBLIGATORIA cuando el día tiene una, y se exige AQUÍ y no sólo en Zod:
  // éste es el único punto que ve la rejilla y sabe si existe. Dejarla opcional convertía el
  // agujero en comportamiento esperado — el MCP, un script o un curl firmaban sobre la jornada
  // que hubiera en ese instante (3ª auditoría de Codex, 31-ago-2026, P1 #2).
  //
  // El mensaje dice QUÉ hacer: un cliente viejo tiene que volver a consultar, no quedarse sin
  // la protección en silencio.
  if (sourceFingerprint && !expectedSourceFingerprint) {
    throw new ConflictError(
      'Para autorizar hace falta la huella de la jornada que estás viendo. Vuelve a consultar el reporte y manda `expectedSourceFingerprint` junto con los minutos.',
    )
  }

  if (expectedSourceFingerprint && expectedSourceFingerprint !== sourceFingerprint) {
    throw new ConflictError(
      'Las checadas de ese día cambiaron mientras lo revisabas. Vuelve a cargar para ver las horas actuales antes de autorizar.',
    )
  }

  if (minutesMeasured <= 0) {
    throw new BadRequestError('Ese día no hay horas extra que autorizar')
  }
  if (minutesApproved > minutesMeasured) {
    throw new BadRequestError(`No puedes autorizar más de lo trabajado: se midieron ${minutesMeasured} minutos`)
  }

  const ahora = new Date()
  const fila = {
    staffVenueId,
    venueId,
    date,
    minutesApproved,
    minutesMeasured,
    sourceFingerprint,
    approvedById,
    approvedAt: ahora,
    note: note ?? null,
  }

  // 🔴 Una autorización por persona y día: volver a autorizar CORRIGE, no acumula. Pero
  // corregir NO puede ser «el último gana»: quien corrige tiene que haber mirado lo que había.
  const existente = await prisma.overtimeApproval.findUnique({
    where: { staffVenueId_date: { staffVenueId, date } },
    select: { updatedAt: true },
  })

  if (!existente) {
    try {
      await prisma.overtimeApproval.create({ data: fila })
    } catch (e) {
      // La carrera real: dos gerentes leen `null` a la vez y los dos intentan crear. El
      // `@@unique` rebota al segundo, y ese rebote NO se reintenta en silencio — reintentar
      // sería volver a «el último gana», que es justo lo que se quiere evitar.
      if ((e as { code?: string }).code === 'P2002') {
        throw new ConflictError('Alguien más autorizó ese día mientras tanto. Vuelve a mirar antes de firmar.')
      }
      throw e
    }
  } else {
    if (!expectedUpdatedAt) {
      throw new ConflictError(
        'Ese día ya tiene una autorización. Vuelve a cargar la pantalla para ver la decisión actual antes de cambiarla.',
      )
    }
    // Se compara ANTES de escribir: una revisión que ya se sabe vieja no merece un viaje a la
    // base, y el mensaje llega más rápido. El CAS de abajo sigue siendo el que cierra la
    // carrera —esto sólo atrapa el caso obvio.
    if (existente.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()) {
      throw new ConflictError('La autorización cambió mientras la revisabas. Vuelve a cargarla y decide sobre lo actual.')
    }
    // El CAS: se actualiza SÓLO si la revisión sigue siendo la que se vio. Si otro gerente
    // escribió en medio, `count` es 0 — y cero filas afectadas no es un éxito silencioso.
    const r = await prisma.overtimeApproval.updateMany({
      where: { staffVenueId, date, updatedAt: new Date(expectedUpdatedAt) },
      data: { minutesApproved, minutesMeasured, sourceFingerprint, approvedById, approvedAt: ahora, note: fila.note },
    })
    if (r.count === 0) {
      throw new ConflictError('La autorización cambió mientras la revisabas. Vuelve a cargarla y decide sobre lo actual.')
    }
  }

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
        // Sólo cuando entró por el MCP: en el camino normal la ausencia del campo ya dice
        // que lo firmó una persona desde el dashboard.
        ...(source ? { source } : {}),
      },
    }),
  ).catch(() => {
    /* logAction ya registra su propio fallo; aquí sólo se evita un rechazo sin manejar */
  })

  return { staffVenueId, date, minutesApproved, minutesMeasured }
}
