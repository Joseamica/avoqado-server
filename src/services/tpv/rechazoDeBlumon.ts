/**
 * D26 · el rechazo que avisa Blumon cierra solo el cobro de la tablet (Testarudo, 22-nov-2026).
 *
 * El incidente: la PAX recibió el cobro de la tablet ($215 + $21.50), el banco lo rechazó a las 09:25:18 y Blumon NOS AVISÓ a las
 * 09:25:19 («12 TRANSACCION NO PERMITIDA», `amount = "236.50"`). El SERVIDOR guardó el aviso como `NOT_APPROVED` y no hizo nada: la
 * tablet canceló, la terminal siguió diciendo «sigo cobrando» 25 min y la venta sólo se cerró cuando una persona declaró «no se
 * cobró». Founder: «si nos dicen rechazado, ¿por qué congelar el pago?» y «que lo pueda volver a intentar con la misma tarjeta».
 *
 * Dos piezas, con la decisión medida del 21-sep (aquí abajo) acotada en vez de tirada:
 *
 *  1. ANOTAR (`anotarRechazoDeBlumon`, lo llama el receptor de Blumon). Blumon no devuelve nuestra llave, así que la correlación es la
 *     RANURA: una terminal sólo tiene un cobro de la tablet en vuelo (índice único). El 21-sep se midió que emparejar «por importe en
 *     15 minutos» falla 1 de cada 8; aquí la correlación es mucho más estrecha y se decide en UN `UPDATE`: la solicitud que en ESE
 *     instante ocupa la ranura de esa terminal exacta, ya entregada, con el importe EXACTO (monto + propina) y con la hora del banco
 *     estrictamente posterior al segundo de su creación. Medido en producción (60 d, 117 solicitudes a PAX): 0 rechazos en la solicitud equivocada y la hora del
 *     banco llega 0.6–2.1 s antes que el aviso, nunca adelantada (`docs/audit/2026-11-22-terminal-sigue-cobrando/` del workspace).
 *
 *  2. CERRAR (`cerrarVentaPorRechazoDeBlumon`). Nunca en el instante del aviso: la PAX ofrece «Reintentar» ahí mismo. Se cierra
 *     `FAILED/BANK_DECLINED` por el MISMO núcleo que AngelPay (`reconcileBankDeclined` → `reconcileUncharged`: candados, CAS, vetos de
 *     dinero, asiento) cuando la tablet ya soltó ese cobro (el POS lo canceló) o la terminal certificó el cese, la terminal no anuncia
 *     intentos (la PAX no lo hace; con vínculos el rechazo de uno no habla por los demás) y NO llegó un aviso APROBADO del mismo
 *     importe y terminal después del rechazo. Founder (22-nov, «A todo automático»): la cuenta libre pronto; un aprobado posterior
 *     gana: su `Payment` concilia la venta a COMPLETED y grita 🚨 (detección y aviso, no un veto de más).
 *
 * Lo disparan: el receptor al anotar, la respuesta de la terminal al cancel del POS, el sello del cese (A3) y el vigía (la red).
 */
import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { terminalIdentityKey } from '../../utils/terminalSerial'
import { utcTs } from '../../utils/sqlDates'
import { sondaReportoActiva } from './sondaActiva'

/** `dateTransaction` de Blumon: `dd/MM/yyyy HH:mm:ss`, hora local de la terminal. */
const HORA_DEL_BANCO = /^\d{2}\/\d{2}\/\d{4} \d{2}:\d{2}:\d{2}$/
const IMPORTE = /^\d{1,9}(\.\d{1,2})?$/
/** Cuánto mira atrás el vigía (un rechazo anotado se cierra en segundos; lo que pase de un día lo resuelve una persona). */
const VENTANA_DEL_BARRIDO_MS = 24 * 60 * 60_000
const TOPE_DEL_BARRIDO = 20
/** Codex r1 #4: el barrido corre dentro del vigía de 30 s; si los candados están ocupados, no lo retrasa más de esto. */
const PRESUPUESTO_DEL_BARRIDO_MS = 5_000
/** Estados en los que el cierre puede aplicar (el núcleo revalida todo bajo candado). */
const ESTADOS_CERRABLES: TerminalPaymentRequestStatus[] = [
  TerminalPaymentRequestStatus.CANCEL_REQUESTED,
  TerminalPaymentRequestStatus.UNKNOWN,
  TerminalPaymentRequestStatus.TIMED_OUT,
]

/** `"236.50"` → 23650. Cualquier otra forma ⇒ `null` (no se anota: lado seguro). */
export function centavosDelAviso(amount: unknown): number | null {
  if (typeof amount !== 'string' || !IMPORTE.test(amount)) return null
  const [enteros, decimales = ''] = amount.split('.')
  return Number(enteros) * 100 + Number(decimales.padEnd(2, '0'))
}

/**
 * Anota el rechazo en la solicitud que ocupa AHORA la ranura de esa terminal con ese importe exacto. Devuelve la solicitud anotada o
 * `null`. Una sola escritura y sólo la primera vez (un segundo rechazo de la misma venta no cambia nada). No toca `updatedAt`.
 * Puede lanzar (base caída, una hora imposible): quien llama lo atrapa y el aviso queda guardado como hoy.
 */
export async function anotarRechazoDeBlumon(input: {
  eventLogId: string
  terminal: { serialNumber: string | null } | null
  payload: { operationType?: unknown; amount?: unknown; dateTransaction?: unknown }
}): Promise<{ requestId: string; venueId: string } | null> {
  const { eventLogId, terminal, payload } = input
  // Sólo una VENTA: una devolución o cancelación rechazada es al revés (el cargo sigue vigente).
  if (payload.operationType !== 'VENTA' || !terminal?.serialNumber) return null
  const centavos = centavosDelAviso(payload.amount)
  const hora = typeof payload.dateTransaction === 'string' ? payload.dateTransaction : ''
  if (!centavos || !HORA_DEL_BANCO.test(hora)) return null
  const filas = await prisma.$queryRaw<{ requestId: string; venueId: string }[]>`
    UPDATE "TerminalPaymentRequest" r SET "bankDeclineEventLogId" = ${eventLogId}
    FROM "Venue" v
    WHERE v."id" = r."venueId"
      AND r."terminalId" = ${terminalIdentityKey(terminal.serialNumber)}
      AND r."status" IN ('PENDING', 'SENT', 'CANCEL_REQUESTED', 'UNKNOWN')
      AND r."bankDeclineEventLogId" IS NULL
      AND (r."acknowledgedAt" IS NOT NULL OR r."lastDeliveredAt" IS NOT NULL)
      AND r."amountCents" + r."tipCents" = ${centavos}
      -- Codex r0 #2: ESTRICTAMENTE después del segundo en que se creó (la hora del banco viene truncada al segundo). Un rechazo de la
      -- solicitud anterior del mismo importe que cae en ese mismo segundo no se le cuelga a ésta; el suyo propio tarda segundos
      -- (entrega, tarjeta, autorización: 7 s en el incidente) y la hora del banco nunca va adelantada (medido: 0.6–2.1 s atrás).
      AND (to_timestamp(${hora}, 'DD/MM/YYYY HH24:MI:SS')::timestamp AT TIME ZONE v."timezone") AT TIME ZONE 'UTC'
          > date_trunc('second', r."createdAt")
      -- Codex r1 #1: y nunca en el futuro. La hora local repetida del cambio de horario (Tijuana) se lee una hora después; medido,
      -- la hora del banco llega 0.6–2.1 s ANTES que el aviso, así que una hora posterior a la recepción no es de esta venta.
      AND (to_timestamp(${hora}, 'DD/MM/YYYY HH24:MI:SS')::timestamp AT TIME ZONE v."timezone") AT TIME ZONE 'UTC'
          <= (NOW() AT TIME ZONE 'UTC') + interval '2 seconds'
    RETURNING r."requestId", r."venueId"`
  return filas[0] ?? null
}

/**
 * «Llegó un aviso APROBADO de Blumon de la misma terminal y el mismo importe DESPUÉS del rechazo anotado, y nadie lo ligó a un pago»:
 * el rechazo ya no es la última palabra del banco (fue el «Reintentar» que pasó). Correlacionada con la fila (`fila` es una referencia
 * a `"TerminalPaymentRequest"` escrita en el código, nunca entrada), para ir igual en la lectura y en el CAS del núcleo.
 */
export function aprobadoTrasElRechazoSql(fila: Prisma.Sql): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM "ProviderEventLog" rechazo, "ProviderEventLog" e
    WHERE rechazo."id" = ${fila}."bankDeclineEventLogId"
      AND e."provider" = 'PAYMENT_PROCESSOR' AND e."type" = 'VENTA' AND e."paymentId" IS NULL
      AND e."terminalId" = rechazo."terminalId"
      AND e."createdAt" >= rechazo."createdAt" AND e."id" <> rechazo."id"
      AND COALESCE(nullif(e."payload"->>'codeResponse', ''), '00') = '00'
      AND (CASE WHEN e."payload"->>'amount' ~ '^[0-9]{1,9}(\\.[0-9]{1,2})?$'
                THEN round((e."payload"->>'amount')::numeric * 100) END) = ${fila}."amountCents" + ${fila}."tipCents")`
}

/**
 * ¿El rechazo anotado ya cierra la venta? Lo decide el núcleo (`reconcileUncharged`, rama BLUMON) dentro de su transacción.
 *  · la anotación es ESE aviso (nadie más escribe la columna);
 *  · la terminal no anuncia intentos (`attemptIds` del núcleo; la PAX no los anuncia);
 *  · ya no se espera otro intento de la TABLET: el POS canceló ese cobro (y la terminal ya recibió el cancel o pasó su gracia), o la
 *    terminal certificó el cese sin un «sigo» posterior.
 * El aviso APROBADO posterior va aparte (`aprobadoTrasElRechazoSql`), en la lectura y en el CAS.
 */
export function elRechazoDeBlumonCierra(
  row: {
    status: TerminalPaymentRequestStatus
    cancelDisposition?: string | null
    bankDeclineEventLogId?: string | null
    cancelRequestedAt?: Date | null
    executionClosedAt?: Date | null
    probeActiveAt?: Date | null
    probeResolvedAt?: Date | null
    resultJson?: unknown
  },
  eventLogId: string | undefined,
  attemptIds: readonly string[],
): boolean {
  if (!eventLogId || row.bankDeclineEventLogId !== eventLogId || attemptIds.length > 0) return false
  // Codex r1 #2: con la fila todavía en `CANCEL_REQUESTED`, sólo si la terminal YA recibió el cancel (contestó «sigo»). Si no lo
  // recibió (sin red), se conserva la gracia en la que el SERVIDOR se lo reenvía al reconectar; después de la gracia cierra el vigía.
  const laTabletLoSolto =
    Boolean(row.cancelRequestedAt) && (row.status !== TerminalPaymentRequestStatus.CANCEL_REQUESTED || row.cancelDisposition === 'ACTIVE')
  return laTabletLoSolto || (Boolean(row.executionClosedAt) && !sondaReportoActiva(row))
}

/**
 * Cierra la venta `FAILED/BANK_DECLINED` si su rechazo anotado ya lo permite. Nunca lanza (un webhook o un socket que lanza no
 * ayuda a nadie); la siguiente pasada del vigía lo vuelve a intentar.
 */
export async function cerrarVentaPorRechazoDeBlumon(fila: { requestId: string; venueId: string }): Promise<boolean> {
  try {
    const row = await prisma.terminalPaymentRequest.findFirst({
      where: { requestId: fila.requestId, venueId: fila.venueId },
      select: { status: true, bankDeclineEventLogId: true, cancelRequestedAt: true, executionClosedAt: true, paymentId: true },
    })
    if (!row?.bankDeclineEventLogId || row.paymentId || !ESTADOS_CERRABLES.includes(row.status)) return false
    if (!row.cancelRequestedAt && !row.executionClosedAt) return false
    const evento = await prisma.providerEventLog.findUnique({ where: { id: row.bankDeclineEventLogId }, select: { payload: true } })
    const p = (evento?.payload ?? {}) as Record<string, unknown>
    const descripcion = [p.codeResponse, p.descriptionResponse].filter(s => typeof s === 'string' && s.trim()).join(' ')
    const { reconcileBankDeclined } = await import('./uncharged-reconciliation.service')
    const r = await reconcileBankDeclined({
      venueId: fila.venueId,
      requestId: fila.requestId,
      origen: 'BLUMON',
      evidencia: { eventLogId: row.bankDeclineEventLogId, descripcion: descripcion || null },
    })
    logger.info(
      r.closed
        ? '🔓 [Blumon] El banco rechazó el cobro de la tablet: la venta y la terminal quedaron libres'
        : 'ℹ️ [Blumon] Rechazo del banco anotado, todavía sin cerrar la venta',
      { requestId: fila.requestId, venueId: fila.venueId, eventLogId: row.bankDeclineEventLogId, closed: r.closed, reason: r.reason },
    )
    return r.closed
  } catch (err) {
    logger.warn('⚠️ [Blumon] No se pudo cerrar la venta por el rechazo del banco — el vigía lo reintenta', {
      requestId: fila.requestId,
      venueId: fila.venueId,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}

/**
 * La red durable (vigía, cada 30 s): solicitudes con un rechazo anotado que ya podrían cerrarse y no se cerraron (un candado ocupado,
 * un reinicio entre el disparo y el cierre). Acotada a un día, a 20 filas y a 5 s por pasada.
 * ponytail: sin cursor; si alguna vez hay más de 50 vetadas a la vez (aprobado posterior), poner un cursor como el del techo.
 */
export async function barrerRechazosDeBlumon(ahora: Date = new Date()): Promise<{ cerradas: number; revisadas: number }> {
  const filas = await prisma.$queryRaw<{ requestId: string; venueId: string }[]>`
    SELECT "requestId", "venueId" FROM "TerminalPaymentRequest"
    WHERE "status" IN ('CANCEL_REQUESTED', 'UNKNOWN', 'TIMED_OUT')
      AND "createdAt" >= ${utcTs(new Date(ahora.getTime() - VENTANA_DEL_BARRIDO_MS))}
      AND "bankDeclineEventLogId" IS NOT NULL AND "paymentId" IS NULL
      AND ("cancelRequestedAt" IS NOT NULL OR "executionClosedAt" IS NOT NULL)
      AND ("status" <> 'CANCEL_REQUESTED' OR "cancelDisposition" = 'ACTIVE')
      AND NOT EXISTS (SELECT 1 FROM "TerminalPaymentAttemptLink" l WHERE l."requestId" = "TerminalPaymentRequest"."requestId")
      AND NOT ${aprobadoTrasElRechazoSql(Prisma.raw('"TerminalPaymentRequest"'))}
    ORDER BY "createdAt" ASC, "id" ASC
    LIMIT ${TOPE_DEL_BARRIDO}`
  const inicio = Date.now()
  let cerradas = 0
  let revisadas = 0
  for (const f of filas) {
    if (Date.now() - inicio > PRESUPUESTO_DEL_BARRIDO_MS) break // el resto, en la siguiente pasada
    revisadas += 1
    if (await cerrarVentaPorRechazoDeBlumon(f)) cerradas += 1
  }
  return { cerradas, revisadas }
}
