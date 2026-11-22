/**
 * D26 · el TECHO a «sigo cobrando» tras el cancel del POS (Testarudo, 22-nov-2026).
 *
 * El incidente: la tablet canceló el cobro y la terminal (TPV 2.16.0 y 2.20.0) contestó a cada sonda «sigo cobrando» durante 25 y
 * 8 min. La pantalla del cobro había muerto con la app viva y su propiedad quedó en memoria: el «residuo aceptado» de
 * `RemotePaymentInbox.respuestaEnProceso` (TPV). El SERVIDOR retuvo la RANURA todo ese tiempo y vetó el «no se cobró» de la cajera.
 *
 * 🔴 Por qué un reloj y no evidencia: lo que esa TPV manda en el residuo (`ACTIVE`, `executionAlive: true`, sin cerrar) es
 * IDÉNTICO a un cobro real en curso. Lo único que los separa es el tiempo: un cobro real termina (tarjeta + PIN 60 s + autorización,
 * con la espera interna del SDK de AngelPay de hasta 140 s). Por eso el techo es el número seguro, 5 min — el de Square, el de F1 en
 * la TPV y el long-poll del POS —, y cuenta desde lo que pase DESPUÉS: el primer cancel o el último intento que abrió la terminal.
 *
 * Lo que retiene (evidencia de ejecución real o de dinero): un intento abierto dentro del techo, un Payment (se concilia), el juego
 * único de vetos de dinero (`sinVetoDeDineroSql`) y la afirmación de cobro de la terminal. Lo que NUNCA hace: escribir «no se cobró»
 * ni soltar la VENTA — sólo la RANURA, con el mismo `TIMED_OUT / AUTO_RELEASED` que el reloj de 20 min y S2.
 */
import { Prisma } from '@prisma/client'
import { utcTs } from '../../utils/sqlDates'

/** 5 min desde el primer cancel del POS o desde el último intento que abrió la terminal, lo que pase después. */
export const TECHO_TRAS_CANCELAR_MS = 5 * 60_000
/** «La terminal sigue contestando»: su último ACTIVE tiene a lo más 2 min (el vigía la sondea cada 30 s). */
export const SIGUE_CONTESTANDO_MS = 2 * 60_000
/** Cuántas filas mira el vigía por pasada (cursor propio; el resto en la siguiente). */
export const TOPE_DEL_BARRIDO_DEL_TECHO = 200

/**
 * La RANURA de esta solicitud ya cumplió el techo — UN solo predicado, sobre las columnas SIN calificar de
 * `"TerminalPaymentRequest"`: lo usan el selector del vigía y el CAS de la liberación, así que no pueden contestar distinto.
 *  · UNKNOWN, sin `Payment` apuntado y sin el cese certificado (`executionClosedAt` es de S2, que suelta en 10 s);
 *  · el POS canceló hace al menos el techo (`cancelRequestedAt <= corte`);
 *  · la terminal dijo «sigo» DESPUÉS del cancel y hace poco (`probeActiveAt`), y nada posterior lo desmintió (`probeResolvedAt`);
 *  · ningún intento abierto dentro del techo (la Nexgo lo anuncia antes de tocar el SDK; la PAX no: ahí sólo cuenta el cancel).
 */
export function techoCumplidoSql(corte: Date, vivaDesde: Date): Prisma.Sql {
  return Prisma.sql`("status" = 'UNKNOWN' AND "paymentId" IS NULL AND "executionClosedAt" IS NULL
    AND "cancelRequestedAt" IS NOT NULL AND "cancelRequestedAt" <= ${utcTs(corte)}
    AND "probeActiveAt" IS NOT NULL AND "probeActiveAt" >= "cancelRequestedAt" AND "probeActiveAt" >= ${utcTs(vivaDesde)}
    AND ("probeResolvedAt" IS NULL OR "probeResolvedAt" <= "probeActiveAt")
    AND NOT EXISTS (SELECT 1 FROM "TerminalPaymentAttemptLink" l
      WHERE l."requestId" = "TerminalPaymentRequest"."requestId" AND l."createdAt" > ${utcTs(corte)}))`
}

/**
 * ¿El «sigo» de la terminal ya cumplió el techo sin ejecución real? La misma regla que `techoCumplidoSql`, para la DECLARACIÓN de
 * una persona sobre una ranura ya suelta (founder, 21-oct y 3-nov: «no se cobró» lo dice una persona). No pide que la terminal siga
 * contestando: con la ranura suelta el vigía deja de sondearla, y el último «sigo» se queda puesto.
 */
export function cumplioElTecho(
  row: { cancelRequestedAt?: Date | null; probeActiveAt?: Date | null },
  ultimoIntentoAbierto: Date | null,
  ahora: Date,
): boolean {
  const cancel = row.cancelRequestedAt
  if (!cancel || !row.probeActiveAt || row.probeActiveAt.getTime() < cancel.getTime()) return false
  const origen = ultimoIntentoAbierto && ultimoIntentoAbierto.getTime() > cancel.getTime() ? ultimoIntentoAbierto : cancel
  return ahora.getTime() >= origen.getTime() + TECHO_TRAS_CANCELAR_MS
}

/** `cumplioElTecho` con el último intento leído en la transacción de quien decide (cualquier negocio: más intentos = más prudente). */
export async function elTechoLevantaElVeto(
  db: Pick<Prisma.TransactionClient, 'terminalPaymentAttemptLink'>,
  row: { requestId: string; cancelRequestedAt?: Date | null; probeActiveAt?: Date | null },
  ahora: Date,
): Promise<boolean> {
  if (!row.cancelRequestedAt) return false
  const ultimo = await db.terminalPaymentAttemptLink.findFirst({
    where: { requestId: row.requestId },
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    select: { createdAt: true },
  })
  return cumplioElTecho(row, ultimo?.createdAt ?? null, ahora)
}
