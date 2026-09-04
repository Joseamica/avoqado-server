import { createHash } from 'crypto'
import { PaymentType, TransactionStatus, CardBrand, CardEntryMode, Prisma } from '@prisma/client'
import { postCashRefundToDrawer } from '../shared/cashDrawerPosting'
import { turnoAbiertoDelNegocio } from '../shared/turnoDeCaja'
import { acumuladoPersistido, centavosYaDevueltos } from '../shared/devueltoDeUnCobro'
import logger from '../../config/logger'
import { BadRequestError, InternalServerError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { Decimal } from '@prisma/client/runtime/library'
import { createRefundTransactionCost } from '../payments/transactionCost.service'
import { createRefundCommission } from '../dashboard/commission/commission-calculation.service'
import { restockOrderItems } from '../dashboard/inventoryRestock.service'
import { logAction } from '../dashboard/activity-log.service'
import { resolveAutofacturaAvailable } from './payment.tpv.service'

/**
 * Refund request data from TPV Android app
 *
 * **CRITICAL - Multi-Merchant Routing:**
 * The refund MUST be processed by the same merchant that processed the original payment.
 */
interface RefundRequestData {
  venueId: string
  originalPaymentId: string
  originalOrderId?: string | null
  amount: number // In cents (5000 = $50.00)
  reason: string // RefundReason.name (e.g., "CUSTOMER_REQUEST")
  staffId: string
  // 🔴 NO hay `shiftId`: el turno lo resuelve el SERVIDOR (`../shared/turnoDeCaja.ts`).
  // El DTO de la PAX DECLARA el campo (`RefundRequest.kt` → `RefundRecorder.kt:265`), pero su
  // VALOR es siempre `null` y Gson omite los nulos: la llave no llega (medido el 3-sep-2026,
  // evidencia en el STEP 3). El contrato HTTP no cambia y la calle no se rompe.
  merchantAccountId?: string | null
  tpvId?: string | null // Terminal that processed this refund (for sales attribution)
  // Blumon serial: REQUIRED for Blumon/PAX refunds (used for SDK merchant switch
  // tracking), OPTIONAL/empty for AngelPay/Nexgo refunds (the AngelPay SDK
  // resolves the merchant via its own auth context, no serial needed).
  blumonSerialNumber?: string | null
  authorizationNumber: string
  referenceNumber: string
  maskedPan?: string | null
  cardBrand?: string | null
  entryMode?: string | null
  isPartialRefund: boolean
  currency: string
  /**
   * Payment processor that handled the original transaction. Persisted into
   * `Payment.processor` for the refund row so reports/reconciliation can
   * separate Blumon vs AngelPay refunds.
   *
   * Backwards compatible: omitting it defaults to `'blumon'`, matching the
   * legacy behavior used by all TPV builds before this field existed.
   * Accepted values: `'blumon'` (PAX) | `'angelpay'` (Nexgo).
   */
  processor?: string
  /**
   * Optional explicit tip portion of the refund, in cents. When omitted, TPV
   * splits proportional to the original sale/tip ratio. When set, the caller
   * controls how much of the refund comes from tip vs sale (0 = keep staff
   * tip intact, equal to amount = tip-only refund, etc.). Bounds are validated.
   */
  tipRefundCents?: number
  /**
   * 🛡️ Llave de idempotencia del reembolso — UUID generado UNA vez por intento lógico en
   * el cliente y reusado por su cola durable. El servidor la persiste en
   * `Payment.idempotencyKey`, protegida por el `@@unique([venueId, idempotencyKey])` que ya
   * existía en el modelo y que nadie poblaba para reembolsos.
   *
   * OPCIONAL a propósito: el APK que hay hoy en la calle NO la manda
   * (`PaymentContext.RefundPayment.idempotencyKey` tiene default `null`, nadie la puebla, y
   * Gson omite los nulos). Sin llave el camino se comporta EXACTAMENTE como antes.
   */
  idempotencyKey?: string | null
}

/**
 * Refund response matching what Android app expects
 */
interface RefundResponse {
  id: string
  originalPaymentId: string
  amount: number // In pesos (decimal)
  status: string
  authorizationNumber?: string | null
  referenceNumber?: string | null
  digitalReceipt?: {
    id: string
    accessKey: string
    receiptUrl: string
    autofacturaAvailable: boolean
  } | null
}

/**
 * Record a refund for an existing payment
 *
 * **Flow:**
 * 1. Find original payment and validate
 * 2. Validate refund amount doesn't exceed original
 * 3. Create new Payment record with type=REFUND
 * 4. Update original payment's processorData with refund tracking
 * 5. Generate digital receipt
 * 6. Return response
 *
 * @param venueId Venue ID from route params
 * @param refundData Refund request data from TPV
 * @param userId Current user ID (from auth context)
 * @param orgId Organization ID (from auth context)
 */
/**
 * Busca el reembolso que YA se registró con esta llave.
 *
 * La llave compuesta se llama `venueId_idempotencyKey` en el cliente de Prisma (el `map:`
 * del modelo sólo renombra la restricción en la base, no la entrada del cliente) — es la
 * misma que usa el camino de cobro en `payment.tpv.service.ts`.
 */
/**
 * ¿Este `P2002` es del índice `@@unique([venueId, idempotencyKey])` y no de otro?
 *
 * Prisma reporta el índice en `meta.target`, a veces como los nombres de las columnas y a
 * veces como el nombre mapeado de la restricción. Se aceptan las dos formas; cualquier otra
 * cosa NO es esta carrera y el error debe propagarse.
 */
function chocoLaLlaveDeIdempotencia(error: Prisma.PrismaClientKnownRequestError): boolean {
  const target = (error.meta as { target?: unknown } | undefined)?.target
  const partes = Array.isArray(target) ? target.map(String) : typeof target === 'string' ? [target] : []
  return partes.some(t => t.includes('idempotencyKey') || t === 'Payment_venueId_idempotencyKey_key')
}

/** `Payment.idempotencyKey` es `@db.VarChar(64)`. */
const LLAVE_IDEMPOTENCIA_MAX = 64

// Read one extra row so an abnormal refund history fails visibly. Truncating this
// list would undercount money already returned and could permit an over-refund.
const MAX_REFUND_ROWS_PER_PAYMENT = 1_000

/**
 * 🔴 Prefijo obligatorio. `Payment.idempotencyKey` es UNA sola columna para cobros Y
 * reembolsos, bajo un `@@unique([venueId, idempotencyKey])` de toda la tabla. Un cliente que
 * genere llaves únicas POR ENDPOINT —que es lo correcto— podría mandar la misma cadena en un
 * cobro y en un reembolso, y sin prefijo la segunda operación chocaría contra la primera. Con
 * el namespace ese choque es imposible por construcción.
 */
const LLAVE_IDEMPOTENCIA_NS = 'refund:'

/** ¿Esta fila es de verdad el reembolso de ESTE pago original? */
type FilaDePago = NonNullable<Awaited<ReturnType<typeof buscarReembolsoPorLlave>>>

function esReembolsoDe(fila: Pick<FilaDePago, 'type' | 'processorData'>, originalPaymentId: string): boolean {
  if (fila.type !== PaymentType.REFUND) return false
  const dueño = ((fila.processorData as Record<string, unknown> | null) ?? {}).originalPaymentId
  return dueño === originalPaymentId
}

/**
 * La llave que se PERSISTE no es la del cliente: es la huella de (llave, pago original, monto).
 *
 * 🔴 Tres auditorías seguidas encontraron defectos alrededor de guardar la cadena cruda, y
 * todos eran la misma pregunta mal resuelta: «¿esta fila con mi llave es de verdad MI
 * reembolso?». Derivar la llave hace que la pregunta no exista —dos reembolsos distintos NO
 * pueden compartir llave— en vez de contestarla después con guardias:
 *
 * - **El pago original entra en la huella** ⇒ la misma cadena sobre dos cobros distintos da
 *   dos llaves distintas. Antes, el segundo se devolvía como «reintento» del primero.
 * - **El monto entra en la huella** ⇒ un segundo parcial que reuse la llave NO se traga. Antes
 *   se devolvía la fila vieja y su dinero —ya devuelto por el SDK— quedaba sin registrar.
 * - **El prefijo `refund:`** ⇒ `Payment.idempotencyKey` es UNA columna para cobros y
 *   reembolsos bajo un `@@unique` de toda la tabla; sin él, un cliente con llaves únicas POR
 *   ENDPOINT chocaba consigo mismo.
 * - **Todo se hashea** ⇒ el largo del cliente deja de importar. La columna es `VarChar(64)` y
 *   una cadena más larga tumbaba la transacción DESPUÉS de que el SDK ya devolvió el dinero.
 *
 * Vacía o en blanco sigue siendo «sin idempotencia»: no hay nada de donde derivar.
 */
function llaveDeIdempotencia(refundData: RefundRequestData, venueId: string): string | undefined {
  const raw = refundData.idempotencyKey
  if (typeof raw !== 'string') return undefined
  const llave = raw.trim()
  if (!llave) return undefined

  // 🔴 Qué entra y por qué. La huella tiene que identificar LA OPERACIÓN, no sólo la cadena del
  // cliente: dos devoluciones reales de $50 sobre el MISMO cobro, con la misma llave reusada,
  // daban la misma huella y la segunda se tragaba como «reintento» — su dinero, ya devuelto por
  // el SDK, quedaba sin registrar. La autorización y la referencia son la identidad que el
  // PROCESADOR le da a esa devolución concreta, y un reintento legítimo las reenvía idénticas
  // desde la cola, así que distinguen operaciones sin romper la deduplicación.
  //
  // El monto se redondea a centavos ENTEROS antes de entrar: la ruta no valida este body, y
  // `100.4` y `100.49` son el MISMO dinero (las columnas son `Decimal(,2)`) pero producían
  // llaves distintas — una forma de saltarse la deduplicación tecleando decimales.
  //
  // Separador `\u0000`: la llave del cliente SÍ podría traerlo (nadie valida ese body), pero las
  // otras cuatro partes salen de Postgres o son números y no pueden contenerlo, así que la
  // lectura desde el final sigue siendo inequívoca. El `trim()` de arriba hace la transformación
  // no inyectiva a propósito: `"abc"` y `" abc "` son la misma llave.
  const huella = createHash('sha256')
    .update(
      [
        llave,
        refundData.originalPaymentId,
        Math.round(Number(refundData.amount) || 0),
        refundData.authorizationNumber ?? '',
        refundData.referenceNumber ?? '',
      ].join('\u0000'),
    )
    .digest('hex')
  logger.info('Refund idempotencyKey derivada', { venueId, originalPaymentId: refundData.originalPaymentId })
  return `${LLAVE_IDEMPOTENCIA_NS}${huella}`.slice(0, LLAVE_IDEMPOTENCIA_MAX)
}

async function buscarReembolsoPorLlave(venueId: string, idempotencyKey: string) {
  return prisma.payment.findUnique({
    where: { venueId_idempotencyKey: { venueId, idempotencyKey } },
    include: { receipts: true },
  })
}

/**
 * Convierte un reembolso que ya existía en la MISMA respuesta que devuelve el camino normal
 * (STEP 8), para que la terminal no pueda distinguir un reintento de un primer envío.
 *
 * 🔴 NO genera un recibo digital: reusa el que la fila ya tenga. Generarlo aquí crearía un
 * segundo recibo del mismo reembolso en cada reintento — el mismo defecto de duplicación que
 * este bloque existe para evitar, una tabla más allá. Si el primer intento no alcanzó a
 * generarlo (el STEP 7 es fail-open), el reintento devuelve `null`, que es lo que el cliente
 * ya tolera (`RefundRecorder` lo lee con `?.`).
 */
async function respuestaDeReembolsoExistente(
  existente: {
    id: string
    amount: Prisma.Decimal | number
    tipAmount: Prisma.Decimal | number | null
    status: string
    authorizationNumber: string | null
    referenceNumber: string | null
    receipts: Array<{ id: string; accessKey: string }>
  },
  originalPaymentId: string,
  originalOrderId: string | null,
): Promise<RefundResponse> {
  const recibo = existente.receipts[0] ?? null
  return {
    id: existente.id,
    originalPaymentId,
    // Mismo cálculo que el STEP 8: la terminal espera el TOTAL (venta + propina), en positivo.
    amount: Math.abs(Number(existente.amount)) + Math.abs(Number(existente.tipAmount ?? 0)),
    status: existente.status,
    authorizationNumber: existente.authorizationNumber,
    referenceNumber: existente.referenceNumber,
    digitalReceipt: recibo
      ? {
          id: recibo.id,
          accessKey: recibo.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${recibo.accessKey}?refund=true`,
          autofacturaAvailable: await resolveAutofacturaAvailable(originalOrderId),
        }
      : null,
  }
}

export async function recordRefund(
  venueId: string,
  refundData: RefundRequestData,
  _userId?: string,
  _orgId?: string,
): Promise<RefundResponse> {
  logger.info('Recording refund', {
    venueId,
    originalPaymentId: refundData.originalPaymentId,
    amount: refundData.amount,
    reason: refundData.reason,
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1: Find and validate original payment
  // ═══════════════════════════════════════════════════════════════════════════
  const originalPayment = await prisma.payment.findUnique({
    where: { id: refundData.originalPaymentId },
    include: {
      order: true,
      receipts: true,
    },
  })

  if (!originalPayment) {
    logger.error('Original payment not found', {
      originalPaymentId: refundData.originalPaymentId,
      venueId,
    })
    throw new NotFoundError(`Payment ${refundData.originalPaymentId} not found`)
  }

  // Validate payment belongs to this venue
  if (originalPayment.venueId !== venueId) {
    logger.error('Payment does not belong to venue', {
      originalPaymentId: refundData.originalPaymentId,
      paymentVenueId: originalPayment.venueId,
      requestedVenueId: venueId,
    })
    throw new BadRequestError('Payment does not belong to this venue')
  }

  // Validate payment is completed
  if (originalPayment.status !== 'COMPLETED') {
    logger.error('Cannot refund non-completed payment', {
      originalPaymentId: refundData.originalPaymentId,
      status: originalPayment.status,
    })
    throw new BadRequestError(`Cannot refund payment with status: ${originalPayment.status}`)
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 1.5: Reintento idempotente — se resuelve ANTES del guardia de importe
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // 🔴 EL ORDEN NO ES COSMÉTICO. Un reintento de un reembolso TOTAL ya aplicado deja
  // `remainingRefundable` en 0, así que si esta comprobación fuera DESPUÉS del STEP 2 el
  // reintento rebotaría con el `BadRequestError` de «excede el monto reembolsable» — un 400
  // que el cliente NO puede distinguir de un rechazo real: su cola lo marcaría como fallo
  // PERMANENTE, alarmaría al cajero y bloquearía el cierre de turno por un reembolso que sí
  // había quedado registrado.
  //
  // Mismo patrón que el camino de COBRO (`payment.tpv.service.ts`, «Idempotent retry
  // detected by idempotencyKey»): el reintento devuelve 200 con la fila existente, nunca 409.
  let llaveIdempotencia = llaveDeIdempotencia(refundData, venueId)

  if (llaveIdempotencia) {
    const existente = await buscarReembolsoPorLlave(venueId, llaveIdempotencia)
    if (existente) {
      if (esReembolsoDe(existente, refundData.originalPaymentId)) {
        logger.info('🔄 Idempotent refund retry detected by idempotencyKey — returning existing refund', {
          venueId,
          idempotencyKey: llaveIdempotencia,
          existingRefundPaymentId: existente.id,
          originalPaymentId: refundData.originalPaymentId,
        })
        // 🔴 NO se repone aquí el `PAY_OUT` del cajón, y no es un olvido. Reponerlo sin
        // `targetSessionId` lo mete en la caja abierta AHORA: un reembolso de ayer cuyo posting
        // falló y se reintenta mañana produciría un faltante inventado para el cajero de mañana
        // — el mismo defecto que se mató en agosto. El job `cash-drawer-reconciler` ya repone
        // los `PAY_OUT` faltantes cada 5 min DENTRO de la ventana `[openedAt, closedAt]` que
        // corresponde, y reporta como `outsideDrawer` lo que no cabe en ninguna. Ésa es la
        // reparación buena; ésta sería una peor compitiendo con ella.
        //
        // ⚠️ Los demás efectos post-commit tampoco se reponen y se declara: reposición de
        // inventario, costo de transacción y comisión, reversión del sello y el recibo digital.
        return respuestaDeReembolsoExistente(existente, refundData.originalPaymentId, originalPayment.orderId)
      }

      // 🔴 La llave está ocupada por otra cosa. NO se responde 400: cuando esto corre el SDK YA
      // devolvió el dinero, así que rechazar deja la devolución hecha y sin asiento — el defecto
      // original por la puerta de atrás, y encima con un mensaje que miente. Se degrada
      // ruidosamente: el reembolso se registra, sin protección de idempotencia.
      logger.error('Refund idempotencyKey ocupada por otra operación — se registra SIN idempotencia', {
        venueId,
        idempotencyKey: llaveIdempotencia,
        filaHallada: existente.id,
        tipoHallado: existente.type,
        originalPaymentIdSolicitado: refundData.originalPaymentId,
      })
      llaveIdempotencia = undefined
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 2: Validate refund amount
  // ═══════════════════════════════════════════════════════════════════════════

  // Reject zero/negative refund amounts up-front — Blumon would accept the
  // call but the resulting DB row is a $0 refund that only pollutes reports.
  if (!Number.isFinite(refundData.amount) || refundData.amount <= 0) {
    logger.error('Invalid refund amount (must be > 0)', { amount: refundData.amount })
    throw new BadRequestError('Refund amount must be greater than zero')
  }

  const refundAmountInPesos = refundData.amount / 100
  const originalAmountNumber = Number(originalPayment.amount)
  // 💸 FIX: Include tip in refundable amount - tip is part of the total transaction
  const originalTipNumber = Number(originalPayment.tipAmount || 0)
  const totalOriginalAmount = originalAmountNumber + originalTipNumber

  // Calculate already refunded amount from processorData.
  // 🔴 La definición de «cuánto se ha devuelto ya» vive UNA sola vez, en
  // `shared/devueltoDeUnCobro.ts`, y es la misma que usa el riel del dashboard: **venta +
  // propina**, leída de los CENTAVOS enteros cuando están. Antes esto era
  // `Number(processorData.refundedAmount || 0)`, que ignoraba `refundedAmountCents` y trataba
  // un acumulado ilegible como 0 — y comparar contra `NaN` da `false`, o sea que un cobro con
  // el acumulado corrupto dejaba pasar TODOS los reembolsos.
  //
  // Esto es sólo el PRE-VUELO (fuera de la transacción). Quien autoriza de verdad es el mismo
  // cálculo bajo el `SELECT … FOR UPDATE` del STEP 4.
  //
  // Se compara en CENTAVOS ENTEROS, igual que el bloque bloqueado: sumar y restar pesos con
  // `+`/`-` teniendo los centavos a la mano deriva, y aquí el error de float es
  // consistentemente PERMISIVO (deja pasar un reembolso que el candado luego rechaza). Las
  // copias en pesos se conservan para el log y el mensaje, que hablan en pesos.
  const processorData = (originalPayment.processorData as Record<string, unknown>) || {}
  const yaDevueltoCentsPrevuelo = centavosYaDevueltos({ processorData })
  const totalOriginalCentsPrevuelo = Math.round(originalAmountNumber * 100) + Math.round(originalTipNumber * 100)
  const esteReembolsoCentsPrevuelo = Math.round(refundAmountInPesos * 100)
  const remainingRefundableCents = totalOriginalCentsPrevuelo - yaDevueltoCentsPrevuelo
  const alreadyRefunded = yaDevueltoCentsPrevuelo / 100
  const remainingRefundable = remainingRefundableCents / 100

  if (esteReembolsoCentsPrevuelo > remainingRefundableCents) {
    logger.error('Refund amount exceeds remaining refundable', {
      originalPaymentId: refundData.originalPaymentId,
      requestedRefund: refundAmountInPesos,
      originalAmount: originalAmountNumber,
      originalTip: originalTipNumber,
      totalOriginalAmount,
      alreadyRefunded,
      remainingRefundable,
    })
    throw new BadRequestError(`Refund amount (${refundAmountInPesos}) exceeds remaining refundable amount (${remainingRefundable})`)
  }

  // Split between sale (Payment.amount) and tip (Payment.tipAmount). Default
  // is proportional; caller can override with `tipRefundCents` for explicit
  // control ("refund only the sale, keep staff tip intact", etc.).
  let tipRefund = 0
  let salesRefund = refundAmountInPesos

  if (typeof refundData.tipRefundCents === 'number') {
    const overrideTip = refundData.tipRefundCents / 100
    if (overrideTip < 0) {
      throw new BadRequestError('tipRefundCents must be >= 0')
    }
    if (overrideTip > refundAmountInPesos + 0.001) {
      throw new BadRequestError(`tipRefundCents ($${overrideTip}) exceeds total refund ($${refundAmountInPesos})`)
    }
    if (overrideTip > originalTipNumber + 0.001) {
      throw new BadRequestError(`tipRefundCents ($${overrideTip}) exceeds original tip ($${originalTipNumber})`)
    }
    tipRefund = Math.round(overrideTip * 100) / 100
    salesRefund = Math.round((refundAmountInPesos - tipRefund) * 100) / 100
    if (salesRefund > originalAmountNumber + 0.001) {
      throw new BadRequestError(`Sale portion of refund ($${salesRefund}) exceeds original sale amount ($${originalAmountNumber})`)
    }
  } else if (originalTipNumber > 0 && totalOriginalAmount > 0) {
    // Default: proportional split.
    tipRefund = Math.round(((refundAmountInPesos * originalTipNumber) / totalOriginalAmount) * 100) / 100
    tipRefund = Math.min(tipRefund, originalTipNumber)
    salesRefund = Math.round((refundAmountInPesos - tipRefund) * 100) / 100
    if (salesRefund > originalAmountNumber) {
      const excess = salesRefund - originalAmountNumber
      salesRefund -= excess
      tipRefund = Math.round((tipRefund + excess) * 100) / 100
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 3: el turno abierto del NEGOCIO — se resuelve DENTRO de la transacción (STEP 4)
  // ═══════════════════════════════════════════════════════════════════════════
  // Aquí NO queda nada: hasta el 3-sep-2026 este paso leía `refundData.shiftId` y sólo caía al
  // helper cuando venía vacío. El body SÍ llega crudo —la ruta valida con
  // `recordFastPaymentParamsSchema`, que declara sólo `params`, así que `validateRequest` no lo
  // parsea ni lo reemplaza—, y por eso se ignora a propósito.
  //
  // 🔴 CORRECCIÓN MEDIDA (3-sep-2026, sobre avoqado-tpv). Se escribió aquí que ese campo «venía
  // SIEMPRE lleno», y es FALSO. La PAX manda `shiftId` VACÍO en todos los reembolsos:
  //
  //   · Blumon: `PaymentScreen.kt:566` construye el `RefundPayment` con `shiftId = null`;
  //     `PaymentViewModel.startRefund` lo copia tal cual (`currentShiftId = context.shiftId`,
  //     con su propio «will be resolved later» que nunca ocurre) y `buildRefundPaymentContext`
  //     lo vuelve a leer (`currentShiftId ?: base.shiftId`) → null.
  //   · AngelPay/Nexgo: `RecordAngelPayRefundUseCase.kt:598` pone `shiftId = null` explícito.
  //   · `createRefundContext`, el ÚNICO helper que aceptaría un turno, sólo se usa en tests.
  //   · Retrofit usa `GsonConverterFactory.create()` sin `serializeNulls()` ⇒ Gson OMITE los
  //     nulos: la llave ni siquiera aparece en el JSON. `req.body.shiftId` es `undefined`.
  //
  // Nunca ha sido de otra forma: nació así con los reembolsos (`12d6e8b`, 16-dic-2025).
  //
  // 🔴 Y la consecuencia, para quien venga a «devolverle al cliente la autoridad del turno para
  // el reembolso TARDÍO»: no hay contexto que conservar, y tardío tampoco hay. Los reembolsos
  // NO tienen cola durable — Room sólo guarda `PendingPaymentEntity` (pagos); la libreta
  // declara `KIND_REFUND`/`ROUTE_REFUND` pero su cableado «ships later» y su sweep es sólo
  // observabilidad («NEVER records payments»)—, así que `RefundRecorder` hace UNA llamada con
  // `callTimeout` de 25 s y, si falla, el dinero ya volvió a la tarjeta y la app manda a
  // soporte. Entre el reembolso físico y este INSERT hay segundos, no horas.
  //
  // El porqué de resolverlo dentro de la transacción está en el bloque «turno» del STEP 4.

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4: Create refund payment and update original in transaction
  // ═══════════════════════════════════════════════════════════════════════════
  const ejecutarTransaccionDelReembolso = () =>
    prisma.$transaction(async tx => {
      // 🔒 Row-lock the original payment for the duration of this tx so
      // concurrent refund attempts cannot both pass the "remaining refundable"
      // check with stale data and each create their own refund (D8 race).
      const lockedRows = await tx.$queryRaw<Array<{ id: string; amount: unknown; tipAmount: unknown; processorData: unknown }>>(Prisma.sql`
      SELECT id, amount, "tipAmount", "processorData"
      FROM "Payment"
      WHERE id = ${refundData.originalPaymentId}
      FOR UPDATE
    `)
      const locked = lockedRows[0]
      if (!locked) {
        throw new NotFoundError(`Payment ${refundData.originalPaymentId} disappeared`)
      }
      // 🔴 El `SELECT` de arriba declara su tipo A MANO, así que TypeScript NO comprueba que el
      // SQL devuelva de verdad estas columnas. Recortar una en una edición futura vuelve la
      // guarda del remanente INOFENSIVA, en silencio y para siempre:
      //
      //   · sin `amount` → `Number(undefined)` = `NaN` ⇒ `lockedRemaining` es `NaN` ⇒
      //     `refundAmountInPesos > NaN` es **false** ⇒ TODOS los reembolsos pasan la validación;
      //   · 🔴 sin `processorData` → aquí NO aparece ningún `NaN` que delate nada: el `?? {}` de
      //     abajo deja `lockedAlreadyRefunded` en 0 en CADA reembolso, el acumulado se reinicia
      //     solo y resucita el «$150 sobre $100» que este mismo bloque acaba de cerrar.
      //
      // Por eso se comprueba la PRESENCIA de la columna y no sólo que el número sea finito:
      // `Number.isFinite` es ciego al segundo caso. Y se mira la LLAVE, no el valor, porque
      // `tipAmount` y `processorData` son nulables: `null` es una fila normal (llave presente),
      // mientras que una columna que no se pidió no aparece en el objeto. Confundirlos
      // rechazaría reembolsos buenos.
      //
      // Falla RUIDOSO —y por tanto no registra el reembolso— a propósito: el dinero ya salió de
      // la terminal, así que ninguna de las dos salidas es buena, pero un rechazo sistemático se
      // nota en minutos y devolver de más no se nota nunca. Es 500 y no 4xx porque el fallo es
      // del servidor, no de quien llama, y así entra a las alertas por `logger.error`.
      for (const columna of ['amount', 'tipAmount', 'processorData'] as const) {
        if (!(columna in locked)) {
          logger.error('El SELECT … FOR UPDATE del reembolso dejó de traer una columna', {
            venueId,
            originalPaymentId: refundData.originalPaymentId,
            columnaFaltante: columna,
            columnasRecibidas: Object.keys(locked),
          })
          throw new InternalServerError(
            `El candado del reembolso no devolvió la columna "${columna}": no se puede validar el monto reembolsable. ` +
              'No se registró ningún reembolso.',
          )
        }
      }

      const lockedProcessorData = (locked.processorData as Record<string, unknown> | null) ?? {}

      // 🔴 LAS FILAS DE REEMBOLSO, NO SÓLO EL ACUMULADO. Es una consulta más dentro de una
      // transacción que YA está abierta, y es lo que cierra el último paso de la fuga: un
      // cobro de $100 + $20 con `refundedAmount: 110` escrito por la regla vieja (dos
      // reembolsos del dashboard que en realidad suman 120) haría creer a la terminal que
      // quedan $10 y sacaría **$130 sobre $120**. Con el acumulado solo, lo que protegía este
      // riel era que ningún cobro vivo tuviera dos reembolsos — o sea una medición, no el
      // código. `centavosYaDevueltos` toma la MAYOR de las dos evidencias
      // (`shared/devueltoDeUnCobro.ts`).
      //
      // Va DESPUÉS del `FOR UPDATE`: el candado serializa a los escritores del mismo cobro,
      // así que esta lectura ve lo que ya commiteó quien ganó. Antes del candado sería una
      // foto vieja, que es exactamente el defecto que cerró la Task 5k.
      //
      // Es `findMany` y no `$queryRaw` a propósito: el `select` lo comprueba TypeScript, así
      // que aquí la columna `tipAmount` no se puede recortar en silencio — que es el descuido
      // del que esta tarea entera nació. La relación sigue pudiendo crecer, por eso se lee
      // `MAX + 1`: si existe esa fila extra se rechaza ruidosamente en vez de validar dinero
      // contra una historia truncada.
      const filasDeReembolso = await tx.payment.findMany({
        where: {
          venueId,
          type: PaymentType.REFUND,
          processorData: { path: ['originalPaymentId'], equals: refundData.originalPaymentId },
        },
        select: { amount: true, tipAmount: true, status: true },
        take: MAX_REFUND_ROWS_PER_PAYMENT + 1,
      })

      if (filasDeReembolso.length > MAX_REFUND_ROWS_PER_PAYMENT) {
        logger.error('El cobro rebasa el máximo verificable de filas de reembolso', {
          venueId,
          originalPaymentId: refundData.originalPaymentId,
          maxRefundRows: MAX_REFUND_ROWS_PER_PAYMENT,
        })
        throw new InternalServerError(
          `El cobro tiene más de ${MAX_REFUND_ROWS_PER_PAYMENT} reembolsos registrados; no se puede validar el monto reembolsable. ` +
            'No se registró ningún reembolso.',
        )
      }

      // Misma definición ÚNICA que el pre-vuelo y que el riel del dashboard: venta + propina,
      // en centavos enteros (`shared/devueltoDeUnCobro.ts`). Se conserva la copia en pesos
      // porque la usan el aviso de concurrencia y los mensajes de error, que hablan en pesos.
      const lockedAlreadyRefundedCents = centavosYaDevueltos({ processorData: lockedProcessorData, filas: filasDeReembolso })
      const lockedAlreadyRefunded = lockedAlreadyRefundedCents / 100
      const lockedTotal = Number(locked.amount) + Number(locked.tipAmount ?? 0)
      // Cinturón además de los tirantes: la llave puede estar y el valor no ser un número
      // (una cadena que no parsea, por ejemplo). Comparar contra `NaN` da `false` igual.
      if (!Number.isFinite(lockedTotal)) {
        logger.error('El importe del pago bloqueado no es un número: no se puede validar el reembolso', {
          venueId,
          originalPaymentId: refundData.originalPaymentId,
          amount: locked.amount,
          tipAmount: locked.tipAmount,
        })
        throw new InternalServerError(
          'El importe del cobro original no es un número: no se puede validar el monto reembolsable. No se registró ningún reembolso.',
        )
      }
      // La comparación se hace en CENTAVOS ENTEROS. Antes se restaban pesos y hacía falta una
      // tolerancia de `+0.001` para absorber el error de punto flotante; con enteros no hay
      // residuo que tolerar y el límite es exacto. Los centavos de ESTE reembolso se derivan
      // igual que los que se guardan en la fila (`amountCents`, más abajo), así que la fila y
      // el acumulado no pueden desalinearse ni por un centavo.
      const esteReembolsoCents = Math.round(refundAmountInPesos * 100)
      const lockedTotalCents = Math.round(Number(locked.amount) * 100) + Math.round(Number(locked.tipAmount ?? 0) * 100)
      const lockedRemainingCents = lockedTotalCents - lockedAlreadyRefundedCents
      const lockedRemaining = lockedRemainingCents / 100
      if (esteReembolsoCents > lockedRemainingCents) {
        throw new BadRequestError(`Refund amount (${refundAmountInPesos}) exceeds remaining refundable amount (${lockedRemaining})`)
      }

      // ═══════════════════════════════════════════════════════════════════════
      // El turno abierto del NEGOCIO: resolver → RECLAMAR → sellar, todo aquí dentro
      // ═══════════════════════════════════════════════════════════════════════
      // 🔴 Plantilla de `mobile/refund.mobile.service.ts:65-88`, y las tres piezas cuentan:
      //
      // 1. Se resuelve con `tx` y DENTRO de la transacción. Resolverlo fuera dejaba una
      //    ventana en la que el turno se cerraba en medio (otro aparato, o el cierre
      //    automático) con el `Payment` ya sellado apuntando a él.
      // 2. El claim ES el decremento: `updateMany` condicionado a `status: 'OPEN'` y acotado
      //    por `venueId` — por id solo aceptaba el turno de OTRO negocio. Es `updateMany` y no
      //    `update` porque un `where` que no encaja tiene que dar `count: 0`, no un P2025 que
      //    tumbe la transacción entera: el dinero YA salió de la caja física.
      // 3. 🔴 El `Payment` se sella con el turno SÓLO si el claim GANÓ. Sellar antes de
      //    reclamar (y descartar el `count`) dejaba un REFUND colgando de un turno cerrado al
      //    que nunca se le restó, y el cierre selecciona estrictamente por `shiftId`
      //    (`shift.tpv.service.ts:1485-1489`): un recálculo desde los pagos discreparía de su
      //    propio `totalSales` por el monto del reembolso.
      //
      // `shiftId` queda en null en DOS casos, y sólo en ésos: no hay ningún turno abierto, o el
      // que había se cerró entre la lectura y el claim. En ambos el reembolso se registra igual
      // y queda FUERA de todo turno de forma coherente (ni el contador denormalizado ni un
      // recálculo desde los pagos lo cuentan). El efectivo físico no se pierde: el `PAY_OUT` al
      // cajón se publica post-commit contra la `CashDrawerSession` abierta del venue
      // (`shared/cashDrawerPosting.ts:334-336`), que no depende del `Shift`. Y un pago con
      // `shiftId` nulo es REATRIBUIBLE después (`scripts/reatribuir-cobros-al-turno.ts`),
      // mientras que uno estampado en un turno ya cerrado CON conteo es justo lo que ese script
      // se niega a tocar.
      let shiftId: string | null = null
      const turnoDelNegocio = await turnoAbiertoDelNegocio(tx, venueId)
      if (turnoDelNegocio) {
        const reclamado = await tx.shift.updateMany({
          where: { id: turnoDelNegocio.id, venueId, status: 'OPEN', endTime: null },
          data: {
            totalSales: { decrement: new Decimal(salesRefund) },
            ...(tipRefund > 0 ? { totalTips: { decrement: new Decimal(tipRefund) } } : {}),
          },
        })
        if (reclamado.count === 1) shiftId = turnoDelNegocio.id
      }

      // Create new Payment record with type=REFUND
      const refundPayment = await tx.payment.create({
        data: {
          venueId,
          orderId: originalPayment.orderId, // Link to same order
          shiftId: shiftId || undefined,
          processedById: refundData.staffId,
          merchantAccountId: refundData.merchantAccountId || originalPayment.merchantAccountId,
          // ⭐ Terminal that processed this refund (use provided tpvId or inherit from original payment)
          terminalId: refundData.tpvId || originalPayment.terminalId || null,

          // Negative amount/tip mirror the original split.
          amount: new Decimal(-salesRefund),
          tipAmount: new Decimal(-tipRefund),

          // Payment info
          method: originalPayment.method,
          // 🔴 El reembolso hereda la IDENTIDAD y la SEMÁNTICA del tipo original, no sólo el
          // `method`. Un cobro del POS con un tipo del catálogo se puede devolver desde la
          // terminal: sin esto, devolver un vale que SÍ entraba al cajón caía al fallback
          // legacy (`method === 'CASH'` = false) y el arqueo seguiría exigiendo un efectivo
          // que YA salió. Espejo exacto de `refund.dashboard.service.ts`.
          //
          // La COMISIÓN no se hereda a propósito: que la plataforma devuelva su porcentaje
          // cuando el cliente cancela es un acuerdo comercial que no conocemos.
          ...(originalPayment.tenderTypeId
            ? {
                tenderTypeId: originalPayment.tenderTypeId,
                ...(originalPayment.tenderRevision != null ? { tenderRevision: originalPayment.tenderRevision } : {}),
                ...(originalPayment.tenderLabel != null ? { tenderLabel: originalPayment.tenderLabel } : {}),
                ...(originalPayment.tenderCountsAsCash != null ? { tenderCountsAsCash: originalPayment.tenderCountsAsCash } : {}),
                ...(originalPayment.tenderCaptureTip != null ? { tenderCaptureTip: originalPayment.tenderCaptureTip } : {}),
                ...(originalPayment.tenderSatFormaPago != null ? { tenderSatFormaPago: originalPayment.tenderSatFormaPago } : {}),
              }
            : {}),
          ...(originalPayment.fundsFlow ? { fundsFlow: originalPayment.fundsFlow } : {}),
          source: originalPayment.source,
          status: TransactionStatus.COMPLETED,
          type: PaymentType.REFUND,

          // Processor info — defaults to 'blumon' for backwards compat with
          // pre-2.31 TPVs that don't send the field. Newer TPVs send 'angelpay'
          // for Nexgo refunds so downstream reports can separate them.
          processor: refundData.processor ?? 'blumon',

          // 🛡️ Sin esta línea el `@@unique([venueId, idempotencyKey])` del modelo no protege
          // NADA en los reembolsos: el índice existe desde siempre y nadie lo poblaba, así que
          // dos POST idénticos creaban dos filas. `undefined` (no `null`) para no tocar el
          // comportamiento de los APK viejos, que no mandan llave.
          idempotencyKey: llaveIdempotencia,
          processorData: {
            originalPaymentId: refundData.originalPaymentId,
            refundReason: refundData.reason,
            isPartialRefund: refundData.isPartialRefund,
            currency: refundData.currency,
            blumonSerialNumber: refundData.blumonSerialNumber,
            // Parity fields with dashboard/mobile refunds so downstream
            // consumers (backfill script, reports) treat TPV refunds uniformly.
            amountCents: Math.round(refundAmountInPesos * 100),
            amount: refundAmountInPesos,
            // Marker: shift totalSales decrement is applied in-line below.
            // `scripts/backfill-refund-shift-totals.ts` skips rows with this flag.
            shiftBackfilled: true,
          },

          // Authorization from Blumon SDK CancelIcc
          authorizationNumber: refundData.authorizationNumber,
          referenceNumber: refundData.referenceNumber,

          // Card details
          cardBrand: mapCardBrand(refundData.cardBrand),
          maskedPan: refundData.maskedPan,
          entryMode: mapEntryMode(refundData.entryMode),

          // Fee calculation (no fees on refunds typically)
          feePercentage: new Decimal(0),
          feeAmount: new Decimal(0),
          netAmount: new Decimal(-refundAmountInPesos),
        },
      })

      // ═══════════════════════════════════════════════════════════════════════
      // Update original payment's processorData with refund tracking
      // ═══════════════════════════════════════════════════════════════════════
      // 🔴 TODO lo de aquí abajo sale de la foto BLOQUEADA (`lockedProcessorData`,
      // `lockedAlreadyRefunded`, `locked.amount`), NUNCA de `processorData` /
      // `alreadyRefunded` / `originalAmountNumber`, que se leyeron con el `findUnique` del
      // STEP 1 — FUERA de la transacción y, por tanto, antes de que existiera candado alguno.
      //
      // Hasta el 3-sep-2026 este bloque validaba con la foto bloqueada y ESCRIBÍA con la
      // vieja, y eso devolvía dinero de más. Cobro de $100, dos reembolsos concurrentes de
      // $60 y $40: los dos leen `refundedAmount = 0` fuera del candado; A escribe 60; B toma
      // el candado, ve correctamente `lockedRemaining = 40` y pasa — pero escribía
      // `0 + 40 = 40`, **borrando los 60 de A** y su historial. Un tercero de $50 leía «40
      // devueltos», pasaba, y salían **$150 sobre $100**.
      //
      // El `FOR UPDATE` de arriba serializa las transacciones, así que la foto bloqueada SÍ
      // ve lo que escribió quien ganó: acumular sobre ella es lo que cierra la carrera. Y el
      // spread tiene que partir de `lockedProcessorData` por lo mismo — con la foto vieja se
      // borra cualquier llave que otro escritor haya puesto en medio (el webhook de AngelPay
      // estampa `angelpayWebhook` sobre esta misma columna: `angelpay-webhook.service.ts`).
      //
      // Prueba: `tests/unit/services/tpv/refund.acumuladoBajoCandado.test.ts`, donde las dos
      // fotos DIFIEREN a propósito (exterior 0, bloqueada 60). Con el mismo valor en ambas la
      // prueba pasaría con el defecto vivo.
      // Se acumula en CENTAVOS ENTEROS y los dos campos persistidos se derivan del MISMO
      // entero (`acumuladoPersistido`): sumar pesos con `+` deriva, y derivar cada campo por
      // su cuenta es cómo empiezan a contradecirse.
      const nuevoDevueltoCents = lockedAlreadyRefundedCents + esteReembolsoCents
      const acumulado = acumuladoPersistido(nuevoDevueltoCents)
      const newRefundedAmount = acumulado.refundedAmount

      // 🔎 Si las dos fotos NO coinciden es que otro reembolso del MISMO cobro entró entre la
      // lectura del STEP 1 y este candado: exactamente la carrera de arriba. Con el defecto
      // vivo esto era invisible; dejarlo dicho es la única forma de saber si pasa de verdad
      // en producción. Importes en PESOS. No cambia el resultado: sólo lo cuenta.
      if (lockedAlreadyRefunded !== alreadyRefunded) {
        logger.warn('Reembolso concurrente sobre el mismo cobro: se acumula sobre la foto BLOQUEADA', {
          venueId,
          originalPaymentId: refundData.originalPaymentId,
          devueltoAlLeerFueraDelCandado: alreadyRefunded,
          devueltoBajoElCandado: lockedAlreadyRefunded,
          esteReembolso: refundAmountInPesos,
          totalDevueltoTrasEste: newRefundedAmount,
        })
      }
      // 🔴 Se compara contra el TOTAL (venta + propina), que es la misma base sobre la que se
      // mide el acumulado. Desde dic-2025 hasta la Task 5r esta línea usaba `locked.amount`
      // —la VENTA sola—, así que con propina el dato PERSISTIDO y el que el historial de la
      // terminal SIRVE se contradecían: devolver $100 de un cobro de $100 + $20 se guardaba
      // como «totalmente reembolsado» mientras `payment.tpv.service.ts:1439`, que recalcula
      // contra `amount + tipAmount`, respondía que no. Mismo cobro, dos respuestas.
      //
      // ⚠️ Sigue leyéndose del candado y no de `originalAmountNumber` por coherencia con el
      // resto del bloque: valen HOY lo mismo siempre —un reembolso nunca toca la columna
      // `amount` del cobro original, crea una fila aparte— y ninguna prueba puede
      // distinguirlas sin fabricar un estado imposible.
      const isFullyRefunded = nuevoDevueltoCents >= lockedTotalCents

      // Build refund history array safely as plain JSON
      const existingHistory = Array.isArray(lockedProcessorData.refundHistory) ? lockedProcessorData.refundHistory : []

      const newRefundEntry = {
        refundId: refundPayment.id,
        amount: refundAmountInPesos,
        reason: refundData.reason,
        staffId: refundData.staffId,
        timestamp: new Date().toISOString(),
      }

      // Mirror the dashboard/mobile `refunds[]` schema so readers that only know
      // the new format (e.g. `transaction.mobile.service.ts:208`) can aggregate
      // TPV-originated refunds without special casing. Keep `refundHistory`
      // intact for backwards compatibility with legacy readers.
      const existingRefundsArray = Array.isArray(lockedProcessorData.refunds) ? (lockedProcessorData.refunds as Prisma.JsonArray) : []
      const newRefundsEntry = {
        refundPaymentId: refundPayment.id,
        amount: refundAmountInPesos,
        amountCents: esteReembolsoCents,
        reason: refundData.reason,
        at: new Date().toISOString(),
      }

      // Build updated processorData as plain object for Prisma JSON field
      const updatedProcessorData = {
        ...lockedProcessorData,
        // `refundedAmount` (pesos) y `refundedAmountCents` salen del MISMO entero, y su
        // significado es el ÚNICO de `shared/devueltoDeUnCobro.ts`: venta + propina.
        ...acumulado,
        isFullyRefunded,
        lastRefundId: refundPayment.id,
        lastRefundAt: new Date().toISOString(),
        refundHistory: [...(existingHistory as Prisma.JsonArray), newRefundEntry],
        refunds: [...existingRefundsArray, newRefundsEntry],
      } as Prisma.InputJsonValue

      await tx.payment.update({
        where: { id: refundData.originalPaymentId },
        data: {
          processorData: updatedProcessorData,
        },
      })

      // Mirror dashboard/mobile: create a VenueTransaction row so accounting
      // reports see the outgoing refund alongside the original charge.
      await tx.venueTransaction.create({
        data: {
          venueId,
          paymentId: refundPayment.id,
          type: 'REFUND',
          grossAmount: new Decimal(-refundAmountInPesos),
          feeAmount: new Decimal(0),
          netAmount: new Decimal(-refundAmountInPesos),
          status: 'SETTLED',
        },
      })

      // El decremento de `Shift.totalSales`/`totalTips` NO va aquí: ES el claim del bloque
      // «turno» de arriba, y tiene que ocurrir ANTES del `payment.create` para poder sellar el
      // pago sólo si ganó. Mismo split proporcional, una sola escritura.

      return refundPayment
    })

  let result: Awaited<ReturnType<typeof ejecutarTransaccionDelReembolso>>
  try {
    result = await ejecutarTransaccionDelReembolso()
  } catch (error) {
    // 🔴 La carrera que el STEP 1.5 no puede cubrir: dos reintentos del MISMO reembolso
    // pueden leer ambos `null` allá arriba y llegar los dos al `create`. Lo único que los
    // separa es el índice único de la base. El perdedor NO puede devolver un 500: su cola
    // lo reintentaría para siempre contra una fila que YA existe, y el cajero vería un
    // reembolso «pendiente» eterno bloqueando el cierre.
    //
    // 🔴 Y tiene que ser el índice DE LA LLAVE. La misma transacción puede violar el PK de
    // `Payment` o los únicos de `VenueTransaction`; aceptar cualquier `P2002` devolvería 201
    // sobre una transacción que nunca se escribió.
    if (
      llaveIdempotencia &&
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === 'P2002' &&
      chocoLaLlaveDeIdempotencia(error)
    ) {
      const ganador = await buscarReembolsoPorLlave(venueId, llaveIdempotencia)
      // 🔴 El MISMO guardia que el camino rápido: arreglar sólo aquél dejaba esta puerta abierta
      // y una venta concurrente con la misma llave se habría devuelto como reembolso exitoso.
      //
      // ⚠️ Si el ganador NO pasa el guardia se propaga el error, y eso es un 500 del que la
      // terminal de hoy NO se recupera: `RefundRecorder` convierte los 5xx en fallo, borra el
      // contexto y pide conciliación manual. Antes escribí aquí que «se cura solo» y era FALSO.
      // Con la llave derivada de (llave, pago, monto) esta rama es inalcanzable salvo colisión
      // de SHA-256: un choque significa que la petición es idéntica, y entonces el ganador SÍ
      // pasa el guardia y se devuelve su fila.
      if (ganador && esReembolsoDe(ganador, refundData.originalPaymentId)) {
        logger.info('🔄 Refund P2002 — otra petición ganó la carrera; se devuelve su fila', {
          venueId,
          idempotencyKey: refundData.idempotencyKey,
          existingRefundPaymentId: ganador.id,
        })
        return respuestaDeReembolsoExistente(ganador, refundData.originalPaymentId, originalPayment.orderId)
      }
    }
    throw error
  }

  logger.info('Refund payment created', {
    refundPaymentId: result.id,
    originalPaymentId: refundData.originalPaymentId,
    amount: refundAmountInPesos,
  })

  // Fase 2 de la unificación de caja: el reembolso en efectivo desde la TPV BAJA el cajón.
  // Sus gemelos `refund.mobile` y `refund.dashboard` ya lo hacían; éste no, y devolver $200
  // desde la PAX dejaba el esperado $200 arriba ⇒ SOBRANTE falso al cerrar. El helper decide
  // con la semántica del pago REAL (fundsFlow → tender → legacy); tarjeta = NOT_DRAWER_CASH.
  // Después del commit y fail-open: el dinero ya salió, el cajón sólo lo refleja.
  try {
    await postCashRefundToDrawer({
      venueId,
      refundPaymentId: result.id,
      orderId: originalPayment.orderId ?? null,
      // 🔴 El cajón sólo ve BILLETES: sale la venta MÁS la propina devuelta. El Payment
      // del reembolso guarda el split contable (`amount` = venta, `tipAmount` = propina),
      // pero el CASH_SALE original entró como `amount + tipAmount`, así que pasar sólo la
      // venta dejaba el esperado arriba por el importe de la propina ⇒ faltante inventado
      // al cerrar. Misma convención que `refund.dashboard` (pasa el total) y `refund.mobile`.
      amount: new Decimal(result.amount).plus(new Decimal(result.tipAmount ?? 0)),
      reason: refundData.reason ?? null,
      method: originalPayment.method,
      fundsFlow: (originalPayment as any).fundsFlow ?? null,
      tenderTypeId: (originalPayment as any).tenderTypeId ?? null,
      tenderCountsAsCash: (originalPayment as any).tenderCountsAsCash ?? null,
      staffId: refundData.staffId ?? null,
      staffName: null,
    })
  } catch (err) {
    logger.error('[CASH-DRAWER] Falló registrar el reembolso en el cajón (el reembolso NO se afecta)', {
      refundPaymentId: result.id,
      error: err instanceof Error ? err.message : String(err),
    })
  }

  void logAction({
    staffId: refundData.staffId ?? null,
    venueId,
    action: 'REFUND_CREATED',
    entity: 'Payment',
    entityId: result.id,
    data: {
      amount: Number(refundAmountInPesos),
      reason: refundData.reason,
      method: originalPayment.method,
      source: 'TPV',
    },
  })

  // REFERRAL HOOK: trigger referral void if the original order had a QUALIFIED referral
  // (idempotent: no-ops if no QUALIFIED Referral matches this orderId)
  if (originalPayment.orderId) {
    try {
      const { onOrderRefunded } = await import('@/services/referrals/referralRefund.service')
      await onOrderRefunded({ orderId: originalPayment.orderId, venueId })
    } catch (err) {
      console.error('[referral hook] onOrderRefunded failed for order', originalPayment.orderId, err)
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 4.5: Restock inventory when this refund fully reverses the order (Bug B)
  // ═══════════════════════════════════════════════════════════════════════════
  // Historically the TPV refund path never returned inventory, so every refund
  // of an inventory-tracked product silently under-counted stock. TPV refunds
  // are amount-based (no per-item breakdown), so we restock the order's items
  // only once the cumulative refunds reach the order total — i.e. the whole
  // order is reversed. Non-blocking (a restock failure must not fail the refund)
  // and processor-agnostic, so it covers both AngelPay and Blumon refunds.
  if (originalPayment.orderId && originalPayment.order) {
    try {
      const orderTotal = Number(originalPayment.order.total)
      if (orderTotal > 0) {
        // This refund row is already committed, so it's included in the sum.
        const orderRefunds = await prisma.payment.findMany({
          where: { orderId: originalPayment.orderId, type: PaymentType.REFUND, status: TransactionStatus.COMPLETED },
          select: { amount: true },
        })
        const totalRefundedSale = orderRefunds.reduce((sum, p) => sum + Math.abs(Number(p.amount)), 0)
        // 🔴 El umbral compara MERCANCÍA contra refunds de VENTA (auditoría
        // 2026-08-12): `Order.total` incluye la propina acumulada, pero los
        // refunds suman solo `Payment.amount` (la parte de venta — la propina
        // viaja aparte en tipAmount). Comparar contra el total con propina
        // hacía que una orden CON propina jamás cruzara y jamás repusiera stock.
        const crossedToFullyRefunded = crossedFullRefundThreshold({
          orderTotal,
          orderTipAmount: Number(originalPayment.order.tipAmount || 0),
          totalRefundedSale,
          salesRefundThisTime: salesRefund,
        })
        if (crossedToFullyRefunded) {
          const summary = await restockOrderItems({
            venueId,
            orderId: originalPayment.orderId,
            refundPaymentId: result.id,
            staffId: refundData.staffId,
          })
          logger.info('Order fully refunded — inventory restocked', {
            orderId: originalPayment.orderId,
            refundPaymentId: result.id,
            ...summary,
          })
        }
      }
    } catch (error) {
      // Never fail the refund because restock failed — the money movement already succeeded.
      logger.error('Failed to restock inventory on full refund', {
        refundPaymentId: result.id,
        orderId: originalPayment.orderId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5: Create negative TransactionCost for refund (for accurate profit reporting)
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    await createRefundTransactionCost(result.id, refundData.originalPaymentId)
    logger.info('Refund TransactionCost created', { refundPaymentId: result.id })
  } catch (error) {
    // Don't fail the refund if TransactionCost creation fails
    logger.error('Failed to create refund TransactionCost', { error, refundPaymentId: result.id })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 5b: Create negative CommissionCalculation for refund (non-blocking)
  // ═══════════════════════════════════════════════════════════════════════════
  createRefundCommission(result.id, refundData.originalPaymentId).catch(error => {
    // Don't fail the refund if commission reversal fails
    logger.error('Failed to create refund commission', {
      refundPaymentId: result.id,
      originalPaymentId: refundData.originalPaymentId,
      error: error instanceof Error ? error.message : String(error),
    })
  })

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 6: Revertir el sello que esta venta había otorgado
  //
  // 🔴 Sin esto el cliente avanza en su cartilla por una compra que devolvió, y acaba
  // cobrando un premio que no se ganó.
  //
  // 🔴 En try/catch a propósito, igual que el recibo de abajo: cuando esto corre, el
  // dinero YA se devolvió al cliente. Si un fallo al revertir el sello propagara, el
  // reembolso se vería fallido con el dinero fuera — infinitamente peor que un sello
  // de más. La reversión es idempotente, así que se puede reintentar después.
  // ═══════════════════════════════════════════════════════════════════════════
  try {
    const { reverseStampForOrder } = await import('../wallet/stampLedger.service')
    await reverseStampForOrder(venueId, originalPayment.orderId)
  } catch (error) {
    logger.error('No se pudo revertir el sello de una venta reembolsada', {
      venueId,
      orderId: originalPayment.orderId,
      refundPaymentId: result.id,
      error: error instanceof Error ? error.message : String(error),
    })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 7: Generate digital receipt for refund
  // ═══════════════════════════════════════════════════════════════════════════
  let digitalReceipt = null
  try {
    const receipt = await generateDigitalReceipt(result.id)
    digitalReceipt = {
      id: receipt.id,
      accessKey: receipt.accessKey,
      // 💸 Add ?refund=true for frontend to detect refund and apply appropriate styling
      receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${receipt.accessKey}?refund=true`,
      // 🧾 Same "can this ticket self-invoice" check as the original payment/order receipt.
      // Hot payment path: resolveAutofacturaAvailable never throws — any lookup error → false.
      autofacturaAvailable: await resolveAutofacturaAvailable(originalPayment.orderId),
    }
    logger.info('Refund digital receipt generated', { receiptId: receipt.id })
  } catch (error) {
    // Don't fail the refund if receipt generation fails
    logger.error('Failed to generate refund receipt', { error, refundPaymentId: result.id })
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STEP 8: Return response matching Android app's expected format
  // ═══════════════════════════════════════════════════════════════════════════
  return {
    id: result.id,
    originalPaymentId: refundData.originalPaymentId,
    // Total refund = abs(amount) + abs(tipAmount). Since the tip-split fix
    // (2026-04-19) Payment.amount holds only the sale portion and tipAmount
    // holds the tip portion. TPV Android expects the TOTAL refund amount.
    amount: Math.abs(Number(result.amount)) + Math.abs(Number(result.tipAmount ?? 0)),
    status: result.status,
    authorizationNumber: result.authorizationNumber,
    referenceNumber: result.referenceNumber,
    digitalReceipt,
  }
}

/**
 * Map card brand string to CardBrand enum
 */
function mapCardBrand(brand?: string | null): CardBrand | null {
  if (!brand) return null

  const brandMap: Record<string, CardBrand> = {
    VISA: CardBrand.VISA,
    MASTERCARD: CardBrand.MASTERCARD,
    AMEX: CardBrand.AMERICAN_EXPRESS,
    AMERICAN_EXPRESS: CardBrand.AMERICAN_EXPRESS,
    DISCOVER: CardBrand.DISCOVER,
    DINERS_CLUB: CardBrand.DINERS_CLUB,
    JCB: CardBrand.JCB,
    MAESTRO: CardBrand.MAESTRO,
    UNIONPAY: CardBrand.UNIONPAY,
    OTHER: CardBrand.OTHER,
  }

  return brandMap[brand.toUpperCase()] || CardBrand.OTHER
}

/**
 * Map entry mode string to CardEntryMode enum
 */
function mapEntryMode(mode?: string | null): CardEntryMode | null {
  if (!mode) return null

  const modeMap: Record<string, CardEntryMode> = {
    CHIP: CardEntryMode.CHIP,
    CONTACTLESS: CardEntryMode.CONTACTLESS,
    SWIPE: CardEntryMode.SWIPE,
    MANUAL: CardEntryMode.MANUAL,
    FALLBACK: CardEntryMode.FALLBACK,
  }

  return modeMap[mode.toUpperCase()] || CardEntryMode.CHIP
}

/**
 * ¿Este refund CRUZA el umbral de "orden completamente reembolsada" (y por
 * tanto debe reponer inventario)?
 *
 * La mercancía se mide como `max(0, total − propina)`: `Order.total` incluye la
 * propina acumulada, mientras los refunds suman solo la parte de VENTA
 * (`Payment.amount`; la propina reembolsada viaja aparte). Cruza exactamente UNA
 * vez: el refund cuyo acumulado alcanza la mercancía; los siguientes ya no
 * (idempotencia del restock entre parciales). Mercancía 0 (cuenta 100% propina)
 * jamás repone.
 */
export function crossedFullRefundThreshold(params: {
  orderTotal: number
  orderTipAmount: number
  totalRefundedSale: number
  salesRefundThisTime: number
}): boolean {
  const merchandiseTotal = Math.max(0, params.orderTotal - params.orderTipAmount)
  if (merchandiseTotal <= 0.01) return false
  const beforeThisRefund = params.totalRefundedSale - params.salesRefundThisTime
  return beforeThisRefund < merchandiseTotal - 0.01 && params.totalRefundedSale >= merchandiseTotal - 0.01
}
