/**
 * Codex R12-4 (pasada exhaustiva, 14-sep-2026): ¿este Payment pertenece al PROTOCOLO de costo del checkpoint 1?
 *
 * Un cobro del protocolo lleva su tarifa CONGELADA en `processorData.pricing` (presente, incluido `null` — el registrador lo
 * escribe en todo cobro, y un `null` también es una decisión del protocolo) o una obligación `TRANSACTION_COST` que converge
 * por el lector histórico (VALIDO / SIN_TARIFA / CAPTURA_FALLIDA / INVALIDO). Su costo sólo puede cambiar por ACREDITACIÓN y
 * CONVERGENCIA — una corrección administrativa genérica (`rateCorrection`) que recalcula sin clasificar el snapshot, o que
 * crea/borra `TransactionCost` sin tocar la obligación, convierte una corrección en «acreditación» del cargo (un SIN_TARIFA
 * de $1,000 con un CREATE_COST al 8 % pasa a $80 «convergido») o deja un efecto DONE sin costo. Hasta que exista una corrección
 * INTEGRADA con acreditación y convergencia, esos cobros se EXCLUYEN de preview, apply y reverse, y se explican.
 *
 * Un solo criterio, en un solo sitio: la comprobación en memoria (sobre un `processorData` ya leído) y la consulta en SQL
 * (bajo el mutex del Payment, para revalidar antes de escribir) dicen exactamente lo mismo.
 *
 * Codex R14-2: el REEMBOLSO de un cobro del protocolo pertenece al protocolo POR SU ORIGINAL. Nace sin `pricing` y su obligación
 * de costo vive en el original (`asegurarObligacionDeCostoNegativo`); su costo negativo es una copia a prorrata del costo
 * original y la unidad de costo lo proyecta bajo el mutex del original (`reembolsosConTrabajoPendiente`: `type = 'REFUND'` y
 * `processorData->>'originalPaymentId'`, mismo venue). Editar su importe o borrarlo deja una devolución bancaria sin contrapartida
 * financiera. Por eso la pertenencia alcanza a todo REFUND cuyo original pertenece — el MISMO predicado que la unidad usa para
 * encontrarlos — y quien protege toma los candados en el orden de la unidad: ORIGINAL → reembolso.
 *
 * Codex R15-2: la corrección por LOTE (apply/reverse) clasifica y escribe reembolsos cuya pertenencia depende de su ORIGINAL —
 * dentro o fuera del lote—: bloquear sólo el lote deja al original libre entre la clasificación y la escritura (una acreditación
 * que entre ahí convierte una corrección en «acreditación» del reembolso), y bloquear el lote en `id ASC` puede tomar el
 * reembolso antes que su original (el orden inverso al de la unidad). `bloquearLoteConOriginales` (`candadosDelLote.ts`) fija el protocolo del lote:
 * ORIGINALES primero (dentro y fuera del lote, únicos, ordenados, SIN ESPERAR — un original ocupado aparta a sus reembolsos y a sí
 * mismo si está en el lote, en vez de esperar a la unidad), después el LOTE en `id ASC`, después la RELECTURA bajo los candados
 * (tipo, venue y puntero de todos los candidatos: si algo cambió, se sueltan TODOS los candados del intento y se reinicia; ≤3
 * intentos, después conflicto explícito). Residuo declarado: la fase del lote sí espera; dos lotes concurrentes cuyos originales
 * están cruzados con sus lotes pueden interbloquearse (Postgres aborta uno con 40P01 y ese lote queda FAILED, reintentable).
 */
import { Prisma, PaymentType } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'

export const MOTIVO_EXCLUSION_DEL_PROTOCOLO =
  'Cobro del protocolo de costo (tarifa congelada u obligación TRANSACTION_COST): su costo sólo cambia por acreditación y convergencia, no por una corrección genérica de tarifas.'

/** Snapshot PRESENTE (incluido `pricing: null`). */
export function tieneSnapshotDeTarifa(processorData: unknown): boolean {
  return (
    !!processorData &&
    typeof processorData === 'object' &&
    !Array.isArray(processorData) &&
    Object.prototype.hasOwnProperty.call(processorData, 'pricing')
  )
}

/**
 * Los ids, entre los dados, que pertenecen al protocolo: snapshot presente (incl. null) u obligación TRANSACTION_COST (en
 * cualquier estado). Una sola consulta. Llamada con la transacción que YA bloqueó esos Payments, es la revalidación bajo el
 * mutex; llamada fuera, es la partición previa (que preview y apply comparten).
 */
export async function cobrosDelProtocolo(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  paymentIds: readonly string[],
): Promise<Set<string>> {
  if (paymentIds.length === 0) return new Set()
  const filas = await db.$queryRaw<{ id: string }[]>`
    SELECT p."id" FROM "Payment" p
    WHERE p."id" IN (${Prisma.join([...paymentIds])})
      AND (
        ${pertenenciaPropiaSql('p')}
        OR (
          p."type" = 'REFUND'
          AND jsonb_typeof(p."processorData") = 'object'
          AND EXISTS (
            SELECT 1 FROM "Payment" o
            WHERE o."id" = p."processorData"->>'originalPaymentId'
              AND o."venueId" = p."venueId"
              AND ${pertenenciaPropiaSql('o')}
          )
        )
      )`
  return new Set(filas.map(f => f.id))
}

/** Pertenencia PROPIA de una fila (alias de `"Payment"`): snapshot presente (incl. `null`) u obligación TRANSACTION_COST. */
function pertenenciaPropiaSql(alias: string): Prisma.Sql {
  const a = Prisma.raw(`"${alias}"`)
  return Prisma.sql`(
    (jsonb_typeof(${a}."processorData") = 'object' AND ${a}."processorData" ? 'pricing')
    OR EXISTS (SELECT 1 FROM "PaymentEffect" pe WHERE pe."paymentId" = ${a}."id" AND pe."kind" = 'TRANSACTION_COST')
  )`
}

/** El original al que apunta un REFUND (`processorData.originalPaymentId`), o `null` si la fila no es un reembolso con puntero. */
export function originalDelReembolso(fila: { type: PaymentType | string | null; processorData: unknown }): string | null {
  if (fila.type !== PaymentType.REFUND) return null
  const pd = fila.processorData
  if (!pd || typeof pd !== 'object' || Array.isArray(pd)) return null
  const original = (pd as Record<string, unknown>).originalPaymentId
  return typeof original === 'string' && original.length > 0 ? original : null
}

export type CandadoDelProtocolo = { existe: false } | { existe: true; originalPaymentId: string | null }

/**
 * Codex R14-2: toma el mutex de un Payment Y el de su original (si es un reembolso), en el orden de la unidad de costo —
 * ORIGINAL → reembolso — para que una protección administrativa nunca se cruce con la unidad (que toma el original y después
 * escribe sus reembolsos). El puntero al original se lee sin candado, se bloquea el original, se bloquea el reembolso y se RELEE
 * el puntero bajo el candado: si cambió mientras se esperaba, los candados tomados son los de otro par — se sueltan (savepoint)
 * y se vuelve a empezar. Tres intentos; después, conflicto explícito (nunca proteger contra el original equivocado).
 */
export async function bloquearConSuOriginal(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw' | 'payment'>,
  destino: { paymentId: string; venueId: string },
  marcador: MarcadorDeCandado = 'proteccion',
): Promise<CandadoDelProtocolo> {
  const select = { id: true, type: true, processorData: true } as const
  for (let intento = 0; intento < 3; intento++) {
    await tx.$executeRaw`SAVEPOINT candado_del_protocolo`
    const lectura = await tx.payment.findFirst({ where: { id: destino.paymentId, venueId: destino.venueId }, select })
    if (!lectura) return { existe: false }
    const original = originalDelReembolso(lectura)
    if (original) await bloquearPayments(tx, [original], marcador)
    await bloquearPayments(tx, [destino.paymentId], marcador)
    const relectura = await tx.payment.findFirst({ where: { id: destino.paymentId, venueId: destino.venueId }, select })
    if (!relectura) return { existe: false }
    if (originalDelReembolso(relectura) === original) {
      await tx.$executeRaw`RELEASE SAVEPOINT candado_del_protocolo`
      return { existe: true, originalPaymentId: original }
    }
    // El puntero cambió mientras se esperaba el candado: suelta lo tomado (el original ya no es el suyo) y vuelve a leer.
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT candado_del_protocolo`
  }
  throw new ConflictError(
    'El reembolso cambió de cobro original mientras se tomaba el candado: vuelve a intentarlo.',
    'PAYMENT_PROTOCOL_LOCK_UNSTABLE',
    { paymentId: destino.paymentId },
  )
}

/** Marcador del SQL del candado (comentario), para que las pruebas observen la espera en `pg_stat_activity`. */
export type MarcadorDeCandado = 'correccion' | 'proteccion'

/** Bloquea los Payments (orden estable por id) antes de revalidar y escribir: `FOR NO KEY UPDATE`, el mismo mutex que la convergencia. */
export async function bloquearPayments(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  paymentIds: readonly string[],
  marcador: MarcadorDeCandado = 'correccion',
): Promise<void> {
  if (paymentIds.length === 0) return
  const comentario = Prisma.raw(marcador === 'proteccion' ? '/* proteccion */' : '/* correccion */')
  await db.$queryRaw`SELECT "id" FROM "Payment" ${comentario} WHERE "id" IN (${Prisma.join([...paymentIds])}) ORDER BY "id" FOR NO KEY UPDATE`
}
