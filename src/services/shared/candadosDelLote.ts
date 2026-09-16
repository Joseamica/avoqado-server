/**
 * Codex R15-2 (checkpoint 1 del webhook, 15-sep-2026): los CANDADOS de un LOTE de corrección de tarifas (apply/reverse), en el
 * orden de la unidad de costo. Ver la cabecera de `cobroDelProtocolo.ts` (pertenencia y el par ORIGINAL → reembolso).
 *
 *  1. Fotografía sin candado: tipo, venue y puntero (`processorData.originalPaymentId` de un REFUND) de cada candidato.
 *  2. ORIGINALES (dentro y fuera del lote), únicos y en `id ASC`, con NOWAIT y savepoint interior por cada uno: el ocupado
 *     aparta a sus reembolsos y, si también está en el lote, a sí mismo (queda fuera de la fase bloqueante) — la corrección
 *     no espera a la unidad de costo.
 *  3. El LOTE (lo no apartado) en `id ASC`, esperando (`bloquearPayments`, el mismo mutex que la convergencia).
 *  4. RELECTURA bajo los candados de TODOS los candidatos —también los que no eran REFUND— y comparación con la fotografía:
 *     si alguno cambió de tipo, de venue o de original, `ROLLBACK TO SAVEPOINT` del intento (se sueltan TODOS sus candados) y
 *     se vuelve a empezar. Tres intentos; después, conflicto explícito (nunca escribir con el original equivocado sin candado).
 *
 * Residuo declarado: la fase del lote sí espera; dos lotes concurrentes cuyos originales están cruzados con sus lotes pueden
 * interbloquearse (Postgres aborta uno con 40P01 y la transacción perdedora revierte sus escrituras): si el perdedor es un apply, su lote
 * queda FAILED y se reintenta; si es un reverse, el lote conserva APPLIED —no alcanza la actualización posterior— y el reverse se repite
 * (Codex R16, precisión documental: no es FAILED para ambos).
 * Módulo aparte de `cobroDelProtocolo.ts` a propósito: la fase del lote llama a `bloquearPayments` A TRAVÉS del módulo, y así las
 * pruebas de intercalación pueden pausar entre las dos fases sin ganchos en el código de producción.
 */
import { Prisma, PaymentType } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import logger from '../../config/logger'
import { bloquearPayments, type MarcadorDeCandado } from './cobroDelProtocolo'

/** Codex R15-2: lo que la corrección apartó porque su ORIGINAL (o el propio cobro, original de otro del lote) estaba tomado. */
export const MOTIVO_EXCLUSION_ORIGINAL_OCUPADO =
  'Su cobro original (o el propio cobro, original de otro del lote) estaba tomado por la unidad de costo u otra corrección: la corrección no espera al original. Vuelve a intentarlo con el lote libre.'
/** `FOR … NOWAIT` sobre una fila tomada (55P03): «could not obtain lock». Cualquier otro fallo se propaga. */
export function esFilaTomada(error: unknown): boolean {
  const texto = error instanceof Error ? error.message : String(error)
  const codigo = (error as { meta?: { code?: unknown } } | null)?.meta?.code
  return codigo === '55P03' || /55P03|could not obtain lock/i.test(texto)
}

/** Toma el mutex de UNA fila SIN esperar, con savepoint interior (la transacción sigue viva si la fila estaba tomada). */
async function bloquearSinEsperar(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>,
  paymentId: string,
  marcador: MarcadorDeCandado,
): Promise<boolean> {
  const comentario = Prisma.raw(marcador === 'proteccion' ? '/* proteccion */' : '/* correccion */')
  await tx.$executeRaw`SAVEPOINT original_sin_esperar`
  try {
    await tx.$queryRaw`SELECT "id" FROM "Payment" ${comentario} WHERE "id" = ${paymentId} FOR NO KEY UPDATE NOWAIT`
    await tx.$executeRaw`RELEASE SAVEPOINT original_sin_esperar`
    return true
  } catch (error) {
    if (!esFilaTomada(error)) throw error
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT original_sin_esperar`
    return false
  }
}

export type CandadosDelLote = {
  /** Ids del lote cuyos candados (y los de sus originales) se tomaron: sobre ellos se revalida y se escribe. */
  bloqueados: string[]
  /** Ids del lote apartados: su original (o ellos mismos, original de otro del lote) estaba tomado — no se esperó ni se bloquearon. */
  ocupados: string[]
  /** Ids del lote que ya no existen (o no son del venue del lote): no se bloquean ni se corrigen; el llamador decide si los reporta. */
  inexistentes: string[]
}

type FotoDelCandidato = { id: string; type: string | null; venueId: string; original: string | null }

/** Codex R15-2: los candados de un LOTE de corrección en el orden de la unidad de costo (ver la cabecera del módulo). */
export async function bloquearLoteConOriginales(
  tx: Pick<Prisma.TransactionClient, '$queryRaw' | '$executeRaw'>,
  lote: { venueId: string; paymentIds: readonly string[] },
  marcador: MarcadorDeCandado = 'correccion',
): Promise<CandadosDelLote> {
  const ids = [...new Set(lote.paymentIds)].sort()
  if (ids.length === 0) return { bloqueados: [], ocupados: [], inexistentes: [] }
  const fotografiar = async (): Promise<Map<string, FotoDelCandidato>> => {
    const filas = await tx.$queryRaw<FotoDelCandidato[]>`
      SELECT "id", "type"::text AS "type", "venueId",
             CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData"->>'originalPaymentId' ELSE NULL END AS "original"
      FROM "Payment" WHERE "id" IN (${Prisma.join(ids)})`
    return new Map(filas.map(f => [f.id, { ...f, original: f.type === PaymentType.REFUND && f.original ? f.original : null }]))
  }
  // Un candidato ausente en las DOS fotografías no cambió (no existe); ausente en una sola, sí (apareció o desapareció mientras se esperaba).
  const misma = (a: FotoDelCandidato | undefined, b: FotoDelCandidato | undefined) =>
    (!a && !b) || (!!a && !!b && a.type === b.type && a.venueId === b.venueId && a.original === b.original)
  for (let intento = 0; intento < 3; intento++) {
    await tx.$executeRaw`SAVEPOINT lote_del_protocolo`
    const foto = await fotografiar()
    // 2. Originales, únicos y ordenados, sin esperar.
    const originales = [...new Set([...foto.values()].map(c => c.original).filter((o): o is string => !!o))].sort()
    const ocupadosOriginales = new Set<string>()
    for (const original of originales) if (!(await bloquearSinEsperar(tx, original, marcador))) ocupadosOriginales.add(original)
    const ocupados = ids.filter(id => {
      const c = foto.get(id)
      return !!c && (ocupadosOriginales.has(id) || (!!c.original && ocupadosOriginales.has(c.original)))
    })
    const apartados = new Set(ocupados)
    // 3. El lote (sólo candidatos existentes, del venue del lote y no apartados), en `id ASC`, esperando.
    const inexistentes = ids.filter(id => foto.get(id)?.venueId !== lote.venueId)
    const bloqueables = ids.filter(id => !apartados.has(id) && !inexistentes.includes(id))
    await bloquearPayments(tx, bloqueables, marcador)
    // 4. Relectura bajo los candados: nada pudo cambiar de tipo, venue u original mientras se esperaba.
    const relectura = await fotografiar()
    const cambiaron = ids.filter(id => !misma(foto.get(id), relectura.get(id)))
    if (cambiaron.length === 0) {
      await tx.$executeRaw`RELEASE SAVEPOINT lote_del_protocolo`
      if (ocupados.length > 0) {
        logger.warn('⚠️ [candadosDelLote] Corrección por lote: cobros apartados porque su original estaba tomado (no se esperó)', {
          venueId: lote.venueId,
          ocupados,
          originalesOcupados: [...ocupadosOriginales],
        })
      }
      if (inexistentes.length > 0) {
        logger.warn('⚠️ [candadosDelLote] Corrección por lote: candidatos que ya no existen o no son del venue del lote — no se tocan', {
          venueId: lote.venueId,
          inexistentes,
        })
      }
      return { bloqueados: bloqueables, ocupados, inexistentes }
    }
    logger.warn(
      '⚠️ [candadosDelLote] Corrección por lote: un candidato cambió de tipo/venue/original mientras se tomaban los candados — se sueltan y se reintenta',
      {
        venueId: lote.venueId,
        intento: intento + 1,
        cambiaron,
      },
    )
    await tx.$executeRaw`ROLLBACK TO SAVEPOINT lote_del_protocolo`
  }
  throw new ConflictError(
    'Un cobro del lote cambió de tipo o de cobro original mientras se tomaban los candados: vuelve a intentarlo.',
    'RATE_CORRECTION_LOCK_UNSTABLE',
    { venueId: lote.venueId, paymentIds: ids },
  )
}
