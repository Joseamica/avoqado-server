/**
 * S2/S3 del checkpoint 1 (Codex P2, 13-sep-2026): costo de transacción PENDIENTE y DURABLE para un Payment nacido del
 * webhook de AngelPay. El webhook no trae marca, modo de entrada ni internacionalidad; calcular el costo con eso
 * fijaría una tarifa equivocada (AMEX e internacional tienen tarifa propia) y «sin costo» no puede leerse como
 * comisión cero. Por eso el registrador NO crea el costo y encola un `PaymentEffect` de tipo `TRANSACTION_COST`:
 *  · se calcula cuando la marca queda ACREDITADA (el REST de la terminal enriquece el Payment, S3) o cuando cierra el
 *    método provisional;
 *  · o, si el REST nunca vuelve, al vencer el PLAZO del payload — con lo que haya, para que el negocio no se quede
 *    sin costo ni liquidación por una terminal que no volvió a hablar;
 *  · nunca para una POSIBLE SEGUNDA CAPTURA ni para nada que no sea COMPLETED.
 * Idempotente por `TransactionCost.paymentId` (único): un reintento tras un corte no crea dos costos.
 *
 * Codex R1/R2 (P1-5, P1-6, N3, P2): el costo persistido es la VERDAD y sus proyecciones (`Payment.feeAmount/netAmount`,
 * `VenueTransaction` con su fecha y configuración de liquidación) se REPARAN siempre a partir de él con la MISMA
 * aritmética que `createTransactionCost`; TODOS los reembolsos que llegaron mientras el costo esperaba reciben su costo
 * negativo (por páginas acotadas, idempotente por Payment del reembolso); y sólo cuando TODO convergió se marca
 * `costPending: false`. Esperar la marca devuelve `false`; un fallo OPERATIVO se PROPAGA para que el efecto cuente el
 * intento (backoff y, si persiste, DEAD_LETTER visible) en vez de reprogramarse para siempre.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { createRefundTransactionCost, createTransactionCost, leerTarifaCongelada } from './transactionCost.service'
import { proyectarComisionYNeto } from './proyeccionMonetaria'
import { calculatePaymentSettlement } from './settlementCalculation.service'
import { utcTs } from '@/utils/sqlDates'

export const COSTO_PENDIENTE_PLAZO_MS = 2 * 60 * 60 * 1000
/** Codex R4 (P3): presupuesto de reembolsos por ejecución, configurable (las pruebas cortan en la 2ª página con 10 por página). */
const entero = (valor: string | undefined, porDefecto: number): number => {
  const n = Number.parseInt(valor ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : porDefecto
}
const paginaDeReembolsos = () => entero(process.env.DEFERRED_COST_REFUND_PAGE, 50)
// Codex R6 (diseño B): el lote de reembolsos por unidad es ACOTADO (4 páginas × 50 = 200 costos negativos por corrida) — la
// unidad es UNA transacción con presupuesto de 10 s: se confirma el lote y se continúa después, nunca se revierte todo.
const maxPaginasDeReembolsos = () => entero(process.env.DEFERRED_COST_REFUND_MAX_PAGES, 4)

/**
 * Codex R12-3: el costo está listo cuando el MÉTODO está acreditado — nunca por el paso del tiempo. El webhook inventa
 * `CREDIT_CARD` (AngelPay no manda el método) y lo marca `methodProvisional: true`; sólo el REST de la terminal (S3) lo acredita
 * (`methodProvisional: false`, con la marca). Un plazo vencido que «acreditaba» el tipo de tarjeta escribía un costo de crédito
 * (2.5 %) sobre un débito (1 %) y lo volvía definitivo. Ahora el plazo sólo ESCALA la espera (`esperaDeMarcaVencida`). Un
 * Payment sin la marca `methodProvisional` (el REST lo registró) está listo: el método es el acreditado por la terminal.
 */
export function costoListoParaCalcular(
  payment: { cardBrand: string | null; processorData: unknown },
  _payload: { deadlineAt?: unknown } | null | undefined,
  _now: Date,
): boolean {
  const meta = payment.processorData && typeof payment.processorData === 'object' ? (payment.processorData as Record<string, unknown>) : {}
  return meta.methodProvisional !== true
}

/** Codex R12-3: el plazo de la obligación ya venció — la espera se ESCALA (motivo visible), no se resuelve calculando. */
export function esperaDeMarcaVencida(payload: { deadlineAt?: unknown } | null | undefined, now: Date): boolean {
  const deadline = typeof payload?.deadlineAt === 'string' ? Date.parse(payload.deadlineAt) : NaN
  return Number.isFinite(deadline) && now.getTime() >= deadline
}

/**
 * La comisión y el neto que PROYECTA un costo persistido — la MISMA proyección monetaria que `createTransactionCost`
 * (`proyectarComisionYNeto`: valores a 4 decimales, comisión a 2, neto = importe − comisión, conserva el total).
 */
export function proyeccionDelCosto(costo: { amount: unknown; venueChargeAmount: unknown; venueFixedFee: unknown }): {
  fee: Prisma.Decimal
  net: Prisma.Decimal
} {
  const { fee, net } = proyectarComisionYNeto(costo.amount, costo.venueChargeAmount, costo.venueFixedFee)
  return { fee: new Prisma.Decimal(fee), net: new Prisma.Decimal(net) }
}

/** Codex R3 (P1-5): la razón por la que el efecto sigue PENDIENTE queda escrita en él (visible en la cola), nunca sólo en un log. */
async function anotarEspera(paymentId: string, motivo: string, db: Cliente = prisma): Promise<void> {
  await db.paymentEffect.updateMany({
    where: { paymentId, kind: 'TRANSACTION_COST', status: { in: ['PROCESSING', 'PENDING'] } },
    data: { lastError: motivo },
  })
}

type Cliente = Prisma.TransactionClient | typeof prisma

/**
 * Codex R4-4 / R6: el cálculo SÍNCRONO del costo (REST de la terminal) falló por un error OPERATIVO. El cobro no se interrumpe;
 * la obligación queda DURABLE y VISIBLE con su motivo en el efecto `TRANSACTION_COST`. `costPending` ya está en `true` desde
 * que nació la obligación (Codex R6, diseño B): aquí no se decide la marca — sólo se anota el porqué. El worker lo retoma.
 */
/**
 * Un error `COST_PENDING_<MOTIVO>: …` del cálculo del costo es una obligación que sigue PENDIENTE por una razón de NEGOCIO
 * (tarifa no acreditable, snapshot ilegible), no un fallo operativo: se anota con ese motivo y no consume intentos.
 */
export function motivoDeCostoPendiente(
  error: unknown,
): 'AFFILIATION_PRICING_UNRESOLVED' | 'INVALID_PRICING_SNAPSHOT' | 'PRICING_CAPTURE_FAILED' | 'AWAITING_ACCREDITED_CARD_DATA' | null {
  const mensaje = error instanceof Error ? error.message : String(error)
  if (mensaje.startsWith('COST_PENDING_AFFILIATION_PRICING_UNRESOLVED')) return 'AFFILIATION_PRICING_UNRESOLVED'
  if (mensaje.startsWith('COST_PENDING_INVALID_PRICING_SNAPSHOT')) return 'INVALID_PRICING_SNAPSHOT'
  // Codex R10-1: al cobrar no se pudo leer la tarifa del negocio; no se reconstruye después. Pendiente con motivo, sin consumir intentos.
  if (mensaje.startsWith('COST_PENDING_PRICING_CAPTURE_FAILED')) return 'PRICING_CAPTURE_FAILED'
  // Codex R12-3: el método sigue provisional (nacido del webhook): se espera al REST de la terminal, sin consumir intentos.
  if (mensaje.startsWith('COST_PENDING_AWAITING_ACCREDITED_CARD_DATA')) return 'AWAITING_ACCREDITED_CARD_DATA'
  return null
}

export async function anotarCostoNoCalculado(paymentId: string, error: unknown): Promise<void> {
  const motivo = motivoDeCostoPendiente(error) ?? 'TRANSACTION_COST_FAILED'
  try {
    await anotarEspera(paymentId, motivo)
  } catch (anotacionError) {
    // Nunca un fallo aquí interrumpe el cobro: el efecto sigue PENDIENTE de todos modos y el worker lo intentará.
    logger.error('⚠️ [R4-4] No se pudo anotar el costo no calculado; el efecto sigue pendiente', {
      paymentId,
      motivo,
      error: anotacionError instanceof Error ? anotacionError.message : String(anotacionError),
    })
  }
}

/**
 * Codex R4-4 / R5-3 / R6 (diseño B): el cálculo SÍNCRONO del costo (REST de la terminal, con orden y venta rápida) es UNA
 * corrida de convergencia más — la misma unidad que corre el worker (`convergerCostoDeTransaccion`), bajo la fila del Payment
 * con `FOR NO KEY UPDATE NOWAIT`. Cierra la obligación (sólo PENDING) dentro de esa misma unidad cuando convergió; si no, la deja
 * PENDIENTE y visible con su motivo; si otra corrida tiene la fila (contención), no hace nada — ni cambia `costPending` ni
 * cierra — y la obligación sigue para el worker. Nunca lanza ni interrumpe el cobro.
 */
/**
 * Codex R12-15: el costo NEGATIVO de un reembolso es una OBLIGACIÓN DURABLE, registrada en la MISMA transacción del reembolso y
 * bajo el mutex del original (el reembolso ya tiene la fila del original `FOR UPDATE`; una corrida de convergencia en vuelo
 * la tiene `FOR NO KEY UPDATE`, así que quien llega segundo espera a que la otra termine). Antes, el costo negativo se
 * intentaba DESPUÉS de registrar el reembolso y un fallo se capturaba o quedaba en una promesa sin dueño: si el original ya
 * había convergido (DONE), no quedaba ninguna ejecución pendiente que lo descubriera y esa comisión revertida se perdía.
 *
 *  · Obligación DONE ⇒ se REABRE (CAS sobre DONE → PENDING, `nextAttemptAt` ahora, presupuesto en cero). La unidad de
 *    convergencia, al volver a correr sobre un original con costo, no recalcula nada: crea los costos negativos de los
 *    reembolsos que aún no lo tienen COPIANDO el costo original (`createRefundTransactionCost`), nunca con tarifas nuevas, y
 *    cierra DONE otra vez. Idempotente: si el costo síncrono posterior al commit sí llega a crearse, la corrida no encuentra
 *    nada que hacer.
 *  · PENDING / PROCESSING ⇒ vigente: esa obligación, cuando corra (o vuelva a correr tras su lease), recorre los reembolsos.
 *  · Sin obligación pero CON costo (cobro anterior al protocolo, costeado en el registro) ⇒ se ENCOLA una, para que también
 *    su reembolso sea durable. Sin obligación y sin costo ⇒ no hay nada que espejar.
 *  · Un original que no es cobro con costo (efectivo, no COMPLETED) ⇒ nada.
 */
export async function asegurarObligacionDeCostoNegativo(
  tx: Prisma.TransactionClient,
  originalPaymentId: string,
  refundPaymentId: string,
): Promise<'REABIERTA' | 'ENCOLADA' | 'VIGENTE' | 'SIN_OBLIGACION'> {
  const original = await tx.payment.findUnique({
    where: { id: originalPaymentId },
    select: { id: true, venueId: true, orderId: true, status: true, method: true },
  })
  if (!original || original.status !== 'COMPLETED' || original.method === 'CASH') return 'SIN_OBLIGACION'
  const efecto = await tx.paymentEffect.findFirst({
    where: { paymentId: originalPaymentId, kind: 'TRANSACTION_COST' },
    select: { id: true, status: true, payload: true },
  })
  const solicitud = { refundPaymentId, at: new Date().toISOString() }
  if (efecto) {
    if (efecto.status === 'PENDING' || efecto.status === 'PROCESSING') return 'VIGENTE'
    if (efecto.status !== 'DONE') return 'VIGENTE' // agotada/fallida: quien la resuelva recorrerá también los reembolsos
    const payload =
      efecto.payload && typeof efecto.payload === 'object' && !Array.isArray(efecto.payload)
        ? (efecto.payload as Record<string, unknown>)
        : {}
    const previas = Array.isArray(payload.refundCostRequests) ? (payload.refundCostRequests as unknown[]) : []
    const reabierta = await tx.paymentEffect.updateMany({
      where: { id: efecto.id, status: 'DONE' },
      data: {
        status: 'PENDING',
        nextAttemptAt: new Date(),
        completedAt: null,
        attempts: 0,
        claimToken: null,
        leaseUntil: null,
        lastError: 'REFUND_COST',
        payload: { ...payload, refundCostRequests: [...previas, solicitud] } as Prisma.InputJsonObject,
      },
    })
    if (reabierta.count !== 1) return 'VIGENTE'
    // Codex R13-5: al registrar trabajo nuevo la MARCA se reactiva — mientras la obligación esté pendiente, el original no
    // anuncia costo final (`costPending: true`); la unidad la vuelve a `false` sólo cuando TODO —incluidas las proyecciones del
    // reembolso— quedó escrito.
    await marcarCostPending(tx, originalPaymentId, true)
    return 'REABIERTA'
  }
  const costo = await tx.transactionCost.findUnique({ where: { paymentId: originalPaymentId }, select: { id: true } })
  if (!costo) return 'SIN_OBLIGACION'
  const { enqueuePaymentEffect } = await import('../tpv/paymentEffects.service')
  await enqueuePaymentEffect(tx, {
    venueId: original.venueId,
    paymentId: original.id,
    orderId: original.orderId,
    kind: 'TRANSACTION_COST',
    dedupeKey: `transaction-cost:${original.id}:v1`,
    payload: { reason: 'REFUND_COST', deadlineAt: new Date().toISOString(), refundCostRequests: [solicitud] },
  })
  await marcarCostPending(tx, originalPaymentId, true)
  return 'ENCOLADA'
}

/**
 * Codex R13-5: las PROYECCIONES del reembolso (su Payment y su VenueTransaction) se derivan de su costo negativo PERSISTIDO con la
 * MISMA regla monetaria que el original (`proyeccionDelCosto`): comisión revertida y neto = importe − comisión. Ambos canales de
 * reembolso nacen con fee 0 y neto = bruto negativo; sin esto, el costo persistido decía «comisión revertida $3» mientras las
 * proyecciones del reembolso seguían diciendo fee 0 / neto −100 (las proyecciones sumaban −$3 que los costos no reconocían).
 * Idempotente: sólo escribe si difiere. `SIN_COSTO` = todavía no hay costo negativo (nada que proyectar);
 * `SIN_VENUE_TRANSACTION` = la fila financiera del reembolso no existe (exactamente una): la obligación NO puede converger.
 */
export async function proyectarCostoDelReembolso(
  db: Cliente,
  refundPaymentId: string,
): Promise<'PROYECTADO' | 'SIN_COSTO' | 'SIN_VENUE_TRANSACTION'> {
  const costo = await db.transactionCost.findUnique({
    where: { paymentId: refundPaymentId },
    select: { amount: true, venueChargeAmount: true, venueFixedFee: true },
  })
  if (!costo) return 'SIN_COSTO'
  const { fee, net } = proyeccionDelCosto(costo)
  const reembolso = await db.payment.findUnique({ where: { id: refundPaymentId }, select: { feeAmount: true, netAmount: true } })
  if (reembolso && (a2(reembolso.feeAmount) !== a2(fee) || a2(reembolso.netAmount) !== a2(net))) {
    await db.payment.update({ where: { id: refundPaymentId }, data: { feeAmount: fee, netAmount: net } })
    logger.info('🔧 [S2] Proyección del costo negativo reparada en el Payment del reembolso', {
      refundPaymentId,
      fee: a2(fee),
      net: a2(net),
    })
  }
  const vt = await db.venueTransaction.findFirst({
    where: { paymentId: refundPaymentId },
    select: { id: true, feeAmount: true, netAmount: true, netSettlementAmount: true },
  })
  if (!vt) return 'SIN_VENUE_TRANSACTION'
  if (a2(vt.feeAmount) !== a2(fee) || a2(vt.netAmount) !== a2(net) || a2(vt.netSettlementAmount) !== a2(net)) {
    await db.venueTransaction.update({ where: { id: vt.id }, data: { feeAmount: fee, netAmount: net, netSettlementAmount: net } })
    logger.info('🔧 [S2] Proyección del costo negativo reparada en la VenueTransaction del reembolso', { refundPaymentId })
  }
  return 'PROYECTADO'
}

/**
 * Codex R13-5: el costo negativo SÍNCRONO de un reembolso (post-commit de los dos canales): crea el costo si falta y PROYECTA
 * desde el persistido. Nunca lanza — la obligación durable (reabierta o encolada en la transacción del reembolso) lo retoma.
 */
export async function costearYProyectarReembolso(refundPaymentId: string, originalPaymentId: string): Promise<void> {
  try {
    await createRefundTransactionCost(refundPaymentId, originalPaymentId)
  } catch (error) {
    // Ya existe (lo creó la unidad de convergencia en medio): `TransactionCost.paymentId` es único — se proyecta desde el persistido.
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
  }
  await proyectarCostoDelReembolso(prisma, refundPaymentId)
}

export async function asegurarCostoSincrono(paymentId: string): Promise<'CUMPLIDA' | 'PENDIENTE' | 'CONTENDIDA'> {
  try {
    const desenlace = await convergerCostoDeTransaccion(paymentId, { tipo: 'REST' })
    if (desenlace === 'CONVERGIO' || desenlace === 'NO_APLICA') return 'CUMPLIDA'
    if (desenlace === 'CONTENDIDO') {
      logger.info('ℹ️ [R6] Otra corrida tiene la fila del Payment: el costo síncrono no compite — la obligación sigue para el worker', {
        paymentId,
      })
      return 'CONTENDIDA'
    }
    return 'PENDIENTE'
  } catch (error) {
    logger.error('⚠️ [R5-3] El costo síncrono no convergió por un fallo operativo: la obligación sigue pendiente y visible', {
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
    await anotarCostoNoCalculado(paymentId, error)
    return 'PENDIENTE'
  }
}

/** Codex R4-4: el REST cierra SÓLO la obligación PENDING (una reclamada la termina el worker con su token). Idempotente. */
export async function cerrarObligacionDeCosto(paymentId: string, db: Cliente = prisma): Promise<void> {
  try {
    await db.paymentEffect.updateMany({
      where: { paymentId, kind: 'TRANSACTION_COST', status: 'PENDING' },
      data: { status: 'DONE', completedAt: new Date(), lastError: null, claimToken: null, leaseUntil: null },
    })
  } catch (error) {
    // Si no se pudo cerrar, el worker la retomará y la encontrará ya calculada (idempotente): sólo trabajo repetido.
    logger.warn('⚠️ [R4-4] No se pudo cerrar la obligación de costo ya cumplida; el worker la confirmará', {
      paymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

const a2 = (valor: unknown): string => new Prisma.Decimal(String(valor ?? 0)).toDecimalPlaces(2).toFixed(2)

/** `true` = terminado (todo convergió, o nada que calcular). `false` = todavía esperando la marca o contención (se reprograma sin consumir intento). Lanza ante un fallo operativo. */
export async function settleDeferredTransactionCost(
  paymentId: string,
  payload: Record<string, unknown> | null,
  now: Date,
  cierre: CierreDeObligacion = { tipo: 'NINGUNO' },
): Promise<boolean> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } })
  if (!payment) return true
  if (payment.status !== 'COMPLETED') return true
  if (!costoListoParaCalcular(payment, payload, now)) {
    // Codex R12-3: la espera queda ESCRITA en la obligación (visible en la cola) y, vencido el plazo, ESCALADA — nunca resuelta
    // calculando con un método que nadie acreditó. La misma decisión se repite bajo el mutex, dentro de la unidad. Si el
    // snapshot ya dice algo PERMANENTE (sin tarifa contratada, captura fallida, ilegible), ese motivo manda sobre la espera:
    // es lo que el operador tiene que resolver, con o sin REST.
    const lectura = leerTarifaCongelada(payment.processorData, payment.merchantAccountId)
    const motivoDelSnapshot =
      lectura.estado === 'SIN_TARIFA'
        ? 'AFFILIATION_PRICING_UNRESOLVED'
        : lectura.estado === 'CAPTURA_FALLIDA'
          ? 'PRICING_CAPTURE_FAILED'
          : lectura.estado === 'INVALIDO'
            ? 'INVALID_PRICING_SNAPSHOT'
            : null
    await anotarEspera(
      paymentId,
      motivoDelSnapshot ?? (esperaDeMarcaVencida(payload, now) ? 'AWAITING_ACCREDITED_CARD_DATA_OVERDUE' : 'AWAITING_ACCREDITED_CARD_DATA'),
    )
    return false
  }
  const desenlace = await convergerCostoDeTransaccion(paymentId, cierre)
  return desenlace === 'CONVERGIO' || desenlace === 'NO_APLICA'
}

/** Quién cierra la obligación DENTRO de la unidad de convergencia: el REST (sólo PENDING) o el worker (con su token). */
export type CierreDeObligacion = { tipo: 'REST' } | { tipo: 'WORKER'; effectId: string; claimToken: string } | { tipo: 'NINGUNO' }
export type DesenlaceDeConvergencia = 'CONVERGIO' | 'NO_APLICA' | 'PENDIENTE' | 'CONTENDIDO'
/** Codex R6 (h): la primera corrida que venza tiene que fallar al continuar; el presupuesto es parametrizable para probarlo. */
export const PRESUPUESTO_DE_CONVERGENCIA_MS = 10_000

const esContencion = (error: unknown): boolean => {
  const mensaje = error instanceof Error ? error.message : String(error)
  // 55P03 lock_not_available (FOR NO KEY UPDATE NOWAIT) — Prisma lo envuelve en un error de consulta cruda con el código de Postgres.
  return /55P03|could not obtain lock|lock_not_available/i.test(mensaje) || (error as { meta?: { code?: string } })?.meta?.code === '55P03'
}

/**
 * Codex R5-3 / R6 (diseño B): el ÚNICO criterio de cumplimiento de la obligación de costo, en UNA unidad transaccional que lo
 * comparten el worker (tras esperar la marca) y el cálculo SÍNCRONO del REST:
 *   fila del Payment `FOR NO KEY UPDATE NOWAIT` (el mutex: esa fila ya existe) → relectura del Payment bajo el candado → efecto de
 *   costo → TransactionCost → proyecciones en Payment y VenueTransaction → liquidación → costos negativos de los reembolsos
 *   (lote acotado) → decisión de `costPending` y transición autorizada de la obligación → COMMIT.
 * Todo con el MISMO `tx`: un fallo operativo aborta la unidad entera y nada escapa por el cliente global. Dos corridas no se
 * intercalan: la segunda encuentra la fila tomada (CONTENDIDO) y no toca nada — ni la marca ni la obligación —, así que una
 * escritura tardía no puede invertir el resultado de la otra. «Convergió» es cumplimiento DURABLE (`costPending: false` sólo
 * cuando TODO quedó escrito), no el éxito del último intento. `NO_APLICA`: el medio no genera costo (ausencia legítima de
 * obligación, que no es «pendiente»).
 */
export async function convergerCostoDeTransaccion(
  paymentId: string,
  cierre: CierreDeObligacion = { tipo: 'NINGUNO' },
  opciones: { presupuestoMs?: number } = {},
): Promise<DesenlaceDeConvergencia> {
  try {
    return await prisma.$transaction(
      async tx => {
        // El mutex: la fila del Payment, sin espera. Se relee BAJO el candado; nada se decide sobre lo leído antes.
        // `FOR NO KEY UPDATE` (no `FOR UPDATE`): excluye a otra corrida de convergencia igual, pero NO bloquea los INSERT
        // ajenos que referencian este Payment por FK (recibo, reembolso, efecto): un `FOR UPDATE` los haría esperar toda la
        // unidad; es la misma fuerza de candado que exige la reapertura (`/* reapertura */`).
        const filas = await tx.$queryRaw<
          { id: string }[]
        >`SELECT "id" FROM "Payment" /* convergencia */ WHERE "id" = ${paymentId} FOR NO KEY UPDATE NOWAIT`
        if (filas.length !== 1) return 'NO_APLICA' as const
        const payment = await tx.payment.findUniqueOrThrow({ where: { id: paymentId } })
        if (payment.status !== 'COMPLETED' || payment.method === 'CASH') {
          await cerrarSegunElCierre(tx, paymentId, cierre)
          return 'NO_APLICA' as const
        }
        const seleccion = {
          id: true,
          amount: true,
          venueChargeAmount: true,
          venueFixedFee: true,
          merchantAccountId: true,
          transactionType: true,
        } as const
        let costo = await tx.transactionCost.findUnique({ where: { paymentId }, select: seleccion })
        const yaExistia = !!costo
        let creado: Awaited<ReturnType<typeof createTransactionCost>> | undefined
        if (!costo) {
          try {
            creado = await createTransactionCost(paymentId, tx)
          } catch (error) {
            // Codex R3 (P1-3): sin tarifa ACREDITABLE (la afiliación ya no está en la configuración y el cobro no trae slot
            // congelado) el costo no se calcula con otra tarifa: obligación DURABLE y visible, sin consumir intentos.
            const motivoPendiente = motivoDeCostoPendiente(error)
            if (motivoPendiente) {
              logger.warn('⚠️ [S2] El costo no se puede calcular con una tarifa acreditable: sigue pendiente y visible', {
                paymentId,
                motivo: motivoPendiente,
                detalle: error instanceof Error ? error.message : String(error),
              })
              await anotarEspera(paymentId, motivoPendiente, tx)
              await marcarCostPending(tx, paymentId, true)
              return 'PENDIENTE' as const
            }
            throw error
          }
          costo = await tx.transactionCost.findUnique({ where: { paymentId }, select: seleccion })
          if (!costo && creado === null) {
            // El medio no es elegible para costo (no lo origina Avoqado, etc.): ausencia LEGÍTIMA de obligación.
            await marcarCostPending(tx, paymentId, false)
            await cerrarSegunElCierre(tx, paymentId, cierre)
            return 'NO_APLICA' as const
          }
        }

        // Proyecciones desde el costo PERSISTIDO (no desde lo que devolvió una llamada que pudo no completar sus escrituras).
        if (costo) {
          const { fee, net } = proyeccionDelCosto(costo)
          if (a2(payment.feeAmount) !== a2(fee) || a2(payment.netAmount) !== a2(net)) {
            await tx.payment.update({ where: { id: paymentId }, data: { feeAmount: fee, netAmount: net } })
            logger.info('🔧 [S2] Proyección del costo diferido reparada en Payment', { paymentId, fee: a2(fee), net: a2(net) })
          }
          // Codex R6 (i): la VenueTransaction es parte de la obligación — sin ella (exactamente una fila) NO hay convergencia.
          const vts = await tx.venueTransaction.updateMany({
            where: { paymentId },
            data: { feeAmount: fee, netAmount: net, netSettlementAmount: net },
          })
          if (vts.count !== 1) {
            logger.error('🚨 [S2] El Payment no tiene VenueTransaction: la obligación de costo no puede converger', {
              paymentId,
              filas: vts.count,
            })
            await anotarEspera(paymentId, 'VENUE_TRANSACTION_MISSING', tx)
            await marcarCostPending(tx, paymentId, true)
            return 'PENDIENTE' as const
          }
          // Codex R2 (P1-5): la fecha estimada y la configuración de liquidación también son proyección del costo. Un corte
          // entre «crear el costo» y escribirlas dejaba el saldo pendiente sin fecha con el efecto ya terminado.
          const vt = await tx.venueTransaction.findUnique({
            where: { paymentId },
            select: { estimatedSettlementDate: true, settlementConfigId: true },
          })
          if (!vt) {
            await anotarEspera(paymentId, 'VENUE_TRANSACTION_MISSING', tx)
            await marcarCostPending(tx, paymentId, true)
            return 'PENDIENTE' as const
          }
          if (!vt.estimatedSettlementDate || !vt.settlementConfigId) {
            const liquidacion = await calculatePaymentSettlement(payment, costo.merchantAccountId, costo.transactionType, tx)
            if (liquidacion) {
              await tx.venueTransaction.update({
                where: { paymentId },
                data: {
                  estimatedSettlementDate: liquidacion.estimatedSettlementDate,
                  netSettlementAmount: liquidacion.netSettlementAmount,
                  settlementConfigId: liquidacion.settlementConfigId,
                },
              })
              logger.info('🔧 [S2] Metadatos de liquidación reparados', {
                paymentId,
                estimatedSettlementDate: liquidacion.estimatedSettlementDate,
              })
            } else {
              // Codex R3 (P1-5): sin configuración de liquidación el efecto NO termina — queda como obligación DURABLE y visible
              // (`lastError` en la cola) y se retoma cuando alguien configure la liquidación de esa afiliación.
              logger.warn('⚠️ [S2] Sin configuración de liquidación para el costo diferido: el efecto sigue pendiente', {
                paymentId,
                merchantAccountId: costo.merchantAccountId,
              })
              await anotarEspera(paymentId, 'AWAITING_SETTLEMENT_CONFIGURATION', tx)
              await marcarCostPending(tx, paymentId, true)
              return 'PENDIENTE' as const
            }
          }
        }

        // Codex R1/R2 (P1-6, N3): los reembolsos que nacieron mientras el costo esperaba no tenían original que espejar; ahora
        // sí — TODOS, por páginas acotadas con orden estable; nunca se termina con una página sin procesar. Codex R6: el lote
        // se confirma (COMMIT con la obligación abierta) y se continúa después — nunca una transacción que siempre vence.
        // Codex R13-5: el cumplimiento incluye las PROYECCIONES del reembolso (Payment y VenueTransaction, desde su costo negativo
        // persistido): se recorren los reembolsos SIN costo y también los que YA lo tienen con proyecciones incompletas.
        let reembolsosVistos = 0
        const PAGINA_DE_REEMBOLSOS = paginaDeReembolsos()
        const MAX_PAGINAS_DE_REEMBOLSOS = maxPaginasDeReembolsos()
        let ultimo: { createdAt: Date; id: string } | null = null
        for (let pagina = 0; pagina < MAX_PAGINAS_DE_REEMBOLSOS && costo; pagina++) {
          // Codex R4 (P3): los reembolsos YA cumplidos se excluyen EN LA CONSULTA (no se recorren para saltarlos): la continuación
          // tras un corte o un presupuesto agotado arranca donde falta trabajo. Keyset sobre columnas inmutables (createdAt, id).
          const reembolsos = await reembolsosConTrabajoPendiente(tx, payment.venueId, paymentId, ultimo, PAGINA_DE_REEMBOLSOS)
          for (const reembolso of reembolsos) {
            reembolsosVistos++
            if (!(await tx.transactionCost.findUnique({ where: { paymentId: reembolso.id }, select: { id: true } }))) {
              await createRefundTransactionCost(reembolso.id, paymentId, tx)
              logger.info('🔧 [S2] Costo negativo del reembolso creado al cerrar el costo diferido', {
                paymentId,
                refundPaymentId: reembolso.id,
              })
            }
            const proyeccion = await proyectarCostoDelReembolso(tx, reembolso.id)
            if (proyeccion === 'SIN_VENUE_TRANSACTION') {
              // Codex R6 (i) / R13-5: la fila financiera del reembolso es parte de la obligación — sin ella NO hay convergencia.
              logger.error('🚨 [S2] El reembolso no tiene VenueTransaction: la obligación de costo del original no puede converger', {
                paymentId,
                refundPaymentId: reembolso.id,
              })
              await anotarEspera(paymentId, 'REFUND_VENUE_TRANSACTION_MISSING', tx)
              await marcarCostPending(tx, paymentId, true)
              return 'PENDIENTE' as const
            }
          }
          if (reembolsos.length < PAGINA_DE_REEMBOLSOS) break
          const cola = reembolsos[reembolsos.length - 1]
          ultimo = { createdAt: cola.createdAt, id: cola.id }
          if (pagina === MAX_PAGINAS_DE_REEMBOLSOS - 1) {
            // Codex R3 (P3): presupuesto por ejecución, con CONTINUACIÓN durable — lo ya costeado se salta al reintentar.
            logger.warn('⚠️ [S2] Presupuesto de reembolsos por ejecución agotado: el efecto sigue pendiente y continúa después', {
              paymentId,
            })
            await anotarEspera(paymentId, 'REFUND_COSTS_CONTINUE_NEXT_RUN', tx)
            await marcarCostPending(tx, paymentId, true)
            return 'PENDIENTE' as const
          }
        }

        await marcarCostPending(tx, paymentId, false)
        await cerrarSegunElCierre(tx, paymentId, cierre)
        logger.info('✅ [S2] Costo de transacción convergió', { paymentId, yaExistia, reembolsos: reembolsosVistos, cierre: cierre.tipo })
        return 'CONVERGIO' as const
      },
      { timeout: opciones.presupuestoMs ?? PRESUPUESTO_DE_CONVERGENCIA_MS, isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    )
  } catch (error) {
    if (esContencion(error)) {
      logger.info('ℹ️ [R6] Fila del Payment tomada por otra corrida de convergencia: esta no hace nada', { paymentId })
      return 'CONTENDIDO'
    }
    throw error
  }
}

/**
 * Codex R13-5: la página de reembolsos del original con TRABAJO PENDIENTE — sin costo negativo, o con costo pero con proyecciones
 * (Payment.fee/net, VenueTransaction.fee/net/netSettlement) distintas de las que su costo persistido dicta. La misma regla monetaria
 * que `proyectarComisionYNeto` (comisión = round(charge₄ + fixed₄, 2); neto = round(amount, 2) − comisión) expresada en SQL para
 * que los YA cumplidos queden fuera de la consulta (continuación durable, Codex R4 P3). Keyset sobre (createdAt, id) — el
 * corte de fecha va por `utcTs`: un `Date` crudo en `$queryRaw` llega como timestamptz y la sesión local lo corre 6 h.
 */
async function reembolsosConTrabajoPendiente(
  tx: Prisma.TransactionClient,
  venueId: string,
  originalPaymentId: string,
  ultimo: { createdAt: Date; id: string } | null,
  pagina: number,
): Promise<{ id: string; createdAt: Date }[]> {
  const desde = ultimo
    ? Prisma.sql`AND (r."createdAt" > ${utcTs(ultimo.createdAt)} OR (r."createdAt" = ${utcTs(ultimo.createdAt)} AND r."id" > ${ultimo.id}))`
    : Prisma.empty
  return tx.$queryRaw<{ id: string; createdAt: Date }[]>`
    SELECT r."id", r."createdAt"
    FROM "Payment" r
    LEFT JOIN "TransactionCost" tc ON tc."paymentId" = r."id"
    LEFT JOIN LATERAL (
      SELECT ROUND(ROUND(tc."venueChargeAmount", 4) + ROUND(tc."venueFixedFee", 4), 2) AS fee,
             ROUND(tc."amount", 2) - ROUND(ROUND(tc."venueChargeAmount", 4) + ROUND(tc."venueFixedFee", 4), 2) AS net
    ) esperado ON TRUE
    LEFT JOIN "VenueTransaction" vt ON vt."paymentId" = r."id"
    WHERE r."venueId" = ${venueId}
      AND r."type" = 'REFUND'
      AND r."processorData"->>'originalPaymentId' = ${originalPaymentId}
      AND (
        tc."id" IS NULL
        OR vt."id" IS NULL
        OR r."feeAmount" IS DISTINCT FROM esperado.fee
        OR r."netAmount" IS DISTINCT FROM esperado.net
        OR vt."feeAmount" IS DISTINCT FROM esperado.fee
        OR vt."netAmount" IS DISTINCT FROM esperado.net
        OR vt."netSettlementAmount" IS DISTINCT FROM esperado.net
      )
      ${desde}
    ORDER BY r."createdAt" ASC, r."id" ASC
    LIMIT ${pagina}`
}

/** `costPending` = «la obligación de costo todavía no ha convergido» — una sola semántica, REST y webhook, decidida bajo el candado. */
async function marcarCostPending(tx: Cliente, paymentId: string, pendiente: boolean): Promise<void> {
  await tx.$executeRaw`
    UPDATE "Payment"
    SET "processorData" = CASE WHEN jsonb_typeof("processorData") = 'object' THEN "processorData" ELSE '{}'::jsonb END || ${JSON.stringify({ costPending: pendiente })}::jsonb
    WHERE "id" = ${paymentId}`
}

/** La transición AUTORIZADA de la obligación, dentro de la unidad: el REST sólo PENDING; el worker sólo su fila y su token. */
async function cerrarSegunElCierre(tx: Cliente, paymentId: string, cierre: CierreDeObligacion): Promise<void> {
  if (cierre.tipo === 'REST') {
    await tx.paymentEffect.updateMany({
      where: { paymentId, kind: 'TRANSACTION_COST', status: 'PENDING' },
      data: { status: 'DONE', completedAt: new Date(), lastError: null, claimToken: null, leaseUntil: null },
    })
  } else if (cierre.tipo === 'WORKER') {
    await tx.paymentEffect.updateMany({
      where: { id: cierre.effectId, claimToken: cierre.claimToken, status: 'PROCESSING' },
      data: { status: 'DONE', completedAt: new Date(), lastError: null, claimToken: null, leaseUntil: null },
    })
  }
}
