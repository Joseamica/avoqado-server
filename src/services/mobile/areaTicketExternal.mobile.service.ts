/**
 * Cobro externo — vales por área cuya caja vive en OTRO POS.
 *
 * `areaTicketV7.mobile.service.ts` es la autoridad de la ruta AVOQADO (emitir,
 * cobrar y entregar dentro de la caja propia). Cuando `AreaTicket.settlementRoute`
 * es `EXTERNAL`, Avoqado nunca ve ese cobro — sólo el rastro operativo de que
 * el papel salió del área y, más adelante, si alguien confirmó, asumió o no
 * cobró ese vale en la otra caja. Todo ESE rastro vive aquí, aparte, porque
 * `areaTicketV7.mobile.service.ts` ya pasa de 2,500 líneas y el cobro externo
 * es un dominio propio y completo (plan "caja externa fase 1 — núcleo").
 *
 * 🔴 La palabra "pagado" no aparece en este archivo. Un cobro externo queda
 * "confirmado" (alguien lo verificó contra la caja externa, Task 7) o
 * "asumido" (se dio por hecho al imprimir, sin verificación) — son cosas
 * DISTINTAS, y esa distinción es la razón de ser de este diseño.
 *
 * Esta tarea (6) implementa sólo el handoff: marcar que el papel salió del
 * área rumbo a la caja externa. `loadExternalTicket` es el guard compartido
 * que las Tasks 7 (confirmar), 8 (marcar no-cobrado) y 9 (cola) reutilizan.
 */

import { AreaSettlementRoute, AreaTicketExternalHandoffState, AreaTicketPrintStatus } from '@prisma/client'

import { logAction } from '../dashboard/activity-log.service'
import prisma from '../../utils/prismaClient'
import { validateStaffVenue } from '../../utils/staff-venue.util'
import { domainError, requireIdempotencyKey, resolveTerminal } from './areaTicketV7.mobile.service'

export interface ExternalSettlementInput {
  idempotencyKey: string
  deviceUid: string
  staffId?: string | null
}

/**
 * Guard compartido (Tasks 6-9): resuelve un vale por id y confirma que vive
 * en la ruta EXTERNAL antes de dejar que cualquier operación de cobro externo
 * lo toque. Incluye `externalSettlement` y `fulfillmentArea` porque confirmar
 * (Task 7), marcar no-cobrado (Task 8) y la cola (Task 9) los van a necesitar
 * — así ninguna de esas tareas tiene que volver a tocar este guard sólo para
 * ensanchar el `include`.
 *
 * Distingue a propósito DOS fallas — "no existe" (404) de "existe pero se
 * cobra en Avoqado" (409) — porque un caller (UI, MCP, job de conciliación)
 * reacciona distinto a cada una: la primera es un id equivocado: la segunda
 * es intentar una operación de cobro externo sobre el vale equivocado.
 */
export async function loadExternalTicket(venueId: string, ticketId: string) {
  const ticket = await prisma.areaTicket.findFirst({
    where: { id: ticketId, venueId },
    include: { externalSettlement: true, fulfillmentArea: true },
  })
  if (!ticket) {
    throw domainError(404, 'AREA_TICKET_NOT_FOUND', 'No encontramos ese vale en este local.')
  }
  if (ticket.settlementRoute !== AreaSettlementRoute.EXTERNAL || !ticket.externalSettlement) {
    throw domainError(409, 'AREA_TICKET_NOT_EXTERNAL', 'Este vale se cobra en Avoqado, no en una caja externa.')
  }
  return ticket
}

/**
 * Marca que el papel salió del área rumbo a la caja externa. Es un hecho
 * FÍSICO, no un cobro: no toca `status` del vale ni ningún campo de
 * confirmación (`confirmedByStaffId`, `confirmedAt`, `externalAmount`... esos
 * son de la Task 7). Exige que el vale ya se haya impreso — sin papel no hay
 * nada que entregar en la otra caja.
 *
 * Idempotente por ESTADO, no por comparar la llave recibida contra una
 * guardada: igual que `cancelAreaTicket` en el archivo v7, una vez que
 * `handoffState` deja `PENDING` cualquier llamada posterior — con cualquier
 * `idempotencyKey` — ve el mismo resultado sin volver a escribir. La llave de
 * ESTA llamada sólo queda en la bitácora para trazabilidad; el schema de
 * `AreaTicketExternalSettlement` no tiene una columna de idempotencia propia
 * para el handoff (su `idempotencyKey` es la del vale, fijada al emitir) así
 * que la columna de estado es el ancla real, igual que en su hermana.
 */
export async function markExternalHandoff(
  venueId: string,
  ticketId: string,
  input: ExternalSettlementInput,
): Promise<{ areaTicketId: string; handoffState: 'HANDED_OFF'; alreadyHandedOff: boolean }> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)

  // 🔴 A propósito NO llama a `assertAreaTicketsEnabled` aquí, a diferencia
  // de sus cuatro hermanas en el archivo v7 que sí lo hacen antes de tocar un
  // vale (`issueAreaTicket:762`, `cancelAreaTicket:946`,
  // `createAreaTicketCheckout:1075`, `materializeAreaTicketCheckout:1144`).
  // No es un descuido: apagar el módulo de vales por área detiene EMISIONES y
  // CLAIMS nuevos, pero un vale que ya se emitió es un compromiso vigente que
  // el local tiene que poder cerrar aunque alguien apague el módulo a media
  // operación. Marcar que el papel salió del área es justo eso — completar
  // algo pendiente, no empezar algo nuevo. Si se agrega el guard aquí, un
  // venue que desactiva vales por área a medio turno deja handoffs en curso
  // sin forma de terminar.
  //
  // Sólo valida que el dispositivo pertenezca a este venue — mismo alcance
  // que `cancelAreaTicket` en el archivo v7. No existe hoy una capacidad de
  // terminal tipo `canSettleExternalTickets`, y el brief no pide una — añadir
  // una restricción que nadie pidió arriesgaba bloquear una llamada legítima.
  await resolveTerminal(venueId, input.deviceUid)
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const ticket = await loadExternalTicket(venueId, ticketId)
  const externalSettlement = ticket.externalSettlement! // el guard ya garantiza que no es null

  if (externalSettlement.handoffState === AreaTicketExternalHandoffState.HANDED_OFF) {
    return { areaTicketId: ticket.id, handoffState: AreaTicketExternalHandoffState.HANDED_OFF, alreadyHandedOff: true }
  }
  if (externalSettlement.handoffState !== AreaTicketExternalHandoffState.PENDING) {
    // Hoy sólo PENDING y HANDED_OFF son alcanzables en producción — ningún
    // código escribe RETURNED todavía (nace en una tarea futura de este
    // mismo plan). Se deja el guard explícito para NUNCA reportar "ya
    // entregado" sobre un vale que en realidad regresó al área: confundir
    // estados es justo el bug que este diseño existe para evitar.
    throw domainError(
      409,
      'AREA_TICKET_HANDOFF_NOT_PENDING',
      `El envío de este vale está en estado ${externalSettlement.handoffState} y no se puede marcar como entregado directamente.`,
    )
  }
  if (ticket.printStatus !== AreaTicketPrintStatus.PRINTED) {
    throw domainError(409, 'AREA_TICKET_NOT_PRINTED', 'Este vale todavía no se imprimió; no hay papel que entregar en la caja externa.')
  }

  // `updateMany` condicionado a PENDING, no un `update` ciego: si dos
  // dispositivos marcan el mismo handoff a la vez, sólo uno afecta una fila.
  // El que pierde la carrera no ve un error — ve el mismo resultado que si
  // hubiera llegado primero (abajo, `count === 0`).
  const written = await prisma.areaTicketExternalSettlement.updateMany({
    where: { areaTicketId: ticket.id, venueId, handoffState: AreaTicketExternalHandoffState.PENDING },
    data: { handoffState: AreaTicketExternalHandoffState.HANDED_OFF },
  })
  if (written.count === 0) {
    return { areaTicketId: ticket.id, handoffState: AreaTicketExternalHandoffState.HANDED_OFF, alreadyHandedOff: true }
  }

  void logAction({
    staffId,
    venueId,
    action: 'AREA_TICKET_EXTERNAL_HANDED_OFF',
    entity: 'AreaTicketExternalSettlement',
    entityId: externalSettlement.id,
    data: { ticketId: ticket.id, code: ticket.code, idempotencyKey },
  })

  return { areaTicketId: ticket.id, handoffState: AreaTicketExternalHandoffState.HANDED_OFF, alreadyHandedOff: false }
}
