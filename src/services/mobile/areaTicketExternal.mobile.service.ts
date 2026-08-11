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

import {
  AreaSettlementRoute,
  AreaTicketExternalHandoffState,
  AreaTicketExternalIncidentKind,
  AreaTicketExternalIncidentStatus,
  AreaTicketExternalSettlementStatus,
  AreaTicketPrintStatus,
  AreaTicketStatus,
  Prisma,
} from '@prisma/client'

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
  // `createAreaTicketCheckout:1075`, `addTicketToCheckout:1144`).
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

export interface ConfirmExternalSettlementInput extends ExternalSettlementInput {
  externalAmount?: string | null // decimal string en pesos, p.ej. "168.00"
  externalReference?: string | null
  notes?: string | null
}

interface ConfirmExternalSettlementResult {
  areaTicketId: string
  status: 'CONFIRMED' | 'DISCREPANCY'
  referenceAmount: string
  externalAmount: string | null
  variance: string | null
  alreadyConfirmed: boolean
}

/**
 * Arma la respuesta idempotente a partir de una fila YA resuelta (CONFIRMED o
 * DISCREPANCY). Se usa en dos momentos: si al leer el settlement ya venía
 * resuelto (alguien lo confirmó antes), o si perdimos la carrera contra otro
 * dispositivo confirmando el MISMO vale entre nuestra lectura y nuestro
 * intento de escritura — en ambos casos se reporta lo que de verdad quedó
 * guardado, nunca el intento propio.
 */
function buildAlreadyConfirmedResult(
  areaTicketId: string,
  // `status` viaja SEPARADO del objeto `settlement` (no como su campo) a
  // propósito: TS no propaga el narrowing de `settlement.status === X` al
  // tipo del objeto `settlement` completo cuando ese objeto se pasa entero a
  // otra función (limitación conocida de control-flow analysis) — pero SÍ
  // preserva el narrowing de la EXPRESIÓN `settlement.status` leída de nuevo
  // en el sitio de la llamada. Pasarlo aparte es lo que hace que el llamador
  // no pueda pasar cualquier string; tiene que venir de un narrowing real.
  status: 'CONFIRMED' | 'DISCREPANCY',
  settlement: {
    referenceAmount: Prisma.Decimal
    externalAmount: Prisma.Decimal | null
  },
): ConfirmExternalSettlementResult {
  const reference = new Prisma.Decimal(settlement.referenceAmount)
  const external = settlement.externalAmount === null ? null : new Prisma.Decimal(settlement.externalAmount)
  return {
    areaTicketId,
    status,
    referenceAmount: reference.toFixed(2),
    externalAmount: external === null ? null : external.toFixed(2),
    variance: external === null ? null : external.sub(reference).toFixed(2),
    alreadyConfirmed: true,
  }
}

/**
 * El momento en que UNA PERSONA afirma que la caja externa cobró este vale —
 * y, si captura el importe real, calcula la diferencia contra lo que Avoqado
 * había calculado (`referenceAmount`, congelado al emitir). Avoqado nunca vio
 * ese dinero: esta función NUNCA produce un `Payment` ni usa la palabra
 * "pagado" — el resultado es "cobro confirmado" (importes iguales, o sin
 * importe capturado) o "cobro asumido con discrepancia" (importes distintos).
 *
 * Una discrepancia abre una incidencia pero NO bloquea nada — el producto ya
 * se cobró en la otra caja; retenerlo castigaría al cliente por un error
 * de captura (la Task 10 hace explícita esa no-obstrucción en la entrega).
 */
export async function confirmExternalSettlement(
  venueId: string,
  ticketId: string,
  input: ConfirmExternalSettlementInput,
): Promise<ConfirmExternalSettlementResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)

  // Mismo alcance que `markExternalHandoff`: sólo valida que el dispositivo
  // pertenezca a este venue. A diferencia del handoff, aquí `terminal.id` SÍ
  // se usa más abajo — queda grabado en `terminalId` (desde qué caja se
  // confirmó), no es sólo una validación de pertenencia.
  const terminal = await resolveTerminal(venueId, input.deviceUid)
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const ticket = await loadExternalTicket(venueId, ticketId)
  const settlement = ticket.externalSettlement! // el guard ya garantiza que no es null

  if (ticket.status !== AreaTicketStatus.ISSUED) {
    // En la ruta EXTERNAL, el CHECK de la Task 2 impide que `status` llegue a
    // CLAIMED/PAID/DELIVERED — la entrega (Task 10) se lee del
    // `AreaTicketFulfillment`, no de `status`. Así que si no es ISSUED aquí,
    // sólo puede ser CANCELLED o EXPIRED: un vale muerto, nada que confirmar.
    // Mismo código y mensaje que usa el resto de este dominio para "vale
    // muerto" (`areaTicketV7.mobile.service.ts`).
    throw domainError(409, 'AREA_TICKET_NOT_ISSUED', `Este vale está en estado ${ticket.status}.`)
  }

  if (
    settlement.status === AreaTicketExternalSettlementStatus.CONFIRMED ||
    settlement.status === AreaTicketExternalSettlementStatus.DISCREPANCY
  ) {
    // Idempotente por ESTADO, igual que `markExternalHandoff`: NO compara la
    // `idempotencyKey` recibida contra ninguna guardada. La columna
    // `idempotencyKey` de esta fila es la de EMITIR (fijada en la Task 6);
    // confirmar no tiene una columna de idempotencia propia, así que el
    // ancla real es `status` saliendo de PENDING.
    return buildAlreadyConfirmedResult(ticket.id, settlement.status, settlement)
  }
  if (settlement.status !== AreaTicketExternalSettlementStatus.PENDING) {
    // ASSUMED / NOT_CHARGED: los produce OTRA operación (un "asumido"
    // automático futuro, y `markExternalNotCharged` de la Task 8,
    // respectivamente) — no ésta. Esta función SÓLO puede terminar en
    // CONFIRMED o DISCREPANCY; fingir uno de esos dos sobre un cobro que ya
    // se resolvió de otra forma sería mentir sobre qué pasó.
    throw domainError(
      409,
      'AREA_TICKET_EXTERNAL_SETTLEMENT_NOT_PENDING',
      `El cobro de este vale ya se resolvió como ${settlement.status} y no se puede confirmar.`,
    )
  }

  // Cuantiza a 2 decimales ANTES de comparar — no después. Sin esto, "168.001"
  // contra referenceAmount "168.00" da variance.isZero() === false (DISCREPANCY)
  // mientras que variance.toFixed(2) y external.toFixed(2) muestran "0.00" /
  // "168.00": la respuesta y la incidencia dirían "hay discrepancia" con
  // importes idénticos, y Postgres redondea la columna Decimal(12,2) al
  // guardar de todos modos — lo persistido tampoco cuadraría con lo devuelto.
  // Cuantizar aquí, una sola vez, hace que el estado, la variación expuesta,
  // lo escrito en la fila y lo auditado salgan del MISMO número.
  // ROUND_HALF_UP porque es el redondeo comercial estándar (0.005 sube a
  // 0.01) y el que ya usa el resto del dinero en este repo
  // (`parsePositiveDecimal` en este mismo archivo hermano, `money.ts`,
  // `recipe-cost-calculator.ts`) — usar otro modo aquí sería la única fuente
  // de dinero del sistema que redondea distinto.
  const reference = new Prisma.Decimal(settlement.referenceAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const external =
    input.externalAmount == null ? null : new Prisma.Decimal(input.externalAmount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
  const variance = external === null ? null : external.sub(reference)
  const status =
    variance !== null && !variance.isZero() ? AreaTicketExternalSettlementStatus.DISCREPANCY : AreaTicketExternalSettlementStatus.CONFIRMED

  // `variance` se DERIVA de referenceAmount y externalAmount, no se persiste:
  // una columna calculada que se puede desincronizar de sus dos insumos es
  // una fuente de mentiras. Se formatea UNA vez aquí y se reutiliza para la
  // respuesta, la incidencia y la bitácora, para que los tres nunca diverjan.
  const referenceAmount = reference.toFixed(2)
  const externalAmount = external === null ? null : external.toFixed(2)
  const variancePesos = variance === null ? null : variance.toFixed(2)
  const now = new Date()
  const externalReference = input.externalReference?.trim() || null
  const notes = input.notes?.trim() || null

  const wroteHere = await prisma.$transaction(async tx => {
    // `updateMany` condicionado a PENDING — no un `update` ciego — por la
    // misma razón que el handoff: dos dispositivos confirmando el MISMO vale
    // a la vez sólo dejan escribir a uno.
    const result = await tx.areaTicketExternalSettlement.updateMany({
      where: { areaTicketId: ticket.id, venueId, status: AreaTicketExternalSettlementStatus.PENDING },
      data: {
        status,
        externalAmount: external,
        externalReference,
        notes,
        confirmedByStaffId: staffId ?? null,
        confirmedAt: now,
        terminalId: terminal.id,
      },
    })
    if (result.count === 0) return false

    if (status === AreaTicketExternalSettlementStatus.DISCREPANCY) {
      // Una fila VIVA por (vale, tipo): si ya existía (p.ej. reabierta por el
      // job de conciliación de la Task 12 antes de que alguien volviera a
      // confirmar), esto la REABRE en vez de duplicarla — mismo `detail`
      // actualizado, `occurrenceCount` +1, `reopenedAt` pisado a ahora. La
      // primera vez (el caso normal de ESTA función) es un INSERT liso,
      // porque el `@@unique([areaTicketId, kind])` no encuentra fila previa.
      await tx.areaTicketExternalIncident.upsert({
        where: { areaTicketId_kind: { areaTicketId: ticket.id, kind: AreaTicketExternalIncidentKind.AMOUNT_VARIANCE } },
        create: {
          venueId,
          areaTicketId: ticket.id,
          kind: AreaTicketExternalIncidentKind.AMOUNT_VARIANCE,
          status: AreaTicketExternalIncidentStatus.OPEN,
          detail: { referenceAmount, externalAmount, variance: variancePesos },
        },
        update: {
          status: AreaTicketExternalIncidentStatus.OPEN,
          detail: { referenceAmount, externalAmount, variance: variancePesos },
          occurrenceCount: { increment: 1 },
          reopenedAt: now,
        },
      })
    }
    return true
  })

  if (!wroteHere) {
    // Perdimos la carrera: alguien más confirmó este MISMO vale entre nuestra
    // lectura (arriba) y nuestro intento de escritura. Releer y responder con
    // lo que de verdad quedó guardado — nunca con nuestro propio intento.
    const fresh = await prisma.areaTicketExternalSettlement.findUniqueOrThrow({ where: { areaTicketId: ticket.id } })
    if (fresh.status !== AreaTicketExternalSettlementStatus.CONFIRMED && fresh.status !== AreaTicketExternalSettlementStatus.DISCREPANCY) {
      // Defensivo: hoy inalcanzable (nada más escribe este settlement entre
      // nuestra lectura y nuestra escritura salvo otra confirmación), pero si
      // algún día lo fuera, seguimos sin poder fingir CONFIRMED/DISCREPANCY.
      throw domainError(
        409,
        'AREA_TICKET_EXTERNAL_SETTLEMENT_NOT_PENDING',
        `El cobro de este vale ya se resolvió como ${fresh.status} y no se puede confirmar.`,
      )
    }
    return buildAlreadyConfirmedResult(ticket.id, fresh.status, fresh)
  }

  void logAction({
    action: 'AREA_TICKET_EXTERNAL_CHARGE_CONFIRMED',
    entity: 'AreaTicketExternalSettlement',
    entityId: settlement.id,
    staffId: staffId ?? null,
    venueId,
    data: { areaTicketId: ticket.id, idempotencyKey, referenceAmount, externalAmount, variance: variancePesos, status },
  })

  return {
    areaTicketId: ticket.id,
    status,
    referenceAmount,
    externalAmount,
    variance: variancePesos,
    alreadyConfirmed: false,
  }
}

export interface MarkExternalNotChargedInput extends ExternalSettlementInput {
  reason: string
}

interface MarkExternalNotChargedResult {
  areaTicketId: string
  status: 'NOT_CHARGED'
}

/**
 * El momento en que UNA PERSONA afirma que la caja externa NUNCA cobró este
 * vale — el papel salió del área, pero el cliente no pasó por la otra caja.
 * Es la salida para un vale que, si no, queda varado: `cancelAreaTicket`
 * bloquea cualquier estado que "suene" a cobrado (`YA_COBRADO_AFUERA` en el
 * archivo hermano, ensanchado en esta misma tarea para incluir `ASSUMED`), y
 * sin esta función nada puede sacar a un vale `ASSUMED` de ahí.
 *
 * 🔴 Esto NO cancela el vale ni revierte inventario — son decisiones DISTINTAS
 * que toma una persona: declarar "no se cobró" es un hecho sobre el pasado;
 * cancelar es qué hacer con el inventario ahora. El vale queda `ISSUED` con el
 * cobro en `NOT_CHARGED`; quien decida cancelarlo (y disparar la reversa) lo
 * hace después, explícitamente, por `cancelAreaTicket` — que con el settlement
 * ya en `NOT_CHARGED` deja de bloquear.
 */
export async function markExternalNotCharged(
  venueId: string,
  ticketId: string,
  input: MarkExternalNotChargedInput,
): Promise<MarkExternalNotChargedResult> {
  const idempotencyKey = requireIdempotencyKey(input.idempotencyKey)
  const reason = input.reason?.trim()
  if (!reason) {
    // Es una afirmación que alguien va a auditar — sin motivo no queda rastro
    // de POR QUÉ se declaró que la otra caja nunca cobró.
    throw domainError(
      400,
      'REASON_REQUIRED',
      'Escribe por qué este vale no se cobró en la caja externa — es una afirmación que alguien tendrá que auditar.',
    )
  }

  // Mismo alcance que `markExternalHandoff` y `confirmExternalSettlement`:
  // sólo valida que el dispositivo pertenezca a este venue.
  await resolveTerminal(venueId, input.deviceUid)
  const staffId = await validateStaffVenue(input.staffId ?? undefined, venueId)

  const ticket = await loadExternalTicket(venueId, ticketId)
  const settlement = ticket.externalSettlement! // el guard ya garantiza que no es null

  if (ticket.status !== AreaTicketStatus.ISSUED) {
    // Mismo razonamiento que `confirmExternalSettlement`: en la ruta EXTERNAL
    // sólo ISSUED/CANCELLED/EXPIRED son alcanzables aquí. Si no es ISSUED, el
    // vale ya está muerto — nada que declarar sobre su cobro.
    throw domainError(409, 'AREA_TICKET_NOT_ISSUED', `Este vale está en estado ${ticket.status}.`)
  }

  if (settlement.status === AreaTicketExternalSettlementStatus.NOT_CHARGED) {
    // Idempotente por ESTADO, igual que el resto de este archivo — no compara
    // la idempotencyKey recibida contra ninguna guardada.
    return { areaTicketId: ticket.id, status: AreaTicketExternalSettlementStatus.NOT_CHARGED }
  }
  if (
    settlement.status === AreaTicketExternalSettlementStatus.CONFIRMED ||
    settlement.status === AreaTicketExternalSettlementStatus.DISCREPANCY
  ) {
    // Alguien YA afirmó que la otra caja cobró (con o sin diferencia de
    // importe) — declarar "no se cobró" encima de eso contradiría esa
    // afirmación en vez de corregirla. Mismo código que usa `cancelAreaTicket`
    // para el mismo hecho.
    throw domainError(
      409,
      'AREA_TICKET_EXTERNAL_ALREADY_CHARGED',
      'Este vale ya se cobró en la caja externa. No se puede declarar que no se cobró.',
    )
  }
  // Sólo quedan PENDING o ASSUMED — ambos elegibles. ASSUMED es exactamente el
  // caso que esta función existe para resolver: un cobro que se dio por hecho
  // sin que nadie lo verificara.

  const now = new Date()

  const wroteHere = await prisma.$transaction(async tx => {
    // `updateMany` condicionado, no un `update` ciego — mismo patrón que sus
    // hermanas: si dos dispositivos declaran "no cobrado" al mismo tiempo,
    // sólo uno afecta una fila.
    const result = await tx.areaTicketExternalSettlement.updateMany({
      where: {
        areaTicketId: ticket.id,
        venueId,
        status: { in: [AreaTicketExternalSettlementStatus.PENDING, AreaTicketExternalSettlementStatus.ASSUMED] },
      },
      data: { status: AreaTicketExternalSettlementStatus.NOT_CHARGED },
    })
    if (result.count === 0) return false

    // Si había una incidencia de "cobro sin confirmar" abierta, esta
    // declaración la resuelve: ya no está sin confirmar, alguien confirmó que
    // NO se cobró. `updateMany` (no `update`) porque puede no existir — hoy
    // ningún código produce todavía esta incidencia, así que "si existe" es
    // literal; que el `count` resultante sea 0 no es un error.
    await tx.areaTicketExternalIncident.updateMany({
      where: {
        areaTicketId: ticket.id,
        venueId,
        kind: AreaTicketExternalIncidentKind.UNCONFIRMED_CHARGE,
        status: AreaTicketExternalIncidentStatus.OPEN,
      },
      data: {
        status: AreaTicketExternalIncidentStatus.RESOLVED,
        resolvedAt: now,
        resolvedByStaffId: staffId ?? null,
        resolution: reason,
      },
    })
    return true
  })

  if (!wroteHere) {
    // Perdimos la carrera: el settlement cambió entre nuestra lectura y
    // nuestro intento de escritura. Releer y responder con lo que de verdad
    // quedó guardado — nunca con nuestro propio intento.
    const fresh = await prisma.areaTicketExternalSettlement.findUniqueOrThrow({ where: { areaTicketId: ticket.id } })
    if (fresh.status === AreaTicketExternalSettlementStatus.NOT_CHARGED) {
      return { areaTicketId: ticket.id, status: AreaTicketExternalSettlementStatus.NOT_CHARGED }
    }
    // Alguien más lo confirmó (CONFIRMED/DISCREPANCY) en el mismo instante:
    // seguimos sin poder fingir NOT_CHARGED sobre eso.
    throw domainError(
      409,
      'AREA_TICKET_EXTERNAL_ALREADY_CHARGED',
      'Este vale ya se cobró en la caja externa. No se puede declarar que no se cobró.',
    )
  }

  void logAction({
    staffId,
    venueId,
    action: 'AREA_TICKET_EXTERNAL_MARKED_NOT_CHARGED',
    entity: 'AreaTicketExternalSettlement',
    entityId: settlement.id,
    data: { ticketId: ticket.id, code: ticket.code, reason, idempotencyKey },
  })

  return { areaTicketId: ticket.id, status: AreaTicketExternalSettlementStatus.NOT_CHARGED }
}
