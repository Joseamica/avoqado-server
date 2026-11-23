/**
 * D26 · el TECHO a «sigo cobrando» tras el cancel del POS (Testarudo, 22-nov-2026).
 *
 * El incidente: la tablet canceló el cobro y la terminal (TPV 2.16.0 y 2.20.0) contestó a cada sonda «sigo cobrando» durante 25 y
 * 8 min. La pantalla del cobro había muerto con la app viva y su propiedad quedó en memoria: el «residuo aceptado» de
 * `RemotePaymentInbox.respuestaEnProceso` (TPV). El SERVIDOR retuvo la RANURA todo ese tiempo y vetó el «no se cobró» de la cajera.
 *
 * Prioridad del founder (22-nov): «me preocupa que se congelen la terminal y no puedan cobrar». La protección contra el doble cobro
 * se queda donde no cuesta disponibilidad: en la VENTA (cercada, con su veto), no en la RANURA. Por eso hay DOS relojes:
 *
 *  · RANURA, 30 s desde el primer cancel. Lo que esa TPV manda en el residuo (`ACTIVE`, `executionAlive: true`, sin cerrar) es
 *    IDÉNTICO a un cobro real en curso, así que el SERVIDOR no puede ser el juez del lector: lo es la propia terminal. Su admisión
 *    (`CobroRemotoDelPos.motivoParaNoIniciar`, v2.16.0 y v2.20.0) rechaza una venta nueva del POS con `failed + PRE_AUTHORIZATION`
 *    («este cobro NO se inició») mientras su pantalla de cobro está trabajando (lector, PIN, autorizando, registrando); con la
 *    pantalla muerta o en un rechazo, la acepta. Soltar la ranura nunca suelta la venta.
 *  · VENTA (el veto de la declaración de una persona), 150 s desde el cancel. Es el tope de una sola llamada del SDK de AngelPay
 *    (140 s internos + 10 s, `LedgerShadowSweepWorker.TOPE_DE_UNA_CONSULTA_MS` de la TPV): un cobro real que seguía al cancelar ya
 *    terminó o dejó rastro. Mantenerlo no le quita disponibilidad a la terminal.
 *
 * Un intento que la terminal abrió en los últimos 150 s (la Nexgo lo anuncia antes de tocar el SDK; la PAX no) es ejecución real:
 * retiene la ranura y el veto. Nunca se escribe «no se cobró» por tiempo.
 */
import { Prisma } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'
import { llaveDeIntento } from './candadoDeIntento'
import { puertaDelDinero } from './avisosNoGuardados'

/** RANURA: 30 s desde el PRIMER cancel del POS. */
export const TECHO_DE_LA_RANURA_MS = 30_000
/** VENTA: 150 s desde el cancel; y la ventana en la que un intento abierto cuenta como ejecución real (retiene las dos). */
export const VENTANA_DE_EJECUCION_MS = 150_000
/** «La terminal sigue contestando»: su último ACTIVE tiene a lo más 2 min (el vigía la sondea cada 30 s). */
export const SIGUE_CONTESTANDO_MS = 2 * 60_000
/** Cuántas filas mira el vigía por pasada (cursor propio; el resto en la siguiente). */
export const TOPE_DEL_BARRIDO_DEL_TECHO = 200
/** Tope de vínculos que se leen para la puerta del dinero en memoria; con más, no se levanta el veto (falla cerrado). */
const TOPE_DE_VINCULOS = 50

/**
 * La RANURA de esta solicitud ya cumplió el techo — UN solo predicado, sobre las columnas SIN calificar de
 * `"TerminalPaymentRequest"`: lo usan el selector del vigía y el CAS de la liberación, así que no pueden contestar distinto.
 *  · UNKNOWN, sin `Payment` apuntado y sin el cese certificado (`executionClosedAt` es de S2, que suelta en 10 s);
 *  · el POS canceló hace al menos 30 s (`cancelRequestedAt`);
 *  · la terminal dijo «sigo» DESPUÉS del cancel y hace poco (`probeActiveAt`), y nada posterior lo desmintió (`probeResolvedAt`);
 *  · ningún intento abierto en los últimos 150 s.
 */
export function techoCumplidoSql(ahora: Date): Prisma.Sql {
  const corteDelCancel = new Date(ahora.getTime() - TECHO_DE_LA_RANURA_MS)
  const corteDelIntento = new Date(ahora.getTime() - VENTANA_DE_EJECUCION_MS)
  const vivaDesde = new Date(ahora.getTime() - SIGUE_CONTESTANDO_MS)
  return Prisma.sql`("status" = 'UNKNOWN' AND "paymentId" IS NULL AND "executionClosedAt" IS NULL
    AND "cancelRequestedAt" IS NOT NULL AND "cancelRequestedAt" <= ${utcTs(corteDelCancel)}
    AND "probeActiveAt" IS NOT NULL AND "probeActiveAt" >= "cancelRequestedAt" AND "probeActiveAt" >= ${utcTs(vivaDesde)}
    AND ("probeResolvedAt" IS NULL OR "probeResolvedAt" <= "probeActiveAt")
    AND NOT EXISTS (SELECT 1 FROM "TerminalPaymentAttemptLink" l
      WHERE l."requestId" = "TerminalPaymentRequest"."requestId" AND l."createdAt" > ${utcTs(corteDelIntento)}))`
}

/** La terminal dijo «sigo» sobre ESTA solicitud después de que el POS la canceló (prueba también que la recibió). */
export function activaTrasElCancel(row: { cancelRequestedAt?: Date | null; probeActiveAt?: Date | null }): boolean {
  return !!row.cancelRequestedAt && !!row.probeActiveAt && row.probeActiveAt.getTime() >= row.cancelRequestedAt.getTime()
}

/**
 * El techo de la VENTA: el «sigo» posterior al cancel ya lleva 150 s sin ningún intento abierto en esa ventana. No pide que la
 * terminal siga contestando: con la ranura suelta el vigía deja de sondearla y el último «sigo» se queda puesto.
 */
export function cumplioElTechoDeLaVenta(
  row: { cancelRequestedAt?: Date | null; probeActiveAt?: Date | null },
  ultimoIntentoAbierto: Date | null,
  ahora: Date,
): boolean {
  if (!activaTrasElCancel(row)) return false
  const origen =
    ultimoIntentoAbierto && ultimoIntentoAbierto.getTime() > row.cancelRequestedAt!.getTime()
      ? ultimoIntentoAbierto
      : row.cancelRequestedAt!
  return ahora.getTime() >= origen.getTime() + VENTANA_DE_EJECUCION_MS
}

/**
 * ¿El techo levanta el veto de la declaración de una PERSONA? `cumplioElTechoDeLaVenta` con los vínculos leídos en la transacción de
 * quien decide (de cualquier negocio: más intentos = más prudente) y la puerta del dinero que el receptor del banco guarda en memoria
 * (un APROBADO firmado que no se pudo guardar todavía): si alguno la tiene, no se levanta.
 */
export async function elTechoLevantaElVeto(
  db: Pick<Prisma.TransactionClient, 'terminalPaymentAttemptLink'>,
  row: { requestId: string; cancelRequestedAt?: Date | null; probeActiveAt?: Date | null },
  ahora: Date,
): Promise<boolean> {
  if (!activaTrasElCancel(row)) return false
  const vinculos = await db.terminalPaymentAttemptLink.findMany({
    where: { requestId: row.requestId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true, attemptId: true },
    take: TOPE_DE_VINCULOS + 1,
  })
  if (vinculos.length > TOPE_DE_VINCULOS) return false
  if (vinculos.some(v => puertaDelDinero(llaveDeIntento(v.attemptId) ?? v.attemptId))) return false
  return cumplioElTechoDeLaVenta(row, vinculos[0]?.createdAt ?? null, ahora)
}
