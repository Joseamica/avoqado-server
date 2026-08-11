import {
  AreaSettlementRoute,
  AreaTicketExternalIncidentKind,
  AreaTicketExternalIncidentStatus,
  AreaTicketExternalSettlementStatus,
  AreaTicketStatus,
  ExternalConfirmationMode,
  Prisma,
} from '@prisma/client'

import logger from '../config/logger'
import prisma from '../utils/prismaClient'
import { logAction } from '../services/dashboard/activity-log.service'
import { retry, shouldRetryDbConnectionError } from '../utils/retry'
import { scheduleCron } from '../observability/jobContext'
import { DEFAULT_TIMEZONE, venueStartOfDay } from '../utils/datetime'

/**
 * Job de conciliación de cobros externos (plan "caja externa fase 1 — núcleo", Task 12).
 *
 * Un vale `AreaTicket.settlementRoute === EXTERNAL` promete que OTRO POS cobró en su
 * propia caja. Alguien tiene que confirmar en Avoqado que eso de verdad ocurrió — y a
 * veces nadie lo hace: el papel se entrega, el turno cambia, y el vale se queda
 * `AreaTicketExternalSettlement.status === PENDING` para siempre, invisible salvo que
 * alguien recuerde ir a buscarlo. Este job es lo que evita que ese cobro sin confirmar
 * se pierda: al cerrar el día operativo del venue, abre (o reabre) una incidencia
 * `UNCONFIRMED_CHARGE` en `AreaTicketExternalIncident` — la cola de trabajo de oficina
 * — para que una persona lo revise.
 *
 * Sólo mira `ExternalConfirmationMode.MANUAL`. Los `ASSUME_ON_PRINT` no tienen nada que
 * confirmar: esa política se congela al emitir (ver el comentario de `confirmationMode`
 * en `prisma/schema.prisma`) precisamente para que el venue que la eligió no reciba
 * después una tarea que decidió que no hacía falta.
 *
 * 🔴 El corte es el DÍA OPERATIVO DEL VENUE, en SU timezone — nunca UTC. Un vale
 * `issuedAt` dentro del día que sigue abierto (>= `venueStartOfDay(tz)` de HOY en esa
 * zona) no se toca: todavía no "cerró el día", no hay nada que reclamar. Comparar contra
 * un corte de calendario UTC (o `new Date('YYYY-MM-DD')` pelón, que resuelve a
 * medianoche del timezone del HOST) reportaría como "atrasados" vales emitidos esta
 * misma tarde en México, porque en producción el host corre en UTC y ya rodó al día
 * siguiente — ver `.claude/rules/critical-warnings.md`, "bare YYYY-MM-DD es una trampa
 * de timezone en runtime".
 *
 * Idempotente por `@@unique([areaTicketId, kind])`: el `upsert` reabre la MISMA fila
 * (`occurrenceCount++`, `reopenedAt` sellado) en vez de insertar una segunda — correr
 * el job dos veces sobre el mismo vale nunca duplica la incidencia. Mismo mecanismo que
 * usa `confirmExternalSettlement` (Task 7, kind `AMOUNT_VARIANCE`); este job es quien de
 * verdad ejercita la rama de reapertura, porque es el ÚNICO productor de incidencias
 * `UNCONFIRMED_CHARGE` — `markExternalNotCharged` (Task 8) sólo las CIERRA cuando
 * alguien declara que la otra caja nunca cobró.
 */

interface ExternalReconciliationCandidate {
  areaTicketId: string
  venueId: string
  referenceAmount: Prisma.Decimal | string
  venue: { timezone: string }
  areaTicket: { issuedAt: Date; code: string }
}

export async function runAreaTicketExternalReconciliation(): Promise<void> {
  // Candidatos: settlement PENDING + modo MANUAL, con el vale todavía ISSUED en la ruta
  // EXTERNAL. `areaTicket.status: ISSUED` importa de verdad: `cancelAreaTicket`
  // (`areaTicketV7.mobile.service.ts`) NUNCA toca `AreaTicketExternalSettlement` — un
  // vale cancelado con settlement PENDING se queda PENDING para siempre. Sin este
  // filtro, este job reportaría como "cobro sin confirmar" un vale que ya está muerto y
  // no tiene nada que cobrar. Mismo filtro de vale vivo que usa la cola de confirmación
  // (`listPendingExternalConfirmation`, Task 9).
  //
  // Lectura de entrada envuelta en `retry` — `.claude/rules/cron-jobs.md`: al tope de la
  // hora arrancan muchos jobs a la vez y una P1001 transitoria no debe tumbar la corrida.
  const candidates: ExternalReconciliationCandidate[] = await retry(
    () =>
      prisma.areaTicketExternalSettlement.findMany({
        where: {
          status: AreaTicketExternalSettlementStatus.PENDING,
          confirmationMode: ExternalConfirmationMode.MANUAL,
          areaTicket: { status: AreaTicketStatus.ISSUED, settlementRoute: AreaSettlementRoute.EXTERNAL },
        },
        select: {
          areaTicketId: true,
          venueId: true,
          referenceAmount: true,
          venue: { select: { timezone: true } },
          areaTicket: { select: { issuedAt: true, code: true } },
        },
      }),
    {
      retries: 2,
      initialDelay: 1500,
      shouldRetry: shouldRetryDbConnectionError,
      context: 'areaTicketExternalReconciliation.findCandidates',
    },
  )

  if (candidates.length === 0) return

  // El corte depende SÓLO del timezone, no del venue — se calcula una vez por zona y se
  // reusa entre todos los venues que la comparten (casi siempre América/Ciudad de México).
  const cutoffByTimezone = new Map<string, Date>()

  let opened = 0
  for (const settlement of candidates) {
    // `Venue.timezone` es NOT NULL con default en el schema, así que este `||` es
    // cinturón-y-tirantes (mismo patrón defensivo que `auto-clockout.job.ts`), no una
    // rama alcanzable hoy — no existe un venue real "sin timezone" que resolver distinto.
    const timezone = settlement.venue.timezone || DEFAULT_TIMEZONE
    let cutoff = cutoffByTimezone.get(timezone)
    if (!cutoff) {
      cutoff = venueStartOfDay(timezone)
      cutoffByTimezone.set(timezone, cutoff)
    }

    if (settlement.areaTicket.issuedAt >= cutoff) {
      // Emitido dentro del día operativo que SIGUE ABIERTO en la zona del venue —
      // todavía no "cierra el día", nada que reclamar todavía.
      continue
    }

    try {
      const now = new Date()
      const detail = {
        referenceAmount: new Prisma.Decimal(settlement.referenceAmount).toFixed(2),
        issuedAt: settlement.areaTicket.issuedAt.toISOString(),
        code: settlement.areaTicket.code,
      }

      // Una fila VIVA por (vale, tipo): la primera vez es un INSERT liso (el
      // `@@unique([areaTicketId, kind])` no encuentra fila previa); si ya existía —
      // p.ej. la corrida anterior de este mismo job, o alguien la resolvió y volvió a
      // quedar sin confirmar— la REABRE en vez de duplicarla.
      const incident = await prisma.areaTicketExternalIncident.upsert({
        where: { areaTicketId_kind: { areaTicketId: settlement.areaTicketId, kind: AreaTicketExternalIncidentKind.UNCONFIRMED_CHARGE } },
        create: {
          venueId: settlement.venueId,
          areaTicketId: settlement.areaTicketId,
          kind: AreaTicketExternalIncidentKind.UNCONFIRMED_CHARGE,
          status: AreaTicketExternalIncidentStatus.OPEN,
          detail,
        },
        update: {
          status: AreaTicketExternalIncidentStatus.OPEN,
          detail,
          occurrenceCount: { increment: 1 },
          reopenedAt: now,
        },
      })
      opened++

      // Sistema, no una persona — `staffId: null` es correcto aquí, no un dato que falta.
      // Fuera de cualquier transacción (no hay ninguna en este bloque) y fire-and-forget,
      // como el resto de la auditoría de este dominio (`logAction` nunca lanza).
      void logAction({
        action: 'AREA_TICKET_EXTERNAL_UNCONFIRMED_CHARGE_DETECTED',
        entity: 'AreaTicketExternalIncident',
        entityId: incident.id,
        staffId: null,
        venueId: settlement.venueId,
        data: { areaTicketId: settlement.areaTicketId, ...detail },
      })
    } catch (err) {
      // Aislado por vale (mismo patrón que `delivery-webhook-reconciliation.job.ts` y
      // `auto-clockout.job.ts`): un fallo transitorio de escritura en UN vale no debe
      // abortar el resto de la corrida — el vale que falló se reintenta solo, en el
      // próximo tick, porque sigue apareciendo en `candidates` mientras siga PENDING.
      logger.error('[Area Ticket External Reconciliation] No se pudo abrir/reabrir la incidencia de un vale', {
        areaTicketId: settlement.areaTicketId,
        venueId: settlement.venueId,
        error: err instanceof Error ? err.message : err,
      })
    }
  }

  if (opened > 0) {
    logger.warn(`[Area Ticket External Reconciliation] Abrió/reabrió ${opened} incidencia(s) UNCONFIRMED_CHARGE`)
  }
}

export function startAreaTicketExternalReconciliationJob(): void {
  logger.info('[Area Ticket External Reconciliation] ⏰ Job started. Runs hourly at :17.')
  // ':17', no ':00' — evita el tope de hora donde arrancan casi todos los demás jobs a
  // la vez (`.claude/rules/cron-jobs.md`); reusa el mismo minuto "seguro" que ya usan
  // varios jobs vecinos (p.ej. los de `*/6`/`*/12` horas). Cadencia horaria, igual que
  // `venue-chat-inactivity-cleanup` (mismo tipo de trabajo: barrer filas que cruzaron un
  // umbral) — alcanza para detectar el cierre del día operativo de cualquier venue
  // dentro de la hora siguiente a su medianoche local, sin importar en qué timezone esté.
  scheduleCron('area-ticket-external-reconciliation', '17 * * * *', () => {
    runAreaTicketExternalReconciliation().catch(err => {
      logger.error('[Area Ticket External Reconciliation] Job iteration failed', { err })
    })
  })
}
