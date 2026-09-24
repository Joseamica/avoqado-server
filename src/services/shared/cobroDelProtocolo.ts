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

/**
 * Excepción de EDICIÓN MANUAL — la usa SÓLO el editor de verificaciones de venta (`editOrgSaleVerification`); el PUT y el DELETE
 * del dashboard no la conocen, así que la pertenencia global no cambia.
 *
 * Desde el 18-sep-2026 el registrador de la terminal escribe la llave `pricing` en TODO cobro (`payment.tpv.service.ts`), y en
 * efectivo sin afiliación vale `null`: `pertenenciaPropiaSql` lo clasifica «del protocolo» aunque no tenga tarifa, evidencia
 * bancaria ni obligación que proteger. Así quedaron 162 SIMs de $0 de PlayTelecom en dos días, y su back-office —que corrige
 * 41-58 verificaciones al mes, 77 de 119 de FORMA de pago (CASH → OTHER)— recibió 409 (auditoría Codex gpt-6-astra, 20-sep).
 *
 * Es elegible, revalidado bajo el mutex del Payment, el cobro que cumple TODO esto: no es REFUND · CASH u OTHER (la forma sólo se
 * mueve entre esos dos: TARJETA afirmaría dinero bancario que Avoqado no ve) · sin `merchantAccountId` (un `pricing: null` CON
 * afiliación es una captura INVÁLIDA, R10-1, y sigue protegido) · snapshot exactamente `null` y sin `pricingSlot` · sin
 * `costPending` · sin TerminalPaymentRequest · sin TransactionCost · sin PaymentEffect TRANSACTION_COST en NINGÚN estado ·
 * sin reembolsos que lo apunten (la unidad de costo proyecta sobre el original: un original reembolsado se queda protegido).
 */
export async function efectivoManualEditable(db: Pick<Prisma.TransactionClient, '$queryRaw'>, paymentId: string): Promise<boolean> {
  const filas = await db.$queryRaw<{ id: string }[]>`
    SELECT p."id" FROM "Payment" p
    WHERE p."id" = ${paymentId}
      AND p."type" <> 'REFUND'
      AND p."method" IN ('CASH', 'OTHER')
      AND p."merchantAccountId" IS NULL
      AND p."terminalPaymentRequestId" IS NULL
      AND jsonb_typeof(p."processorData") = 'object'
      AND jsonb_typeof(p."processorData"->'pricing') = 'null'
      AND COALESCE(jsonb_typeof(p."processorData"->'pricingSlot'), 'null') = 'null'
      AND COALESCE(p."processorData"->>'costPending', 'false') <> 'true'
      AND NOT EXISTS (SELECT 1 FROM "TransactionCost" tc WHERE tc."paymentId" = p."id")
      AND NOT EXISTS (SELECT 1 FROM "PaymentEffect" pe WHERE pe."paymentId" = p."id" AND pe."kind" = 'TRANSACTION_COST')
      AND NOT EXISTS (
        SELECT 1 FROM "Payment" r
        WHERE r."type" = 'REFUND' AND jsonb_typeof(r."processorData") = 'object' AND r."processorData"->>'originalPaymentId' = p."id"
      )`
  return filas.length === 1
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
