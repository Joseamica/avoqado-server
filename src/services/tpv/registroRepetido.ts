/**
 * S3 + P1-5 del checkpoint 1 (webhook como primer confirmador, Codex 13-sep-2026): qué se hace con un registro
 * REPETIDO — el mismo cobro que vuelve a llegar por llave o por referencia — además de devolver el existente.
 *
 *  · ENRIQUECER, no duplicar: rellena lo VACÍO del Payment existente (marca, PAN enmascarado, modo de entrada,
 *    autorización, referencia y las llaves de `processorData`) con lo que trae el registro posterior. La fusión es
 *    sobre los valores VIGENTES en la base, en UNA escritura (`COALESCE` por columna; `entrante || existente` en el
 *    JSON, con el existente ganando), nunca desde una lectura vieja que pueda pisar lo que dejó el webhook.
 *  · Una CONTRADICCIÓN (importe, propina, orden, afiliación, o un dato ya acreditado distinto) NO se fusiona: el
 *    Payment queda intacto, 🚨 y `ActivityLog TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION` con los dos valores.
 *    Nunca se toca `amount` ni `tipAmount`.
 *  · REPARAR el vínculo con la solicitud si falta (P1-5): un retorno idempotente ya no devuelve el Payment «sin
 *    intentar reparar el cierre». `closeRowFromPaymentTx` es idempotente y se valida solo (dueño, terminal, orden).
 */
import { CardBrand, CardEntryMode, PaymentMethod, Prisma, type Payment } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { logAction } from '../dashboard/activity-log.service'
import { avisarAprobacionTardiaTrasVentana, terminalPaymentService } from '../terminal-payment.service'
import { afiliacionDelApkDelRegistro, afiliacionesDe, esElMismoCobroPorReferencia, huellaDelRegistro } from './identidadDelCobro'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento, llaveDeIntento } from './candadoDeIntento'

export interface RegistroEntrante {
  amount: number
  tip?: number
  method?: string
  isInternational?: boolean
  idempotencyKey?: string
  referenceNumber?: string
  authorizationNumber?: string
  cardBrand?: string
  maskedPan?: string
  entryMode?: string
  last4?: string
  typeOfCard?: string
  bank?: string
  blumonOperationNumber?: number
  blumonSerialNumber?: string
  mentaAuthorizationReference?: string
  mentaTicketId?: string
  merchantAccountId?: string
  /** Codex R7-2: la afiliación que MANDÓ el APK (identidad histórica del cargo) cuando la definitiva se resolvió por serial. */
  merchantAccountIdDelApk?: string | null
  terminalPaymentRequestId?: string
  deviceSerialNumber?: string
  authenticatedTerminalSerial?: string | null
  /** `'webhook'` cuando el entrante nace del webhook de AngelPay: su método es PROVISIONAL y nunca acredita nada. */
  registradoVia?: string
}

export interface Contradiccion {
  campo: string
  existente: unknown
  entrante: unknown
}

export interface PlanDeConsolidacion {
  contradicciones: Contradiccion[]
  relleno: {
    cardBrand: CardBrand | null
    maskedPan: string | null
    entryMode: CardEntryMode | null
    authorizationNumber: string | null
    referenceNumber: string | null
    /** S2: el Payment nacido del webhook lleva método PROVISIONAL; el REST de la terminal trae el real. */
    method: PaymentMethod | null
    processorData: Record<string, unknown>
    /** Llaves del JSON que SÍ se sobrescriben (el resto sólo rellena lo vacío). */
    sobrescribir: Record<string, unknown>
  }
  hayRelleno: boolean
}

const centavos = (pesos: unknown): number => Math.round(Number(pesos ?? 0) * 100)
const limpio = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)

export function marcaAcreditada(cardBrand: string | undefined): CardBrand | null {
  const normalizada = limpio(cardBrand)?.toUpperCase().replace(' ', '_')
  return normalizada && (Object.values(CardBrand) as string[]).includes(normalizada) ? (normalizada as CardBrand) : null
}

export function modoDeEntradaAcreditado(entryMode: string | undefined): CardEntryMode | null {
  const normalizado = limpio(entryMode)?.toUpperCase()
  return normalizado && (Object.values(CardEntryMode) as string[]).includes(normalizado) ? (normalizado as CardEntryMode) : null
}

/** La llave ya es de OTRO Payment: P2002 (cliente) o, en SQL crudo, P2010 con el código 23505 de Postgres. */
function esViolacionDeUnicidad(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError)) return false
  if (error.code === 'P2002') return true
  const meta = error.meta as { code?: unknown } | undefined
  return error.code === 'P2010' && (String(meta?.code) === '23505' || error.message.includes('23505'))
}

/** Pura: decide qué se rellena y qué contradice, sin tocar la base. */
export function planDeConsolidacion(existente: Payment, entrante: RegistroEntrante, targetOrderId: string | null): PlanDeConsolidacion {
  const contradicciones: Contradiccion[] = []
  const contradice = (campo: string, e: unknown, n: unknown) => contradicciones.push({ campo, existente: e, entrante: n })

  const amountEntrante = entrante.amount / 100
  const tipEntrante = (entrante.tip ?? 0) / 100
  if (centavos(existente.amount) !== centavos(amountEntrante) || centavos(existente.tipAmount) !== centavos(tipEntrante)) {
    contradice(
      'dinero',
      { amount: Number(existente.amount), tip: Number(existente.tipAmount ?? 0) },
      { amount: amountEntrante, tip: tipEntrante },
    )
  }
  if (targetOrderId && existente.orderId && targetOrderId !== existente.orderId) contradice('orderId', existente.orderId, targetOrderId)
  // Codex R7-2: la afiliación se contrasta como CONJUNTO de identidades (la definitiva y la que mandó el APK, en los dos
  // lados): un replay cuya afiliación DEFINITIVA cambió por el enrutamiento de hoy sigue siendo el mismo cargo si alguna
  // identidad coincide — y conserva la afiliación REGISTRADA (nunca se reescribe).
  const afiliacionesEntrante = afiliacionesDe({
    merchantAccountId: entrante.merchantAccountId ?? null,
    merchantAccountIdDelApk: entrante.merchantAccountIdDelApk ?? null,
  })
  const afiliacionesExistente = afiliacionesDe({
    merchantAccountId: existente.merchantAccountId,
    merchantAccountIdDelApk: afiliacionDelApkDelRegistro(existente.processorData),
  })
  if (
    afiliacionesEntrante.length > 0 &&
    afiliacionesExistente.length > 0 &&
    !afiliacionesEntrante.some(a => afiliacionesExistente.includes(a))
  ) {
    contradice('merchantAccountId', existente.merchantAccountId, entrante.merchantAccountId)
  }
  const marca = marcaAcreditada(entrante.cardBrand)
  if (marca && existente.cardBrand && marca !== existente.cardBrand) contradice('cardBrand', existente.cardBrand, marca)
  const pan = limpio(entrante.maskedPan)
  if (pan && existente.maskedPan && pan !== existente.maskedPan) contradice('maskedPan', existente.maskedPan, pan)
  const modo = modoDeEntradaAcreditado(entrante.entryMode)
  if (modo && existente.entryMode && modo !== existente.entryMode) contradice('entryMode', existente.entryMode, modo)
  const auth = limpio(entrante.authorizationNumber)
  if (auth && existente.authorizationNumber && auth !== existente.authorizationNumber)
    contradice('authorizationNumber', existente.authorizationNumber, auth)
  const ref = limpio(entrante.referenceNumber)
  if (ref && existente.referenceNumber && ref !== existente.referenceNumber) contradice('referenceNumber', existente.referenceNumber, ref)
  const metaExistente =
    existente.processorData && typeof existente.processorData === 'object' ? (existente.processorData as Record<string, unknown>) : {}
  // Codex R2 (N1): el método que trae el WEBHOOK es inventado (AngelPay no lo manda); un webhook repetido o retomado
  // tras un corte nunca puede cerrar la provisionalidad ni contradecir: sólo el REST de la terminal acredita el método.
  const metodoEntrante =
    entrante.registradoVia !== 'webhook' && (['CREDIT_CARD', 'DEBIT_CARD'] as string[]).includes(String(entrante.method))
      ? (entrante.method as PaymentMethod)
      : null
  const metodoProvisional = metaExistente.methodProvisional === true
  if (metodoEntrante && !metodoProvisional && metodoEntrante !== existente.method) contradice('method', existente.method, metodoEntrante)

  const processorData: Record<string, unknown> = {}
  for (const [k, v] of Object.entries({
    cardBrand: marca,
    last4: limpio(entrante.last4),
    typeOfCard: limpio(entrante.typeOfCard),
    bank: limpio(entrante.bank),
    blumonOperationNumber: entrante.blumonOperationNumber ?? null,
    blumonSerialNumber: limpio(entrante.blumonSerialNumber),
    mentaAuthorizationReference: limpio(entrante.mentaAuthorizationReference),
    mentaTicketId: limpio(entrante.mentaTicketId),
    deviceSerialNumber: limpio(entrante.authenticatedTerminalSerial ?? entrante.deviceSerialNumber),
    isInternational: typeof entrante.isInternational === 'boolean' ? entrante.isInternational : null,
  })) {
    if (v !== null && v !== undefined) processorData[k] = v
  }
  const relleno = {
    cardBrand: existente.cardBrand ? null : marca,
    maskedPan: existente.maskedPan ? null : pan,
    entryMode: existente.entryMode ? null : modo,
    authorizationNumber: existente.authorizationNumber ? null : auth,
    referenceNumber: existente.referenceNumber ? null : ref,
    method: metodoProvisional && metodoEntrante ? metodoEntrante : null,
    processorData,
    sobrescribir: metodoProvisional && metodoEntrante ? { methodProvisional: false } : {},
  }
  const hayRelleno =
    Object.keys(processorData).length > 0 ||
    [relleno.cardBrand, relleno.maskedPan, relleno.entryMode, relleno.authorizationNumber, relleno.referenceNumber, relleno.method].some(
      v => v !== null,
    )
  return { contradicciones, relleno, hayRelleno }
}

/**
 * Aplica el plan sobre los valores VIGENTES y repara el vínculo con la solicitud si falta. Devuelve el Payment
 * releído (con sus recibos). Nunca lanza: un fallo aquí no puede convertir un reintento en un error para la terminal.
 */
/**
 * Codex R4-2: la consolidación distingue lo que DEMOSTRÓ de lo que no pudo demostrar. Un candidato elegido por referencia
 * (identidad débil) sólo se confirma como este cobro con `CONSOLIDADO`; `CONTRADICE` significa que la fila viva contradice
 * al entrante (no es este cobro, y tampoco se crea otro a ciegas: el llamador guarda evidencia), `PERDIDO` que otro escritor
 * la acreditó en medio (se vuelve a resolver), `DUENO` que la llave ya pertenece a otro Payment (ése es el resuelto) e
 * `INCIERTO` que el candado falló o venció antes de comprobar nada — nunca es un éxito sobre una copia sin validar.
 */
export type ResultadoDeConsolidacion<T> =
  | { estado: 'CONSOLIDADO'; registro: T }
  | { estado: 'CONTRADICE'; registro: T; contradicciones: Contradiccion[] }
  | { estado: 'DUENO'; registro: T }
  | { estado: 'PERDIDO'; motivo: string }
  | { estado: 'INCIERTO'; error: string }

export async function consolidarRegistroRepetidoDetallado<T extends Payment>(
  existente: T,
  entrante: RegistroEntrante,
  venueId: string,
  targetOrderId: string | null,
): Promise<ResultadoDeConsolidacion<T>> {
  try {
    // Codex R2 (P2-2): el plan se decide sobre la fila VIGENTE y BLOQUEADA (`FOR UPDATE`), no sobre la copia con la que
    // el llamador entró: un webhook, un worker o el REST que enriquecieron en medio ya cuentan como acreditados, y la
    // escritura es sobre esa misma fila dentro de la transacción. Sólo se toma el Payment (nunca la solicitud): no hay
    // ciclo con Order → Solicitud → Payment → Turno.
    // Codex R7-1: la consolidación que conoce un INTENTO es un escritor más del protocolo de exclusión por intento —
    // candado del intento PRIMERO (mismo orden que la reapertura: intento → Payment), después la fila del Payment, y S1 se
    // relee BAJO el candado en otra sentencia. El `exigeLlave` que trajo el llamador se calculó FUERA de la transacción:
    // un vínculo publicado entre esa lectura y este candado convertía a un Payment legacy sin llave (otro cargo del mismo
    // segundo) en «este cobro» y le escribía la llave del intento — dos cargos, una venta.
    const llave = llaveDeIntento(entrante.idempotencyKey)
    const plan = await prisma.$transaction(async tx => {
      if (llave) await candadoDeIntento(tx, llave)
      await tx.$queryRaw`SELECT "id" FROM "Payment" /* consolidacion */ WHERE "id" = ${existente.id} AND "venueId" = ${venueId} FOR UPDATE`
      const vivo = await tx.payment.findUnique({ where: { id: existente.id } })
      if (!vivo) return null
      const vinculoVigente = llave
        ? await tx.terminalPaymentAttemptLink.findUnique({ where: { attemptId: llave }, select: { requestId: true } })
        : null
      const exigeLlaveVigente = entrante.registradoVia === 'webhook' || !!vinculoVigente
      // Codex R3 (R3-2): las ANCLAS de identidad (llave, solicitud, terminal) se revalidan sobre la fila BLOQUEADA, con
      // la MISMA regla con la que se eligió el candidato. Si otro escritor le acreditó su llave o su terminal en medio,
      // esta fila ya no es este cobro: no se consolida ni se devuelve como éxito — el llamador vuelve a resolver el
      // intento con lo durable. El dinero, la orden y la afiliación no cambian de dueño: sus diferencias siguen siendo
      // CONTRADICCIONES del plan (con bitácora), no una identidad perdida.
      const anclas = huellaDelRegistro(vivo)
      const identidad = esElMismoCobroPorReferencia(anclas, {
        orderId: anclas.orderId,
        amountPesos: anclas.amountPesos,
        tipPesos: anclas.tipPesos,
        merchantAccountId: anclas.merchantAccountId,
        idempotencyKey: entrante.idempotencyKey ?? null,
        terminalSerial: entrante.authenticatedTerminalSerial ?? entrante.deviceSerialNumber ?? null,
        terminalPaymentRequestId: entrante.terminalPaymentRequestId ?? null,
        exigeLlave: exigeLlaveVigente,
      })
      if (!identidad.mismo) return { perdido: identidad.motivo as string }
      const decidido = planDeConsolidacion(vivo, entrante, targetOrderId)
      if (decidido.contradicciones.length === 0 && (decidido.hayRelleno || (entrante.idempotencyKey && !vivo.idempotencyKey))) {
        const r = decidido.relleno
        // N2: una transición legítima (Payment sin llave reutilizado por un REST con llave) deja la ASOCIACIÓN
        // durable: desde aquí el webhook y el REST resuelven al MISMO Payment por llave.
        const llaveDurable = entrante.idempotencyKey && !vivo.idempotencyKey ? entrante.idempotencyKey : null
        // Codex R9 (P2): del `processorData` existente se quitan SÓLO los nulos de PRIMER nivel (los que el relleno puede
        // completar, porque `||` fusiona sólo ese nivel). `jsonb_strip_nulls` borraba también los anidados, y
        // `pricing.venue: null` es un dato SEMÁNTICO («sin tarifa contratada al cobrar»): un replay normal lo convertía en un
        // snapshot incompleto (`INVALID_PRICING_SNAPSHOT`) que ya nadie podía acreditar. El snapshot se conserva byte a byte.
        // Codex R11 (P2): y sólo los nulos de las llaves que ESTE relleno trae (las enriquecibles: marca, últimos 4, banco,
        // serial…). Un `pricing: null` de primer nivel con afiliación es INVALIDO para el lector (R10-1); borrarlo lo volvía
        // «sin snapshot» ⇒ la tarifa de hoy. Nada del snapshot se limpia jamás: el relleno nunca trae `pricing`.
        const escritas = await tx.$executeRaw`
            UPDATE "Payment" SET
              "cardBrand" = COALESCE("cardBrand", CAST(${r.cardBrand} AS "CardBrand")),
              "maskedPan" = COALESCE("maskedPan", ${r.maskedPan}),
              "entryMode" = COALESCE("entryMode", CAST(${r.entryMode} AS "CardEntryMode")),
              "authorizationNumber" = COALESCE("authorizationNumber", ${r.authorizationNumber}),
              "referenceNumber" = COALESCE("referenceNumber", ${r.referenceNumber}),
              "idempotencyKey" = COALESCE("idempotencyKey", ${llaveDurable}),
              "method" = COALESCE(CAST(${r.method} AS "PaymentMethod"), "method"),
              "processorData" = (CAST(${JSON.stringify(r.processorData)} AS jsonb) ||
                CASE WHEN jsonb_typeof("processorData") = 'object'
                  THEN COALESCE((SELECT jsonb_object_agg(e.key, e.value) FROM jsonb_each("processorData") AS e
                                 WHERE e.value <> 'null'::jsonb OR NOT (CAST(${JSON.stringify(r.processorData)} AS jsonb) ? e.key)), '{}'::jsonb)
                  ELSE '{}'::jsonb END)
                || CAST(${JSON.stringify(r.sobrescribir)} AS jsonb),
              "updatedAt" = (NOW() AT TIME ZONE 'UTC')
            WHERE "id" = ${existente.id} AND "venueId" = ${venueId}`
        if (escritas !== 1) {
          logger.warn('⚠️ [Terminal-payment] El enriquecimiento del registro repetido no escribió exactamente una fila', {
            paymentId: existente.id,
            escritas,
          })
        }
        // S2: si el costo estaba PENDIENTE esperando la marca (Payment nacido del webhook), que el worker lo tome ya.
        await tx.paymentEffect.updateMany({
          where: { paymentId: existente.id, kind: 'TRANSACTION_COST', status: 'PENDING' },
          data: { nextAttemptAt: new Date() },
        })
      }
      return decidido
    }, OPCIONES_DE_TRANSACCION_DEL_INTENTO)
    if (!plan) return { estado: 'PERDIDO', motivo: 'DESAPARECIDO' }
    if ('perdido' in plan) {
      logger.warn('🔁 [Terminal-payment] Bajo el candado la fila ya NO es este cobro (otro escritor la acreditó): no se consolida', {
        venueId,
        paymentId: existente.id,
        motivo: plan.perdido,
      })
      return { estado: 'PERDIDO', motivo: plan.perdido }
    }
    if (plan.contradicciones.length > 0) {
      logger.error('🚨 [Terminal-payment] Registro repetido que CONTRADICE al Payment existente — no se fusiona, queda para revisión', {
        venueId,
        paymentId: existente.id,
        idempotencyKey: existente.idempotencyKey,
        contradicciones: plan.contradicciones,
      })
      await logAction({
        action: 'TERMINAL_PAYMENT_ENRICHMENT_CONTRADICTION',
        entity: 'Payment',
        entityId: existente.id,
        venueId,
        staffId: existente.processedById,
        // JSON plano (los valores pueden traer Decimal): la bitácora es lo único que le queda al dueño para entender
        // por qué un registro repetido no cambió nada.
        data: JSON.parse(
          JSON.stringify({
            campos: plan.contradicciones.map(c => c.campo),
            existente: { amount: Number(existente.amount), tip: Number(existente.tipAmount ?? 0) },
            entrante: { amount: entrante.amount / 100, tip: (entrante.tip ?? 0) / 100 },
            contradicciones: plan.contradicciones,
            terminalPaymentRequestId: entrante.terminalPaymentRequestId ?? null,
          }),
        ),
      })
    }

    // P1-5: reparación idempotente del vínculo con la solicitud. `closeRowFromPaymentTx` se valida solo.
    // Codex R5-1: SÓLO cuando el candidato ES este cobro. Un candidato que CONTRADICE al entrante (otra autorización, otro
    // dinero) no es el cargo de la solicitud: ligarlo la habría cerrado con el Payment equivocado, y el cargo REAL, al
    // llegar con el mismo requestId, habría quedado como «segunda captura» detrás de un ganador ajeno.
    if (entrante.terminalPaymentRequestId && existente.status === 'COMPLETED' && plan.contradicciones.length === 0) {
      const cierre = await prisma.$transaction(tx =>
        terminalPaymentService.closeRowFromPaymentTx(
          tx,
          entrante.terminalPaymentRequestId as string,
          existente.id,
          venueId,
          { amountCents: centavos(existente.amount), tipCents: centavos(existente.tipAmount) },
          'REST',
          entrante.authenticatedTerminalSerial ?? entrante.deviceSerialNumber ?? null,
        ),
      )
      if (cierre.bound) {
        logger.warn('🔧 [Terminal-payment] Vínculo con la solicitud REPARADO desde un registro repetido', {
          paymentId: existente.id,
          requestId: entrante.terminalPaymentRequestId,
        })
      }
      // Ventana de confirmación (Task 3): la reparación también puede reabrir una fila que la ventana liberó — correo ops
      // DESPUÉS del commit (sin `lateAfterWindow` no hace nada).
      avisarAprobacionTardiaTrasVentana(cierre, {
        requestId: entrante.terminalPaymentRequestId,
        venueId,
        paymentId: existente.id,
        terminalId: entrante.authenticatedTerminalSerial ?? entrante.deviceSerialNumber ?? null,
        orderId: existente.orderId,
      })
    }
    const releido = await prisma.payment.findUnique({ where: { id: existente.id }, include: { receipts: true } })
    const registro = releido ? ({ ...existente, ...releido } as T) : existente
    return plan.contradicciones.length > 0
      ? { estado: 'CONTRADICE', registro, contradicciones: plan.contradicciones }
      : { estado: 'CONSOLIDADO', registro }
  } catch (error) {
    // Codex R3 (R3-2): un P2002 del índice (venueId, idempotencyKey) al asociar la llave significa que OTRO Payment ya es
    // el dueño durable de esa llave (dos escritores con la misma llave sobre candidatos distintos): se devuelve ESE
    // dueño, nunca el candidato anterior — dos Payments para un intento sería exactamente el cobro doble.
    if (esViolacionDeUnicidad(error) && entrante.idempotencyKey) {
      const dueno = await prisma.payment.findUnique({
        where: { venueId_idempotencyKey: { venueId, idempotencyKey: entrante.idempotencyKey } },
        include: { receipts: true },
      })
      if (dueno) {
        logger.warn('🔁 [Terminal-payment] La llave ya pertenece a OTRO Payment: se devuelve su dueño durable', {
          venueId,
          idempotencyKey: entrante.idempotencyKey,
          candidatoAnterior: existente.id,
          dueno: dueno.id,
        })
        return { estado: 'DUENO', registro: dueno as unknown as T }
      }
    }
    const mensaje = error instanceof Error ? error.message : String(error)
    logger.error('⚠️ [Terminal-payment] No se pudo consolidar el registro repetido — desenlace INCIERTO (el llamador decide)', {
      paymentId: existente.id,
      error: mensaje,
    })
    return { estado: 'INCIERTO', error: mensaje }
  }
}

/**
 * Identidad FUERTE (misma llave, o el ganador de la solicitud): el existente ES este cobro por construcción y la
 * consolidación sólo lo enriquece. Por eso una contradicción o un fallo devuelven el existente (nunca se pierde el cobro:
 * ya está registrado) y sólo una identidad PERDIDA devuelve `null`. La identidad DÉBIL (referencia) usa la versión detallada.
 */
export async function consolidarRegistroRepetido<T extends Payment>(
  existente: T,
  entrante: RegistroEntrante,
  venueId: string,
  targetOrderId: string | null,
): Promise<T | null> {
  const resultado = await consolidarRegistroRepetidoDetallado(existente, entrante, venueId, targetOrderId)
  switch (resultado.estado) {
    case 'CONSOLIDADO':
    case 'CONTRADICE':
    case 'DUENO':
      return resultado.registro
    case 'PERDIDO':
      return null
    case 'INCIERTO':
      return existente
  }
}
