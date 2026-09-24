import { performance } from 'node:perf_hooks'
import { Payment, PaymentMethod, SplitType, OrderSource, PaymentSource, Prisma, type DigitalReceipt } from '@prisma/client'
import logger from '../../config/logger'
import { BadRequestError, ConflictError, NotFoundError, ServiceUnavailableError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { generateDigitalReceipt } from './digitalReceipt.tpv.service'
import { publishCommand } from '../../communication/rabbitmq/publisher'
import { trackRecentPaymentCommand } from '../pos-sync/posSyncOrder.service'
import { socketManager } from '../../communication/sockets/managers/socketManager'
import { SocketEventType } from '../../communication/sockets/types'
import { tarifaCongeladaDeLaAfiliacion, tarifaConCapturaFallida, type TarifaCongelada } from '../payments/transactionCost.service'
import { elegirRegistroPorReferencia, huellaDelRegistro, solicitudDelRegistro, type HuellaDelCobro } from './identidadDelCobro'
import {
  evidenciaDurableDelIngreso,
  MOTIVO_EVIDENCIA_DE_OTRA_AFILIACION,
  MOTIVO_SIN_CAPTURA_AL_INGRESO,
  MOTIVO_EVIDENCIA_DE_INGRESO_NO_VISIBLE,
  MOTIVO_EVIDENCIA_DE_INGRESO_SIN_ORDEN,
} from './evidenciaDeIngreso'
import { OPCIONES_DE_TRANSACCION_DEL_INTENTO, candadoDeIntento, llaveDeIntento } from './candadoDeIntento'

/**
 * Codex R3 (P1-3) + R4 (R4-3): el slot que ocupa HOY una afiliación en la configuración efectiva del venue (venue →
 * organización) Y las TARIFAS vigentes de ese slot y de esa afiliación, congeladas juntas en el registro. Una etiqueta de
 * slot no congela nada: si el negocio sustituye la afiliación del slot y le pone otra tarifa, «SECONDARY» apunta a la tarifa
 * nueva. Lo que se guarda es la tarifa contratada AL COBRAR (`processorData.pricing`). Nunca lanza: un fallo aquí no puede
 * interrumpir el cobro; sin slot ni tarifa, el costo queda pendiente y visible.
 */
/**
 * Codex R5-6: «no reembolsos» SIN perder las filas legacy. `Payment.type` es NULLABLE (anteriores al default REGULAR): un
 * `type: { not: 'REFUND' }` a secas es `type <> 'REFUND'` en SQL y NULL no lo cumple — esos Payments desaparecían de la
 * búsqueda por referencia y su replay nacía como venta nueva (cobro doble).
 */
const SIN_REEMBOLSOS: Prisma.PaymentWhereInput = { OR: [{ type: null }, { type: { not: 'REFUND' } }] }

/**
 * Codex R5 (P2): la venta a la que puede ligarse el cliente de un retorno idempotente. Si lo que devuelve la llave es
 * EVIDENCIA de conciliación (segunda captura o colisión de referencia, R4-6), su `orderId` es el de la venta del CANDIDATO
 * — otra venta —: no hay venta propia, y ligar ahí al cliente sería atribuirlo a un cobro ajeno.
 */
const ordenPropia = (registro: { orderId: string | null; status?: unknown; processorData?: unknown }): string | null =>
  esEvidenciaDeConciliacion(registro) ? null : registro.orderId

/**
 * Codex R12-1 / R13-1 / R14-1: UN solo selector de tarifa para TODOS los orígenes que crean el Payment, sin retorno anticipado
 * por origen. La tarifa se congela sobre la PRIMERA evidencia bancaria aceptada del cargo (`evidenciaDurableDelIngreso`: el
 * primer evento aprobado del intento, en orden durable, elegido en SQL antes de cualquier límite): la consume el registrador del
 * webhook —también cuando el evento que lo disparó es POSTERIOR y trae otra captura (R14-1: E1 al 2.5 % cuyo registrador murió,
 * edición al 8 %, E2 creaba con la suya)—, S4 y el REST de la terminal que llega con la misma llave. Sólo captura «ahora» quien
 * es de verdad la primera evidencia: un REST sin evento aprobado previo del intento. Un evento pertinente SIN captura (anterior a
 * la regla) conserva la incertidumbre (marcador TOTAL, pendiente hasta una acreditación explícita); un evento del intento recibido
 * por OTRA afiliación tampoco acredita ésta ni autoriza capturar la de hoy; y un cobro nacido del webhook para el que no se ve
 * NINGÚN aprobado (ni el suyo) conserva la incertidumbre — nunca captura «ahora». La captura persistida es la única que se
 * consume: nunca una enviada por el cliente.
 *
 * Serialización (R14-1): se llama DENTRO de la transacción del dinero, con el candado del intento ya tomado y con SU cliente
 * (`tx`): la lectura de la evidencia y la creación del Payment son una sola decisión frente al ingreso de un evento del mismo
 * intento (que toma el mismo candado). La captura «ahora» abre su propia vista REPEATABLE READ (sólo lee configuración).
 */
async function tarifaDeLaAfiliacion(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  venueId: string,
  merchantAccountId: string,
  origen: { registradoVia?: string; idempotencyKey?: string } = {},
): Promise<{ slot: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | null; pricing: TarifaCongelada | null }> {
  const ahora = new Date()
  try {
    // Codex R13-1 / R14-1: TODO origen resuelve PRIMERO la primera evidencia durable del cargo (primer evento aprobado del
    // intento, en este venue, recibido por esta afiliación), con el cliente de la transacción que tiene el candado del intento.
    // Un fallo al consultarla NO autoriza capturar «ahora»: cae al `catch` como captura fallida (pendiente y visible).
    const llave = llaveDeIntento(origen.idempotencyKey)
    const evidencia = llave ? await evidenciaDurableDelIngreso(db, venueId, merchantAccountId, llave) : null
    if (evidencia?.tipo === 'ORDEN_NO_ACREDITADO') {
      // Codex R15-1: algún ingreso del intento entró SIN candado (55P03): el orden histórico de la evidencia no es demostrable
      // —tampoco tras la recuperación—, así que ninguna captura acredita la tarifa ni se captura «ahora»: pendiente hasta acreditar.
      logger.error(
        '🚨 [Terminal-payment] Un ingreso del intento entró SIN candado: el orden histórico de la evidencia no está acreditado — el costo queda pendiente hasta una acreditación explícita, nunca la tarifa de hoy',
        {
          venueId,
          merchantAccountId,
          llave,
          registradoVia: origen.registradoVia ?? 'terminal',
        },
      )
      return { slot: null, pricing: tarifaConCapturaFallida(merchantAccountId, ahora, new Error(MOTIVO_EVIDENCIA_DE_INGRESO_SIN_ORDEN)) }
    }
    if (evidencia?.tipo === 'CON_CAPTURA') {
      logger.info('🧾 [Terminal-payment] El Payment nace con la tarifa capturada al INGRESO de la PRIMERA evidencia durable del intento', {
        venueId,
        merchantAccountId,
        eventLogId: evidencia.eventLogId,
        registradoVia: origen.registradoVia ?? 'terminal',
      })
      return evidencia.captura
    }
    if (evidencia?.tipo === 'SIN_CAPTURA') {
      logger.warn('⚠️ [Terminal-payment] REST antes de S4 sobre un evento durable SIN captura al ingreso: pendiente hasta acreditar', {
        venueId,
        merchantAccountId,
        eventLogId: evidencia.eventLogId,
      })
      return { slot: null, pricing: tarifaConCapturaFallida(merchantAccountId, ahora, new Error(MOTIVO_SIN_CAPTURA_AL_INGRESO)) }
    }
    if (evidencia?.tipo === 'OTRA_AFILIACION') {
      logger.error(
        '🚨 [Terminal-payment] La evidencia durable del intento la recibió OTRA afiliación: la tarifa no se acredita ni se captura «ahora»',
        {
          venueId,
          merchantAccountId,
          eventLogId: evidencia.eventLogId,
          receivedByMerchantAccountId: evidencia.receivedByMerchantAccountId,
        },
      )
      return {
        slot: null,
        pricing: tarifaConCapturaFallida(merchantAccountId, ahora, new Error(MOTIVO_EVIDENCIA_DE_OTRA_AFILIACION)),
      }
    }
    if (origen.registradoVia === 'webhook') {
      // Codex R14-1: el registrador del webhook SIEMPRE tiene su propio evento aprobado persistido; si no se ve ninguno, algo
      // no cuadra (llave distinta, clasificación) — se conserva la incertidumbre, nunca la tarifa de hoy.
      logger.error('🚨 [Terminal-payment] Cobro nacido del webhook sin NINGÚN aprobado visible del intento: pendiente hasta acreditar', {
        venueId,
        merchantAccountId,
        llave,
      })
      return { slot: null, pricing: tarifaConCapturaFallida(merchantAccountId, ahora, new Error(MOTIVO_EVIDENCIA_DE_INGRESO_NO_VISIBLE)) }
    }
    return await tarifaCongeladaDeLaAfiliacion(venueId, merchantAccountId, ahora)
  } catch (error) {
    // Codex R10-1: una captura fallida se guarda como tal (DURABLE) — `pricing: null` se leía como «sin snapshot» y abría el
    // fallback a PRIMARY; el cobro se registra igual (nunca se interrumpe) y su costo queda pendiente con motivo visible.
    logger.warn('⚠️ [Terminal-payment] No se pudo congelar la tarifa de la afiliación al cobrar', {
      venueId,
      merchantAccountId,
      error: error instanceof Error ? error.message : String(error),
    })
    return { slot: null, pricing: tarifaConCapturaFallida(merchantAccountId, ahora, error) }
  }
}

/**
 * Codex R2 (N2): la identidad acreditada por el vínculo S1 manda en los DOS caminos (REST y webhook), no sólo cuando llega
 * primero el webhook. Con vínculo para la llave del entrante, un Payment SIN llave (legacy del mismo segundo) nunca es este
 * intento. Sin vínculo se conserva el reintento de la transición APK viejo → nuevo. Se consulta sólo si hay candidatos.
 */
async function identidadAcreditadaPorVinculo(paymentData: { registradoVia?: string; idempotencyKey?: string }): Promise<boolean> {
  if (paymentData.registradoVia === 'webhook') return true
  if (!paymentData.idempotencyKey) return false
  const vinculo = await prisma.terminalPaymentAttemptLink.findUnique({
    where: { attemptId: paymentData.idempotencyKey },
    select: { requestId: true },
  })
  return !!vinculo
}

/**
 * Codex R3 (R3-1) + R4 (R4-1): la búsqueda por referencia lleva los DISCRIMINADORES en la consulta (venue, referencia,
 * importe, propina, orden objetivo y afiliación) y recorre TODAS las páginas hasta resolver la identidad o agotar el
 * conjunto: un subconjunto agotado nunca acredita ausencia.
 *  · Dos PASADAS: primero los candidatos SIN llave (legacy ↔ legacy) y después los que tienen llave. Dentro de cada
 *    pasada la paginación es KEYSET sobre columnas INMUTABLES (`createdAt desc, id desc`), nunca un cursor de Prisma sobre
 *    un orden que incluya `idempotencyKey` — esa columna la ESCRIBE la propia consolidación (un candidato sin llave puede
 *    ganar su llave entre dos páginas) y un cursor sobre ella saltaba candidatos (Codex R4-1: el 11º nunca se examinaba).
 *  · `excluir`: candidatos que YA contradijeron bajo el candado en este mismo registro (Codex R4-6) — no se vuelven a
 *    elegir, se sigue con el resto.
 *  · Agotar el presupuesto de páginas devuelve `agotado: true`: el llamador NUNCA crea con eso (R4-1) — rechaza con un
 *    error REINTENTABLE, para que la terminal vuelva a mandar el mismo cobro y no nazca un duplicado.
 */
export async function buscarRegistroPorReferencia(
  venueId: string,
  referenceNumber: string,
  targetOrderId: string | null,
  huella: HuellaDelCobro,
  paymentData: { registradoVia?: string; idempotencyKey?: string },
  excluir: readonly string[] = [],
): Promise<{
  registro: (Payment & { receipts: DigitalReceipt[] }) | null
  descartes: { id: string; motivo: string; orderId: string | null }[]
  candidatos: number
  agotado: boolean
  /** La regla de identidad con la que se eligió (vínculo S1 ⇒ un Payment sin llave nunca es este intento). */
  exigeLlave: boolean
}> {
  const PAGINA = 10
  const MAX_PAGINAS = 1000
  const base: Prisma.PaymentWhereInput = {
    venueId,
    referenceNumber,
    amount: new Prisma.Decimal(String(huella.amountPesos)),
    tipAmount: new Prisma.Decimal(String(huella.tipPesos ?? 0)),
    ...(targetOrderId ? { orderId: targetOrderId } : {}),
    ...(excluir.length > 0 ? { id: { notIn: [...excluir] } } : {}),
    // Codex R7-2 / R8-1: la AFILIACIÓN NO filtra en la consulta. La configuración de enrutamiento de hoy no puede excluir un
    // cargo histórico, y un candidato de otra afiliación sólo demuestra ser OTRO cargo si las dos autorizaciones existen y
    // difieren — un replay legacy sin merchant ni autorización (el contrato los admite) quedaba fuera de la OR y nacía como
    // venta nueva. La única regla de identidad (conjunto {definitiva, la del APK} en los dos lados + autorización) vive en
    // `esElMismoCobroPorReferencia`: los candidatos de otra afiliación LLEGAN ahí y salen como `AFILIACION` (otro cargo)
    // o `AFILIACION_INCIERTA` (evidencia PENDING), nunca se esconden en SQL con un criterio paralelo.
    AND: [
      // Refunds share refNumber with originals — don't match against them (`SIN_REEMBOLSOS` conserva los `type` NULL legacy).
      SIN_REEMBOLSOS,
    ],
  }
  const descartes: { id: string; motivo: string; orderId: string | null }[] = []
  let exigeLlave: boolean | null = null
  let candidatos = 0
  let paginas = 0
  // Sin llave primero (legacy ↔ legacy): con un entrante CON llave los candidatos con otra llave se descartan igual
  // (LLAVE), así que el orden de las pasadas sólo acorta el recorrido, nunca cambia la elección.
  for (const pasada of [{ idempotencyKey: null }, { idempotencyKey: { not: null } }] as Prisma.PaymentWhereInput[]) {
    let ultimo: { createdAt: Date; id: string } | null = null
    for (;;) {
      if (paginas >= MAX_PAGINAS) {
        logger.error(
          '🚨 [Terminal-payment] Demasiados candidatos por referencia sin resolver la identidad — NO se registra como cobro nuevo',
          {
            venueId,
            referenceNumber,
            candidatos,
          },
        )
        return { registro: null, descartes, candidatos, agotado: true, exigeLlave: exigeLlave ?? false }
      }
      paginas++
      const lote: (Payment & { receipts: DigitalReceipt[] })[] = await prisma.payment.findMany({
        where: {
          AND: [
            base,
            pasada,
            ...(ultimo ? [{ OR: [{ createdAt: { lt: ultimo.createdAt } }, { createdAt: ultimo.createdAt, id: { lt: ultimo.id } }] }] : []),
          ],
        },
        include: { receipts: true }, // Include receipt data for idempotent response
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: PAGINA,
      })
      candidatos += lote.length
      if (lote.length > 0 && exigeLlave === null) exigeLlave = await identidadAcreditadaPorVinculo(paymentData)
      const eleccion = elegirRegistroPorReferencia(lote.map(huellaDelRegistro), { ...huella, exigeLlave: exigeLlave ?? false })
      descartes.push(...eleccion.descartes.map(d => ({ ...d, orderId: lote.find(p => p.id === d.id)?.orderId ?? null })))
      if (eleccion.elegido)
        return { registro: eleccion.elegido.registro, descartes, candidatos, agotado: false, exigeLlave: exigeLlave ?? false }
      if (lote.length < PAGINA) break
      const cola = lote[lote.length - 1]
      ultimo = { createdAt: cola.createdAt, id: cola.id }
    }
  }
  return { registro: null, descartes, candidatos, agotado: false, exigeLlave: exigeLlave ?? false }
}

/**
 * Codex R4 (R4-1, R4-2, R4-6): la resolución por referencia no puede terminar en «se crea» sin haber DEMOSTRADO que ningún
 * candidato es este cobro. Desenlaces:
 *  · `EXISTENTE`   — un candidato quedó CONSOLIDADO bajo el candado (o la llave ya tiene dueño durable): ése es el cobro.
 *  · `NUEVO`       — no hay candidatos (o todos se descartaron por identidad ANTES del candado): se registra un cobro nuevo.
 *  · `COLISION`    — hubo candidatos con identidad suficiente que bajo el candado CONTRADICEN al entrante (dinero, orden,
 *                    afiliación o un dato acreditado distinto) y no quedó ninguno: la referencia es una colisión con
 *                    identidad débil. NO se crea un COMPLETED a ciegas: el llamador guarda EVIDENCIA PENDING.
 *  · lanza 503     — la búsqueda se agotó, la consolidación fue INCIERTA o se acabó el presupuesto de intentos: el
 *                    desenlace no se conoce y el único movimiento seguro es que la terminal REINTENTE el mismo cobro.
 */
type ResolucionPorReferencia =
  | { kind: 'EXISTENTE'; registro: Payment & { receipts: DigitalReceipt[] } }
  | { kind: 'NUEVO' }
  | { kind: 'COLISION'; contradicciones: { paymentId: string; orderId: string; campos: string[] }[] }

class RegistroNoResuelto extends ServiceUnavailableError {
  constructor(motivo: string) {
    super(
      'No se pudo confirmar si este cobro ya estaba registrado. Vuelve a enviar el mismo cobro: no se cobró dos veces.',
      `PAYMENT_REGISTRATION_UNRESOLVED_${motivo}`,
    )
  }
}

async function resolverPorReferencia(args: {
  etiqueta: string
  venueId: string
  referenceNumber: string
  targetOrderId: string | null
  huella: HuellaDelCobro
  paymentData: RegistroEntrante & { registradoVia?: string }
}): Promise<ResolucionPorReferencia> {
  const PRESUPUESTO = 5
  const excluidos: string[] = []
  const contradicciones: { paymentId: string; orderId: string; campos: string[] }[] = []
  for (let intento = 0; intento < PRESUPUESTO; intento++) {
    const busqueda = await buscarRegistroPorReferencia(
      args.venueId,
      args.referenceNumber,
      args.targetOrderId,
      args.huella,
      args.paymentData,
      excluidos,
    )
    if (busqueda.agotado) throw new RegistroNoResuelto('SEARCH_EXHAUSTED')
    if (!busqueda.registro) {
      // Codex R7-2: un candidato que coincide en TODO salvo la afiliación —y cuya autorización no demuestra que sea otro
      // cargo— es una identidad INCIERTA (el enrutamiento pudo cambiar entre el registro y el replay): queda como evidencia
      // de colisión, nunca como venta nueva.
      for (const inciertos of busqueda.descartes.filter(d => d.motivo === 'AFILIACION_INCIERTA')) {
        contradicciones.push({ paymentId: inciertos.id, orderId: inciertos.orderId ?? '', campos: ['merchantAccountId'] })
      }
      if (contradicciones.length > 0) return { kind: 'COLISION', contradicciones }
      if (busqueda.candidatos > 0) {
        logger.warn(
          `🔁 [${args.etiqueta}] Misma referencia pero NO es el mismo cobro (colisión de referencia) — se registra como cobro nuevo`,
          {
            venueId: args.venueId,
            orderId: args.targetOrderId,
            referenceNumber: args.referenceNumber,
            descartes: busqueda.descartes,
          },
        )
      }
      return { kind: 'NUEVO' }
    }
    // Codex R7-1: la consolidación NO recibe el `exigeLlave` de la búsqueda (se calculó fuera de toda transacción): lo
    // vuelve a decidir ella misma bajo el candado del intento, releyendo S1.
    const resultado = await consolidarRegistroRepetidoDetallado(busqueda.registro, args.paymentData, args.venueId, args.targetOrderId)
    switch (resultado.estado) {
      case 'CONSOLIDADO':
      case 'DUENO':
        return { kind: 'EXISTENTE', registro: resultado.registro }
      case 'PERDIDO':
        logger.warn(`🔁 [${args.etiqueta}] El candidato por referencia dejó de ser este cobro bajo el candado — se vuelve a resolver`, {
          venueId: args.venueId,
          existingPaymentId: busqueda.registro.id,
          motivo: resultado.motivo,
        })
        continue
      case 'CONTRADICE':
        // Codex R4-6: con identidad DÉBIL, una contradicción bajo el candado no es «el mismo cobro»: ese candidato queda
        // excluido y se sigue con el resto. Si no queda ninguno, es una COLISIÓN de referencia: evidencia, no venta.
        excluidos.push(busqueda.registro.id)
        contradicciones.push({
          paymentId: busqueda.registro.id,
          orderId: busqueda.registro.orderId,
          campos: resultado.contradicciones.map(c => c.campo),
        })
        continue
      case 'INCIERTO':
        throw new RegistroNoResuelto('CONSOLIDATION_UNCERTAIN')
    }
  }
  throw new RegistroNoResuelto('RETRY_BUDGET_EXHAUSTED')
}
import {
  consolidarRegistroRepetido,
  consolidarRegistroRepetidoDetallado,
  retenerSolicitudLiberadaDelRegistro,
  type RegistroEntrante,
} from './registroRepetido'
import { candadoDeReferencia, esVencimientoDeCandado } from './candadoDeReferencia'
import { deductInventoryForProduct, getProductInventoryStatus } from '../dashboard/productInventoryIntegration.service'
import type { OrderModifierForInventory } from '../dashboard/rawMaterial.service'
import { parseDateRange } from '@/utils/datetime'
import { PhaseTimer } from '@/utils/phaseTimer'
import { awardLoyaltyForPaidOrder } from '../shared/loyaltyOnPaidOrder'
import {
  claimShiftForCompletedPayment,
  lockExistingOrderForPayment,
  recordCapturedPaymentOrderReconciliation,
  recordPendingPaymentShiftReconciliation,
  resolvePaymentShiftReconciliationEnabled,
} from '../shared/paymentShiftClaim'
import { countPriorCompletedPayments } from '../shared/priorCompletedPayments'
import { enqueuePaymentEffect, enqueuePaymentCommissionInTx } from './paymentEffects.service'
import { COSTO_PENDIENTE_PLAZO_MS, asegurarCostoSincrono } from '../payments/deferredTransactionCost.service'
import { esEvidenciaDeConciliacion } from './segundaCaptura'
import { runAutoReorderForVenue } from '../dashboard/autoReorder.service'
import { serializedInventoryService } from '../serialized-inventory/serializedInventory.service'
import { getEffectivePaymentConfig } from '../organization-payment-config.service'
import { logAction } from '../dashboard/activity-log.service'
import { paymentIsAvoqadoSettled } from '../shared/tenderSemantics'
// La ÚNICA definición de "qué cuenta como pagado" — la comparten los cuatro
// caminos de cobro, para que un reembolso no reabra saldo en ninguno.
import { summarizeRefunds, computeOrderBalance, REFUND_PAYMENT_TYPE } from '../shared/orderBalance'
// El candado del toque repetido en «Efectivo». La regla vive AHÍ, pura y probada aparte.
import { aplicaCandadoDeEfectivo, cobroEnEfectivoSobreOrdenSaldada } from '../shared/cobroEnEfectivoDuplicado'
import { resolveTenderForCharge, computeTenderCommission, type ResolvedTenderCharge } from '../dashboard/tenderType.dashboard.service'
import { validateStaffVenue as validateStaffVenueShared } from '../../utils/staff-venue.util'
import { isRetryableDbError } from '../../utils/serializableRetry'
import { loadOrderForCfdiFromDb } from '../fiscal/cfdi.service'
import {
  terminalPaymentService,
  avisarAprobacionTardiaTrasVentana,
  type ArbitrajeDeRegistro,
  CloseRowOutcome,
} from '../terminal-payment.service'
// Sin ciclo: table.tpv.service NO importa este archivo (verificado 2026-08-03).
import * as tableService from './table.tpv.service'
import { assertVenueSalesEnabled } from '../venueSalesGuard'
import { postCashSaleToDrawer } from '../shared/cashDrawerPosting'
import {
  classifyCardInternationality,
  type CardInternationalityDecision,
  type ClientCountryEvidenceSource,
} from '../payments/cardInternationality.service'
import { getAreaTicketLineIdsCoveredByInventoryReservations } from './order.tpv.service'
import { resolveFastPaymentTarget } from './fastPaymentTarget'
import { linkCustomerToExistingOrder, normalizeRequestedCustomerId, resolveFastOrderCustomer } from './fastPaymentCustomer'

/**
 * Se lanza DENTRO de la transacción para abortarla sin escribir DINERO; el `catch` la convierte
 * en la respuesta idempotente con el cobro que ya existía. No hereda de `AppError` a propósito:
 * NO es un error que deba salir por HTTP — es un desvío interno hacia una respuesta 2xx (el
 * controlador responde 201 en todas las ramas de este servicio).
 *
 * ⚠️ «Sin escribir nada» sería falso: la transacción se revierte entera, pero FUERA de ella el
 * recibo digital del cobro existente sí puede crearse (`ensureDigitalReceiptResponse`) y la
 * bitácora recibe su `CASH_PAYMENT_DEDUPLICATED`. Lo que no se escribe es un segundo `Payment`,
 * su `VenueTransaction` ni el incremento del turno.
 */
/**
 * Cuánto puede retener la bitácora del descarte la respuesta de un cobro deduplicado.
 *
 * 1.5 s deja escribir el asiento en el caso normal (milisegundos) y corta muy por debajo de
 * los 12 s en que la TPV abandona la petición: pasado ese punto la terminal reintentaría un
 * cobro que el servidor ya resolvió, que es peor que perder el rastro auxiliar.
 */
const TOPE_BITACORA_DEDUPLICACION_MS = 1500

class CobroDuplicadoEnEfectivo extends Error {
  constructor(readonly existingPaymentId: string) {
    super('cobro en efectivo duplicado')
    this.name = 'CobroDuplicadoEnEfectivo'
  }
}

/**
 * Revisión final · ronda 2 (17-sep, P1 — Codex r7, preexistente): tras el COMMIT, un cobro con tarjeta que no ligó su solicitud (el
 * cierre común se negó, o el arbitraje lo registró como asociación inválida) puede estar LIGADO —por la llave del intento— a una
 * solicitud ya LIBERADA (ventana o cajero) que seguiría en «puedes volver a cobrar». Se pide su re-retención por las identidades del
 * Payment (`retenerSolicitudLiberadaDelRegistro`: sólo si el registro nombra una solicitud o el Payment la trae; un cobro local de la
 * terminal no tiene vínculo). Fuera de la transacción financiera — nunca dentro — y nunca lanza.
 */
async function retenerSiQuedoSinLigar(payment: Payment, paymentData: PaymentCreationData): Promise<void> {
  await retenerSolicitudLiberadaDelRegistro(payment, paymentData as RegistroEntrante)
}

/**
 * 🔴 Ronda 3 (17-sep, P1-B — Codex r8, preexistente): tras el COMMIT de una COLISIÓN DE REFERENCIA, la solicitud que el
 * registro nombraba puede estar LIBERADA (ventana o cajero) y seguiría diciéndole al POS «puedes volver a cobrar» con una
 * posible segunda captura encima — el barrido no la ve, porque sólo busca Payments COMPLETED y esto es evidencia PENDING.
 *
 * La solicitud sale de la EVIDENCIA que el registrador acaba de crear (su columna o su etiqueta), nunca del cuerpo del
 * cliente, y viaja el serial ACREDITADO del llamador: el servicio sólo re-retiene si esa identidad es la terminal de la
 * solicitud (regla T10) — si no, no toca la fila y grita. Fuera de la transacción financiera, y nunca lanza: la evidencia ya
 * es durable y la terminal necesita su 2xx (un 500 aquí la haría reintentar el cobro).
 *
 * 🔴 Sólo el camino REST. Un registro nacido del WEBHOOK ya tiene su propia re-retención para este caso desde la ronda 1
 * (`retenerSolicitudLiberadaPorAprobacion` con motivo `POSSIBLE_REFERENCE_COLLISION`), que marca con
 * `BANK_APPROVED_AWAITING_PAYMENT` —más preciso: ahí CONSTA la aprobación del banco— y guarda además el evento que la trajo.
 * Pedir las dos dejaría el marcador al azar de quién escribiera primero, con la misma protección. El hueco era el REST.
 *
 * La SEGUNDA CAPTURA no entra: exige que la solicitud ya tenga un ganador acreditado (`winnerPaymentId`), o sea `paymentId`
 * puesto, y entonces no está liberada. El predicado SQL acepta las dos clases de evidencia de todos modos, por si algún día
 * otro escritor la produce sobre una fila liberada.
 */
async function retenerSiHayColisionSobreUnaLiberada(evidencia: Payment, paymentData: PaymentCreationData): Promise<void> {
  if (paymentData.registradoVia === 'webhook') return
  const requestId = evidencia.terminalPaymentRequestId ?? solicitudDelRegistro(evidencia.processorData)
  if (!requestId) return
  try {
    const resultado = await terminalPaymentService.retenerSolicitudLiberadaPorColisionDeReferencia({
      requestId,
      venueId: evidencia.venueId,
      paymentId: evidencia.id,
      capturedBySerial: paymentData.authenticatedTerminalSerial ?? null,
      origen: 'REST',
    })
    // 🔴 Ronda 4 (P1-B, Codex r9): el resultado ya NO se descarta. Un `DEFERRED` (candado ocupado, base caída) dejaba la
    // solicitud liberada diciéndole al POS «puedes volver a cobrar» PARA SIEMPRE: la respuesta al cajero es un éxito y
    // nadie volvía a pasar por aquí. Ahora la recoge la RED DURABLE del watchdog, que desde esta ronda selecciona también
    // por la EVIDENCIA PENDING (no sólo por un Payment COMPLETED ligado), así que la promesa de este mensaje es cierta.
    if (resultado === 'DEFERRED')
      logger.warn('⏱️ [Terminal-payment] la re-retención por colisión de referencia quedó diferida — la red durable la recoge', {
        paymentId: evidencia.id,
        venueId: evidencia.venueId,
        requestId,
      })
  } catch (error) {
    logger.warn('⚠️ [Terminal-payment] No se pudo pedir la re-retención por colisión de referencia — la red durable la recoge', {
      paymentId: evidencia.id,
      venueId: evidencia.venueId,
      requestId,
      error: error instanceof Error ? error.message : String(error),
    })
  }
}

/** S0: bajo el candado de la solicitud resultó que el ganador YA es este mismo intento (misma llave): reintento idempotente. */
/**
 * S8: bitácora del webhook como confirmador SÓLO bajo la condición de alarma de `closeRowFromPaymentTx`
 * (`alarmed` = `reopened || CANCEL_REQUESTED`): dinero que llegó por webhook a una solicitud que ya dábamos por cerrada o
 * en cancelación — lo que un dueño audita. La confirmación normal es tráfico de cada cobro y NO se registra. Corre
 * DESPUÉS del commit y sin `await` encadenado: si la bitácora truena, el cobro ya quedó.
 */
function registrarConfirmacionAnomalaPorWebhook(
  cierre: CloseRowOutcome | null,
  ctx: {
    venueId: string
    requestId: string | null
    paymentId: string
    attemptId: string | null
    staffId: string | null
    amountCents: number
    tipCents: number
  },
): void {
  if (!cierre?.bound || !cierre.alarmed || !ctx.requestId) return
  void logAction({
    action: 'TERMINAL_PAYMENT_CONFIRMED_BY_WEBHOOK',
    entity: 'TerminalPaymentRequest',
    entityId: ctx.requestId,
    venueId: ctx.venueId,
    staffId: ctx.staffId,
    data: JSON.parse(
      JSON.stringify({
        requestId: ctx.requestId,
        paymentId: ctx.paymentId,
        attemptId: ctx.attemptId,
        previousStatus: cierre.previousStatus,
        reopened: cierre.reopened,
        amountCents: ctx.amountCents,
        tipCents: ctx.tipCents,
        via: 'webhook',
      }),
    ),
  })
}

class ReintentoDelGanadorDeLaSolicitud extends Error {
  constructor(readonly winnerPaymentId: string) {
    super('reintento del ganador de la solicitud')
    this.name = 'ReintentoDelGanadorDeLaSolicitud'
  }
}

/**
 * Codex R12-7: bajo el candado de la referencia, la RELECTURA encontró el cargo que otro replay acababa de commitear. Aborta
 * la transacción de creación (todavía sin escribir nada) y el llamador devuelve el existente por la misma rama que la
 * resolución previa a la transacción.
 */
class RegistroYaExistentePorReferencia extends Error {
  constructor(readonly registro: Payment & { receipts: DigitalReceipt[] }) {
    super('el cargo ya estaba registrado (relectura bajo el candado de la referencia)')
    this.name = 'RegistroYaExistentePorReferencia'
  }
}

/**
 * Codex R12-7: primera sentencia de la transacción de creación de un registro SIN llave — exclusión por (venue, referencia) y
 * RELECTURA de la referencia ya con el candado (fotografía nueva: quien llega segundo ve lo que el primero commiteó). Devuelve
 * la colisión vigente (o null) para que la creación la registre como evidencia; lanza `RegistroYaExistentePorReferencia` si el
 * cargo ya existe, y un error REINTENTABLE si el candado no se pudo adquirir en el plazo (la terminal vuelve a mandar el
 * mismo cobro; nunca nace un duplicado). Con llave no aplica: la protege el índice único `(venueId, idempotencyKey)`.
 */
async function exclusionPorReferencia(
  tx: Prisma.TransactionClient,
  args: Parameters<typeof resolverPorReferencia>[0],
): Promise<ColisionDeReferenciaRegistrada['candidates'] | null> {
  try {
    await candadoDeReferencia(tx, args.venueId, args.referenceNumber)
  } catch (error) {
    if (esVencimientoDeCandado(error)) throw new RegistroNoResuelto('REFERENCE_LOCK_TIMEOUT')
    throw error
  }
  const relectura = await resolverPorReferencia(args)
  if (relectura.kind === 'EXISTENTE') throw new RegistroYaExistentePorReferencia(relectura.registro)
  return relectura.kind === 'COLISION' ? relectura.contradicciones : null
}

type SegundaCapturaRegistrada = { requestId: string; winnerPaymentId: string; winnerIdempotencyKey: string | null }
/** El snapshot de tarifa es dato plano; Prisma exige `InputJsonValue` (con índice de cadena) para el JSON. */
const tarifaComoJson = (t: TarifaCongelada | null | undefined): Prisma.InputJsonValue | null =>
  t ? (JSON.parse(JSON.stringify(t)) as Prisma.InputJsonValue) : null
/** Codex R4-6: candidatos de la misma referencia que bajo el candado CONTRADIJERON al entrante (identidad débil). */
type ColisionDeReferenciaRegistrada = { referenceNumber: string; candidates: { paymentId: string; orderId: string; campos: string[] }[] }

const fuenteDelPago = (source?: string): PaymentSource => {
  if (!source) return 'OTHER'
  if (source === 'AVOQADO_TPV') return 'TPV'
  return ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER'].includes(source) ? (source as PaymentSource) : 'OTHER'
}

/**
 * S0 · POSIBLE SEGUNDA CAPTURA (Codex, 13-sep-2026). La solicitud POS→terminal ya tiene ganador y llega OTRO intento
 * acreditado. Desde aquí no se puede saber si el banco cobró dos veces o si es el mismo cobro con otra llave: se
 * GUARDA como evidencia durable —ligada a la solicitud y a la venta VALIDADA del ganador— y se deja a conciliación.
 *  · NUNCA COMPLETED: fuera de ventas, turno, liquidación, lealtad, costos, allocations y efectos.
 *  · NUNCA una venta nueva: cuelga de la orden del ganador (`Payment.orderId` es obligatorio).
 *  · La respuesta a la terminal es 2xx con ESTE Payment (nunca el del ganador): así el intento queda REGISTRADO en su
 *    libreta y no vuelve a intentarlo; el índice único parcial del ganador no lo alcanza porque no es COMPLETED.
 */
async function crearEvidenciaDeSegundaCaptura(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    orderId: string
    arbitraje: Extract<ArbitrajeDeRegistro, { kind: 'SECOND_CAPTURE' }>
    paymentData: PaymentCreationData
    totalAmount: number
    tipAmount: number
    method: PaymentMethod
    merchantAccountId: string | undefined
    terminalId: string | null
    staffId: string | null | undefined
  },
) {
  const { paymentData, arbitraje } = args
  return tx.payment.create({
    data: {
      venueId: args.venueId,
      orderId: args.orderId,
      amount: args.totalAmount,
      tipAmount: args.tipAmount,
      method: args.method,
      status: 'PENDING',
      splitType: paymentData.splitType as SplitType,
      source: fuenteDelPago(paymentData.source),
      processor: 'TBD',
      terminalPaymentRequestId: arbitraje.row.requestId,
      processorData: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
        typeOfCard: paymentData.typeOfCard,
        bank: paymentData.bank,
        currency: paymentData.currency,
        isInternational: paymentData.isInternational,
        blumonSerialNumber: paymentData.blumonSerialNumber || null,
        blumonOperationNumber: paymentData.blumonOperationNumber || null,
        deviceSerialNumber: paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
        pricingSlot: paymentData.pricingSlot ?? null,
        pricing: tarifaComoJson(paymentData.pricing),
        // Codex R3 (P2): la evidencia nacida del webhook conserva su origen y la provisionalidad del método — el REST
        // posterior con el método REAL enriquece sin contradicción. Sigue PENDING y sin costo.
        ...(paymentData.registradoVia === 'webhook' ? { registradoVia: 'webhook', methodProvisional: true } : {}),
        terminalPaymentRequestId: arbitraje.row.requestId,
        reconciliation: {
          kind: 'POSSIBLE_SECOND_CAPTURE',
          requestId: arbitraje.row.requestId,
          winnerPaymentId: arbitraje.winnerPaymentId,
          winnerIdempotencyKey: arbitraje.winnerIdempotencyKey,
          requested: { amountCents: arbitraje.row.amountCents, tipCents: arbitraje.row.tipCents },
          detectedAt: new Date().toISOString(),
          via: paymentData.registradoVia === 'webhook' ? 'webhook' : 'REST',
        },
      },
      authorizationNumber: paymentData.authorizationNumber,
      referenceNumber: paymentData.referenceNumber,
      idempotencyKey: paymentData.idempotencyKey,
      maskedPan: paymentData.maskedPan,
      cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
      entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
      merchantAccountId: args.merchantAccountId,
      terminalId: args.terminalId,
      processedById: args.staffId ?? null,
      shiftId: null,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: args.totalAmount + args.tipAmount,
      posRawData: {
        splitType: paymentData.splitType,
        staffId: args.staffId ?? null,
        source: fuenteDelPago(paymentData.source),
        paidProductsId: paymentData.paidProductsId || [],
        possibleSecondCapture: true,
      },
    },
  })
}

/**
 * S0 · Fail-open a propósito, igual que la lectura de la fila de arbitraje antes de la transacción: si el arbitraje
 * no puede DECIDIR (la consulta truena), el cobro —que YA ocurrió en el banco— se registra como cobro normal, sin
 * ligar ni clasificar, con 🚨 para conciliar. Un fallo de infraestructura jamás puede impedir registrar dinero
 * cobrado; dentro de una transacción real de Postgres un fallo de conexión aborta todo de todos modos, así que
 * esto sólo cambia el desenlace de un fallo LÓGICO en la decisión. Nunca «adivina» ganador: no ligar es lo seguro.
 */
async function arbitrarSinPerderElCobro(
  tx: Prisma.TransactionClient,
  input: Parameters<typeof terminalPaymentService.arbitrarRegistroDeSolicitud>[1],
): Promise<ArbitrajeDeRegistro> {
  try {
    return await terminalPaymentService.arbitrarRegistroDeSolicitud(tx, input)
  } catch (error) {
    logger.error('🚨 [Terminal-payment] El arbitraje de la solicitud no pudo decidir — el cobro se registra sin ligar, para conciliar', {
      venueId: input.venueId,
      requestId: input.requestId,
      attemptKey: input.attemptKey,
      error: error instanceof Error ? error.message : String(error),
    })
    return { kind: 'INVALID_ASSOCIATION', reason: 'NO_TERMINAL_IDENTITY' }
  }
}

/**
 * S2 + Codex R4-4: la OBLIGACIÓN de costo se encola DENTRO de la transacción financiera (durable aunque el proceso muera)
 * para TODO cobro COMPLETED que no sea efectivo — no sólo el nacido del webhook. Para el REST de la terminal el costo se
 * calcula enseguida y cierra la obligación; si ese cálculo falla (tarifa no acreditable, configuración incompleta, fallo
 * operativo) la obligación sigue PENDIENTE y visible en la cola, en vez de un `log.error` que nadie retoma.
 */
async function encolarObligacionDeCosto(
  tx: Prisma.TransactionClient,
  payment: { id: string; venueId: string; orderId: string; status: string; method: string },
  via: 'webhook' | 'terminal',
): Promise<void> {
  if (payment.status !== 'COMPLETED' || payment.method === 'CASH') return
  await enqueuePaymentEffect(tx, {
    venueId: payment.venueId,
    paymentId: payment.id,
    orderId: payment.orderId,
    kind: 'TRANSACTION_COST',
    dedupeKey: `transaction-cost:${payment.id}:v1`,
    payload:
      via === 'webhook'
        ? { reason: 'AWAITING_ACCREDITED_CARD_DATA', deadlineAt: new Date(Date.now() + COSTO_PENDIENTE_PLAZO_MS).toISOString() }
        : { reason: 'ASSURE_COST', deadlineAt: new Date().toISOString() },
    // El cálculo síncrono de ESTA petición cierra la obligación en cuanto termina; el worker sólo la toma si no lo hizo. Con el
    // primer intento un minuto después no compiten los dos por crear el mismo costo (índice único de `paymentId`) en el segundo
    // que dura el registro.
    ...(via === 'terminal' ? { nextAttemptAt: new Date(Date.now() + 60_000) } : {}),
  })
}

/**
 * Codex R4-6 · COLISIÓN DE REFERENCIA con identidad débil. La misma referencia (mismo segundo), mismo importe, misma
 * terminal y misma orden que un Payment ya registrado, pero bajo el candado ese Payment CONTRADICE al entrante en un dato
 * acreditado (autorización, tarjeta, modo de entrada, afiliación…): no es el mismo cobro y tampoco se puede afirmar que
 * sea una segunda venta. Se guarda como EVIDENCIA PENDING —ligada a la venta del candidato— y se deja a conciliación:
 *  · NUNCA COMPLETED: fuera de ventas, turno, liquidación, lealtad, costos, allocations y efectos.
 *  · NUNCA se absorbe devolviendo el existente (eso hacía desaparecer un cobro real).
 *  · La respuesta a la terminal es 2xx con ESTE Payment: el intento queda REGISTRADO en su libreta y no se reintenta.
 */
async function crearEvidenciaDeColisionDeReferencia(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    orderId: string
    colision: ColisionDeReferenciaRegistrada
    paymentData: PaymentCreationData
    totalAmount: number
    tipAmount: number
    method: PaymentMethod
    merchantAccountId: string | undefined
    terminalId: string | null
    staffId: string | null | undefined
  },
) {
  const { paymentData, colision } = args
  return tx.payment.create({
    data: {
      venueId: args.venueId,
      orderId: args.orderId,
      amount: args.totalAmount,
      tipAmount: args.tipAmount,
      method: args.method,
      status: 'PENDING',
      splitType: paymentData.splitType as SplitType,
      source: fuenteDelPago(paymentData.source),
      processor: 'TBD',
      terminalPaymentRequestId: paymentData.terminalPaymentRequestId ?? null,
      processorData: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
        typeOfCard: paymentData.typeOfCard,
        bank: paymentData.bank,
        currency: paymentData.currency,
        isInternational: paymentData.isInternational,
        blumonSerialNumber: paymentData.blumonSerialNumber || null,
        blumonOperationNumber: paymentData.blumonOperationNumber || null,
        deviceSerialNumber: paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
        pricingSlot: paymentData.pricingSlot ?? null,
        pricing: tarifaComoJson(paymentData.pricing),
        ...(paymentData.registradoVia === 'webhook' ? { registradoVia: 'webhook', methodProvisional: true } : {}),
        ...(paymentData.terminalPaymentRequestId ? { terminalPaymentRequestId: paymentData.terminalPaymentRequestId } : {}),
        reconciliation: {
          kind: 'POSSIBLE_REFERENCE_COLLISION',
          referenceNumber: colision.referenceNumber,
          candidates: colision.candidates,
          detectedAt: new Date().toISOString(),
          via: paymentData.registradoVia === 'webhook' ? 'webhook' : 'REST',
        },
      },
      authorizationNumber: paymentData.authorizationNumber,
      referenceNumber: paymentData.referenceNumber,
      idempotencyKey: paymentData.idempotencyKey,
      maskedPan: paymentData.maskedPan,
      cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
      entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
      merchantAccountId: args.merchantAccountId,
      terminalId: args.terminalId,
      processedById: args.staffId ?? null,
      shiftId: null,
      feePercentage: 0,
      feeAmount: 0,
      netAmount: args.totalAmount + args.tipAmount,
      posRawData: {
        splitType: paymentData.splitType,
        staffId: args.staffId ?? null,
        source: fuenteDelPago(paymentData.source),
        paidProductsId: paymentData.paidProductsId || [],
        possibleReferenceCollision: true,
      },
    },
  })
}

/** Respuesta específica de la colisión de referencia: 🚨, bitácora durable para el dueño, y recibo (la terminal lo exige). */
async function responderColisionDeReferencia(
  venueId: string,
  payment: Awaited<ReturnType<typeof prisma.payment.create>>,
  ctx: ColisionDeReferenciaRegistrada,
) {
  logger.error(
    '🚨 [Terminal-payment] POSIBLE COLISIÓN DE REFERENCIA: misma referencia, importe y terminal que un Payment que CONTRADICE al entrante — guardado como evidencia PENDING, fuera de ventas, para conciliar',
    {
      venueId,
      paymentId: payment.id,
      referenceNumber: ctx.referenceNumber,
      candidates: ctx.candidates,
      amount: Number(payment.amount),
      tip: Number(payment.tipAmount),
      idempotencyKey: payment.idempotencyKey,
      authorizationNumber: payment.authorizationNumber,
    },
  )
  await logAction({
    action: 'TERMINAL_PAYMENT_POSSIBLE_REFERENCE_COLLISION',
    entity: 'Payment',
    entityId: payment.id,
    venueId,
    staffId: payment.processedById ?? undefined,
    data: {
      referenceNumber: ctx.referenceNumber,
      candidates: ctx.candidates,
      amount: Number(payment.amount),
      tip: Number(payment.tipAmount),
      idempotencyKey: payment.idempotencyKey,
      authorizationNumber: payment.authorizationNumber,
      resolution:
        'Confirma en el portal del procesador si hubo un segundo cargo con esta referencia. Si es un cobro real distinto, regístralo sobre su venta; si es el mismo cobro, descarta esta evidencia.',
    },
  })
  return {
    ...payment,
    digitalReceipt: await ensureDigitalReceiptResponse(payment.id, undefined),
    possibleReferenceCollision: { referenceNumber: ctx.referenceNumber, candidates: ctx.candidates.map(c => c.paymentId) },
  }
}

/** Respuesta específica de la segunda captura: 🚨, bitácora durable para el dueño, y recibo (la terminal lo exige). */
async function responderSegundaCaptura(
  venueId: string,
  payment: Awaited<ReturnType<typeof prisma.payment.create>>,
  ctx: SegundaCapturaRegistrada,
) {
  logger.error(
    '🚨 [Terminal-payment] POSIBLE SEGUNDA CAPTURA: la solicitud ya tenía ganador y llegó OTRO intento acreditado — guardado como evidencia PENDING, fuera de ventas, para conciliar',
    {
      venueId,
      paymentId: payment.id,
      ...ctx,
      amount: Number(payment.amount),
      tip: Number(payment.tipAmount),
      idempotencyKey: payment.idempotencyKey,
      referenceNumber: payment.referenceNumber,
    },
  )
  await logAction({
    action: 'TERMINAL_PAYMENT_POSSIBLE_SECOND_CAPTURE',
    entity: 'Payment',
    entityId: payment.id,
    venueId,
    staffId: payment.processedById ?? undefined,
    data: {
      requestId: ctx.requestId,
      winnerPaymentId: ctx.winnerPaymentId,
      winnerIdempotencyKey: ctx.winnerIdempotencyKey,
      amount: Number(payment.amount),
      tip: Number(payment.tipAmount),
      idempotencyKey: payment.idempotencyKey,
      referenceNumber: payment.referenceNumber,
      authorizationNumber: payment.authorizationNumber,
      resolution:
        'Confirma en el portal del procesador si el cliente pagó dos veces. Si sí, devuelve esta captura; si no, descártala. La venta ya está cobrada por el ganador.',
    },
  })
  return {
    ...payment,
    digitalReceipt: await ensureDigitalReceiptResponse(payment.id, undefined),
    possibleSecondCapture: { requestId: ctx.requestId, winnerPaymentId: ctx.winnerPaymentId },
  }
}

/**
 * Build the slim digitalReceipt response shape with a constructed `receiptUrl`.
 *
 * The TPV client (`FastPaymentRecorder`) requires `digitalReceipt.receiptUrl` (non-null). The
 * fresh-record path constructs it inline, but the idempotent / existing-payment branches used to
 * return the raw Prisma receipt (which has NO `receiptUrl` field) → the TPV crashed parsing the
 * response and the offline queue never cleared (stuck "pago pendiente" + blank QR). Use this
 * everywhere a digitalReceipt is returned so every response shape is consistent.
 *
 * `autofacturaAvailable` is ALWAYS present (defaults to `false`) so the TPV can pick a "…y
 * factura" QR caption only when the venue+merchant can actually self-invoice this ticket.
 */
export function mapDigitalReceiptResponse<T extends { accessKey: string }>(
  receipt: T | null | undefined,
  autofacturaAvailable = false,
): (T & { receiptUrl: string; autofacturaAvailable: boolean }) | null {
  if (!receipt) return null
  // Purely ADDITIVE: keep every field the idempotent branches already returned (id, accessKey,
  // dataSnapshot, status, …) and just ADD the constructed `receiptUrl` the TPV client needs.
  // Removes nothing → cannot break any consumer that relied on the previous shape.
  return {
    ...receipt,
    receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${receipt.accessKey}`,
    autofacturaAvailable,
  }
}

/**
 * Igual que {@link mapDigitalReceiptResponse}, pero si el pago existente NO tiene fila en
 * `DigitalReceipt`, la GENERA en vez de devolver `null`.
 *
 * 🔴 Por qué existe (incidente Testarudo Café, 2026-08-05). `mapDigitalReceiptResponse` corta con
 * `if (!receipt) return null` — correcto como mapeo, pero en las ramas idempotentes significaba
 * responder 200 con `digitalReceipt: null` a un TPV que lo leía sin protección
 * (`FastPaymentRecorder.kt` → `body.data.digitalReceipt.receiptUrl`). Gson no respeta la
 * no-nulabilidad de Kotlin, así que el null entraba y reventaba con NPE; la NPE se clasificaba
 * como error TRANSITORIO y el pago —ya cobrado y ya registrado— se reintentaba sin tope:
 * 2,781 reintentos del mismo cobro del 23-jun en 6.3 h. Cero doble cargo (la idempotencia
 * respondió bien las 2,781 veces), pero la terminal nunca cerró su pendiente.
 *
 * El TPV ya quedó blindado (`digitalReceipt` nullable + lectura null-safe), PERO un APK tarda
 * 3-5 días en llegar a las terminales y hay pagos en prod hoy en esa condición. Esto lo corta
 * desde el server, que despliega en minutos y cubre también a las terminales viejas.
 *
 * Nunca lanza: si la generación falla se cae a `null` (el comportamiento anterior) — un recibo
 * faltante jamás puede tumbar la respuesta de un cobro que ya ocurrió.
 */
export async function ensureDigitalReceiptResponse(
  paymentId: string,
  receipt: { accessKey: string } | null | undefined,
  autofacturaAvailable = false,
): Promise<{ accessKey: string; receiptUrl: string; autofacturaAvailable: boolean } | null> {
  if (receipt) return mapDigitalReceiptResponse(receipt, autofacturaAvailable)

  try {
    const generated = await generateDigitalReceipt(paymentId)
    logger.info('🧾 [idempotent] Recibo digital faltante generado al vuelo', { paymentId, receiptId: generated.id })
    return mapDigitalReceiptResponse(generated, autofacturaAvailable)
  } catch (error) {
    logger.error('🧾 [idempotent] No se pudo generar el recibo faltante — se responde sin recibo', {
      paymentId,
      error: error instanceof Error ? error.message : error,
    })
    return null
  }
}

/**
 * Resolve whether this order's ticket may self-invoice (autofactura), for the TPV's
 * "…y factura" QR caption. Mirrors `getAutofacturaStatusController`
 * (`src/controllers/public/cfdi.public.controller.ts`) — reuses the SAME canonical resolver
 * (`loadOrderForCfdiFromDb`) so the definition of "available" never drifts between the customer
 * receipt portal and the TPV printout.
 *
 * 🛡️ Hot payment path: this is a read-only fiscal-config lookup layered on top of a successful
 * charge. It must NEVER break the payment/receipt response — any error (including a rejected
 * promise) degrades to `false`, same as "not invoiceable".
 */
export async function resolveAutofacturaAvailable(orderId: string | null | undefined): Promise<boolean> {
  if (!orderId) return false
  try {
    const bundle = await loadOrderForCfdiFromDb(orderId)
    // Fuera del sobre seguro (promoción, cargo por servicio…) el motor rechazaría el documento: el
    // ticket no ofrece una autofactura que después va a fallar.
    return !!bundle && bundle.facturacionEnabled && bundle.autofacturaEnabled && !bundle.unsupportedReasons?.length
  } catch (error) {
    logger.error('[payment.tpv.service] resolveAutofacturaAvailable lookup failed — defaulting to false', {
      orderId,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

/**
 * Convert TPV rating strings to numeric values for database storage
 *
 * **Supports:**
 * - Numeric strings: "1", "2", "3", "4", "5" (new Android format - 2025-01-30)
 * - Categorical strings: "EXCELLENT", "GOOD", "POOR" (legacy format - backward compatibility)
 *
 * @param tpvRating The rating string from TPV
 * @returns Numeric rating (1-5) or null if invalid
 */
function mapTpvRatingToNumeric(tpvRating: string): number | null {
  // ✅ NEW: First try to parse as numeric string (Android app sends "1"-"5")
  const numericRating = parseInt(tpvRating, 10)
  if (!isNaN(numericRating) && numericRating >= 1 && numericRating <= 5) {
    return numericRating
  }

  // ⚠️ LEGACY: Fallback to categorical format for backward compatibility
  const ratingMap: Record<string, number> = {
    EXCELLENT: 5,
    GOOD: 3,
    POOR: 1,
  }

  return ratingMap[tpvRating.toUpperCase()] || null
}

/**
 * 🔴 DINERO — Aviso de inventario que viaja PEGADO a un cobro que YA se registró.
 *
 * Existe porque el inventario se revisa DESPUÉS de que el Payment quedó
 * comiteado (desde la paridad con Square, 2026-08-12, nada rechaza un cobro por
 * stock; el pre-flight previo a la transacción se quitó el 2026-08-25 porque
 * sólo duplicaba la consulta). Ahí ya no hay nada que prevenir: rechazar no
 * des-cobra la tarjeta, sólo le miente al cajero, que entonces vuelve a
 * pasarla. Ese fue el doble cobro real.
 *
 * Mismo criterio que el bloque 🚨 [Sobrepago] de este archivo: el pago se
 * registra SIEMPRE y lo que se elimina es la invisibilidad del problema.
 *
 * Se sirve como campo OPCIONAL de la respuesta de `recordOrderPayment` — con
 * spread condicional, igual que `areaTicketCheckoutState`, así que la llave
 * está AUSENTE (no `null`) cuando no hay nada que avisar y ningún cliente viejo
 * cambia de comportamiento.
 */
export interface OrderInventoryWarning {
  /**
   * `INSUFFICIENT_INVENTORY` — se detectó faltante pero el descuento SÍ corrió.
   * `INVENTORY_NOT_DEDUCTED` — el descuento falló y se revirtió; la causa puede ser
   * falta de stock, concurrencia o una receta mal configurada, y va en `issues[].reason`.
   */
  code: 'INSUFFICIENT_INVENTORY' | 'INVENTORY_NOT_DEDUCTED'
  /** El cobro SIEMPRE quedó registrado. Esto dice si el stock alcanzó a moverse. */
  inventoryDeducted: boolean
  /** Español, listo para pintarse al cajero. NO puede sugerir que el cobro falló. */
  message: string
  /** Los mismos 4 datos que antes se aplastaban en el string del error, ya estructurados. */
  issues: Array<{
    productId: string
    productName: string
    requested: number | null
    available: number | string | null
    reason: string
  }>
}

/**
 * Arma el aviso que ve el cajero. La PRIMERA frase siempre confirma el cobro:
 * si el POS sólo alcanza a pintar una línea, esa línea no puede ser la que lo
 * mande a pasar la tarjeta otra vez.
 */
export function buildInventoryWarning(rawIssues: OrderInventoryWarning['issues'], inventoryDeducted: boolean): OrderInventoryWarning {
  // En un TOCTOU real las DOS puertas reportan el MISMO producto: el pre-flight
  // con el `available` numérico, y la deducción con `available: null` y su error.
  // Sin esto el cajero ve la hamburguesa dos veces y no sabe si son dos problemas.
  // Gana la primera (el pre-flight, que trae el número), y si a ella le faltaba el
  // dato disponible, lo rellena la segunda. Un producto = una línea.
  const porProducto = new Map<string, OrderInventoryWarning['issues'][number]>()
  for (const issue of rawIssues) {
    const previo = porProducto.get(issue.productId)
    if (!previo) {
      porProducto.set(issue.productId, { ...issue })
      continue
    }
    if (previo.available == null && issue.available != null) previo.available = issue.available
    if (previo.requested == null && issue.requested != null) previo.requested = issue.requested
  }
  const issues = [...porProducto.values()]

  const detalle = issues
    .map(issue => {
      const disponible = issue.available == null ? 'sin disponibilidad confirmada' : `disponibles ${issue.available}`
      const pedido = issue.requested == null ? 'cantidad no determinada' : `se pidieron ${issue.requested}`
      return `${issue.productName} (${pedido}, ${disponible} — ${issue.reason})`
    })
    .join('; ')

  const cierre = inventoryDeducted
    ? 'El inventario sí se descontó; revisa el stock de estos productos.'
    : 'El inventario NO se descontó y la cuenta quedó marcada para revisión.'

  return {
    // El motivo real (falta de stock, concurrencia, receta mal configurada) viaja
    // verbatim en `issues[].reason`; el código sólo resume qué pasó con el stock.
    code: inventoryDeducted ? 'INSUFFICIENT_INVENTORY' : 'INVENTORY_NOT_DEDUCTED',
    inventoryDeducted,
    message: `El cobro se registró correctamente. Hubo un problema de inventario: ${detalle || 'sin detalle disponible'}. ${cierre}`,
    issues,
  }
}

/**
 * ✅ WORLD-CLASS PATTERN: Pre-flight validation (Stripe, Shopify, Toast POS)
 * Validate inventory availability BEFORE capturing payment
 * Also validates modifier inventory (Toast/Square pattern)
 *
 * @param venueId Venue ID
 * @param orderItems Order items to validate (including modifiers)
 * @returns Validation result with issues if any
 */
async function validateOrderInventoryAvailability(
  venueId: string,
  orderItems: Array<{
    productId: string
    product: { name: string }
    quantity: number
    weightQuantity?: any
    modifiers?: Array<{
      quantity: number
      modifier: {
        id: string
        name: string
        rawMaterialId: string | null
        quantityPerUnit: any // Decimal
        unit: string | null
        inventoryMode: string
      }
    }>
  }>,
): Promise<{
  available: boolean
  issues?: Array<{ productId: string; productName: string; requested: number; available: number | string; reason: string }>
}> {
  const issues: Array<{ productId: string; productName: string; requested: number; available: number | string; reason: string }> = []

  // Validate each product
  for (const item of orderItems) {
    const effectiveQuantity = item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity
    try {
      const inventoryStatus = await getProductInventoryStatus(venueId, item.productId)

      // QUANTITY method → check current stock
      if (inventoryStatus.inventoryMethod === 'QUANTITY') {
        const currentStock = inventoryStatus.currentStock || 0

        if (currentStock < effectiveQuantity) {
          issues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: effectiveQuantity,
            available: currentStock,
            reason: 'Insufficient stock for product',
          })
        }
      }

      // RECIPE method → check max portions
      if (inventoryStatus.inventoryMethod === 'RECIPE') {
        const maxPortions = inventoryStatus.maxPortions || 0

        if (maxPortions < effectiveQuantity) {
          // Gather missing ingredient details
          const missingIngredients =
            inventoryStatus.insufficientIngredients
              ?.map(ing => `${ing.name} (need ${ing.required} ${ing.unit}, have ${ing.available} ${ing.unit})`)
              .join(', ') || 'Unknown ingredients'

          issues.push({
            productId: item.productId,
            productName: item.product.name,
            requested: effectiveQuantity,
            available: `${maxPortions} portions (missing: ${missingIngredients})`,
            reason: 'Insufficient ingredients for recipe',
          })
        }
      }
    } catch (error: any) {
      logger.error('⚠️ Failed to validate inventory for product', {
        productId: item.productId,
        productName: item.product.name,
        error: error.message,
      })

      // If validation fails for any reason, mark as unavailable
      issues.push({
        productId: item.productId,
        productName: item.product.name,
        requested: item.quantity,
        available: 'Unknown',
        reason: `Validation error: ${error.message}`,
      })
    }

    // ✅ WORLD-CLASS: Validate modifier inventory (Toast/Square pattern)
    if (item.modifiers?.length) {
      for (const orderModifier of item.modifiers) {
        const modifier = orderModifier.modifier

        // Skip modifiers without inventory tracking
        if (!modifier.rawMaterialId || !modifier.quantityPerUnit) continue

        try {
          // Check raw material stock for this modifier
          const rawMaterial = await prisma.rawMaterial.findUnique({
            where: { id: modifier.rawMaterialId },
            select: {
              id: true,
              name: true,
              currentStock: true,
              unit: true,
            },
          })

          if (!rawMaterial) {
            issues.push({
              productId: item.productId,
              productName: `${item.product.name} + ${modifier.name}`,
              requested: orderModifier.quantity,
              available: 'Unknown',
              reason: `Raw material not found for modifier ${modifier.name}`,
            })
            continue
          }

          // Calculate total quantity needed: quantityPerUnit × orderItem.quantity × modifier.quantity
          const quantityPerUnit = parseFloat(modifier.quantityPerUnit.toString())
          const totalNeeded = quantityPerUnit * effectiveQuantity * orderModifier.quantity
          const currentStock = parseFloat(rawMaterial.currentStock.toString())

          if (currentStock < totalNeeded) {
            issues.push({
              productId: item.productId,
              productName: `${item.product.name} + ${modifier.name}`,
              requested: totalNeeded,
              available: `${currentStock} ${rawMaterial.unit}`,
              reason: `Insufficient ${rawMaterial.name} for modifier`,
            })
          }
        } catch (modifierError: any) {
          logger.error('⚠️ Failed to validate inventory for modifier', {
            productId: item.productId,
            modifierId: modifier.id,
            modifierName: modifier.name,
            error: modifierError.message,
          })
        }
      }
    }
  }

  return {
    available: issues.length === 0,
    issues: issues.length > 0 ? issues : undefined,
  }
}

/**
 * Map payment source from Android app format to PaymentSource enum
 * @param source The source string from the app (e.g., "AVOQADO_TPV")
 * @returns Valid PaymentSource enum value
 */
function mapPaymentSource(source?: string): PaymentSource {
  if (!source) return 'OTHER'

  // Map "AVOQADO_TPV" from Android app to "TPV" enum value
  if (source === 'AVOQADO_TPV') return 'TPV'

  // Check if it's a valid PaymentSource enum value
  const validSources: PaymentSource[] = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
  return validSources.includes(source as PaymentSource) ? (source as PaymentSource) : 'OTHER'
}

/** Measurements are monotonic, contain identifiers only, and never affect payment results. */
function paymentStepTimer(venueId: string, requestId?: string) {
  const started = performance.now()
  const phases: Array<{ step: string; elapsedMs: number }> = []
  return {
    async time<T>(step: string, operation: () => Promise<T>): Promise<T> {
      const start = performance.now()
      try {
        return await operation()
      } finally {
        try {
          phases.push({ step, elapsedMs: Math.round(performance.now() - start) })
        } catch {
          /* observation only */
        }
      }
    },
    end(paymentId: string) {
      try {
        logger.info('Payment blocking steps', { venueId, requestId, paymentId, elapsedMs: Math.round(performance.now() - started), phases })
      } catch {
        /* observation only */
      }
    },
  }
}

async function enqueueCommittedPaymentEffects(
  tx: Prisma.TransactionClient,
  payment: { id: string; venueId: string; orderId: string; status: string; type: string | null },
  reviewRating: string | undefined,
  staffId: string | undefined,
  expectsSettlement: boolean,
): Promise<void> {
  if (payment.status !== 'COMPLETED') return
  const source = { venueId: payment.venueId, paymentId: payment.id, orderId: payment.orderId }
  await enqueuePaymentEffect(tx, { ...source, kind: 'RECEIPT', dedupeKey: 'receipt:' + payment.id + ':v1', payload: {} })
  const rating = reviewRating ? mapTpvRatingToNumeric(reviewRating) : null
  if (rating !== null)
    await enqueuePaymentEffect(tx, {
      ...source,
      kind: 'REVIEW',
      dedupeKey: 'review:' + payment.id + ':v1',
      payload: { rating, servedById: staffId ?? null },
    })
  if (expectsSettlement)
    await enqueuePaymentEffect(tx, {
      ...source,
      kind: 'REFERRAL',
      dedupeKey: 'referral:' + payment.orderId + ':v1',
      payload: { expectsSettlement: true },
    })
  if (payment.type !== 'TEST') await enqueuePaymentCommissionInTx(tx, payment.id)
}

type CommittedStandaloneSettlement = { firstSettlement: boolean; postingId: string | null }

/** Caller holds the Order lock; money and its inventory/loyalty obligation share one commit. */
async function settleStandalonePaymentInTx(
  tx: Prisma.TransactionClient,
  venueId: string,
  orderId: string,
  payment: { amount: Prisma.Decimal; tipAmount: Prisma.Decimal },
  staffId?: string,
): Promise<CommittedStandaloneSettlement> {
  // One specific invoice, not a tenant list: its entire item snapshot is required
  // to preserve the stock obligation without silently truncating a paid invoice.
  const order = await tx.order.findFirstOrThrow({
    where: { id: orderId, venueId },
    include: { items: { include: { modifiers: { include: { modifier: true } } } } },
  })
  const paid = await tx.payment.aggregate({
    where: { venueId, orderId, status: 'COMPLETED', OR: [{ type: null }, { type: { not: REFUND_PAYMENT_TYPE } }] },
    _sum: { amount: true, tipAmount: true },
    _count: true,
  })
  const amount = paid._sum.amount ?? new Prisma.Decimal(0)
  const tipAmount = paid._sum.tipAmount ?? new Prisma.Decimal(0)
  const balance = computeOrderBalance(order, [{ amount, tipAmount }])
  const previous = computeOrderBalance(order, [{ amount: amount.minus(payment.amount), tipAmount: tipAmount.minus(payment.tipAmount) }])
  const firstSettlement = balance.isFullyPaid && !(paid._count > 1 && previous.isFullyPaid)
  await tx.order.update({
    where: { id: orderId, venueId },
    data: {
      paidAmount: balance.paidAmount,
      remainingBalance: balance.remainingBalance,
      tipAmount: balance.tipAmount,
      total: balance.total,
      paymentStatus: balance.isFullyPaid ? 'PAID' : balance.paidAmount.greaterThan(0) ? 'PARTIAL' : order.paymentStatus,
      ...(balance.isFullyPaid && { status: 'COMPLETED', completedAt: order.completedAt ?? new Date() }),
      ...(!order.servedById && staffId && { servedById: staffId, createdById: order.createdById ?? staffId }),
      ...(firstSettlement && { loyaltyEligibleAt: new Date(), loyaltyStaffId: staffId }),
    },
  })
  const { createSalePostingInTx } = await import('@/services/inventory/inventoryPosting.service')
  const posting = firstSettlement ? await createSalePostingInTx(tx, { venueId, orderId, items: order.items, staffId }) : null
  return { firstSettlement, postingId: posting?.id ?? null }
}

/**
 * Update order totals directly in backend for standalone mode
 * @param orderId Order ID to update
 * @param paymentAmount Total payment amount (including tip)
 * @param tipAmount Tip amount from this payment (to calculate cumulative order.tipAmount)
 * @param currentPaymentId Current payment ID to exclude from calculation
 * @param staffId Optional staff ID who processed the payment (for loyalty points)
 * @returns Aviso de inventario cuando hubo faltante, o `null`. NUNCA lanza por
 *          inventario: cuando esta función corre el Payment ya está comiteado.
 */
async function updateOrderTotalsForStandalonePayment(
  orderId: string,
  paymentAmount: number,
  tipAmount: number, // ✅ FIX: Pass tip separately to update order.tipAmount
  currentPaymentId?: string,
  staffId?: string,
  options?: { areaTicketAlreadyFinalized?: boolean; venueId?: string; committedSettlement?: CommittedStandaloneSettlement },
): Promise<OrderInventoryWarning | null> {
  // Get current order with payment information
  const order = await prisma.order.findUnique({
    where: { id: orderId, ...(options?.venueId ? { venueId: options.venueId } : {}) },
    include: {
      payments: {
        where: {
          status: 'COMPLETED',
          // ✅ FIX: Exclude the current payment to avoid double-counting
          ...(currentPaymentId && { id: { not: currentPaymentId } }),
        },
        // 🔴 `type` NO es decorativo: un reembolso vive como un `Payment` NEGATIVO
        // `type: REFUND` colgado de la MISMA orden, y sin ese campo restaba de lo
        // pagado. Se leen TODOS los COMPLETED sin filtrar por `type` en la
        // consulta —igual que los otros tres canales— porque el resumen
        // compartido necesita los REFUND para reportar `refundState`.
        select: { amount: true, tipAmount: true, type: true },
      },
      items: {
        include: {
          product: true,
          // ✅ Include paymentAllocations to filter out paid items in validation
          paymentAllocations: true,
          modifiers: {
            include: {
              modifier: {
                select: {
                  id: true,
                  name: true,
                  groupId: true,
                  rawMaterialId: true,
                  quantityPerUnit: true,
                  unit: true,
                  inventoryMode: true,
                },
              },
            },
          },
        },
      },
      customer: true, // ⭐ LOYALTY: Need customer for points earning
    },
  })

  if (!order) {
    throw new Error(`Order ${orderId} not found for total update`)
  }
  const isAreaTicketOrder = order.items.some(item => item.areaTicketLineId != null)

  // 🔴 UN REEMBOLSO NO REABRE SALDO (founder, 2026-08-18).
  //
  // `summarizeRefunds` es la ÚNICA definición de "qué cuenta como pagado" del
  // backend (`src/services/shared/orderBalance.ts`), la misma que usan efectivo,
  // vales por área y cripto. Antes esta suma incluía el `Payment` NEGATIVO
  // `type: REFUND`, así que un cobro nuevo sobre una cuenta ya devuelta
  // recalculaba el saldo restando lo reembolsado y la venta volvía a pedir
  // dinero que el cliente ya había recuperado. El reembolso ahora lleva su
  // propio carril (`refundedAmount`/`refundState`), como `refunded_money` de
  // Square o `refundStatus` de Toast — y en México lo cierra el SAT: la
  // devolución se ampara con un CFDI de Egreso y el de ingreso no se toca.
  const refundSummary = summarizeRefunds(order.payments)

  // No se BLOQUEA nada: cuando esta función corre la tarjeta YA se cobró en el
  // proveedor, y rechazar aquí dejaría dinero cobrado SIN registro en Avoqado.
  // Queda un rastro greppable — MISMO token en los cuatro canales de cobro.
  if (refundSummary.refundState !== 'NONE') {
    logger.warn('⚠️ [Reembolso] cobro sobre una cuenta con reembolsos — el saldo NO los cuenta, revisar', {
      orderId,
      venueId: order.venueId,
      channel: 'recordOrderPayment',
      paymentId: currentPaymentId ?? null,
      refundState: refundSummary.refundState,
      refundedAmount: refundSummary.refundedAmount.toFixed(2),
    })
  }

  // Calculate total payments made (including this new one)
  const previousPayments = refundSummary.netPaidAmount.toNumber()
  const totalPaid = previousPayments + paymentAmount

  // ✅ FIX: Use subtotal as base (doesn't include tips), not order.total (which may already include tips from previous payments)
  const orderSubtotal = parseFloat(order.subtotal.toString())

  // Subtract order-level discount (e.g., 100% cortesía applied via applyManualDiscount).
  // Without this, discounted orders never reach isFullyPaid and stay in PENDING.
  const orderDiscount = order.discountAmount ? parseFloat(order.discountAmount.toString()) : 0

  // 🔴 EL CARGO POR SERVICIO ES DEUDA DE LA CUENTA (auditoría Codex, 2026-09-02).
  //
  // `Order.serviceChargeAmount` (propina automática por grupo, descorche, entrega) es —dicho
  // por el propio schema— «INGRESO GRAVABLE del negocio: SUMA al total y entra al corte y al
  // CFDI», a diferencia de la propina, que pasa al mesero. Este recálculo lo OMITÍA: una
  // cuenta de $100 + $10 de cargo con $100 cobrados se declaraba saldada, se le reescribía el
  // `total` a $100 —hacia ABAJO— y se cerraba con la mesa liberada. $10 fuera del corte, sin
  // error y sin rastro.
  //
  // `computeOrderBalance` (`shared/orderBalance.ts`) —la aritmética canónica que ya usan el
  // efectivo móvil y los vales por área— siempre lo sumó: era este camino el que discrepaba.
  const orderServiceCharge = order.serviceChargeAmount ? parseFloat(order.serviceChargeAmount.toString()) : 0

  // ✅ FIX: Calculate cumulative tip from all completed payments + current tip
  // 🔴 Sin los REFUND: la propina DEVUELTA (negativa) borraba del total la
  // propina que el mesero sí había cobrado.
  const previousTips = refundSummary.netTipAmount.toNumber()
  const totalTip = previousTips + tipAmount

  // ✅ FIX: Calculate new total including tips (consistent with fast payments)
  //
  // 🔴 MONEY: la MERCANCÍA se clampa a 0 ANTES de sumar la propina.
  //
  // Un `discountAmount` mayor que el subtotal es un estado que sí existe en la
  // base —lo dejan las cortesías de cuenta completa, y `recalculateOrderTotals`
  // guarda la suma cruda de descuentos aunque clampe su propio total— y aquí se
  // convertía en un `Order.total` NEGATIVO al cobrar: la cuenta pasaba a deber
  // dinero al cliente, el corte lo restaba de la venta del día y el POS pintaba
  // un botón "Pagar $-25.30". Visto en M13 (`cmsetvfft0001c9jxv33p26gl`):
  // subtotal 253.00 − descuento 278.30 = −25.30.
  //
  // El clamp va sobre `subtotal − descuento` y NO sobre el total completo: la
  // propina es dinero que el cliente decidió dar, no mercancía, y un descuento
  // excedente no debe comérsela. Mismo criterio que
  // `recalculateOrderTotals` (base clampada, luego se suman los cargos) y que
  // `applyManualDiscount` en discount.tpv.service.ts.
  //
  // El cargo por servicio va DESPUÉS del clamp, como la propina: un descuento excedente se
  // come la mercancía, no los cargos (mismo criterio que `computeOrderBalance`).
  const newTotal = Math.max(0, orderSubtotal - orderDiscount) + orderServiceCharge + totalTip

  // Calculate remaining amount (based on new total)
  // 🔴 El clamp a 0 se CONSERVA a propósito: clientes viejos (TPV/Android/iOS) esperan
  // remainingBalance >= 0 y quitarlo rompería su UI. El problema nunca fue el clamp en sí,
  // sino que era la ÚNICA representación del saldo: un sobrepago quedaba idéntico a una
  // cuenta bien saldada y nadie se enteraba (Mindform: $734 cobrados sobre una cuenta de
  // $380, invisible 2 meses hasta que el watchdog lo pescó). La detección de abajo rompe
  // esa invisibilidad sin cambiar el contrato de la API.
  const remainingAmount = Math.max(0, newTotal - totalPaid)
  const isFullyPaid = remainingAmount <= 0.01 // Account for floating point precision

  // 🔴 ¿La cuenta YA estaba saldada ANTES de este pago? (audit Codex 2026-08-12, P1)
  //
  // Re-cobrar una orden ya COMPLETED —el gesto exacto del doble cobro del
  // cajero, con idempotencyKey NUEVA que la dedup no atrapa— volvía a disparar
  // `isFullyPaid` y con él TODO el loop de deducción: la mercancía se
  // descontaba DOS veces (y sin el piso del decremento condicional, a
  // negativo). El dinero sigue el criterio del bloque 🚨 [Sobrepago] de
  // arriba: se registra SIEMPRE; lo que no se repite es el efecto de
  // inventario, que ya ocurrió cuando la orden se saldó la primera vez.
  // Se compara contra el total SIN la propina de este pago (previousTips, no
  // totalTip): la propina nueva no convierte una cuenta saldada en pendiente.
  // Y exige pagos PREVIOS: una orden 100% cortesía (total clampado a 0) sin
  // pagos aún NO está saldada — su primer cobro de $0 sí debe deducir.
  const settledBeforeThisPayment = options?.committedSettlement
    ? !options.committedSettlement.firstSettlement
    : order.payments.length > 0 && previousPayments >= Math.max(0, orderSubtotal - orderDiscount) + orderServiceCharge + previousTips - 0.01
  const coveredAreaTicketLines = isFullyPaid
    ? await getAreaTicketLineIdsCoveredByInventoryReservations(order.venueId, order.items)
    : new Set<string>()

  // 🚨 SOBREPAGO — detectar y gritar, NUNCA rechazar ni lanzar.
  //
  // Cuando este código corre, la tarjeta YA se cobró (Blumon primero, backend después): un
  // rechazo aquí dejaría dinero cobrado al cliente SIN registro en Avoqado — un cobro
  // fantasma, peor que el sobrepago. Por eso el pago SIEMPRE se registra; lo que se elimina
  // es la invisibilidad. `wasAlreadyPaid` distingue el caso Mindform exacto: un cobro nuevo
  // aterrizando sobre una cuenta que YA estaba saldada.
  const overpaidBy = Math.round((totalPaid - newTotal) * 100) / 100
  if (overpaidBy > 0.01) {
    const wasAlreadyPaid = order.paymentStatus === 'PAID'
    // BetterStack debe alertar sobre '🚨 [Sobrepago]'.
    logger.error('🚨 [Sobrepago] Se cobró MÁS de lo que vale la cuenta — el pago se registra, pero requiere revisión', {
      orderId,
      venueId: order.venueId,
      totalPaid,
      orderTotal: newTotal,
      overpaidBy,
      wasAlreadyPaid,
      paymentId: currentPaymentId ?? null,
      staffId: staffId ?? null,
    })
    // Fire-and-forget FUERA de toda transacción: una falla del audit jamás puede tocar el cobro.
    void prisma.activityLog
      .create({
        data: {
          action: 'SOBREPAGO_DETECTADO',
          entity: 'Order',
          entityId: orderId,
          staffId: staffId ?? null,
          venueId: order.venueId,
          data: {
            totalPaid,
            orderTotal: newTotal,
            overpaidBy,
            wasAlreadyPaid,
            paymentId: currentPaymentId ?? null,
          },
        },
      })
      .catch(err => {
        logger.error('🚨 [Sobrepago] No se pudo escribir el ActivityLog del sobrepago', {
          orderId,
          error: err instanceof Error ? err.message : err,
        })
      })
  }

  // 🚨 INVENTARIO INSUFICIENTE — detectar y gritar, NUNCA rechazar ni lanzar.
  //
  // Cuando este bloque corre, `prisma.$transaction` de `recordOrderPayment` YA
  // retornó: el Payment está comiteado y la tarjeta ya se cobró en el proveedor.
  // Un `throw` aquí NO des-cobra nada — sólo hace que el POS pinte "error de
  // inventario" sobre un cobro que sí pasó. El cajero concluye que no se cobró y
  // vuelve a pasar la tarjeta; ese segundo intento lleva `idempotencyKey` y
  // `referenceNumber` NUEVOS, así que la deduplicación no lo atrapa. Doble cobro
  // irrecuperable, medido en producción.
  //
  // Éste es el ÚNICO chequeo de inventario del camino de cobro. Desde la paridad con
  // Square (2026-08-12) nada rechaza un cobro por stock, así que el pre-flight que
  // corría ANTES de la transacción sólo duplicaba esta consulta y se quitó
  // (2026-08-25). Cuando dispara, el dinero ya entró: se avisa, no se revierte.
  //
  // Mismo razonamiento, línea por línea, que el bloque 🚨 [Sobrepago] de arriba.
  const inventoryIssues: OrderInventoryWarning['issues'] = []
  // true cuando la deducción REAL falló (no el pre-flight): decide el
  // `inventoryDeducted` del aviso final. Vive aquí porque el return está fuera
  // del bloque de deducción.
  let deductionFailed = false

  // ✅ WORLD-CLASS: Pre-flight validation BEFORE capturing payment (Stripe pattern)
  // Validate inventory availability before marking order as complete
  // (skip si la orden ya estaba saldada: su inventario ya se validó y dedujo)
  if (isFullyPaid && !settledBeforeThisPayment && !options?.areaTicketAlreadyFinalized) {
    // ✅ FIX: Only validate items that haven't been paid yet (no paymentAllocations)
    // Items with paymentAllocations have already been "claimed" by a previous split payment
    // Also skip items with deleted products (productId is null - Toast/Square pattern)
    const unpaidItems = order.items.filter(
      (item: any) =>
        item.productId &&
        (!item.paymentAllocations || item.paymentAllocations.length === 0) &&
        (!item.areaTicketLineId || !coveredAreaTicketLines.has(item.areaTicketLineId)),
    )

    logger.info('🔍 Pre-flight validation: Checking inventory availability before completing order', {
      orderId,
      venueId: order.venueId,
      totalItems: order.items.length,
      unpaidItems: unpaidItems.length,
      paidItems: order.items.length - unpaidItems.length,
    })

    const validation = await validateOrderInventoryAvailability(
      order.venueId,
      unpaidItems as { productId: string; product: { name: string }; quantity: number; modifiers?: any[] }[],
    )

    if (!validation.available) {
      // Se conserva el mismo detalle que antes viajaba en el mensaje del error
      // (producto, cuánto se pidió, cuánto había, motivo) — ahora estructurado.
      const issuesDescription = validation.issues
        ?.map(issue => `${issue.productName}: requested ${issue.requested}, available ${issue.available} (${issue.reason})`)
        .join('; ')

      // 🚨 token estable que machea la regla de Better Stack — NO renombrar.
      logger.error('🚨 [Inventario] Stock insuficiente detectado DESPUÉS de registrar el cobro — el pago se conserva, requiere revisión', {
        orderId,
        venueId: order.venueId,
        paymentId: currentPaymentId ?? null,
        staffId: staffId ?? null,
        stage: 'PRE_DEDUCTION',
        issues: validation.issues,
        issuesDescription,
      })

      // Fire-and-forget FUERA de toda transacción: una falla del audit jamás puede tocar el cobro.
      void prisma.activityLog
        .create({
          data: {
            action: 'INVENTARIO_INSUFICIENTE_AL_COBRAR',
            entity: 'Order',
            entityId: orderId,
            staffId: staffId ?? null,
            venueId: order.venueId,
            data: {
              stage: 'PRE_DEDUCTION',
              paymentId: currentPaymentId ?? null,
              issues: (validation.issues ?? []) as unknown as Prisma.InputJsonValue,
            },
          },
        })
        .catch(err => {
          logger.error('🚨 [Inventario] No se pudo escribir el ActivityLog del faltante de inventario', {
            orderId,
            error: err instanceof Error ? err.message : err,
          })
        })

      for (const issue of validation.issues ?? []) {
        inventoryIssues.push({
          productId: issue.productId,
          productName: issue.productName,
          requested: issue.requested,
          available: issue.available,
          reason: issue.reason,
        })
      }
      // Sin `throw`: el cobro ya existe. Se sigue adelante para dejar la cuenta
      // consistente con el dinero que SÍ entró, y el faltante viaja como aviso.
    } else {
      // En `else` a propósito: al quitar el `throw`, este log quedaba cayendo por
      // gravedad y cantaba "All inventory available" JUSTO debajo de la alerta de
      // faltante. Un log que se contradice a sí mismo cuesta una hora en un incidente.
      logger.info('✅ Pre-flight validation passed: All inventory available', {
        orderId,
        venueId: order.venueId,
      })
    }
  }

  // Determine new payment status
  let newPaymentStatus = order.paymentStatus
  if (isFullyPaid) {
    newPaymentStatus = 'PAID'
  } else if (totalPaid > 0) {
    newPaymentStatus = 'PARTIAL'
  }

  // Update order totals and status (including partial payment tracking)
  // ⭐ KIOSK MODE FIX: If servedById is null, assign the staff who processed the payment
  const shouldAssignServer = !order.servedById && staffId

  // 🔴 ATOMICIDAD del vale (audit Codex xhigh 2026-08-14): la transición a PAID y
  // el posting van en la MISMA transacción, para que valga el invariante
  //
  //     orden PAID  ⟺  posting existe
  //
  // Antes eran dos commits: si el proceso moría entre ellos, la orden quedaba
  // pagada SIN vale, y el sweeper no puede rescatar un posting que nunca nació
  // (sólo reintenta los existentes) — la deducción se perdía invisible.
  //
  // Trade-off aceptado: si el insert del vale falla, la transición a PAID se
  // revierte. NO es una regresión de "el inventario nunca bloquea un cobro":
  // el Payment YA está commiteado y el dinero registrado; lo que queda es una
  // orden sin marcar como pagada, estado que el watchdog de integridad ya
  // vigila (pago sin orden pagada) — visible y recuperable, a diferencia de la
  // deducción perdida en silencio. Los dos modos de falla realistas del vale ya
  // están cerrados aguas arriba: el UNIQUE con pre-check y la clasificación en
  // lote (nada de N+1 dentro de la transacción del dinero).
  const { createSalePostingInTx } = await import('@/services/inventory/inventoryPosting.service')
  let tpvPostingId: string | null = options?.committedSettlement?.postingId ?? null
  const debeRegistrarPosting = isFullyPaid && !settledBeforeThisPayment && !options?.areaTicketAlreadyFinalized

  const updatedOrder =
    options?.areaTicketAlreadyFinalized || options?.committedSettlement
      ? order
      : await prisma.$transaction(async tx => {
          const updated = await tx.order.update({
            where: { id: orderId, ...(options?.venueId ? { venueId: options.venueId } : {}) },
            data: {
              paymentStatus: newPaymentStatus,
              // ⭐ Partial payment tracking: Persist paidAmount and remainingBalance
              paidAmount: totalPaid,
              remainingBalance: remainingAmount,
              // ✅ FIX: Update order.tipAmount with cumulative tip from all payments
              tipAmount: totalTip,
              // ✅ FIX: Update order.total to include cumulative tips (consistent with fast payments)
              total: newTotal,
              // ⭐ KIOSK MODE: Assign payment processor as server if no server was assigned
              ...(shouldAssignServer && {
                servedById: staffId,
                createdById: order.createdById || staffId, // Also set createdById if null
              }),
              ...(isFullyPaid && {
                status: 'COMPLETED',
                completedAt: new Date(),
              }),
              ...(debeRegistrarPosting && { loyaltyEligibleAt: new Date(), loyaltyStaffId: staffId }),
            },
            include: {
              items: {
                include: {
                  product: true,
                  // ✅ Include modifiers with inventory-related fields for stock deduction
                  modifiers: {
                    include: {
                      modifier: {
                        select: {
                          id: true,
                          name: true,
                          groupId: true,
                          rawMaterialId: true,
                          quantityPerUnit: true,
                          unit: true,
                          inventoryMode: true,
                        },
                      },
                    },
                  },
                },
              },
            },
          })

          // El vale nace aquí dentro: mismo commit que la transición a PAID.
          if (debeRegistrarPosting) {
            const posting = await createSalePostingInTx(tx, {
              venueId: updated.venueId,
              orderId,
              items: updated.items as any,
              staffId,
            })
            tpvPostingId = posting?.id ?? null
          }

          return updated
        })

  logger.info('Order totals updated for standalone payment', {
    orderId,
    orderSubtotal,
    newTotal, // ✅ Subtotal + cumulative tips
    paymentAmount,
    tipAmount,
    totalTip, // ✅ Cumulative tip from all payments
    totalPaid,
    remainingAmount,
    isFullyPaid,
    newPaymentStatus,
    // ⭐ KIOSK MODE: Log if we assigned the server from payment processor
    kioskModeServerAssigned: shouldAssignServer,
    assignedServerId: shouldAssignServer ? staffId : null,
  })

  // 🔥 INVENTORY DEDUCTION: Automatically deduct stock when order is completed
  // Non-blocking (payments.md): la venta cobrada nunca se revierte por
  // inventario — el fallo viaja como aviso + 🚨 log, y QUANTITY llega a negativo
  // en la fuente. (El comentario anterior decía "Fail payment if inventory
  // deduction fails (Shopify, Square, Toast)" — falso: Square hace lo opuesto.)
  // 🔴 `!settledBeforeThisPayment`: la mercancía de una orden ya saldada salió
  // con el PRIMER cobro — repetir el loop la descontaba dos veces (audit Codex).
  if (isFullyPaid && !settledBeforeThisPayment && !options?.areaTicketAlreadyFinalized) {
    const deductionErrors: Array<{ productId: string; productName: string; requested: number; error: string }> = []
    // Items cuya deducción SÍ se aplicó — se QUEDAN deducidos aunque otro item
    // falle (se vendieron); van al log/ActivityLog como contexto del drift.
    const deductedItems: Array<{ productId: string; quantity: number }> = []

    // 🔴 Posting durable (fase 2, atomizado en la 3.5): el vale YA nació en la
    // transacción que marcó la orden PAID (arriba) — aquí sólo se RECLAMA para
    // deducir: se leen sus líneas y se marca APPLYING. Cada línea se marca
    // APPLIED/FAILED conforme el loop avanza, así el sweeper sólo reintenta lo
    // que quedó pendiente y nunca re-deduce lo ya aplicado. El loop de abajo NO
    // se toca: lo comparten 8 features del cobro y está probado en producción.
    let tpvPostingLines = new Map<string, string>()
    try {
      if (tpvPostingId) {
        const lines = await prisma.inventoryPostingLine.findMany({ where: { postingId: tpvPostingId } })
        tpvPostingLines = new Map(lines.map(l => [l.effectKey, l.id]))
        await prisma.inventoryPosting.updateMany({
          where: { id: tpvPostingId, status: 'PENDING' },
          data: { status: 'APPLYING', attempts: { increment: 1 } },
        })
      }
    } catch (postingError: any) {
      // El posting es OBSERVABILIDAD durable: si falla, la deducción sigue igual
      // que antes de la fase 2 — jamás puede impedir que la mercancía se descuente.
      logger.error('[InventoryPosting] No se pudo registrar el posting del cobro TPV (la deducción continúa)', {
        orderId,
        error: postingError?.message,
      })
    }

    logger.info('🎯 Starting inventory deduction for completed order', {
      orderId,
      venueId: updatedOrder.venueId,
      itemCount: updatedOrder.items.length,
    })

    // Deduct stock for each product in the order
    for (const item of updatedOrder.items) {
      if (item.areaTicketLineId && coveredAreaTicketLines.has(item.areaTicketLineId)) {
        logger.info('⏭️ Skipping generic deduction for area-ticket line covered by reservation', {
          orderId,
          orderItemId: item.id,
          areaTicketLineId: item.areaTicketLineId,
        })
        continue
      }

      // Skip items where product was deleted (Toast/Square pattern)
      if (!item.productId) {
        // ⚠️ SERIALIZED INVENTORY: Check if this is a serialized item before skipping
        // Serialized items have productId=null but productSku contains the serial number
        if (item.productSku) {
          try {
            logger.info('📦 Marking serialized item as SOLD', {
              orderId,
              orderItemId: item.id,
              serialNumber: item.productSku,
              productName: item.productName,
            })
            // Plan §1.5 — pass staffId so the custody precheck logs WARN-mode
            // violations even at payment-post-hook. The order createdById is
            // the promoter who rang the sale. We intentionally wrap in
            // try/catch (already here) so ENFORCE mode does not break payment
            // completion — the scan/sell precheck is the primary gate.
            await serializedInventoryService.markAsSold(updatedOrder.venueId, item.productSku, item.id, undefined, {
              staffId: updatedOrder.createdById ?? staffId,
            })
            logger.info('✅ Serialized item marked as SOLD', {
              orderId,
              serialNumber: item.productSku,
            })
          } catch (markAsSoldError: any) {
            logger.error('❌ Failed to mark serialized item as SOLD', {
              orderId,
              orderItemId: item.id,
              serialNumber: item.productSku,
              error: markAsSoldError.message,
            })
            // Don't fail the payment if marking as sold fails
            // Item will remain in AVAILABLE status and can be manually corrected
          }
        } else {
          logger.info('⏭️ Skipping inventory deduction for deleted product', {
            orderId,
            productName: item.productName,
          })
        }
        continue
      }

      try {
        // ✅ Transform order item modifiers to inventory format
        // Skip modifiers where the modifier was deleted (Toast/Square pattern)
        const orderModifiers: OrderModifierForInventory[] =
          item.modifiers
            ?.filter(m => m.modifier)
            .map(m => ({
              quantity: m.quantity,
              modifier: {
                id: m.modifier!.id,
                name: m.modifier!.name,
                groupId: m.modifier!.groupId,
                rawMaterialId: m.modifier!.rawMaterialId,
                quantityPerUnit: m.modifier!.quantityPerUnit,
                unit: m.modifier!.unit,
                inventoryMode: m.modifier!.inventoryMode,
              },
            })) || []

        // Venta por peso: weighted lines deduct the weighed kilos (quantity is
        // always 1 on them); the same effective quantity feeds the compensation
        // restock below so a rollback returns exactly what was deducted.
        const effectiveQuantity = item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity
        const tpvLineId = tpvPostingLines.get(item.id)
        await deductInventoryForProduct(
          updatedOrder.venueId,
          item.productId,
          effectiveQuantity,
          orderId,
          staffId, // staffId for tracking who processed the order
          orderModifiers,
          tpvLineId ? { postingLineId: tpvLineId } : undefined,
        )

        // Línea aplicada: el sweeper ya no la reintenta. Fire-and-forget — el
        // estado del posting nunca puede tumbar un cobro ya registrado.
        if (tpvLineId) {
          void prisma.inventoryPostingLine
            .update({
              where: { id: tpvLineId },
              data: { status: 'APPLIED', appliedQuantityBase: new Prisma.Decimal(effectiveQuantity) },
            })
            .catch(() => undefined)
        }

        deductedItems.push({ productId: item.productId, quantity: effectiveQuantity })

        logger.info('✅ Stock deducted successfully for product', {
          orderId,
          productId: item.productId,
          productName: item.product?.name || item.productName,
          quantity: item.quantity,
          modifiersCount: orderModifiers.length,
        })
      } catch (deductionError: any) {
        // Collect errors instead of swallowing them
        //
        // La rama CONCURRENT_TRANSACTION antes buscaba SOLO el texto
        // 'could not obtain lock', que Prisma nunca emite: en un deadlock manda
        // 'Transaction failed due to a write conflict or a deadlock' con code
        // P2034. Los 9 eventos del 17-18 jul 2026 (Mindform) cayeron por eso en
        // 'UNKNOWN' y nos dejaron sin diagnóstico — parecían recetas mal
        // configuradas cuando eran colisiones de concurrencia.
        //
        // Ahora se detectan por CÓDIGO (isRetryableDbError), no por texto, más
        // el ConflictError que deductStockFIFO lanza cuando agota sus reintentos.
        // ⚠️ Esto solo corrige la ETIQUETA para poder diagnosticar: el
        // comportamiento no cambia — abajo, todo lo que no sea NO_RECIPE sigue
        // tumbando la orden, a propósito.
        const errorReason = deductionError.message.includes('does not have a recipe')
          ? 'NO_RECIPE'
          : deductionError.message.includes('Insufficient stock')
            ? 'INSUFFICIENT_STOCK'
            : isRetryableDbError(deductionError) ||
                deductionError.message.includes('could not obtain lock') ||
                deductionError.message.includes('Conflicto de concurrencia persistente')
              ? 'CONCURRENT_TRANSACTION'
              : 'UNKNOWN'

        // Línea fallida: queda FAILED para que el sweeper la reintente sola.
        const failedLineId = tpvPostingLines.get(item.id)
        if (failedLineId) {
          void prisma.inventoryPostingLine
            .update({ where: { id: failedLineId }, data: { status: 'FAILED', reason: deductionError.message } })
            .catch(() => undefined)
        }

        logger.error('❌ Failed to deduct stock for product', {
          orderId,
          productId: item.productId,
          productName: item.product?.name || item.productName,
          quantity: item.quantity,
          error: deductionError.message,
          reason: errorReason,
        })

        // Solo NO_RECIPE es benigno (producto sin receta/tracking de inventario).
        // Cualquier otro error — incluido UNKNOWN (p.ej. unidades incompatibles
        // por una receta mal configurada) — debe fallar la orden: tragarlo en
        // silencio dejaba ventas completadas SIN deducción de stock.
        if (errorReason !== 'NO_RECIPE') {
          deductionErrors.push({
            productId: item.productId!,
            productName: item.product?.name || item.productName || 'Unknown',
            requested: item.weightQuantity != null ? Number(item.weightQuantity) : item.quantity,
            error: deductionError.message,
          })

          logAction({
            staffId,
            venueId: updatedOrder.venueId,
            action: 'INVENTORY_DEDUCTION_FAILED',
            entity: 'Order',
            entityId: orderId,
            data: {
              source: 'TPV',
              productId: item.productId,
              productName: item.product?.name || item.productName || 'Unknown',
              quantity: item.quantity,
              reason: errorReason,
              error: deductionError.message,
            },
          })
        }
      }
    }

    // Estado final del posting: APPLIED si todo aplicó, PARTIAL_FAILED si algo
    // quedó pendiente (el sweeper lo recoge). Cercado por el claim APPLYING para
    // no pisar a otro worker.
    if (tpvPostingId) {
      void prisma.inventoryPosting
        .updateMany({
          where: { id: tpvPostingId, status: 'APPLYING' },
          data:
            deductionErrors.length > 0
              ? { status: 'PARTIAL_FAILED', lastError: deductionErrors[0]?.error ?? 'línea fallida' }
              : { status: 'APPLIED', appliedAt: new Date(), lastError: null },
        })
        .catch(() => undefined)
    }

    // ✅ FIX: Rollback order if ANY critical inventory deduction failed
    if (deductionErrors.length > 0) {
      deductionFailed = true
      // 🔴 La venta cobrada SE QUEDA CERRADA (decisión founder+Claude 2026-08-12,
      // espejo de Square y de la regla escrita en payments.md: "Non-blocking:
      // payment succeeds even if deduction fails"). Antes este bloque restauraba
      // lo ya deducido, regresaba los seriales a AVAILABLE y revertía la orden a
      // PENDING/PARTIAL — con el cliente ya pagado y en la puerta: cuenta abierta,
      // sin lealtad/cupones, y CERO señal en inventario. Revertir la orden no
      // des-vende nada; sólo hace que el registro mienta.
      //
      // Con QUANTITY yendo a negativo en la fuente, lo que cae aquí son fallos de
      // receta (FIFO/unidades), deadlocks agotados y errores de configuración: el
      // faltante queda como drift para conciliación — igual que ya lo hace el
      // flujo de carrito libre en order.tpv.service.ts ("We do NOT throw — the
      // order is closed, customer is happy").
      const errorDetails = deductionErrors.map(e => `${e.productName}: ${e.error}`).join('; ')

      // Resumen a nivel orden. El detalle POR ITEM ya se auditó arriba con
      // INVENTORY_DEDUCTION_FAILED en cada catch — nombre distinto a propósito
      // para no duplicar entradas en la bitácora.
      logAction({
        staffId,
        venueId: updatedOrder.venueId,
        action: 'INVENTORY_DEDUCTION_INCOMPLETE',
        entity: 'Order',
        entityId: orderId,
        data: {
          source: 'TPV',
          failedProducts: deductionErrors,
          // Lo ya deducido se QUEDA deducido: esos items sí se vendieron.
          keptDeducted: deductedItems,
          orderStatus: 'COMPLETED',
        },
      })

      // 🚨 Segunda puerta del MISMO doble cobro: este bloque corre con el Payment
      // ya comiteado, así que no puede lanzar. 🚨 token estable de Better Stack —
      // NO renombrar.
      logger.error('🚨 [Inventario] La deducción de stock falló DESPUÉS de registrar el cobro — el pago se conserva, requiere revisión', {
        orderId,
        venueId: updatedOrder.venueId,
        paymentId: currentPaymentId ?? null,
        staffId: staffId ?? null,
        stage: 'DEDUCTION',
        failedProducts: deductionErrors,
        keptDeducted: deductedItems,
        errorDetails,
      })

      for (const failed of deductionErrors) {
        inventoryIssues.push({
          productId: failed.productId,
          productName: failed.productName,
          requested: failed.requested,
          available: null,
          reason: failed.error,
        })
      }

      // SIN `return`: la venta quedó completa, así que cupones, referidos,
      // lealtad y la liberación de la mesa corren igual que en cualquier otro
      // cobro. El aviso viaja en el retorno final de la función.
    } else {
      logger.info('🎯 Inventory deduction completed successfully for order', {
        orderId,
        totalItems: updatedOrder.items.length,
      })
    }
  }

  // Efectos del settlement, independientes del modo de inventario. Los vales
  // por área ya consumieron inventario dentro de su transacción, pero también
  // deben redimir cupones, calificar referidos y acreditar lealtad. Antes esos
  // tres hooks vivían dentro del `!areaTicketAlreadyFinalized` y nunca corrían.
  if (isFullyPaid && !settledBeforeThisPayment) {
    try {
      await finalizeCouponsForOrder(updatedOrder.venueId, orderId)
    } catch (couponError: any) {
      logger.error('⚠️ Failed to finalize coupons (payment still succeeded)', { orderId, error: couponError.message })
    }

    if (!options?.committedSettlement) {
      try {
        const { onOrderPaid } = await import('@/services/referrals/referralQualification.service')
        await onOrderPaid({ orderId: updatedOrder.id, venueId: updatedOrder.venueId })
      } catch (err) {
        console.error('[referral hook] onOrderPaid failed for order', updatedOrder.id, err)
      }
    }

    await awardLoyaltyForPaidOrder({
      venueId: updatedOrder.venueId,
      orderId,
      orderTotal: Math.max(0, newTotal - totalTip),
      staffId,
      legacyCustomer: order.customer
        ? { id: order.customer.id, firstName: order.customer.firstName, lastName: order.customer.lastName }
        : null,
    })
  }

  // 🪑 Liberar la mesa si ésta era su última cuenta viva.
  //
  // Va en try/catch porque el estado del plano es bookkeeping — jamás puede
  // tumbar un cobro que el banco ya aprobó. (Antes también dependía de que la
  // deducción no hubiera revertido la orden; desde 2026-08-12 la venta cobrada
  // nunca se revierte por inventario, así que la mesa se libera siempre.)
  //
  // Antes esto lo hacía SOLO el cliente (`finishTableAfterPayment` → HTTP
  // directo). Sin red, con la app matada, o cobrando desde otro dispositivo, la
  // mesa se quedaba OCCUPIED sin cuenta: imposible de abrir, anular o liberar.
  if (isFullyPaid && !isAreaTicketOrder && updatedOrder.tableId) {
    try {
      await tableService.releaseTableIfSettled(updatedOrder.venueId, updatedOrder.tableId)
    } catch (error) {
      logger.error('⚠️ No se pudo liberar la mesa tras el cobro (el pago NO se ve afectado)', {
        orderId,
        tableId: updatedOrder.tableId,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // Todo faltante —del pre-flight o de la deducción misma— viaja como aviso.
  // `inventoryDeducted: false` sólo cuando la deducción real falló: el cajero
  // ve el problema, pero la venta cobrada nunca se revierte por inventario.
  return inventoryIssues.length > 0 ? buildInventoryWarning(inventoryIssues, !deductionFailed) : null
}

/**
 * Fase 0 (turno de caja del negocio): vuelve a correr, sin cobro nuevo, la misma transacción del
 * camino de cobro que marca una orden como pagada. Sirve para las órdenes cuyos cobros ya la
 * cubren pero se quedaron CONFIRMED/PENDING (caso semilla ORD-1788276418170: el Payment quedó
 * COMPLETED y la transición a PAID nunca aterrizó). Con `paymentAmount = 0` y sin
 * `currentPaymentId`, `totalPaid` es la suma de TODOS los COMPLETED, así que si cubren la base la
 * orden pasa a PAID/COMPLETED; si no la cubren, queda como estaba (PARTIAL).
 *
 * 🔴 QUÉ HACE Y QUÉ NO. Reejecutar el camino del cobro NO es inocuo, y quien llame a esto desde un
 * barrido tiene que saber exactamente qué toca.
 *
 * NO ocurre nada de esto: sin cobro nuevo, `settledBeforeThisPayment` coincide con `isFullyPaid` en
 * cuanto la orden tenga al menos un `Payment`, y con él `debeRegistrarPosting` queda en false — así
 * que no nace vale de inventario (`createSalePostingInTx`), no se deduce stock, no se acredita
 * lealtad (`awardLoyaltyForPaidOrder`), no se finalizan cupones (`finalizeCouponsForOrder`) ni se
 * califica el referido (`onOrderPaid`). Única excepción: una cuenta saldada SIN un solo `Payment`
 * (cortesía total, base 0) sí los dispara — por eso el criterio del barrido
 * (`shared/pagadaPeroAbierta.ts`) exige un cobro positivo.
 *
 * SÍ ocurre, y se acepta a propósito porque son los efectos del cobro en vivo:
 *   1. `completedAt` se (re)estampa con la hora de ESTA corrida (~L788): la orden queda fechada
 *      cuando se reconcilió, no cuando se cobró — y una que ya estuviera COMPLETED pierde su fecha.
 *   2. `tipAmount` y `total` se REESCRIBEN desde los cobros (~L778 y ~L780): si la propina
 *      registrada en la orden no coincide con la de sus `Payment`, gana la de los pagos.
 *   3. La mesa se libera (`releaseTableIfSettled`, ~L1200) si la orden quedó saldada, no es un vale
 *      por área y tiene mesa.
 *   4. Si los cobros SUPERAN la cuenta, salen el `🚨 [Sobrepago]` (~L586) y una fila
 *      `SOBREPAGO_DETECTADO` de `ActivityLog` (~L600), las dos con `paymentId: null` y
 *      `staffId: null` porque no las hizo una persona. Y si la orden trae reembolsos, sale el
 *      `⚠️ [Reembolso]` con `channel: 'recordOrderPayment'` (~L500-503) — ahí `channel` nombra el
 *      CAMINO que se reejecutó, no a quien llamó.
 */
export async function reconcileOrderFromPayments(orderId: string): Promise<{ orderId: string; warning: OrderInventoryWarning | null }> {
  const warning = await updateOrderTotalsForStandalonePayment(orderId, 0, 0, undefined, undefined)
  return { orderId, warning }
}

interface PaymentFilters {
  fromDate?: string
  toDate?: string
  staffId?: string
}

interface PaginationResponse<T> {
  data: T[]
  meta: {
    totalCount: number
    pageSize: number
    currentPage: number
    totalPages: number
    hasNextPage: boolean
    hasPrevPage: boolean
    diagnostics?: any
  }
}

interface PaymentHistoryItem extends Payment {
  refundedAmount?: string | null
  isFullyRefunded?: boolean
}

/**
 * Validate staff and venue relationship using staffId
 * @param staffId Staff ID to validate
 * @param venueId Venue ID to validate against
 * @param userId Fallback user ID if staffId is not provided
 * @returns Validated staff ID
 */
export async function validateStaffVenue(staffId: string | undefined, venueId: string, userId?: string): Promise<string | undefined> {
  return validateStaffVenueShared(staffId, venueId, userId)
}

/**
 * Get payments for a venue with pagination and filtering
 * @param orgId Organization ID (for future authorization)
 * @param venueId Venue ID
 * @param pageSize Number of items per page
 * @param pageNumber Page number
 * @param filters Filter options
 * @returns Paginated payment results
 */
export async function getPayments(
  venueId: string,
  pageSize: number,
  pageNumber: number,
  filters: PaymentFilters = {},
  _orgId?: string,
): Promise<PaginationResponse<PaymentHistoryItem>> {
  const { fromDate, toDate, staffId } = filters

  // Build the query filters
  const whereClause: any = {
    venueId: venueId,
  }

  // Add date range filters if provided using standardized datetime utility
  if (fromDate || toDate) {
    try {
      // Use parseDateRange with no default (throws error if dates are invalid)
      const dateRange = parseDateRange(fromDate, toDate, 0)
      whereClause.createdAt = {
        gte: dateRange.from,
        lte: dateRange.to,
      }
    } catch (error) {
      throw new BadRequestError(`Invalid date range: ${error instanceof Error ? error.message : 'Unknown error'}`)
    }
  }

  // Handle staff filter (staffId maps to processedById in new schema)
  if (staffId) {
    // Check if the staff member exists in the venue
    const staffMember = await prisma.staff.findFirst({
      where: {
        id: staffId,
        venues: {
          some: {
            venueId: venueId,
          },
        },
      },
    })

    if (!staffMember) {
      logger.warn(`Staff member with ID ${staffId} not found for venue ${venueId}`)
      throw new NotFoundError(`Staff member with ID ${staffId} not found for this venue`)
    }

    whereClause.processedById = staffId
  }

  // Calculate pagination values
  const skip = (pageNumber - 1) * pageSize

  // Check total payments for venue for diagnostics
  const totalVenuePayments = await prisma.payment.count({
    where: { venueId },
  })

  // Execute the query with pagination
  const [payments, totalCount] = await prisma.$transaction([
    prisma.payment.findMany({
      where: whereClause,
      include: {
        processedBy: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
          },
        },
        order: {
          select: {
            id: true,
            orderNumber: true,
            status: true,
            total: true,
            table: true,
          },
        },
        // Include allocations for tip information
        allocations: {
          select: {
            id: true,
            amount: true,
            orderItem: {
              select: {
                id: true,
                product: {
                  select: {
                    name: true,
                  },
                },
              },
            },
          },
        },
      },
      orderBy: {
        createdAt: 'desc',
      },
      skip,
      take: pageSize,
    }),
    prisma.payment.count({
      where: whereClause,
    }),
  ])

  // Calculate pagination metadata
  const totalPages = Math.ceil(totalCount / pageSize)

  const paymentsWithRefundMeta: PaymentHistoryItem[] = payments.map(payment => {
    const processorData = (payment.processorData as Record<string, unknown>) || {}
    const refundedRaw = processorData.refundedAmount

    let refundedAmount: number | null = null
    if (typeof refundedRaw === 'number') {
      refundedAmount = refundedRaw
    } else if (typeof refundedRaw === 'string' && refundedRaw.trim() !== '') {
      const parsed = parseFloat(refundedRaw)
      refundedAmount = Number.isNaN(parsed) ? null : parsed
    }

    const amountValue = parseFloat(payment.amount.toString())
    const tipValue = parseFloat(payment.tipAmount?.toString() || '0')
    const totalOriginalAmount = amountValue + tipValue
    const isFullyRefunded = refundedAmount != null && totalOriginalAmount > 0 ? refundedAmount >= totalOriginalAmount : false

    return {
      ...payment,
      refundedAmount: refundedAmount != null ? refundedAmount.toString() : null,
      isFullyRefunded,
    }
  })

  const response: PaginationResponse<PaymentHistoryItem> = {
    data: paymentsWithRefundMeta,
    meta: {
      totalCount,
      pageSize,
      currentPage: pageNumber,
      totalPages,
      hasNextPage: pageNumber < totalPages,
      hasPrevPage: pageNumber > 1,
    },
  }

  // Add diagnostic information if no results
  if (totalCount === 0) {
    const diagnosticInfo: any = {
      venueExists: (await prisma.venue.findUnique({ where: { id: venueId } })) !== null,
      totalVenuePayments,
      filters: {
        dateRange: fromDate || toDate ? true : false,
        staffId: staffId ? true : false,
      },
    }

    // Try to get the most recent payment for this venue
    const latestPayment = await prisma.payment.findFirst({
      where: { venueId },
      orderBy: { createdAt: 'desc' },
      select: { id: true, createdAt: true, processedById: true },
    })

    if (latestPayment) {
      diagnosticInfo.latestPaymentDate = latestPayment.createdAt
    }

    response.meta.diagnostics = diagnosticInfo
  }

  return response
}

/**
 * Interface for payment creation data
 */
interface PaymentCreationData {
  venueId: string
  amount: number // Amount in cents
  tip: number // Tip in cents
  status: 'COMPLETED' | 'PENDING' | 'FAILED' | 'PROCESSING' | 'REFUNDED'
  // Ausente SÓLO cuando viaja `tenderTypeId`: ahí el método fiscal lo resuelve el
  // server desde la revisión congelada del catálogo. El schema exige exactamente uno
  // de los dos, así que un payload sin ninguno nunca llega hasta aquí.
  method?: 'CASH' | 'CREDIT_CARD' | 'DEBIT_CARD' | 'DIGITAL_WALLET' | 'BANK_TRANSFER' | 'OTHER'
  // Referencia al tipo de pago del negocio. Sólo la referencia: la semántica de dinero
  // (comisión, cajón, forma SAT) la congela el server desde `VenueTenderTypeRevision`.
  tenderTypeId?: string
  tenderRevision?: number
  // Sólo la cola de reintentos del POS. Honra la revisión que el cajero vio al cobrar:
  // una venta ya ocurrida no se rechaza porque el catálogo cambió después.
  isOfflineReplay?: boolean
  // Detalle del cobro declarado a mano ("Tarjeta (terminal externa)"). Sólo aplica a
  // métodos que NO pasaron por Avoqado; en efectivo va null. iOS manda null explícito.
  externalSource?: string | null
  source: string
  splitType: 'PERPRODUCT' | 'EQUALPARTS' | 'CUSTOMAMOUNT' | 'FULLPAYMENT'
  tpvId: string
  staffId: string
  paidProductsId: string[]

  // 🔴 El CLIENTE de la venta rápida. Opcional/aditivo: los POS que no lo mandan se
  // comportan exactamente igual que antes. Un id inválido NUNCA rechaza el cobro — ver
  // `fastPaymentCustomer.ts` para el porqué completo.
  customerId?: string | null

  // Snapshot de MERCHANT_ROUTING_RULES evaluado por la TPV para este cobro
  // (auditoría). Opcional — APKs viejos no lo envían.
  routingEvaluation?: Prisma.InputJsonValue

  // Card payment fields
  cardBrand?: string
  last4?: string
  typeOfCard?: 'CREDIT' | 'DEBIT'
  currency: string
  bank?: string

  // Menta integration fields
  mentaAuthorizationReference?: string
  mentaOperationId?: string
  mentaTicketId?: string
  token?: string
  isInternational: boolean
  issuerCountryCode?: string
  issuerCountrySource?: ClientCountryEvidenceSource

  // Additional fields
  reviewRating?: string

  // Enhanced payment tracking fields (from new database migration)
  authorizationNumber?: string
  referenceNumber?: string
  maskedPan?: string
  entryMode?: string

  // ⭐ Provider-agnostic merchant account tracking (2025-01-10)
  merchantAccountId?: string // Primary: Structured merchant account ID
  blumonSerialNumber?: string // Legacy: Blumon-specific serial number (deprecated)

  // Split payment specific fields
  equalPartsPartySize?: number
  equalPartsPayedFor?: number

  // 🔧 PRE-payment verification fields (generated ONCE when entering verification screen)
  // orderReference ensures photos match order number (FAST-{timestamp} or ORD-{number})
  orderReference?: string

  // Firebase Storage URLs of verification photos (uploaded before payment)
  verificationPhotos?: string[]

  // Scanned barcodes from verification screen
  verificationBarcodes?: string[]

  // 💸 Blumon Operation Number (2025-12-16)
  // Small integer from SDK response (response.operation) needed for CancelIcc refunds
  // This allows refunds to work WITHOUT waiting for Blumon webhook
  // Example: 12945658 (fits in number, unlike the 12-digit referenceNumber string)
  blumonOperationNumber?: number

  // ⭐ Device Serial Number for Terminal attribution (2026-01-08)
  // Links payment to the Terminal that processed it (for device-based reporting)
  // This is the Terminal.serialNumber (e.g., "AVQD-2841548417"), NOT blumonSerialNumber
  deviceSerialNumber?: string
  /**
   * S0 (P1-2, Codex): serial de la terminal AUTENTICADA (JWT). Lo pone SIEMPRE el controlador de la TPV; el body no
   * puede decidirlo. Es el que arbitra a qué solicitud POS→terminal pertenece este registro.
   */
  authenticatedTerminalSerial?: string | null
  /**
   * S2: quién registra. 'webhook' = el Payment nace del webhook de AngelPay por el vínculo S1: método PROVISIONAL
   * (el REST lo cierra, S3) y costo PENDIENTE durable (efecto TRANSACTION_COST). Sólo lo pone el servidor.
   */
  registradoVia?: 'terminal' | 'webhook'

  // 🛡️ Idempotency key (2026-04-08) - Stripe/Square/Toast pattern
  // Client-generated UUID v4 sent ONCE per logical payment attempt and reused
  // on every retry. Backend deduplicates atomically via the unique index
  // (venueId, idempotencyKey) in the Payment table.
  //
  // Backwards compatible: optional. TPV versions < v1.10.10 do not send it,
  // and those requests fall back to the legacy referenceNumber-based check.
  idempotencyKey?: string
  // POS→TPV arbitration link (the POS-generated requestId). When present, this
  // Payment's creation closes the TerminalPaymentRequest row + frees the
  // terminal slot atomically. Optional/additive; old TPVs omit it.
  terminalPaymentRequestId?: string
  /**
   * Codex R3 (P1-3): el slot (PRIMARY/SECONDARY/TERTIARY) que la afiliación acreditada ocupa HOY en la configuración del
   * venue, CONGELADO al cobrar. Si mañana retiran esa afiliación de la configuración, el costo se calcula con la tarifa
   * contratada entonces, no con la de otra afiliación. Lo resuelve el registrador; el cuerpo no lo decide.
   */
  pricingSlot?: 'PRIMARY' | 'SECONDARY' | 'TERTIARY' | null
  /** Codex R4-3: las tarifas (proveedor y negocio) vigentes al cobrar para la afiliación acreditada — congeladas en `processorData.pricing`. */
  pricing?: TarifaCongelada | null
}

/**
 * Shadow-only issuer-country decision. Cash/manual/external methods have no card
 * issuer to classify and therefore keep the new Payment fields null.
 */
function classifyPaymentInternationalityShadow(paymentData: PaymentCreationData): CardInternationalityDecision | null {
  if (paymentData.method !== 'CREDIT_CARD' && paymentData.method !== 'DEBIT_CARD') return null

  return classifyCardInternationality({
    issuerCountryCode: paymentData.issuerCountryCode,
    issuerCountrySource: paymentData.issuerCountrySource,
    maskedPan: paymentData.maskedPan,
    legacyIsInternational: paymentData.isInternational,
  })
}

function logPaymentInternationalityShadow(
  paymentId: string,
  legacyIsInternational: boolean,
  decision: CardInternationalityDecision | null,
): void {
  if (!decision) return

  logger.info('[CardInternationality][shadow] Classification recorded; financial behavior unchanged', {
    paymentId,
    shadowMode: true,
    status: decision.status,
    source: decision.source,
    reasonCode: decision.reasonCode,
    classificationVersion: decision.classificationVersion,
    legacyIsInternational,
    legacyComparison: decision.legacyComparison,
    registryMatched: decision.registryMatched,
  })
}

/**
 * ⭐ Helper: Resolve Blumon serial number to merchant account ID
 *
 * **Purpose:** Backward compatibility for old Android clients that send only `blumonSerialNumber`
 *
 * **Logic:**
 * 1. Find MerchantAccount where blumonSerialNumber matches
 * 2. Verify it's configured for the given venue
 * 3. Return merchant account ID or undefined
 *
 * **Example:**
 * ```typescript
 * const merchantId = await resolveBlumonSerialToMerchantId('venue_123', '2841548417')
 * // Returns: 'cuid_abc123' (MerchantAccount.id)
 * ```
 *
 * @param venueId Venue ID to scope the search
 * @param blumonSerialNumber Blumon serial number (e.g., "2841548417")
 * @returns MerchantAccount ID or undefined if not found
 */
async function resolveBlumonSerialToMerchantId(venueId: string, blumonSerialNumber: string): Promise<string | undefined> {
  try {
    return await buscarAfiliacionPorSerial(venueId, blumonSerialNumber)
  } catch (error) {
    logger.error(`Error resolving blumonSerialNumber ${blumonSerialNumber}:`, error)
    return undefined
  }
}

/**
 * Codex R6-1: la búsqueda por serial que PROPAGA los errores. Un fallo de la base no es «no hay afiliación»: leído así, el
 * registrador deduplicaba y registraba con otra identidad y un replay podía nacer como segunda venta.
 */
async function buscarAfiliacionPorSerial(venueId: string, blumonSerialNumber: string): Promise<string | undefined> {
  {
    // 1. Check venue-level configs
    const merchant = await prisma.merchantAccount.findFirst({
      where: {
        blumonSerialNumber,
        OR: [
          { venueConfigsPrimary: { some: { venueId } } },
          { venueConfigsSecondary: { some: { venueId } } },
          { venueConfigsTertiary: { some: { venueId } } },
        ],
      },
    })

    if (merchant) {
      logger.info(`Resolved blumonSerialNumber ${blumonSerialNumber} → merchantAccountId ${merchant.id} (venue config)`)
      return merchant.id
    }

    // 2. Fallback: check org-level configs via inheritance
    const venue = await prisma.venue.findUnique({
      where: { id: venueId },
      select: { organizationId: true },
    })

    if (venue?.organizationId) {
      const orgMerchant = await prisma.merchantAccount.findFirst({
        where: {
          blumonSerialNumber,
          OR: [
            { orgConfigsPrimary: { some: { organizationId: venue.organizationId } } },
            { orgConfigsSecondary: { some: { organizationId: venue.organizationId } } },
            { orgConfigsTertiary: { some: { organizationId: venue.organizationId } } },
          ],
        },
      })

      if (orgMerchant) {
        logger.info(`Resolved blumonSerialNumber ${blumonSerialNumber} → merchantAccountId ${orgMerchant.id} (org config)`)
        return orgMerchant.id
      }
    }

    logger.warn(`Could not resolve blumonSerialNumber ${blumonSerialNumber} for venue ${venueId}`)
    return undefined
  }
}

/** Codex R6-1: la afiliación con la que se deduplica, se consolida y se registra — UNA sola, resuelta ANTES de todo. */
type AfiliacionDelCobro = {
  /** La afiliación DEFINITIVA (undefined = sin afiliación resoluble: TIER-3, o cobro sin afiliación). */
  merchantAccountId: string | undefined
  /** Lo que mandó el APK, conservado como evidencia cuando difiere de la definitiva. */
  merchantAccountIdDelApk: string | undefined
  via: 'DIRECTA' | 'POR_SERIAL' | 'RECUPERADA_POR_SERIAL' | 'INACTIVA_ACREDITADA_POR_WEBHOOK' | 'SIN_RESOLVER' | 'SIN_AFILIACION'
}

/**
 * Codex R6-1: la identidad de afiliación se resuelve UNA vez y ANTES de la deduplicación por referencia — no después.
 * Antes, la búsqueda del duplicado filtraba con el `merchantAccountId` que mandó el APK mientras el registro se guardaba con
 * el recuperado por serial (TIER-2): el replay legacy (misma referencia, sin llave) no encontraba su propio Payment y nacía
 * una SEGUNDA venta por la misma autorización. Prioridad: (1) el id del APK si existe y está activo; (2) el serial del
 * procesador (`blumonSerialNumber`), fuente de verdad, para un id inexistente o inactivo; (3) sin resolver ⇒ sin afiliación,
 * con contexto para conciliar. Una afiliación inactiva la conserva SÓLO el webhook firmado del propio merchant (Codex R1 P1-3).
 * Un fallo de la base al resolver NO es ausencia: es incierto ⇒ 503 reintentable (la terminal reenvía el mismo cobro).
 */
async function resolverAfiliacionDelCobro(
  etiqueta: string,
  venueId: string,
  orderId: string | null,
  paymentData: {
    merchantAccountId?: string
    blumonSerialNumber?: string
    registradoVia?: string
    authorizationNumber?: string
    referenceNumber?: string
  },
): Promise<AfiliacionDelCobro> {
  const delApk = paymentData.merchantAccountId || undefined
  const serial = paymentData.blumonSerialNumber || undefined
  const contexto = { venueId, orderId, providedMerchantId: delApk, blumonSerialNumber: serial }
  try {
    let merchantAccountId = delApk
    let via: AfiliacionDelCobro['via'] = delApk ? 'DIRECTA' : 'SIN_AFILIACION'
    if (!merchantAccountId && serial) {
      logger.info(`🔄 [${etiqueta}] Resolving legacy blumonSerialNumber: ${serial}`)
      merchantAccountId = await buscarAfiliacionPorSerial(venueId, serial)
      via = merchantAccountId ? 'POR_SERIAL' : 'SIN_RESOLVER'
    }
    if (merchantAccountId) {
      const merchantExists = await prisma.merchantAccount.findUnique({
        where: { id: merchantAccountId },
        select: { id: true, active: true },
      })
      if (!merchantExists) {
        logger.error(`❌ [${etiqueta}] MerchantAccount not found: ${merchantAccountId}`, {
          ...contexto,
          hint: 'Android may have stale config. Attempting TIER 2 recovery from blumonSerialNumber.',
        })
        const recuperada = serial ? await buscarAfiliacionPorSerial(venueId, serial) : undefined
        if (recuperada) {
          logger.info(`✅ [${etiqueta}] TIER 2 Recovery SUCCESS: Inferred merchant from blumonSerialNumber`, {
            ...contexto,
            recoveredMerchantId: recuperada,
          })
          merchantAccountId = recuperada
          via = 'RECUPERADA_POR_SERIAL'
        } else {
          logger.error(`❌ [${etiqueta}] TIER 3: Cannot resolve merchant - reconciliation required`, {
            ...contexto,
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
          })
          merchantAccountId = undefined
          via = 'SIN_RESOLVER'
        }
      } else if (!merchantExists.active && paymentData.registradoVia === 'webhook') {
        // Codex R1 (P1-3): la afiliación la acredita el webhook FIRMADO del propio merchant (así lo resolvió el secreto).
        // Desactivarla después no cambia por dónde pasó el dinero: se conserva para que costo y liquidación la respeten.
        logger.warn(
          `⚠️ [${etiqueta}] MerchantAccount ${merchantAccountId} está inactivo pero lo acredita el webhook — se conserva la afiliación`,
          contexto,
        )
        via = 'INACTIVA_ACREDITADA_POR_WEBHOOK'
      } else if (!merchantExists.active) {
        logger.warn(`⚠️ [${etiqueta}] MerchantAccount ${merchantAccountId} is inactive`, contexto)
        const recuperada = serial ? await buscarAfiliacionPorSerial(venueId, serial) : undefined
        if (recuperada && recuperada !== merchantAccountId) {
          logger.info(`✅ [${etiqueta}] TIER 2 Recovery: Found active merchant with same serial`, {
            ...contexto,
            recoveredMerchantId: recuperada,
          })
          merchantAccountId = recuperada
          via = 'RECUPERADA_POR_SERIAL'
        } else {
          merchantAccountId = undefined
          via = 'SIN_RESOLVER'
        }
      }
    }
    if (merchantAccountId) logger.info(`✅ [${etiqueta}] Payment will be attributed to merchantAccountId: ${merchantAccountId}`)
    else logger.warn(`⚠️ [${etiqueta}] No merchantAccountId - payment will have null merchant (legacy mode)`)
    return { merchantAccountId, merchantAccountIdDelApk: delApk, via }
  } catch (error) {
    logger.error(
      `🚨 [${etiqueta}] No se pudo resolver la afiliación del cobro — se rechaza con reintento, nunca se registra con otra identidad`,
      {
        ...contexto,
        error: error instanceof Error ? error.message : String(error),
      },
    )
    throw new RegistroNoResuelto('AFFILIATION_RESOLUTION_UNCERTAIN')
  }
}

/**
 * ⭐ Helper: Resolve Terminal ID from device serial number
 *
 * **Purpose:** Auto-link payments/orders to the Terminal that processed them
 * using the device's unique serial number (e.g., "AVQD-2841548417")
 *
 * **Logic:**
 * 1. Find Terminal by serialNumber (unique field)
 * 2. Verify it belongs to the venue (security)
 * 3. Return terminal.id for foreign key assignment
 *
 * **Example:**
 * ```typescript
 * const terminalId = await resolveTerminalIdFromSerial('venue_123', 'AVQD-2841548417')
 * // Returns: 'cmhtgsr3100gi9k1we6pyr777' (Terminal.id)
 * ```
 *
 * @param venueId Venue ID to validate ownership
 * @param deviceSerialNumber Terminal serial number (e.g., "AVQD-2841548417")
 * @returns Terminal ID or null if not found
 */
async function resolveTerminalIdFromSerial(venueId: string, deviceSerialNumber: string): Promise<string | null> {
  try {
    const terminal = await prisma.terminal.findFirst({
      where: {
        serialNumber: deviceSerialNumber,
        venueId, // Security: ensure terminal belongs to this venue
      },
      select: { id: true },
    })

    if (terminal) {
      logger.debug(`✅ Resolved deviceSerialNumber ${deviceSerialNumber} → terminalId ${terminal.id}`)
      return terminal.id
    }

    logger.warn(`⚠️ Could not resolve deviceSerialNumber ${deviceSerialNumber} for venue ${venueId}`)
    return null
  } catch (error) {
    logger.error(`❌ Error resolving deviceSerialNumber ${deviceSerialNumber}:`, error)
    return null
  }
}

/**
 * Record a payment for a specific order
 * @param venueId Venue ID
 * @param orderId Order ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment with order information
 */
async function markAreaTicketPaymentForReconciliation(input: {
  venueId: string
  sessionId: string
  attemptId: string
  paymentId: string
}): Promise<void> {
  await prisma.$transaction(async tx => {
    await tx.areaTicketPaymentAttempt.updateMany({
      where: { id: input.attemptId, checkoutSessionId: input.sessionId },
      data: {
        status: 'UNKNOWN',
        paymentId: input.paymentId,
        lastCheckedAt: new Date(),
      },
    })
    await tx.areaTicketCheckoutSession.updateMany({
      where: { id: input.sessionId, venueId: input.venueId },
      data: {
        status: 'RECONCILIATION_REQUIRED',
        activePaymentAttemptId: input.attemptId,
        version: { increment: 1 },
      },
    })
  })
}

async function finalizeCapturedAreaTicketPayment(input: {
  venueId: string
  orderId: string
  paymentId: string
  sessionId: string
  attemptId: string
  staffId?: string | null
}): Promise<'PAID' | 'PARTIALLY_PAID'> {
  const areaTicketPayment = await import('../mobile/areaTicketV7.mobile.service')
  const finalization = await prisma.$transaction(
    tx =>
      areaTicketPayment.finalizeAreaTicketPaymentInTransaction(tx, {
        venueId: input.venueId,
        orderId: input.orderId,
        paymentId: input.paymentId,
        // The transaction recomputes this from durable COMPLETED payments.
        fullyPaid: false,
        staffId: input.staffId ?? undefined,
        reconcileCapturedPayment: true,
        locked: { sessionId: input.sessionId, attemptId: input.attemptId },
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
  )
  return finalization.fullyPaid ? 'PAID' : 'PARTIALLY_PAID'
}

async function resumeCapturedAreaTicketPayment(
  venueId: string,
  orderId: string,
  payment: { id: string; processedById?: string | null },
  idempotencyKey?: string | null,
): Promise<'PAID' | 'PARTIALLY_PAID' | 'RECONCILIATION_REQUIRED' | null> {
  const session = await prisma.areaTicketCheckoutSession.findFirst({
    where: { venueId, orderId },
    select: { id: true, status: true, activePaymentAttemptId: true },
  })
  if (!session) return null

  const attempt = await prisma.areaTicketPaymentAttempt.findFirst({
    where: {
      checkoutSessionId: session.id,
      orderId,
      OR: [{ paymentId: payment.id }, ...(idempotencyKey ? [{ idempotencyKey }] : [])],
    },
    orderBy: { sequence: 'desc' },
  })
  if (!attempt) return session.status === 'PAID' ? 'PAID' : session.status === 'PARTIALLY_PAID' ? 'PARTIALLY_PAID' : null

  if (attempt.status === 'SUCCEEDED' && attempt.paymentId === payment.id) {
    if (session.status === 'PAID') return 'PAID'
    if (session.status === 'PARTIALLY_PAID') return 'PARTIALLY_PAID'
  }

  try {
    return await finalizeCapturedAreaTicketPayment({
      venueId,
      orderId,
      paymentId: payment.id,
      sessionId: session.id,
      attemptId: attempt.id,
      staffId: payment.processedById,
    })
  } catch (error) {
    await markAreaTicketPaymentForReconciliation({
      venueId,
      sessionId: session.id,
      attemptId: attempt.id,
      paymentId: payment.id,
    })
    logger.error('[AREA TICKETS v7] Reintento del pago capturado sigue requiriendo conciliación', {
      venueId,
      orderId,
      paymentId: payment.id,
      checkoutSessionId: session.id,
      error: error instanceof Error ? error.message : String(error),
    })
    return 'RECONCILIATION_REQUIRED'
  }
}

export async function recordOrderPayment(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  userId?: string,
  _orgId?: string,
) {
  const timing = paymentStepTimer(venueId, paymentData.terminalPaymentRequestId)
  logger.info('Recording order payment', { venueId, orderId, splitType: paymentData.splitType })
  // Tiempo desde la entrada al servicio. La TPV abandona a los 10 s: cada hito lleva
  // `elapsedMs` para que un cobro lento se pueda atribuir a un tramo, no adivinar.
  const startedAt = Date.now()
  const elapsedMs = () => Date.now() - startedAt

  // 🔴 Este camino cobra CONTRA UNA ORDEN desde la terminal, y la terminal es un
  // aparato de tarjeta: sus medios son efectivo y tarjeta, no el catálogo de tipos
  // propios del negocio ("Uber Eats", vales). Ese catálogo vive en el POS, que cobra
  // por `payCashOrder` / `recordFastPayment`. Rechazar aquí es explícito a propósito:
  // si algún día alguien conecta el catálogo a esta ruta, tiene que hacerlo estampando
  // los snapshots — no colándose con un `method` a medias.
  const classicMethod = paymentData.method
  if (paymentData.tenderTypeId != null || classicMethod == null) {
    throw new BadRequestError('Esta ruta de cobro no acepta tipos de pago del catálogo. Usa el punto de venta.')
  }

  // Codex R6-1: la afiliación DEFINITIVA se resuelve ANTES de deduplicar (por llave o por referencia) y es la que viaja en
  // `paymentData` desde aquí: filtro de candidatos, consolidación y registro usan la MISMA identidad.
  const afiliacion = await resolverAfiliacionDelCobro('OrderPayment', venueId, orderId, paymentData)
  paymentData.merchantAccountId = afiliacion.merchantAccountId
  // Codex R7-2: la identidad de afiliación que mandó el APK viaja con el entrante (consolidación y huella la contrastan como conjunto).
  ;(paymentData as RegistroEntrante).merchantAccountIdDelApk = afiliacion.merchantAccountIdDelApk ?? null

  // 🛡️ IDEMPOTENCY CHECK - Layered defense (Stripe/Square/Toast pattern)
  // See recordFastPayment for full explanation. Both checks run in sequence to
  // handle the legacy→new TPV transition correctly.
  if (paymentData.idempotencyKey) {
    const existingByKey = await prisma.payment.findUnique({
      where: {
        venueId_idempotencyKey: {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
        },
      },
      include: { receipts: true },
    })

    if (existingByKey) {
      logger.info('🔄 Idempotent retry detected by idempotencyKey — returning existing order payment', {
        venueId,
        orderId,
        idempotencyKey: paymentData.idempotencyKey,
        existingPaymentId: existingByKey.id,
      })
      const areaTicketCheckoutState =
        existingByKey.status === 'COMPLETED'
          ? await resumeCapturedAreaTicketPayment(venueId, orderId, existingByKey, paymentData.idempotencyKey)
          : null
      return {
        ...((await consolidarRegistroRepetido(existingByKey, paymentData as RegistroEntrante, venueId, orderId)) ?? existingByKey),
        ...(areaTicketCheckoutState ? { areaTicketCheckoutState } : {}),
        digitalReceipt: await ensureDigitalReceiptResponse(existingByKey.id, existingByKey.receipts[0]),
      }
    }
  }

  let colisionDeReferencia: ColisionDeReferenciaRegistrada['candidates'] | null = null
  /** Codex R4 (P2): la respuesta se arma con el Payment RESUELTO (consolidado o dueño durable), nunca con el candidato con el que se entró. */
  const devolverExistentePorReferencia = async (existingPayment: Payment & { receipts: DigitalReceipt[] }) => {
    logger.warn('🔄 Duplicate order payment attempt detected (referenceNumber check)', {
      venueId,
      orderId,
      referenceNumber: paymentData.referenceNumber,
      existingPaymentId: existingPayment.id,
      incomingIdempotencyKey: paymentData.idempotencyKey || null,
      existingIdempotencyKey: existingPayment.idempotencyKey || null,
      message: 'Returning existing payment (safe retry / legacy→new TPV transition)',
    })
    // Ronda 2 (P1): el existente puede estar ligado a una solicitud ya liberada sin haberla podido ligar.
    await retenerSiQuedoSinLigar(existingPayment, paymentData)

    // Return existing payment with receipt (safe retry - client gets same response)
    const areaTicketCheckoutState =
      existingPayment.status === 'COMPLETED'
        ? await resumeCapturedAreaTicketPayment(
            venueId,
            orderId,
            existingPayment,
            paymentData.idempotencyKey ?? existingPayment.idempotencyKey,
          )
        : null
    return {
      ...existingPayment,
      ...(areaTicketCheckoutState ? { areaTicketCheckoutState } : {}),
      digitalReceipt: await ensureDigitalReceiptResponse(existingPayment.id, existingPayment.receipts[0]),
    }
  }
  /** Los argumentos de la resolución por referencia: los MISMOS antes de la transacción y en la relectura bajo el candado (R12-7). */
  let argumentosDeReferencia: Parameters<typeof resolverPorReferencia>[0] | null = null
  if (paymentData.referenceNumber) {
    // Always-on referenceNumber check (catches legacy retries and legacy→new transition races)
    // S0-a (checkpoint 1 del webhook): la referencia sola no identifica un cobro — Blumon y AngelPay usan
    // `yyMMddHHmmss` y dos terminales del mismo negocio colisionan en el mismo segundo. Un reintento legítimo coincide
    // en importe, propina, orden y afiliación; una colisión difiere en alguna y se registra como cobro NUEVO.
    // Codex R2 (P1-1): se examinan TODOS los candidatos de la referencia (acotados) y se elige el que tiene identidad
    // suficiente; descartar al primero nunca es permiso para crear.
    const huellaEntrante: HuellaDelCobro = {
      orderId,
      amountPesos: paymentData.amount / 100,
      tipPesos: (paymentData.tip ?? 0) / 100,
      merchantAccountId: afiliacion.merchantAccountId ?? null,
      merchantAccountIdDelApk: afiliacion.merchantAccountIdDelApk ?? null,
      authorizationNumber: paymentData.authorizationNumber ?? null,
      idempotencyKey: paymentData.idempotencyKey ?? null,
      terminalSerial: paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
      terminalPaymentRequestId: paymentData.terminalPaymentRequestId ?? null,
    }
    argumentosDeReferencia = {
      etiqueta: 'recordOrderPayment',
      venueId,
      referenceNumber: paymentData.referenceNumber,
      targetOrderId: orderId,
      huella: huellaEntrante,
      paymentData: paymentData as RegistroEntrante,
    }
    // Codex R4 (R4-1/R4-2/R4-6): la resolución demuestra o no demuestra — nunca crea con la búsqueda agotada ni sobre una
    // consolidación incierta, y una colisión con identidad débil queda como EVIDENCIA (más abajo, en la transacción).
    const resolucion = await resolverPorReferencia(argumentosDeReferencia)
    if (resolucion.kind === 'EXISTENTE') return devolverExistentePorReferencia(resolucion.registro)
    if (resolucion.kind === 'COLISION') colisionDeReferencia = resolucion.contradicciones
  }

  // Find the order directly by ID. Only scalar item fields are used from here on
  // (`id`, `total`, `areaTicketLineId`); the product/modifier/allocation/venue/payments
  // relations only fed the pre-transaction pre-flight removed on 2026-08-25, and the
  // post-commit inventory check re-reads the order with what it needs.
  const activeOrder = await prisma.order.findUnique({
    where: {
      id: orderId,
      venueId,
    },
    include: {
      items: true,
    },
  })

  if (!activeOrder) {
    // 🔴 El código es parte del contrato con la TPV, no decoración: al reproducir su cola,
    // `ORDER_NOT_FOUND` es el ÚNICO 404 en el que puede caer a venta rápida. Un 404 por venue
    // equivocado o por una ruta caída se parece byte a byte, y sin distinguirlos la TPV
    // convierte una orden VIVA en una venta suelta —perdiendo su SaleVerification— y otra
    // terminal la vuelve a cobrar (2ª auditoría de Codex, P1 nuevo).
    //
    // 🔴 Y por eso la consulta de arriba NO basta para emitirlo: está acotada al venue, así que
    // una fila heredada con el `venueId` equivocado —o un supervisor autorizado en dos
    // sucursales, que la ruta permite: `checkPermission`, no un candado de venue— produce el
    // mismo `null` que una orden borrada. Se pregunta una segunda vez SIN el venue, y sólo si
    // la orden no existe en ninguna parte se firma «ya no existe» (3ª auditoría de Codex, P1).
    // Esta consulta cuesta un viaje y corre únicamente en el camino que ya iba a fallar.
    const ordenEnOtraSucursal = await prisma.order.findUnique({ where: { id: orderId }, select: { id: true, venueId: true } })
    if (ordenEnOtraSucursal) {
      // No se filtra nada del otro negocio —ni su id, ni su nombre—: sólo el código, que es lo
      // que la TPV necesita para dejar la fila en revisión humana en vez de recobrarla.
      logger.warn('🚧 [recordOrderPayment] La orden existe pero pertenece a otra sucursal — no se puede cobrar aquí', {
        venueId,
        orderId,
      })
      throw new NotFoundError('La orden pertenece a otra sucursal', 'ORDER_NOT_IN_VENUE')
    }
    throw new NotFoundError(`Order ${orderId} not found in venue ${venueId}`, 'ORDER_NOT_FOUND')
  }

  // Validate splitType business logic
  if (activeOrder.splitType && activeOrder.splitType !== paymentData.splitType) {
    // Define allowed transitions based on business rules
    const allowedTransitions = {
      PERPRODUCT: ['PERPRODUCT', 'FULLPAYMENT'], // Can only continue with same method or pay full
      EQUALPARTS: ['EQUALPARTS', 'FULLPAYMENT'], // Can only continue with same method or pay full
      CUSTOMAMOUNT: ['PERPRODUCT', 'EQUALPARTS', 'CUSTOMAMOUNT', 'FULLPAYMENT'], // Can use any method
      FULLPAYMENT: ['FULLPAYMENT'], // Only full payment allowed (order should be completed)
    }

    const allowedMethods = allowedTransitions[activeOrder.splitType] || []

    if (!allowedMethods.includes(paymentData.splitType)) {
      throw new BadRequestError(
        `Order has splitType ${activeOrder.splitType}. Cannot use ${paymentData.splitType}. Allowed methods: ${allowedMethods.join(', ')}`,
      )
    }
  }

  await assertVenueSalesEnabled(venueId)

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100
  const hasAreaTicketLines = activeOrder.items.some(item => item.areaTicketLineId != null)
  if (hasAreaTicketLines && !paymentData.idempotencyKey) {
    throw new BadRequestError('Las ventas con vales requieren idempotencyKey. Reintenta el mismo pago con una llave estable.')
  }

  // Ya NO hay pre-flight de inventario ANTES de registrar el cobro. Desde la paridad
  // con Square (2026-08-12) ese chequeo no rechazaba nada — sólo repetía la misma
  // consulta que hace `updateOrderTotalsForStandalonePayment` tras el commit y
  // escribía dos líneas de log. Costaba ~1 s por cobro en un camino que el cliente
  // abandona a los 10 s (prod 2026-08-25: 7 cobros abandonados en una ventana, sólo la
  // idempotencia evitó el doble cobro). El ÚNICO chequeo de inventario vive post-commit
  // y viaja al cajero como `inventoryWarning`, nunca como error.

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await validateStaffVenue(paymentData.staffId, venueId, userId)

  // Codex R6-1: la afiliación ya está resuelta (arriba, antes de deduplicar); aquí sólo se lee.
  const merchantAccountId = afiliacion.merchantAccountId

  // Codex R3 (P1-3) / R5-2: la TARIFA se congela al cobrar — sobre la afiliación DEFINITIVA, la que queda tras TIER-2/3 —,
  // nunca sobre la que mandó el APK. Congelarla antes de la recuperación dejaba el snapshot (slot y tasas) de M1 en un
  // Payment atribuido a M2; sin snapshot de M2, el costo diferido caía al slot de M1 en cuanto M2 saliera de la configuración.
  // Codex R14-1: la tarifa se congela DENTRO de la transacción del dinero, con el candado del intento tomado (ver abajo).
  const llaveDelIntento = llaveDeIntento(paymentData.idempotencyKey)

  // ⭐ TERMINAL ATTRIBUTION: Resolve terminalId from device serial number
  // Links payment to the Terminal that processed it (for device-based reporting)
  let terminalId: string | null = null
  if (paymentData.deviceSerialNumber) {
    terminalId = await resolveTerminalIdFromSerial(venueId, paymentData.deviceSerialNumber)
  }

  // Shadow mode only: persist the new evidence/result beside the legacy boolean,
  // but keep every pricing and settlement consumer on the legacy path for now.
  const internationalityShadow = classifyPaymentInternationalityShadow(paymentData)
  const internationalityClassifiedAt = internationalityShadow ? new Date() : undefined
  // The request object is shared/mutable. Claim and persistence must observe one
  // primitive snapshot, even if an awaited hook mutates the wrapper in between.
  const paymentStatusSnapshot = paymentData.status
  const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)

  // ⭐ ATOMICITY: Wrap critical payment creation in transaction (all or nothing)
  // This prevents orphaned records if any operation fails
  //
  // 🛡️ SAFETY NET: If two concurrent requests race past the idempotency fast-path
  // above, the @@unique([venueId, idempotencyKey]) constraint will throw P2002 on
  // the second request. We catch that below and return the winning payment, making
  // the concurrent retry behave exactly like an idempotent success.
  let payment: Awaited<ReturnType<typeof prisma.payment.create>>
  let lockedAreaCheckout: { sessionId: string; attemptId: string } | null = null
  let areaTicketCheckoutState: string | null = null
  let committedStandaloneSettlement: CommittedStandaloneSettlement | undefined
  // Faltante de inventario detectado con el cobro YA registrado. Viaja como aviso
  // en la respuesta — nunca como error, o el cajero vuelve a pasar la tarjeta.
  let inventoryWarning: OrderInventoryWarning | null = null
  // S0: se llena DENTRO de la transacción (por eso un holder y no un `let`: TS no ve asignaciones en closures).
  const s0 = {
    segundaCaptura: null as SegundaCapturaRegistrada | null,
    colision: null as ColisionDeReferenciaRegistrada | null,
    cierre: null as CloseRowOutcome | null,
  }
  const shiftAmount = new Prisma.Decimal(totalAmount)
  const shiftTip = new Prisma.Decimal(tipAmount)
  try {
    payment = await timing.time('financial_commit', () =>
      prisma.$transaction(async tx => {
        // Codex R14-1: PRIMERA sentencia — el candado del intento (el mismo del ingreso del webhook, de S1 y de la consolidación):
        // la lectura de la primera evidencia y la creación del Payment quedan serializadas con la llegada de cualquier evento del
        // intento. Orden de candados: intento → referencia → sesión de vales → tickets → Order → TerminalPaymentRequest → Payment → Shift.
        if (llaveDelIntento) await candadoDeIntento(tx, llaveDelIntento)
        // Codex R12-7: un registro SIN llave se serializa por (venue, referencia) como PRIMERA sentencia y vuelve a resolver
        // ya con el candado — la resolución de arriba corrió fuera de esta transacción y dos replays simultáneos veían
        // «ausencia» los dos. Con llave no aplica (índice único del intento).
        if (!paymentData.idempotencyKey && argumentosDeReferencia) {
          colisionDeReferencia = await exclusionPorReferencia(tx, argumentosDeReferencia)
        }
        // Codex R3 (P1-3) / R5-2 / R14-1: la TARIFA se congela aquí, bajo el candado, sobre la afiliación DEFINITIVA y sobre la
        // PRIMERA evidencia durable del intento (o «ahora» si el REST es esa primera evidencia).
        const tarifa = merchantAccountId
          ? await tarifaDeLaAfiliacion(tx, venueId, merchantAccountId, paymentData)
          : { slot: null, pricing: null }
        paymentData.pricingSlot = tarifa.slot
        paymentData.pricing = tarifa.pricing
        const areaTicketPayment = await import('../mobile/areaTicketV7.mobile.service')
        // P1-3 (Codex, S0): PRIMERO los candados (sesión de vales → tickets → Order), DESPUÉS el arbitraje, y sólo el
        // ganador prepara el intento de vales — `lockAreaTicketCheckoutForPayment` rechaza una sesión ya pagada, y eso
        // dejaba al segundo intento acreditado fuera, sin evidencia.
        if (paymentStatusSnapshot === 'COMPLETED') {
          await areaTicketPayment.lockAreaTicketCheckoutHierarchy(tx, { venueId, orderId: activeOrder.id })
        }
        // El submódulo de vales conserva session → tickets → Order. Si no hay
        // vales, este helper toma Order aquí; si los hay, el lock es reentrante.
        // Desde este punto todos los carriles siguen Order → TerminalPaymentRequest → Payment → Shift.
        const orderStillBelongsToVenue = await lockExistingOrderForPayment(tx, { venueId, orderId: activeOrder.id })
        if (!orderStillBelongsToVenue) {
          throw new ConflictError(
            'La orden cambió mientras se registraba el cobro. Se requiere conciliación manual.',
            'PAYMENT_ORDER_AUTHORITY_UNAVAILABLE',
          )
        }

        // S0 (Codex, 13-sep): UN ganador por solicitud POS→terminal, decidido AQUÍ — bajo el candado de la fila, antes
        // de reclamar turno y antes de crear cualquier Payment. Ver `arbitrarRegistroDeSolicitud`.
        let ligarSolicitud = false
        if (paymentData.terminalPaymentRequestId) {
          const arbitraje = await arbitrarSinPerderElCobro(tx, {
            requestId: paymentData.terminalPaymentRequestId,
            venueId,
            attemptKey: paymentData.idempotencyKey ?? null,
            targetOrderId: activeOrder.id,
            authenticatedSerial: paymentData.authenticatedTerminalSerial ?? null,
          })
          if (arbitraje.kind === 'RETRY_OF_WINNER') throw new ReintentoDelGanadorDeLaSolicitud(arbitraje.winnerPaymentId)
          if (arbitraje.kind === 'SECOND_CAPTURE') {
            s0.segundaCaptura = {
              requestId: arbitraje.row.requestId,
              winnerPaymentId: arbitraje.winnerPaymentId,
              winnerIdempotencyKey: arbitraje.winnerIdempotencyKey,
            }
            return crearEvidenciaDeSegundaCaptura(tx, {
              venueId,
              orderId: activeOrder.id,
              arbitraje,
              paymentData,
              totalAmount,
              tipAmount,
              method: classicMethod as PaymentMethod,
              merchantAccountId,
              terminalId,
              staffId: validatedStaffId,
            })
          }
          ligarSolicitud = arbitraje.kind === 'WINNER'
        }
        // Codex R4-6: la colisión de referencia (decidida ANTES de la transacción, bajo el candado del candidato) se
        // guarda como evidencia PENDING sobre ESTA venta — nunca como una segunda venta ni como el existente.
        if (colisionDeReferencia && paymentData.referenceNumber) {
          s0.colision = { referenceNumber: paymentData.referenceNumber, candidates: colisionDeReferencia }
          return crearEvidenciaDeColisionDeReferencia(tx, {
            venueId,
            orderId: activeOrder.id,
            colision: s0.colision,
            paymentData,
            totalAmount,
            tipAmount,
            method: classicMethod as PaymentMethod,
            merchantAccountId,
            terminalId,
            staffId: validatedStaffId,
          })
        }
        // La PREPARACIÓN del intento de vales va después del arbitraje y sólo para quien sigue (ganador, cobro sin
        // solicitud o asociación inválida): una segunda captura ya salió arriba. Sin sesión de vales devuelve `null`.
        if (paymentStatusSnapshot === 'COMPLETED') {
          lockedAreaCheckout = await areaTicketPayment.lockAreaTicketCheckoutForPayment(tx, {
            venueId,
            orderId: activeOrder.id,
            idempotencyKey: paymentData.idempotencyKey,
            amount: new Prisma.Decimal(totalAmount),
            method: classicMethod as PaymentMethod,
          })
        }

        // 🔴 Toque repetido en «Efectivo» sobre una orden ya cubierta (SN00396, BAE MEZQUITAL,
        // 2026-09-04: 5 cobros en 1.7 s, referencias distintas, sin llave). Va DESPUÉS del
        // `FOR UPDATE` de la orden —lo que serializa la ráfaga— y ANTES de reclamar el turno,
        // que ya suma dinero. No basta con «la orden está saldada»: se exige la FIRMA de la
        // ráfaga —mismo dinero, misma terminal, dentro de la ventana— porque «saldada» a secas
        // confunde dos entregas físicas distintas y hace desaparecer una (ver
        // `cobroEnEfectivoDuplicado.ts`). Se responde con el cobro existente y un 2xx —el
        // controlador responde 201 en todas las ramas—, nunca con un 4xx: un rechazo delante
        // del cliente empuja al cajero a volver a cobrar.
        //
        // La consulta se hace SÓLO cuando el candado puede aplicar (`aplicaCandadoDeEfectivo`),
        // que hoy quiere decir «es efectivo COMPLETED sin vales»: este camino lo abandona la TPV
        // a los 10 s y un viaje de más por cada cobro con TARJETA es justo lo que produce el
        // reintento que se está evitando. El efectivo con llave sí paga la consulta desde la
        // ronda 4 — es el precio de cerrar la ráfaga mixta, y se paga sólo en efectivo.
        const candidatoDeEfectivo = {
          method: classicMethod,
          status: paymentStatusSnapshot,
          hasAreaTicketLines,
          amount: totalAmount,
          tip: tipAmount,
          terminalId,
          // 🔴 La llave entra a la FIRMA, no apaga el candado. Dos cobros que la traen son dos
          // intentos lógicos distintos y no se deduplican (los resuelve el índice único de
          // arriba); pero si a uno de los dos le falta —la ráfaga MIXTA de la 3ª auditoría de
          // Codex, P2: una entrega que sale dos veces, una sin llave y otra con ella— la firma
          // vuelve a ser la única defensa. Ver `cobroEnEfectivoDuplicado.ts`.
          idempotencyKey: paymentData.idempotencyKey ?? null,
        }
        if (aplicaCandadoDeEfectivo(candidatoDeEfectivo)) {
          const pagosCompletadosDeLaOrden = await tx.payment.findMany({
            where: { venueId, orderId: activeOrder.id, status: 'COMPLETED' },
            // 🔴 `idempotencyKey` no es opcional en este select: sin ella todos los cobros previos
            // parecerían «sin llave» y dos intentos lógicos distintos se deduplicarían entre sí
            // — el único olvido de esta lista que vuelve la regla MÁS agresiva, no inerte.
            select: {
              id: true,
              amount: true,
              tipAmount: true,
              type: true,
              method: true,
              createdAt: true,
              terminalId: true,
              idempotencyKey: true,
            },
            // 🔑 Desempate estable por `id`: con `createdAt` a secas, filas empatadas al
            // milisegundo (un backfill, una importación) pueden dejar dentro del corte un cobro
            // y fuera su reembolso — y entonces una orden devuelta se leería como saldada.
            orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
            // Tope explícito: una orden con más cobros que esto quedaría con el saldo
            // SUBESTIMADO ⇒ la regla ve «todavía falta» y NO deduplica. El lado seguro.
            take: 200,
          })
          // Sólo si hay un cobro previo vale la pena releer la orden: con la fila BLOQUEADA, no
          // la copia leída antes de la transacción. Entre aquella lectura y este `FOR UPDATE`
          // alguien pudo añadirle $50 a la cuenta, y con el subtotal viejo la regla vería
          // «saldada» una orden que ya no lo está.
          if (pagosCompletadosDeLaOrden.some(p => p.type !== 'REFUND')) {
            const ordenBloqueada = await tx.order.findUnique({
              where: { id: activeOrder.id },
              select: {
                subtotal: true,
                discountAmount: true,
                serviceChargeAmount: true,
                items: { select: { areaTicketLineId: true } },
              },
            })
            if (ordenBloqueada) {
              const cobroPrevio = cobroEnEfectivoSobreOrdenSaldada(
                { ...candidatoDeEfectivo, hasAreaTicketLines: ordenBloqueada.items.some(i => i.areaTicketLineId != null) },
                {
                  subtotal: ordenBloqueada.subtotal,
                  discountAmount: ordenBloqueada.discountAmount,
                  serviceChargeAmount: ordenBloqueada.serviceChargeAmount,
                },
                pagosCompletadosDeLaOrden,
              )
              if (cobroPrevio) {
                throw new CobroDuplicadoEnEfectivo(cobroPrevio.id)
              }
            }
          }
        }

        // Sólo COMPLETED representa dinero capturado. FAILED/PENDING/PROCESSING/
        // REFUNDED conservan `null`: no reclaman turno ni generan una falsa
        // conciliación post-cierre. Para COMPLETED, el claim ES el incremento y
        // ocurre dentro de esta misma tx, antes del Payment.
        const priorCompletedPaymentCount = await countPriorCompletedPayments(tx, { venueId, orderId: activeOrder.id })
        const shiftClaim = await claimShiftForCompletedPayment(tx, {
          paymentStatus: paymentStatusSnapshot,
          venueId,
          amountPesos: shiftAmount,
          tipPesos: shiftTip,
          incrementTotalOrders: priorCompletedPaymentCount === 0,
        })

        // Create the payment record
        const newPayment = await tx.payment.create({
          data: {
            venueId,
            orderId: activeOrder.id,
            amount: totalAmount,
            tipAmount,
            method: classicMethod as PaymentMethod, // Cast to PaymentMethod enum
            // Mismo criterio que la venta rápida: el detalle declarado a mano sólo se
            // guarda cuando el dinero NO pasó por Avoqado.
            externalSource: classicMethod === 'CASH' ? null : paymentData.externalSource?.trim()?.slice(0, 50) || null,
            status: paymentStatusSnapshot as any, // Direct enum mapping since frontend sends correct values
            splitType: paymentData.splitType as SplitType, // Cast to SplitType enum
            source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
            processor: 'TBD',
            // Snapshot de MERCHANT_ROUTING_RULES (por qué la TPV mostró/eligió este merchant)
            routingEvaluation: paymentData.routingEvaluation ?? undefined,
            processorId: paymentData.mentaOperationId,
            processorData: {
              cardBrand: paymentData.cardBrand,
              last4: paymentData.last4,
              typeOfCard: paymentData.typeOfCard,
              bank: paymentData.bank,
              currency: paymentData.currency,
              mentaAuthorizationReference: paymentData.mentaAuthorizationReference,
              mentaTicketId: paymentData.mentaTicketId,
              isInternational: paymentData.isInternational,
              ...(paymentData.issuerCountryCode && paymentData.issuerCountrySource
                ? {
                    issuerCountryEvidence: {
                      code: paymentData.issuerCountryCode,
                      source: paymentData.issuerCountrySource,
                    },
                  }
                : {}),
              // ⭐ Blumon serial for reconciliation (matches dashboard de Blumon)
              blumonSerialNumber: paymentData.blumonSerialNumber || null,
              // 💸 Blumon Operation Number (2025-12-16) - For CancelIcc refunds without webhook
              blumonOperationNumber: paymentData.blumonOperationNumber || null,
              // Procedencia AUTENTICADA del cobro (serial del token). Aditivo: conserva la identidad del
              // aparato aunque `terminalId` no resuelva, para la atribución y la recuperación del
              // arbitraje POS→terminal.
              // Codex R2 (P1-1): el serial que se conserva es el ACREDITADO por el JWT (T10); el del cuerpo sólo cuando no hay otro.
              deviceSerialNumber: paymentData.authenticatedTerminalSerial ?? (paymentData.deviceSerialNumber || null),
              pricingSlot: paymentData.pricingSlot ?? null,
              pricing: tarifaComoJson(paymentData.pricing),
              // S2: nacido del webhook ⇒ método provisional y costo pendiente hasta acreditar la marca (o vencer el plazo).
              ...(paymentData.registradoVia === 'webhook' ? { registradoVia: 'webhook', methodProvisional: true } : {}),
              // Codex R6 (diseño B): `costPending` = «la obligación de costo todavía no ha convergido» — nace con la obligación
              // (todo cobro COMPLETED que no es efectivo, por REST o por webhook) y sólo la convergencia lo pone en false.
              ...(paymentStatusSnapshot === 'COMPLETED' && paymentData.method !== 'CASH' ? { costPending: true } : {}),
              ...(afiliacion.merchantAccountIdDelApk !== afiliacion.merchantAccountId
                ? { merchantAccountIdFromApk: afiliacion.merchantAccountIdDelApk ?? null, merchantResolvedVia: afiliacion.via }
                : {}),
            },
            // New enhanced fields in the Payment table
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            // 🛡️ Idempotency key (2026-04-08) - Stripe/Square/Toast pattern
            idempotencyKey: paymentData.idempotencyKey,
            maskedPan: paymentData.maskedPan,
            cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
            entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
            internationalityStatus: internationalityShadow?.status,
            internationalitySource: internationalityShadow?.source,
            issuerCountryCode: internationalityShadow?.issuerCountryCode,
            internationalityClassificationVersion: internationalityShadow?.classificationVersion,
            internationalityClassifiedAt,
            // ⭐ Provider-agnostic merchant account tracking
            merchantAccountId,
            // ⭐ Terminal that processed this payment (resolved from deviceSerialNumber)
            terminalId,
            processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
            shiftId: shiftClaim?.shiftId ?? null,
            feePercentage: 0, // TODO: Calculate based on payment processor
            feeAmount: 0, // TODO: Calculate based on amount and percentage
            netAmount: totalAmount + tipAmount, // For now, net amount = total
            posRawData: {
              splitType: paymentData.splitType,
              staffId: validatedStaffId, // identidad efectiva validada (POS en relay; TPV en cobro directo)
              source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
              paidProductsId: paymentData.paidProductsId || [],
              ...(paymentData.equalPartsPartySize && { equalPartsPartySize: paymentData.equalPartsPartySize }),
              ...(paymentData.equalPartsPayedFor && { equalPartsPayedFor: paymentData.equalPartsPayedFor }),
              ...(paymentData.reviewRating && { reviewRating: paymentData.reviewRating }),
            },
          },
          include: {
            order: {
              include: {
                items: true,
                venue: true,
              },
            },
            processedBy: true,
          },
        })

        if (shiftClaim) {
          await recordPendingPaymentShiftReconciliation(tx, {
            reconciliationEnabled,
            claim: shiftClaim,
            venueId,
            paymentId: newPayment.id,
            orderId: activeOrder.id,
            staffId: validatedStaffId ?? null,
            channel: 'recordOrderPayment',
            amountPesos: shiftAmount,
            tipPesos: shiftTip,
          })
        }

        // Create VenueTransaction for financial tracking and settlement
        //
        // 🔴 `PENDING` significa "Avoqado todavía le debe este dinero al negocio". Estaba
        // FIJO, así que el efectivo del cajón —y ahora un cobro de Uber Eats, que Avoqado
        // jamás va a depositar— entraban a la cola de liquidación como saldo por depositar.
        // El lado de lectura (`availableBalance`) ya filtra con este mismo predicado, o sea
        // que el número que ve el dueño estaba bien; la FILA era la que mentía, y cualquier
        // consumidor nuevo la leería mal. "¿Esto lo deposita Avoqado?" tiene UNA autoridad:
        // `paymentIsAvoqadoSettled`. Sin tender reproduce el histórico para tarjeta
        // (PENDING) y corrige el efectivo a SETTLED — que es justo lo que ya hace el cobro
        // en efectivo del POS ("Cash is immediately settled").
        await tx.venueTransaction.create({
          data: {
            venueId,
            paymentId: newPayment.id,
            type: 'PAYMENT',
            grossAmount: totalAmount + tipAmount,
            feeAmount: newPayment.feeAmount,
            netAmount: newPayment.netAmount,
            // Lo que no pasa por Avoqado no tiene nada pendiente: nace liquidado.
            status: paymentIsAvoqadoSettled(newPayment) ? 'PENDING' : 'SETTLED',
          },
        })

        // Close the POS→TPV arbitration row (frees the terminal slot) atomically
        // with the Payment — the robust recovery path (survives socket loss/restart).
        // S0: sólo el GANADOR liga la fila (el arbitraje ya excluyó las asociaciones inválidas), y se comprueba el
        // desenlace: «no lanzó» no es «ligó». Un ganador sin vínculo queda registrado y la fila, recuperable.
        if (ligarSolicitud && paymentData.terminalPaymentRequestId) {
          const cierre = await terminalPaymentService.closeRowFromPaymentTx(
            tx,
            paymentData.terminalPaymentRequestId,
            newPayment.id,
            venueId,
            { amountCents: paymentData.amount, tipCents: paymentData.tip },
            'REST',
            // Serial AUTENTICADO (el controlador lo toma del token): la identidad del aparato que cobró aunque la FK
            // `terminalId` no haya resuelto en este venue. `deviceSerialNumber` del body sólo como respaldo legacy.
            paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
            paymentData.registradoVia === 'webhook' ? 'webhook' : 'terminal',
          )
          s0.cierre = cierre
          // Checkpoint 2 · N0b (Codex, diseño v3): la terminal acredita al GANADOR de la solicitud por la columna
          // `Payment.terminalPaymentRequestId`, que sólo escribe `closeRowFromPaymentTx` al ligar. El objeto del `create` nació sin
          // ella: se refleja aquí para que el 2xx la lleve (la relectura idempotente ya la trae de la fila). Sin ligar, va null.
          if (cierre.bound) newPayment.terminalPaymentRequestId = paymentData.terminalPaymentRequestId ?? null
          if (!cierre.bound) {
            logger.error(
              '🚨 [Terminal-payment] El ganador quedó REGISTRADO pero la solicitud NO se ligó — la fila queda para recuperación',
              {
                venueId,
                requestId: paymentData.terminalPaymentRequestId,
                paymentId: newPayment.id,
                reason: cierre.reason,
              },
            )
          }
        }

        // Update Order.splitType if this is the first payment
        if (!activeOrder.splitType) {
          await tx.order.update({
            where: { id: activeOrder.id, venueId },
            data: { splitType: paymentData.splitType as any },
          })
        }

        // Handle split payment allocations based on splitType
        if (paymentData.splitType === 'PERPRODUCT' && paymentData.paidProductsId.length > 0) {
          // Create allocations for specific products
          const orderItems = activeOrder.items.filter((item: any) => paymentData.paidProductsId.includes(item.id))

          for (const item of orderItems) {
            await tx.paymentAllocation.create({
              data: {
                paymentId: newPayment.id,
                orderItemId: item.id,
                orderId: activeOrder.id,
                amount: item.total, // Allocate the full item amount
              },
            })
          }
        } else {
          // For other split types, create a general allocation to the order
          await tx.paymentAllocation.create({
            data: {
              paymentId: newPayment.id,
              orderId: activeOrder.id,
              amount: totalAmount,
            },
          })
        }

        const integratedOrder = activeOrder.source === OrderSource.POS && !!activeOrder.externalId?.trim()
        if (
          newPayment.status === 'COMPLETED' &&
          !integratedOrder &&
          !lockedAreaCheckout &&
          !activeOrder.items.some(item => item.areaTicketLineId != null)
        ) {
          committedStandaloneSettlement = await settleStandalonePaymentInTx(tx, venueId, activeOrder.id, newPayment, validatedStaffId)
        }

        if (newPayment.status === 'COMPLETED') {
          const paidOrder = await tx.order.findUniqueOrThrow({ where: { id: activeOrder.id, venueId } })
          let expectsSettlement = paidOrder.paymentStatus === 'PAID'
          if (!expectsSettlement && !committedStandaloneSettlement) {
            // SR and area-ticket flows retain their settlement owner. Freeze the
            // expectation now so their referral survives a delayed settlement.
            const sums = await tx.payment.aggregate({
              where: {
                venueId,
                orderId: activeOrder.id,
                status: 'COMPLETED',
                OR: [{ type: null }, { type: { not: REFUND_PAYMENT_TYPE } }],
              },
              _sum: { amount: true, tipAmount: true },
            })
            expectsSettlement = computeOrderBalance(paidOrder, [{ amount: sums._sum.amount, tipAmount: sums._sum.tipAmount }]).isFullyPaid
          }
          await enqueueCommittedPaymentEffects(tx, newPayment, paymentData.reviewRating, validatedStaffId, expectsSettlement)
          await encolarObligacionDeCosto(tx, newPayment, paymentData.registradoVia === 'webhook' ? 'webhook' : 'terminal')
        }
        return newPayment
      }, OPCIONES_DE_TRANSACCION_DEL_INTENTO),
    )
  } catch (error) {
    if (error instanceof RegistroYaExistentePorReferencia) return devolverExistentePorReferencia(error.registro)
    if (error instanceof CobroDuplicadoEnEfectivo) {
      const existente = await prisma.payment.findUnique({ where: { id: error.existingPaymentId }, include: { receipts: true } })
      if (existente) {
        logger.warn('🔄 [recordOrderPayment] Cobro en EFECTIVO sobre una orden ya saldada — se devuelve el existente', {
          venueId,
          orderId,
          existingPaymentId: existente.id,
          incomingReferenceNumber: paymentData.referenceNumber ?? null,
          incomingIdempotencyKey: paymentData.idempotencyKey ?? null,
          incomingAmount: totalAmount,
          incomingTip: tipAmount,
          terminalId,
          elapsedMs: elapsedMs(),
        })
        // 🔴 Rastro DURABLE: el `logger.warn` vive en Better Stack 30 días y no lo ve el dueño.
        // Un cobro que el servidor decide no registrar tiene que poder explicarse después —
        // «entregué el dinero y no aparece»— desde la bitácora del negocio.
        //
        // 🔴 Y aquí SÍ se espera (`await`), en contra del «fire-and-forget» que la regla del
        // repo pide para `logAction` en general. La diferencia: en el resto de los casos la
        // bitácora ACOMPAÑA a un dato que ya quedó guardado; aquí ES el dato, porque el
        // `Payment` entrante no se guarda. Sin el `await`, la respuesta 2xx sale antes de que
        // exista la fila y un reinicio entre medias borra el único rastro del intento
        // descartado —referencia, llave, monto, propina y terminal— (2ª auditoría de Codex,
        // P3); además, un `logAction` que rechaza deja una promesa sin manejar. El `try/catch`
        // sigue: esperar la bitácora no puede convertirla en un punto de falla del cobro.
        //
        // 🔴 Pero el `await` va ACOTADO. Sin tope convierte una escritura auxiliar en
        // disponibilidad del cobro: con el pool agotado Prisma puede esperar 10 s sólo por la
        // conexión y la TPV abandona a los 12 s, así que la terminal vería un timeout y
        // volvería a encolar un cobro que el servidor YA decidió devolver — justo el reintento
        // que todo esto evita (3ª auditoría de Codex, P3). El rastro importa; la respuesta al
        // cajero, más. Vencido el tope se responde y queda el `logger.warn` como aviso.
        let temporizadorDeLaBitacora: NodeJS.Timeout | undefined
        let vencioLaBitacora = false
        try {
          await Promise.race([
            logAction({
              staffId: userId ?? paymentData.staffId,
              venueId,
              action: 'CASH_PAYMENT_DEDUPLICATED',
              entity: 'Payment',
              entityId: existente.id,
              data: {
                orderId,
                incomingReferenceNumber: paymentData.referenceNumber ?? null,
                incomingIdempotencyKey: paymentData.idempotencyKey ?? null,
                incomingAmount: totalAmount,
                incomingTip: tipAmount,
                terminalId,
                source: 'TPV',
              },
            }),
            new Promise<void>(resolve => {
              temporizadorDeLaBitacora = setTimeout(() => {
                vencioLaBitacora = true
                resolve()
              }, TOPE_BITACORA_DEDUPLICACION_MS)
            }),
          ])
          if (vencioLaBitacora) {
            logger.warn('[recordOrderPayment] La bitácora de deduplicación tardó >1.5 s; se responde sin esperarla', {
              venueId,
              orderId,
              existingPaymentId: existente.id,
            })
          }
        } catch {
          logger.warn('[recordOrderPayment] No se pudo escribir CASH_PAYMENT_DEDUPLICATED en la bitácora', { venueId, orderId })
        } finally {
          // Se limpia SIEMPRE —también cuando la bitácora rechaza— para no dejar vivo un
          // temporizador de 1.5 s por cada cobro deduplicado.
          if (temporizadorDeLaBitacora) clearTimeout(temporizadorDeLaBitacora)
        }
        return {
          ...existente,
          digitalReceipt: await ensureDigitalReceiptResponse(existente.id, existente.receipts[0]),
        }
      }
      logger.error('🚨 [recordOrderPayment] Duplicado en efectivo detectado pero el cobro existente ya no está — imposible', {
        venueId,
        orderId,
        existingPaymentId: error.existingPaymentId,
      })
      throw new ConflictError('La orden ya está cobrada. Revisa el historial de cobros.', 'ORDER_ALREADY_PAID_CASH')
    }
    if (error instanceof ConflictError && error.code === 'PAYMENT_ORDER_AUTHORITY_UNAVAILABLE') {
      if (paymentStatusSnapshot === 'COMPLETED') {
        await recordCapturedPaymentOrderReconciliation(prisma, {
          venueId,
          orderId: activeOrder.id,
          staffId: userId ?? null,
          amountPesos: shiftAmount,
          tipPesos: shiftTip,
        })
      }
      throw error
    }
    if (error instanceof ReintentoDelGanadorDeLaSolicitud) {
      const ganador = await prisma.payment.findUnique({ where: { id: error.winnerPaymentId }, include: { receipts: true } })
      if (ganador) {
        logger.info('🔄 [S0] Bajo el candado de la solicitud, el ganador ya era este mismo intento — se devuelve el existente', {
          venueId,
          winnerPaymentId: ganador.id,
        })
        // Codex R1 (P1-4): el REST que perdió la carrera bajo el candado trae marca, PAN, modo y método REALES — se
        // consolidan sobre el ganador (S3) igual que en los retornos idempotentes; devolverlo tal cual los perdía.
        return {
          ...((await consolidarRegistroRepetido(ganador, paymentData as RegistroEntrante, venueId, activeOrder.id)) ?? ganador),
          digitalReceipt: await ensureDigitalReceiptResponse(ganador.id, ganador.receipts[0]),
        }
      }
      throw error
    }
    // 🛡️ P2002 safety net: unique constraint violation on (venueId, idempotencyKey)
    // means another concurrent request already created this payment. Return the
    // winner as if this was a normal idempotent retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta as { target?: string[] } | undefined)?.target
      const isIdempotencyConflict = Array.isArray(target) && target.includes('idempotencyKey')

      if (isIdempotencyConflict && paymentData.idempotencyKey) {
        logger.warn('🛡️ [recordOrderPayment] Concurrent race blocked by unique index — returning winner', {
          venueId,
          orderId,
          idempotencyKey: paymentData.idempotencyKey,
          target,
        })

        const winner = await prisma.payment.findUnique({
          where: {
            venueId_idempotencyKey: {
              venueId,
              idempotencyKey: paymentData.idempotencyKey,
            },
          },
          include: { receipts: true },
        })

        if (winner) {
          const winnerAreaTicketCheckoutState =
            winner.status === 'COMPLETED'
              ? await resumeCapturedAreaTicketPayment(venueId, orderId, winner, paymentData.idempotencyKey)
              : null
          return {
            ...((await consolidarRegistroRepetido(winner, paymentData as RegistroEntrante, venueId, orderId)) ?? winner),
            ...(winnerAreaTicketCheckoutState ? { areaTicketCheckoutState: winnerAreaTicketCheckoutState } : {}),
            digitalReceipt: await ensureDigitalReceiptResponse(winner.id, winner.receipts[0]),
          }
        }

        logger.error('🚨 [recordOrderPayment] P2002 on idempotencyKey but winner not found — should be impossible', {
          venueId,
          orderId,
          idempotencyKey: paymentData.idempotencyKey,
        })
      }
    }
    throw error
  }

  // Ventana de confirmación (Task 3): si el cierre reabrió una fila que la ventana ya había liberado, el correo ops sale
  // DESPUÉS del commit — por REST o por webhook, los dos pueden reabrir. Sin `lateAfterWindow` no hace nada.
  if (paymentData.terminalPaymentRequestId) {
    avisarAprobacionTardiaTrasVentana(s0.cierre, {
      requestId: paymentData.terminalPaymentRequestId,
      venueId,
      paymentId: payment.id,
      terminalId: paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
      orderId: activeOrder.id,
    })
  }
  // Ronda 2 (P1): el cobro no ligó su solicitud (cierre negado o asociación inválida) ⇒ si una solicitud ya liberada lo tiene
  // ligado, se re-retiene. La evidencia PENDING (segunda captura, colisión) no es un cobro: no aplica.
  if (!s0.cierre?.bound && !s0.segundaCaptura && !s0.colision) await retenerSiQuedoSinLigar(payment, paymentData)

  // Ronda 3 (P1-B): la colisión también es una señal positiva sobre la solicitud — si ésta ya estaba liberada, se re-retiene.
  if (s0.colision) await retenerSiHayColisionSobreUnaLiberada(payment, paymentData)

  if (s0.segundaCaptura) return await responderSegundaCaptura(venueId, payment, s0.segundaCaptura)
  if (s0.colision) return await responderColisionDeReferencia(venueId, payment, s0.colision)

  logger.info('VenueTransaction created for payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
    elapsedMs: elapsedMs(),
  })
  logPaymentInternationalityShadow(payment.id, paymentData.isInternational, internationalityShadow)

  // 🔴 EL CAJÓN SUMA LA VENTA EN EFECTIVO (simétrico con el PAY_OUT del reembolso).
  // Ver `services/shared/cashDrawerPosting.ts`: decide con `tenderSemantics` si el
  // dinero entró al cajón, no lanza nunca, y es idempotente por paymentId.
  await timing.time('drawer', () =>
    postCashSaleToDrawer({
      venueId,
      paymentId: payment.id,
      method: payment.method,
      fundsFlow: payment.fundsFlow,
      tenderTypeId: payment.tenderTypeId,
      tenderCountsAsCash: payment.tenderCountsAsCash,
      status: payment.status,
      type: payment.type,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      staffId: payment.processedById,
      orderId: activeOrder.id,
    }),
  )

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  // S2 (Codex P2): un Payment nacido del webhook NO calcula costo aquí — queda PENDIENTE durable (efecto TRANSACTION_COST)
  // hasta acreditar la marca o vencer el plazo. «Sin costo» nunca se presenta como comisión cero.
  if (paymentData.registradoVia === 'webhook') {
    logger.info('⏳ [S2] Costo de transacción PENDIENTE (Payment nacido del webhook, sin marca acreditada)', { paymentId: payment.id })
    registrarConfirmacionAnomalaPorWebhook(s0.cierre, {
      venueId,
      requestId: paymentData.terminalPaymentRequestId ?? null,
      paymentId: payment.id,
      attemptId: paymentData.idempotencyKey ?? null,
      staffId: payment.processedById ?? null,
      amountCents: paymentData.amount,
      tipCents: paymentData.tip ?? 0,
    })
  } else {
    // Codex R4-4 / R5-3: UN solo criterio de cumplimiento para el costo síncrono — el MISMO del worker (costo persistido →
    // proyecciones en Payment y VenueTransaction → liquidación → reembolsos). La obligación se cierra SÓLO al converger; si
    // falta la liquidación o la tarifa no es acreditable, queda PENDIENTE y visible con su motivo. Nunca interrumpe el cobro.
    await timing.time('transaction_cost', () => asegurarCostoSincrono(payment.id))
  }

  // Create Review record if reviewRating is provided
  if (payment.status !== 'COMPLETED' && paymentData.reviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(paymentData.reviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: activeOrder.venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: validatedStaffId, // vendedor validado; no confiar en el body crudo
          },
        })
        logger.info('Review created successfully', { paymentId: payment.id, rating, originalRating: paymentData.reviewRating })
      } else {
        logger.warn('Invalid review rating provided', { paymentId: payment.id, rating: paymentData.reviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await timing.time('canonical_receipt', () => generateDigitalReceipt(payment.id))
    logger.info('Digital receipt generated for payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // 🔌 REAL-TIME: Emit socket events based on payment status
  try {
    const paymentPayload = {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      timestamp: new Date().toISOString(),
      tableId: activeOrder.tableId,
      metadata: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
      },
    }

    // Emit appropriate event based on payment status
    if (payment.status === 'COMPLETED') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_COMPLETED, paymentPayload)
      logger.info('🔌 PAYMENT_COMPLETED event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
        elapsedMs: elapsedMs(),
      })

      // Create commission calculation for this payment (non-blocking)
      if (payment.type !== 'TEST') {
        // Real-time auto-reorder: if this sale left any ingredient at/below its
        // reorder point, create the PO + email the supplier right away instead of
        // waiting for the nightly job. Non-blocking (never affects the payment)
        // and self-gated — the run checks AUTO_REORDER feature + PREMIUM tier +
        // config.enabled and skips items that already have an open PO.
        runAutoReorderForVenue(activeOrder.venueId).catch(err => {
          logger.error('Failed to run real-time auto-reorder after payment', {
            paymentId: payment.id,
            venueId: activeOrder.venueId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else if (payment.status === 'PROCESSING') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_PROCESSING, paymentPayload)
      logger.info('🔌 PAYMENT_PROCESSING event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })
    } else if (payment.status === 'FAILED') {
      socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.PAYMENT_FAILED, {
        ...paymentPayload,
        errorMessage: 'Payment failed during processing',
      })
      logger.warn('🔌 PAYMENT_FAILED event emitted', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        amount: payment.amount,
      })
    }

    // Emit order updated event to venue room
    socketManager.broadcastToVenue(activeOrder.venueId, SocketEventType.ORDER_UPDATED, {
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      status: activeOrder.status,
      paymentStatus: activeOrder.paymentStatus,
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      orderNumber: activeOrder.orderNumber,
      venueId: activeOrder.venueId,
      paymentStatus: payment.status,
    })
  } catch (error) {
    logger.error('Failed to emit socket events', {
      paymentId: payment.id,
      orderId: activeOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  // ✅ NUEVO: Detectar modo de operación y manejar pago según el contexto
  const isIntegratedMode = activeOrder.source === OrderSource.POS && activeOrder.externalId && activeOrder.externalId.trim() !== ''

  logger.info('Payment processing mode detected', {
    paymentId: payment.id,
    orderId: activeOrder.id,
    isIntegratedMode,
    orderSource: activeOrder.source,
    hasExternalId: !!activeOrder.externalId,
  })

  if (isIntegratedMode) {
    // MODO INTEGRADO: Enviar comando a POS, POS maneja los totales
    try {
      const isPartialPayment = totalAmount + tipAmount < parseFloat(activeOrder.total.toString())

      await timing.time('sr_apply', () =>
        publishCommand(`command.softrestaurant.${venueId}`, {
          entity: 'Payment',
          action: 'APPLY',
          payload: {
            orderExternalId: activeOrder.externalId,
            paymentData: {
              amount: totalAmount,
              tip: tipAmount,
              posPaymentMethodId: mapPaymentMethodToPOS(classicMethod),
              reference: paymentData.mentaOperationId || paymentData.authorizationNumber || '',
              isPartial: isPartialPayment,
            },
          },
        }),
      )

      // Track this payment command to prevent double deduction when POS sends back order.updated
      if (activeOrder.externalId) {
        trackRecentPaymentCommand(activeOrder.externalId, totalAmount + tipAmount)
      }

      logger.info('Payment command sent to POS (Integrated Mode)', {
        paymentId: payment.id,
        orderExternalId: activeOrder.externalId,
        isPartial: isPartialPayment,
      })
    } catch (rabbitMQError) {
      logger.error('Failed to send payment command to POS', {
        paymentId: payment.id,
        error: rabbitMQError,
      })
      // No fallar el pago si RabbitMQ falla
    }
  } else {
    // MODO AUTÓNOMO: Backend maneja los totales directamente
    try {
      const capturedAreaCheckout = lockedAreaCheckout as {
        sessionId: string
        attemptId: string
      } | null

      if (capturedAreaCheckout && payment.status === 'COMPLETED') {
        try {
          areaTicketCheckoutState = await finalizeCapturedAreaTicketPayment({
            venueId,
            orderId: activeOrder.id,
            paymentId: payment.id,
            sessionId: capturedAreaCheckout.sessionId,
            attemptId: capturedAreaCheckout.attemptId,
            staffId: validatedStaffId,
          })
        } catch (finalizationError) {
          // El proveedor ya confirmó el dinero. Nunca habilitar otro cobro:
          // congela la sesión y conserva el mismo intento para conciliación.
          await markAreaTicketPaymentForReconciliation({
            venueId,
            sessionId: capturedAreaCheckout.sessionId,
            attemptId: capturedAreaCheckout.attemptId,
            paymentId: payment.id,
          })
          logger.error('[AREA TICKETS v7] Pago capturado; finalización requiere conciliación', {
            venueId,
            orderId,
            paymentId: payment.id,
            checkoutSessionId: capturedAreaCheckout.sessionId,
            error: finalizationError instanceof Error ? finalizationError.message : String(finalizationError),
          })
          areaTicketCheckoutState = 'RECONCILIATION_REQUIRED'
        }
        if (areaTicketCheckoutState !== 'RECONCILIATION_REQUIRED') {
          try {
            // The atomic area-ticket transaction already persisted totals and
            // inventory. Re-enter only the coupon/referral/loyalty side effects.
            await updateOrderTotalsForStandalonePayment(activeOrder.id, totalAmount + tipAmount, tipAmount, payment.id, validatedStaffId, {
              areaTicketAlreadyFinalized: true,
              venueId,
            })
          } catch (sideEffectError) {
            logger.error('[AREA TICKETS v7] El pago finalizó, pero fallaron efectos secundarios no monetarios', {
              venueId,
              orderId,
              paymentId: payment.id,
              error: sideEffectError instanceof Error ? sideEffectError.message : String(sideEffectError),
            })
          }
        }
      } else {
        // ✅ FIX: Pass payment ID to exclude it from previousPayments calculation
        // ⭐ LOYALTY: Pass staffId for loyalty points attribution
        // ✅ FIX: Pass tipAmount separately to update order.tipAmount
        inventoryWarning = await updateOrderTotalsForStandalonePayment(
          activeOrder.id,
          totalAmount + tipAmount,
          tipAmount,
          payment.id,
          validatedStaffId,
          { venueId, committedSettlement: committedStandaloneSettlement },
        )
      }

      logger.info('Order totals updated directly in backend (Standalone Mode)', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        paymentAmount: totalAmount + tipAmount,
        elapsedMs: elapsedMs(),
      })
    } catch (updateError: any) {
      // ⚠️ Este re-throw ya NO puede alcanzar al inventario, y es a propósito.
      //
      // Decía "Validation errors should FAIL the payment", pero para cuando este
      // catch corre el Payment lleva rato comiteado: fallar aquí no des-cobra la
      // tarjeta, sólo le miente al cajero — que vuelve a pasarla con
      // `idempotencyKey`/`referenceNumber` nuevos y produce el doble cobro. Por eso
      // `updateOrderTotalsForStandalonePayment` ya no lanza por inventario: devuelve
      // un `inventoryWarning` que viaja en la respuesta 201.
      //
      // El clause se conserva como guard LATENTE, no como vía viva: a hoy (2026-08-12)
      // NINGUNA ruta post-commit produce `BadRequestError`/`NotFoundError`. Se verificó
      // una por una — el inventario ya no lanza; la rama de area tickets envuelve
      // `finalizeCapturedAreaTicketPayment` en su propio try/catch y lo único que queda
      // suelto ahí (`markAreaTicketPaymentForReconciliation`) sólo puede tronar con
      // errores de Prisma; el resto de `updateOrderTotalsForStandalonePayment` va en
      // try/catch. Su único throw propio vivo es el `Error` pelón de "order not found
      // for total update", que NO es BadRequest/NotFound y por diseño cae abajo sin
      // tumbar el cobro.
      //
      // 🔴 Si algún día vuelves a meter aquí un `BadRequestError` post-commit, estás
      // reabriendo el doble cobro: el POS pinta error sobre dinero que YA entró.
      // Devuelve un aviso en la respuesta (`inventoryWarning`), no un error.
      //
      // Lo que SÍ puede tronar hoy con el Payment ya comiteado es el `throw error` del
      // catch de `prisma.$transaction` (commit en duda: se pierde el ack, se cae la
      // conexión). Por eso el fallback de `recordFastPayment` sigue siendo necesario y
      // está anclado justo con ese escenario en `fastPaymentDelegation.test.ts`.
      if (updateError instanceof BadRequestError || updateError instanceof NotFoundError) {
        logger.error('❌ Payment rejected: Business validation failed', {
          paymentId: payment.id,
          orderId: activeOrder.id,
          error: updateError.message,
          reason: 'VALIDATION_ERROR',
        })
        throw updateError // Re-throw to fail the payment
      }

      logger.error('Failed to update order totals in standalone mode', {
        paymentId: payment.id,
        orderId: activeOrder.id,
        error: updateError,
      })
      // Continue execution - payment is still recorded even if total update fails (infrastructure error only)
    }
  }

  logger.info('Payment recorded successfully', { paymentId: payment.id, amount: totalAmount, elapsedMs: elapsedMs() })

  // 🪝 Backfill any Blumon webhook that arrived BEFORE this Payment was recorded.
  // Fire-and-forget — never block the API response on reconciliation. The cron
  // worker (`BlumonWebhookReconciliationJob`) is the safety net if this fails.
  void import('./blumon-webhook.service').then(({ reconcileWebhooksForPayment }) =>
    reconcileWebhooksForPayment({
      id: payment.id,
      processorId: payment.processorId,
      referenceNumber: payment.referenceNumber,
      venueId,
    }).catch(err => {
      logger.error('🪝 [Blumon backfill] Failed to reconcile pending webhooks for order payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // 🪝 Backfill any AngelPay webhook that arrived BEFORE this Payment was recorded.
  // AngelPay fires on charge-approval; the TPV records only after the cashier
  // dismisses AngelPay's success screen — often minutes later. No-op for non-AngelPay
  // payments (no matching pending webhook will exist).
  void import('./angelpay-webhook.service').then(({ reconcileAngelPayWebhookForPayment }) =>
    reconcileAngelPayWebhookForPayment({
      id: payment.id,
      idempotencyKey: payment.idempotencyKey,
      referenceNumber: payment.referenceNumber,
      venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      merchantAccountId: payment.merchantAccountId,
    }).catch(err => {
      logger.error('🪝 [AngelPay backfill] Failed to reconcile pending webhooks for order payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  const autofacturaAvailable = digitalReceipt ? await timing.time('autofactura', () => resolveAutofacturaAvailable(orderId)) : false
  timing.end(payment.id)

  // Add digital receipt info to payment response
  return {
    ...payment,
    ...(areaTicketCheckoutState ? { areaTicketCheckoutState } : {}),
    // Aditivo y con spread condicional (mismo criterio que `areaTicketCheckoutState`):
    // la llave está AUSENTE cuando no hay nada que avisar, así que ninguna app vieja
    // en la calle cambia de comportamiento.
    ...(inventoryWarning ? { inventoryWarning } : {}),
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${digitalReceipt.accessKey}`,
          autofacturaAvailable,
        }
      : null,
  }
}

/**
 * ¿El Payment de ESTA llamada quedó comiteado?
 *
 * - `landed`       — sí, con certeza. NO se cae a FAST (duplicaría).
 * - `not-landed`   — no. Se cae a FAST (el dinero tiene que aterrizar en algún lado).
 * - `unverifiable` — el payload no trae NINGUNA llave de identidad y tampoco se pudo
 *                    censar la orden. Se cae a FAST: perder un cobro es peor que
 *                    duplicar un registro (ver `verifyDelegatedPaymentLanded`).
 */
type DelegatedPaymentVerdict = 'landed' | 'not-landed' | 'unverifiable'

/** ¿El payload trae con qué probar identidad? Hoy la TPV SIEMPRE manda `idempotencyKey`. */
function hasPaymentIdentityKey(paymentData: PaymentCreationData): boolean {
  return !!(paymentData.idempotencyKey || paymentData.referenceNumber)
}

/**
 * Censo de los pagos que la orden YA tenía antes de delegar.
 *
 * Sólo se usa para payloads SIN llave de identidad — o sea, nunca en producción: la TPV
 * manda `idempotencyKey` en todo cobro (`buildFastPaymentContext`) y las reposiciones de
 * la cola offline mandan `referenceNumber`. Es la red para un cliente que no cumpla el
 * contrato, no un camino caliente: con llave, esta consulta NO corre.
 *
 * Fail-open: si truena, devuelve null → el veredicto será `unverifiable` → FAST.
 */
async function snapshotOrderPaymentIds(venueId: string, orderId: string): Promise<Set<string> | null> {
  try {
    const rows = await prisma.payment.findMany({ where: { venueId, orderId }, select: { id: true } })
    return new Set(rows.map(r => r.id))
  } catch (err) {
    logger.error('⚠️ [FastPayment] No se pudo censar los pagos de la orden antes de delegar', {
      venueId,
      orderId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/**
 * ¿MI pago comiteó? Se le pregunta a la tabla `Payment` por IDENTIDAD.
 *
 * 🔴 Por qué NO se le pregunta a la fila de arbitraje: `TerminalPaymentRequest.paymentId`
 * es un binding HEURÍSTICO por diseño de este repo, no una prueba de identidad.
 *   · El watchdog (`terminal-payment.service.ts`) ata CUALQUIER Payment COMPLETED + tarjeta
 *     + posterior a la fila sobre esa orden; su propio comentario dice que un binding
 *     exacto "tendría que venir de una referencia request↔payment, no de aritmética".
 *   · `closeRow` escribe el paymentId que reporte la terminal por socket, y ese campo del
 *     resultado es opcional.
 *   · En el schema es `paymentId String?` "(soft ref)", sin FK.
 *
 * Leer EXISTENCIA en esa fila contesta "¿hay ALGÚN paymentId?", no "¿está el MÍO?" — y se
 * equivoca en las DOS direcciones, las dos caras:
 *   · paymentId AJENO + throw TEMPRANO (nada escrito) → creeríamos que aterrizó, no
 *     caeríamos a FAST, y el cobro no quedaría registrado en NINGÚN lado. Ésa es
 *     exactamente la regresión que este fallback vino a evitar.
 *   · Fila ya COMPLETED con paymentId NULO + throw POST-commit → creeríamos que no
 *     aterrizó y caeríamos a FAST: DOS Payments. Y no es teórico ni raro:
 *     `closeRowFromPaymentTx` retorna SIN escribir cuando la fila ya está COMPLETED
 *     (deliberado y ya testeado en `terminal-payment.service.test.ts`), y un resultado por
 *     socket con `status:'success'` sin paymentId deja la fila justo así ANTES de que la
 *     TPV registre por REST. Es una vía MAINLINE.
 *
 * La llave con la que se verifica aquí es la MISMA con la que la ruta FAST deduplica más
 * abajo, así que un falso negativo NO duplica: FAST encuentra el pago ya comiteado y lo
 * devuelve. Por eso, ante la duda, caer a FAST es la dirección segura.
 *
 * Sin ninguna llave, el último recurso es el censo antes/después de la orden: si apareció
 * un pago que no estaba, fue el nuestro.
 */
async function verifyDelegatedPaymentLanded(
  venueId: string,
  orderId: string,
  paymentData: PaymentCreationData,
  paymentIdsBeforeDelegation: Set<string> | null,
): Promise<DelegatedPaymentVerdict> {
  // Identidad exacta: `@@unique([venueId, idempotencyKey])` en Payment.
  if (paymentData.idempotencyKey) {
    const mine = await prisma.payment.findFirst({
      where: { venueId, orderId, idempotencyKey: paymentData.idempotencyKey },
      select: { id: true },
    })
    return mine ? 'landed' : 'not-landed'
  }

  // Igual que el Check 2 de idempotencia de FAST: los refunds comparten
  // `referenceNumber` con el original, por eso se excluyen.
  if (paymentData.referenceNumber) {
    const mine = await prisma.payment.findFirst({
      where: { venueId, orderId, referenceNumber: paymentData.referenceNumber, ...SIN_REEMBOLSOS },
      select: { id: true },
    })
    return mine ? 'landed' : 'not-landed'
  }

  if (paymentIdsBeforeDelegation) {
    const after = await prisma.payment.findMany({ where: { venueId, orderId }, select: { id: true } })
    return after.some(p => !paymentIdsBeforeDelegation.has(p.id)) ? 'landed' : 'not-landed'
  }

  return 'unverifiable'
}

/**
 * Record a fast payment (without specific table association)
 * @param venueId Venue ID
 * @param paymentData Payment creation data
 * @param userId User ID who processed the payment
 * @param orgId Organization ID
 * @returns Created payment
 */
export async function recordFastPayment(venueId: string, paymentData: PaymentCreationData, userId?: string, _orgId?: string) {
  const timing = paymentStepTimer(venueId, paymentData.terminalPaymentRequestId)
  logger.info('Recording fast payment', { venueId, amount: paymentData.amount, paymentData })

  // 🔴 EL CLIENTE EFECTIVO de esta venta. Por defecto, el que mandó quien registra el
  // cobro; si no vino y la solicitud de arbitraje trae uno sembrado por el POS, ése.
  //
  // Sin `terminalPaymentRequestId` esta variable NUNCA cambia, así que el camino de
  // EFECTIVO y el de las TPV viejas quedan byte por byte iguales a como estaban.
  let effectiveCustomerId: unknown = paymentData.customerId
  let relayProcessedByStaffId: string | undefined
  let effectiveReviewRating = paymentData.reviewRating

  // 🔴 ¿Este dinero pertenece a una venta que YA existe? El cajero pudo mandar el cobro
  // desde el POS, cancelar, y la terminal cobrar igual. Ese cobro es de la venta que lo
  // originó —con sus productos—, no de una venta sintética vacía. La solicitud de
  // arbitraje guarda el `orderId`; hasta hoy sólo se usaba para cerrar la fila.
  //
  // Fail-open a propósito: si la consulta truena, se sigue por FAST. Un fallo de infra
  // jamás puede impedir registrar dinero que YA se cobró.
  if (paymentData.terminalPaymentRequestId) {
    let arbitrationRow: {
      orderId: string | null
      venueId: string
      status: string
      customerId: string | null
      processedByStaffId: string | null
      rating: number | null
    } | null = null
    try {
      arbitrationRow = await prisma.terminalPaymentRequest.findFirst({
        where: { requestId: paymentData.terminalPaymentRequestId, venueId },
        // 🔑 `customerId` es el cliente que el POS eligió antes de mandar el cobro a la
        // terminal. La TPV registra el pago con SU payload, que no lo lleva — sin esto,
        // la venta con tarjeta nace anónima mientras la misma venta en efectivo sí trae
        // cliente.
        select: { orderId: true, venueId: true, status: true, customerId: true, processedByStaffId: true, rating: true },
      })
    } catch (err) {
      logger.error('⚠️ [FastPayment] No se pudo leer la solicitud de arbitraje — se sigue como venta rápida', {
        requestId: paymentData.terminalPaymentRequestId,
        error: err instanceof Error ? err.message : String(err),
      })
    }

    const target = resolveFastPaymentTarget(arbitrationRow, venueId)

    // 🔑 El del BODY GANA sobre el de la fila: es el dato más fresco (el cajero lo acaba
    // de elegir), mientras la fila puede llevar minutos escrita. `target.seededCustomerId`
    // ya pasó por el MISMO candado de inquilino que la orden — una fila de otro venue no
    // presta ni su orden ni su cliente.
    effectiveCustomerId = normalizeRequestedCustomerId(paymentData.customerId) ?? target.seededCustomerId
    if (arbitrationRow?.rating != null) effectiveReviewRating = String(arbitrationRow.rating)

    // La identidad elegida en el POS es la autoridad del relay. Se valida otra vez
    // al registrar porque pudo desactivarse mientras el cliente pasaba la tarjeta.
    // Si ya no es válida, el dinero NO se pierde: se degrada a la identidad autenticada
    // de la TPV y se levanta una alerta de conciliación.
    if (arbitrationRow?.processedByStaffId) {
      try {
        relayProcessedByStaffId = await validateStaffVenue(arbitrationRow.processedByStaffId, venueId)
      } catch (error) {
        logger.error('🚨 [Terminal-payment] El vendedor congelado ya no está activo; se usará el operador de la TPV', {
          requestId: paymentData.terminalPaymentRequestId,
          processedByStaffId: arbitrationRow.processedByStaffId,
          venueId,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }

    // 🔴 `requestId` es `@unique` GLOBAL y lo genera el cliente: una colisión entre
    // inquilinos devolvería el `orderId` de OTRO negocio. Se degrada a venta rápida —
    // el dinero se registra en el venue del token, nunca cruzando la frontera — y se
    // alerta, porque una colisión así no debería ocurrir jamás.
    if (target.kind === 'fastOrder' && target.reason === 'venueMismatch') {
      logger.error(
        '🚨 [FastPayment] La solicitud de arbitraje pertenece a OTRO venue — se ignora su orden y se registra como venta rápida',
        {
          requestId: paymentData.terminalPaymentRequestId,
          expectedVenueId: venueId,
          rowVenueId: arbitrationRow?.venueId,
        },
      )
    }

    if (target.kind === 'existingOrder') {
      logger.info('🎯 [FastPayment] El cobro pertenece a una venta existente — no se crea venta rápida', {
        requestId: paymentData.terminalPaymentRequestId,
        orderId: target.orderId,
        priorStatus: arbitrationRow?.status,
      })
      // recordOrderPayment ya sabe descontar inventario, cerrar la orden, actualizar el
      // turno y cerrar la fila de arbitraje. No se reimplementa nada de eso aquí.
      //
      // 🔴 `return await` (no `return` a secas): así el try/catch de abajo SÍ atrapa
      // un rechazo de esta promesa. Con `return recordOrderPayment(...)` a secas, el
      // catch nunca vería el error — se propagaría directo al llamador.
      const requestId = paymentData.terminalPaymentRequestId
      // Sólo para payloads SIN llave de identidad (nunca en producción — ver
      // `snapshotOrderPaymentIds`): con llave, esta consulta NO corre.
      const paymentIdsBeforeDelegation = hasPaymentIdentityKey(paymentData) ? null : await snapshotOrderPaymentIds(venueId, target.orderId)
      try {
        const delegated = await recordOrderPayment(
          venueId,
          target.orderId,
          {
            ...paymentData,
            ...(relayProcessedByStaffId ? { staffId: relayProcessedByStaffId } : {}),
            ...(effectiveReviewRating ? { reviewRating: effectiveReviewRating } : {}),
          },
          userId,
          _orgId,
        )
        // El cliente que eligió el cajero también cuenta cuando el cobro pertenece a una
        // venta que YA existe. Sólo RELLENA (nunca reasigna) y nunca lanza, así que no
        // altera la semántica del catch de abajo. Así `customerLink` viaja en TODAS las
        // respuestas exitosas de `/fast` y el cliente móvil no tiene que adivinar.
        const customerLink = await linkCustomerToExistingOrder(venueId, target.orderId, effectiveCustomerId)
        return { ...delegated, customerLink }
      } catch (err) {
        // 🔴 La tarjeta YA se cobró. Antes de esta delegación, ese dinero por lo menos
        // aterrizaba en una venta FAST. Si recordOrderPayment truena por dentro —
        // pre-flight de inventario rechazando por stock insuficiente, venue con
        // ventas deshabilitadas, split incompatible, orden no encontrada— y se deja
        // propagar el error, el cobro no aterriza en NINGÚN lado: sería una regresión
        // que introduciríamos nosotros, dejando el sistema peor que antes de este
        // cambio. Una venta FAST vacía es mala; ninguna venta es peor. Por eso se cae
        // a la ruta FAST de siempre en vez de propagar... PERO SÓLO si el pago no
        // aterrizó ya. Ver el chequeo de abajo.
        //
        // 🔴 [Ronda 2] recordOrderPayment puede tronar DESPUÉS de que su propia
        // transacción ya comitió el Payment: `updateOrderTotalsForStandalonePayment`
        // corre un pre-flight de inventario FUERA de la transacción (rama "autónoma"
        // — MODO AUTÓNOMO más abajo en recordOrderPayment) y, si rechaza por stock
        // insuficiente, el catch de recordOrderPayment relanza BadRequestError /
        // NotFoundError con el Payment YA escrito en firme. Caer a FAST en ESE caso
        // duplicaría el cobro — y sólo se salvaría si paymentData trae
        // idempotencyKey/referenceNumber (los checks de idempotencia de FAST, arriba
        // en esta misma función, encontrarían el pago ya comitteado y lo devolverían
        // en vez de duplicar). Que la TPV siempre mande uno de los dos es una
        // suposición operativa, no una invariante forzada — no basta como red.
        //
        // La señal real NO es la fila de arbitraje: su `paymentId` es un binding
        // heurístico que ni prueba que MI pago comiteó (puede traer uno AJENO) ni
        // prueba que no (llega a COMPLETED con paymentId nulo por vía mainline). Se
        // le pregunta a la tabla `Payment` por IDENTIDAD — el razonamiento completo,
        // con las dos formas de equivocarse y lo que cuesta cada una, está en
        // `verifyDelegatedPaymentLanded`.
        let verdict: DelegatedPaymentVerdict = 'unverifiable'
        try {
          verdict = await verifyDelegatedPaymentLanded(venueId, target.orderId, paymentData, paymentIdsBeforeDelegation)
        } catch (checkErr) {
          // No se pudo verificar. Fail-open consistente con el resto de esta función
          // (nunca perder un cobro por un fallo de infraestructura): se sigue a FAST,
          // donde los checks de idempotencia vuelven a mirar por la MISMA llave y
          // devuelven el pago existente en vez de duplicarlo.
          logger.error(
            '🚨 [FastPayment] No se pudo confirmar si el pago ya aterrizó tras el fallo de recordOrderPayment — se sigue a FAST bajo incertidumbre',
            {
              requestId,
              orderId: target.orderId,
              originalError: err instanceof Error ? err.message : String(err),
              verificationError: checkErr instanceof Error ? checkErr.message : String(checkErr),
            },
          )
        }

        if (verdict === 'landed') {
          // El dinero SÍ quedó registrado en su venta real — el fallo es del
          // pre-flight posterior (inventario, etc.), no del cobro en sí. Se deja
          // subir el error ORIGINAL tal cual para que el llamador vea la razón real,
          // en vez de disfrazarlo con un segundo Payment.
          //
          // 🚨 = el token estable que Better Stack usa para alertar (mismo patrón
          // que terminal-payment.service.ts).
          logger.error('🚨 [FastPayment] recordOrderPayment tronó DESPUÉS de comitear el pago — NO se cae a FAST (evita duplicar)', {
            requestId,
            orderId: target.orderId,
            error: err instanceof Error ? err.message : String(err),
          })
          throw err
        }

        // 🚨 = el token estable que Better Stack usa para alertar (mismo patrón que
        // terminal-payment.service.ts) — un cobro que no pudo aterrizar en su venta
        // real necesita que alguien lo revise, aunque el dinero SÍ quede registrado.
        //
        // `unverifiable` se distingue del `not-landed` limpio: significa que el
        // payload no traía NINGUNA llave de identidad (contrato incumplido — la TPV
        // siempre manda `idempotencyKey`) y tampoco hubo censo. Se cae a FAST igual,
        // porque perder el cobro es peor: el POS le diría al cajero que la venta
        // sigue sin pagar y volvería a pasar la tarjeta — un doble cobro REAL. Sin
        // llave, además, FAST no tiene con qué deduplicar, así que el residual de
        // duplicar el REGISTRO se acepta a cambio de no perder el DINERO.
        logger.error('🚨 [FastPayment] recordOrderPayment tronó al delegar — el cobro cae a venta rápida para no perderse', {
          requestId,
          orderId: target.orderId,
          verdict,
          error: err instanceof Error ? err.message : String(err),
        })
      }
    }
  }

  // ⏱️ SOLO MEDICIÓN (2026-08-09). Prod: mediana 4,471 ms / p95 4,971 ms contra
  // 130 ms de red real México→Oregon: ~97% del tiempo es trabajo del servidor,
  // no internet. Antes de mover algo a segundo plano hay que saber QUÉ fase
  // pesa. No cambia orden, valores ni manejo de errores.
  const t = new PhaseTimer('recordFastPayment', { venueId, method: paymentData.method })

  // 🛡️ IDEMPOTENCY CHECK - Layered defense (Stripe/Square/Toast pattern)
  //
  // Check 1 (preferred):  idempotencyKey — client-generated UUID v4 per logical
  //                       payment attempt. TPV >= v1.10.10 sends this.
  // Check 2 (fallback):   referenceNumber — Blumon-generated per-transaction id.
  //                       Both legacy TPV (< v1.10.10) AND new TPV send this.
  //
  // BOTH checks run in sequence (not exclusively). This is crucial for the
  // legacy→new TPV transition: if a payment exists from an old TPV client (no
  // idempotencyKey) and a new TPV client sends a retry with the same ref but a
  // new idempotencyKey, Check 2 catches it and returns the existing payment
  // instead of creating a duplicate.
  //
  // If a concurrent request races past BOTH fast-path checks, the @@unique
  // constraint on (venueId, idempotencyKey) in the Payment table will throw
  // P2002 and we catch that below as the atomic safety net.
  // Codex R6-1: la afiliación DEFINITIVA se resuelve ANTES de deduplicar (misma regla que en la ruta de orden).
  const afiliacion = await resolverAfiliacionDelCobro('FastPayment', venueId, null, paymentData)
  paymentData.merchantAccountId = afiliacion.merchantAccountId
  // Codex R7-2: la identidad de afiliación que mandó el APK viaja con el entrante (consolidación y huella la contrastan como conjunto).
  ;(paymentData as RegistroEntrante).merchantAccountIdDelApk = afiliacion.merchantAccountIdDelApk ?? null

  if (paymentData.idempotencyKey) {
    const existingByKey = await prisma.payment.findUnique({
      where: {
        venueId_idempotencyKey: {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
        },
      },
      include: { receipts: true },
    })

    if (existingByKey) {
      logger.info('🔄 Idempotent retry detected by idempotencyKey — returning existing payment', {
        venueId,
        idempotencyKey: paymentData.idempotencyKey,
        existingPaymentId: existingByKey.id,
      })
      // 🔑 El reintento NO vuelve a cobrar, pero SÍ puede rellenar el cliente que faltaba:
      // si el primer intento entró anónimo, sin esto la venta se quedaba sin cliente para
      // siempre (la idempotencia devuelve el pago y nadie vuelve a mirar). Rellenar es
      // aditivo y no toca dinero; reasignar está prohibido (ver `fastPaymentCustomer.ts`).
      const customerLink = await linkCustomerToExistingOrder(venueId, ordenPropia(existingByKey), effectiveCustomerId)
      return {
        ...((await consolidarRegistroRepetido(existingByKey, paymentData as RegistroEntrante, venueId, null)) ?? existingByKey),
        digitalReceipt: await ensureDigitalReceiptResponse(existingByKey.id, existingByKey.receipts[0]),
        customerLink,
      }
    }
  }

  let colisionDeReferencia: ColisionDeReferenciaRegistrada['candidates'] | null = null
  /** Codex R4 (P2): recibo y cliente del Payment RESUELTO, nunca del candidato con el que se entró. */
  const devolverExistentePorReferencia = async (existingPayment: Payment & { receipts: DigitalReceipt[] }) => {
    logger.warn('🔄 Duplicate payment attempt detected (referenceNumber check)', {
      venueId,
      referenceNumber: paymentData.referenceNumber,
      existingPaymentId: existingPayment.id,
      incomingIdempotencyKey: paymentData.idempotencyKey || null,
      existingIdempotencyKey: existingPayment.idempotencyKey || null,
      message: 'Returning existing payment (safe retry / legacy→new TPV transition)',
    })
    // Ronda 2 (P1): el existente puede estar ligado a una solicitud ya liberada sin haberla podido ligar.
    await retenerSiQuedoSinLigar(existingPayment, paymentData)

    // Return existing payment with receipt (safe retry - client gets same response)
    // Mismo relleno de cliente que el check por `idempotencyKey`: un reintento legacy
    // (TPV < v1.10.10, sin llave) también puede traer el cliente que faltaba.
    const customerLink = await linkCustomerToExistingOrder(venueId, ordenPropia(existingPayment), effectiveCustomerId)
    return {
      ...existingPayment,
      digitalReceipt: await ensureDigitalReceiptResponse(existingPayment.id, existingPayment.receipts[0]),
      customerLink,
    }
  }
  /** Los argumentos de la resolución por referencia: los MISMOS antes de la transacción y en la relectura bajo el candado (R12-7). */
  let argumentosDeReferencia: Parameters<typeof resolverPorReferencia>[0] | null = null
  if (paymentData.referenceNumber) {
    // Always-on referenceNumber check — catches:
    //   (a) Legacy TPV retries (no idempotencyKey sent)
    //   (b) Transition-period retries (new TPV sends a fresh key, but the payment
    //       was already created by the legacy client with no key)
    // S0-a: misma regla que en la ruta de orden; en venta rápida no hay orden objetivo (queda fuera de la comparación).
    // Codex R2 (P1-1): todos los candidatos de la referencia, acotados; se elige el de identidad suficiente.
    const huellaEntrante: HuellaDelCobro = {
      orderId: null,
      amountPesos: paymentData.amount / 100,
      tipPesos: (paymentData.tip ?? 0) / 100,
      merchantAccountId: afiliacion.merchantAccountId ?? null,
      merchantAccountIdDelApk: afiliacion.merchantAccountIdDelApk ?? null,
      authorizationNumber: paymentData.authorizationNumber ?? null,
      idempotencyKey: paymentData.idempotencyKey ?? null,
      terminalSerial: paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
      terminalPaymentRequestId: paymentData.terminalPaymentRequestId ?? null,
    }
    argumentosDeReferencia = {
      etiqueta: 'FastPayment',
      venueId,
      referenceNumber: paymentData.referenceNumber,
      targetOrderId: null,
      huella: huellaEntrante,
      paymentData: paymentData as RegistroEntrante,
    }
    // Codex R4 (R4-1/R4-2/R4-6): misma resolución que en la ruta de orden (demostrar o no demostrar; nunca crear a ciegas).
    const resolucion = await resolverPorReferencia(argumentosDeReferencia)
    if (resolucion.kind === 'EXISTENTE') return devolverExistentePorReferencia(resolucion.registro)
    if (resolucion.kind === 'COLISION') colisionDeReferencia = resolucion.contradicciones
  }

  await t.time('assertVenueSalesEnabled', () => assertVenueSalesEnabled(venueId))

  // Convert amounts from cents to decimal (Prisma expects Decimal)
  const totalAmount = paymentData.amount / 100
  const tipAmount = paymentData.tip / 100

  // ✅ CORRECTED: Use validateStaffVenue helper for proper staffId validation
  const validatedStaffId = await t.time('validateStaffVenue', () =>
    validateStaffVenue(relayProcessedByStaffId ?? paymentData.staffId, venueId, userId),
  )

  t.mark('idempotenciaYChequeosPrevios')

  // Map source from Android app format to PaymentSource enum
  const mapPaymentSource = (source?: string): PaymentSource => {
    if (!source) return 'OTHER'
    // Map "AVOQADO_TPV" from Android app to "TPV" enum value
    if (source === 'AVOQADO_TPV') return 'TPV'
    // Check if it's a valid PaymentSource enum value
    const validSources = ['TPV', 'DASHBOARD_TEST', 'QR', 'WEB', 'APP', 'PHONE', 'POS', 'OTHER']
    return validSources.includes(source) ? (source as PaymentSource) : 'OTHER'
  }

  // Codex R6-1: la afiliación ya está resuelta (arriba, antes de deduplicar); aquí sólo se lee.
  const merchantAccountId = afiliacion.merchantAccountId

  // Codex R3 (P1-3) / R5-2: la TARIFA se congela al cobrar — sobre la afiliación DEFINITIVA, la que queda tras TIER-2/3 —,
  // nunca sobre la que mandó el APK. Congelarla antes de la recuperación dejaba el snapshot (slot y tasas) de M1 en un
  // Payment atribuido a M2; sin snapshot de M2, el costo diferido caía al slot de M1 en cuanto M2 saliera de la configuración.
  // Codex R14-1: la tarifa se congela DENTRO de la transacción del dinero, con el candado del intento tomado (ver abajo).
  const llaveDelIntento = llaveDeIntento(paymentData.idempotencyKey)

  // ⭐ TERMINAL ATTRIBUTION: Resolve terminalId from device serial number
  // Links order and payment to the Terminal that processed them (for device-based reporting)
  let terminalId: string | null = null
  if (paymentData.deviceSerialNumber) {
    terminalId = await resolveTerminalIdFromSerial(venueId, paymentData.deviceSerialNumber)
  }

  // Same additive shadow snapshot as order payments. No existing consumer reads
  // these fields yet, so old cost/settlement behavior remains byte-for-byte intact.
  const internationalityShadow = classifyPaymentInternationalityShadow(paymentData)
  const internationalityClassifiedAt = internationalityShadow ? new Date() : undefined
  // Snapshot once: the nullable Shift claim and the Payment row must classify
  // the same state even if an awaited Order/tender hook mutates the request.
  const paymentStatusSnapshot = paymentData.status

  // 🔴 EL CLIENTE DE LA VENTA. Se resuelve ANTES de abrir la transacción (para no tener
  // una consulta de lectura dentro del bloqueo del cobro) y su resultado se escribe
  // DENTRO del mismo `order.create` de abajo — nunca en un attach posterior, que podría
  // fallar DESPUÉS de registrar el dinero y dejar la venta sin cliente, que es justo el
  // defecto que esto vino a arreglar.
  //
  // Un cliente inválido NO tumba el cobro: devuelve `orderData.customerId = null` y un
  // aviso en la respuesta. El dinero ya está en la caja. Detalle en `fastPaymentCustomer.ts`.
  const { link: customerLink, orderData: customerOrderData } = await t.time('resolveFastOrderCustomer', () =>
    resolveFastOrderCustomer(venueId, effectiveCustomerId),
  )
  const reconciliationEnabled = await resolvePaymentShiftReconciliationEnabled(prisma, venueId)

  // ⭐ ATOMICITY: Wrap critical fast payment creation in transaction (all or nothing)
  // This prevents orphaned records if any operation fails
  //
  // 🛡️ SAFETY NET: If two concurrent requests race past the idempotency fast-path
  // above, the @@unique([venueId, idempotencyKey]) constraint will throw P2002 on
  // the second request. We catch that below and return the winning payment, making
  // the concurrent retry behave exactly like an idempotent success.
  let payment: Awaited<ReturnType<typeof prisma.payment.create>> & { processedBy: any }
  let fastOrder: Awaited<ReturnType<typeof prisma.order.create>>
  const s0 = {
    segundaCaptura: null as SegundaCapturaRegistrada | null,
    colision: null as ColisionDeReferenciaRegistrada | null,
    cierre: null as CloseRowOutcome | null,
  }
  // 🔑 El tender resuelto se saca de la transacción a propósito: la respuesta al POS y
  // todo lo posterior tienen que ver el método REAL del cobro, no el que mandó el
  // cliente. (Aquí no hace falta para `payment.method` —ya viene del registro creado—
  // pero sí para no volver a leer el catálogo fuera de la tx.)
  const tenderState: { resolved: ResolvedTenderCharge | null } = { resolved: null }
  try {
    t.mark('turnoMerchantYTerminal')
    const result = await timing.time('financial_commit', () =>
      prisma.$transaction(async tx => {
        // Codex R14-1: PRIMERA sentencia — el candado del intento (ver la ruta de orden). Orden: intento → referencia →
        // TerminalPaymentRequest → Payment → Shift.
        if (llaveDelIntento) await candadoDeIntento(tx, llaveDelIntento)
        // Codex R12-7: un registro SIN llave se serializa por (venue, referencia) y vuelve a resolver ya con el candado.
        if (!paymentData.idempotencyKey && argumentosDeReferencia) {
          colisionDeReferencia = await exclusionPorReferencia(tx, argumentosDeReferencia)
        }
        // Codex R3 (P1-3) / R5-2 / R14-1: la TARIFA se congela aquí, bajo el candado (primera evidencia durable o «ahora»).
        const tarifa = merchantAccountId
          ? await tarifaDeLaAfiliacion(tx, venueId, merchantAccountId, paymentData)
          : { slot: null, pricing: null }
        paymentData.pricingSlot = tarifa.slot
        paymentData.pricing = tarifa.pricing
        // En venta rápida la Order y el Payment nacen juntos. Sólo COMPLETED es
        // dinero capturado y puede reclamar; los demás estados nacen sin turno y
        // sin anomalía post-cierre. Cuando aplica, el claim debe ganar antes de
        // crear cualquiera de los dos para que compartan el mismo id seguro.
        const shiftAmount = new Prisma.Decimal(totalAmount)
        const shiftTip = new Prisma.Decimal(tipAmount)
        // S0 (Codex): en venta rápida no hay Order previa — el arbitraje empieza en la solicitud, ANTES del turno y de
        // crear cualquier cosa. Una segunda captura cuelga de la venta materializada por el GANADOR: nunca otra venta.
        let ligarSolicitud = false
        if (paymentData.terminalPaymentRequestId) {
          const arbitraje = await arbitrarSinPerderElCobro(tx, {
            requestId: paymentData.terminalPaymentRequestId,
            venueId,
            attemptKey: paymentData.idempotencyKey ?? null,
            targetOrderId: null,
            authenticatedSerial: paymentData.authenticatedTerminalSerial ?? null,
          })
          if (arbitraje.kind === 'RETRY_OF_WINNER') throw new ReintentoDelGanadorDeLaSolicitud(arbitraje.winnerPaymentId)
          if (arbitraje.kind === 'SECOND_CAPTURE') {
            const ventaDelGanador = await tx.order.findFirst({ where: { id: arbitraje.winnerOrderId, venueId } })
            if (ventaDelGanador) {
              s0.segundaCaptura = {
                requestId: arbitraje.row.requestId,
                winnerPaymentId: arbitraje.winnerPaymentId,
                winnerIdempotencyKey: arbitraje.winnerIdempotencyKey,
              }
              const evidencia = await crearEvidenciaDeSegundaCaptura(tx, {
                venueId,
                orderId: ventaDelGanador.id,
                arbitraje,
                paymentData,
                totalAmount,
                tipAmount,
                method: paymentData.method as PaymentMethod,
                merchantAccountId,
                terminalId,
                staffId: validatedStaffId,
              })
              // Sale por la respuesta específica de la segunda captura: nada de lo que sigue la usa.
              return { payment: { ...evidencia, processedBy: null }, fastOrder: ventaDelGanador }
            }
            logger.error(
              '🚨 [FastPayment] La venta del ganador de la solicitud no existe — se registra como venta rápida normal, sin ligar',
              {
                venueId,
                requestId: arbitraje.row.requestId,
                winnerPaymentId: arbitraje.winnerPaymentId,
              },
            )
          } else {
            ligarSolicitud = arbitraje.kind === 'WINNER'
          }
        }
        // Codex R4-6: en venta rápida la colisión de referencia cuelga de la venta del candidato que CONTRADIJO (misma
        // referencia, importe y terminal): nunca nace otra venta por una referencia repetida.
        if (colisionDeReferencia && paymentData.referenceNumber) {
          const ventaDelCandidato = await tx.order.findFirst({ where: { id: colisionDeReferencia[0].orderId, venueId } })
          if (ventaDelCandidato) {
            s0.colision = { referenceNumber: paymentData.referenceNumber, candidates: colisionDeReferencia }
            const evidencia = await crearEvidenciaDeColisionDeReferencia(tx, {
              venueId,
              orderId: ventaDelCandidato.id,
              colision: s0.colision,
              paymentData,
              totalAmount,
              tipAmount,
              method: paymentData.method as PaymentMethod,
              merchantAccountId,
              terminalId,
              staffId: validatedStaffId,
            })
            return { payment: { ...evidencia, processedBy: null }, fastOrder: ventaDelCandidato }
          }
          logger.error(
            '🚨 [FastPayment] La venta del candidato que contradijo la referencia no existe — se registra como venta rápida normal',
            {
              venueId,
              referenceNumber: paymentData.referenceNumber,
              candidates: colisionDeReferencia,
            },
          )
        }
        const shiftClaim = await claimShiftForCompletedPayment(tx, {
          paymentStatus: paymentStatusSnapshot,
          venueId,
          amountPesos: shiftAmount,
          tipPesos: shiftTip,
          incrementTotalOrders: true,
        })

        // 🔧 FIX: Use orderReference from Android if provided (ensures photos match order number)
        // Android generates "FAST-{timestamp}" ONCE when entering VerifyingPrePayment state
        // Photos are uploaded to Firebase with this same reference
        // This ensures photos at "venues/X/verifications/2024-01-01/FAST-123456_1.jpg" match the order
        const orderNumber = paymentData.orderReference || `FAST-${Date.now()}`

        // Create fast order
        const order = await tx.order.create({
          data: {
            venueId,
            orderNumber,
            type: 'TAKEOUT', // Fast payments are typically quick sales (para llevar)
            source: 'TPV',
            // ⭐ Terminal that created this order (resolved from deviceSerialNumber)
            terminalId,
            status: 'COMPLETED', // Fast payments are instantly paid, so order is completed
            completedAt: new Date(),
            // 🔴 La orden cae en el MISMO turno que su cobro (auditoría Codex, 2026-09-02).
            //
            // El `Payment` de abajo ya llevaba `shiftId`; la orden no. Y desde la fase 1 del
            // turno del negocio, `getActiveShifts` cuenta las órdenes de un turno agrupando por
            // `Order.shiftId`: un turno con diez ventas rápidas enseñaba el dinero correcto y
            // «0 órdenes», y el cierre tampoco veía sus productos.
            //
            // Sólo el ganador del CAS transaccional se estampa. Sin turno (o si el
            // cierre ganó) la venta sigue, pero queda pendiente explícita abajo.
            shiftId: shiftClaim?.shiftId ?? null,
            subtotal: totalAmount, // Base amount (without tip)
            taxAmount: 0, // No tax for fast payments
            total: totalAmount + tipAmount, // ✅ FIX: Total = subtotal + tax + tip
            // ✅ FIX: Include tip and paid amounts for fast orders
            tipAmount, // Tip amount from this payment
            paidAmount: totalAmount + tipAmount, // Total paid (base + tip)
            remainingBalance: 0, // Fast payments are always fully paid
            paymentStatus: 'PAID',
            splitType: paymentData.splitType as any, // Set splitType for fast orders
            createdById: validatedStaffId, // Track which staff created the fast order
            servedById: validatedStaffId, // ⭐ KIOSK MODE FIX: Also set server to payment processor
            // 🔴 El cliente, en la MISMA transacción que el dinero: `Order.customerId`
            // (vínculo legacy) + `OrderCustomer` primario (vínculo moderno) — exactamente
            // lo que hace `POST /orders`. Sin cliente el objeto es vacío y la orden nace
            // idéntica a como nacía antes de este cambio.
            ...(customerOrderData ?? {}),
          },
        })

        // 🔑 Semántica de dinero SERVER-OWNED: si el POS referenció un tipo de pago del
        // catálogo, el método fiscal, la comisión, el cajón y la forma SAT salen de la
        // revisión CONGELADA — nunca de lo que mandó el cliente. Editar el catálogo
        // mañana no reinterpreta este cobro.
        const resolvedTender =
          paymentData.tenderTypeId != null && paymentData.tenderRevision != null
            ? await resolveTenderForCharge(
                venueId,
                paymentData.tenderTypeId,
                paymentData.tenderRevision,
                tx,
                paymentData.isOfflineReplay ? 'replay' : 'online',
              )
            : null
        tenderState.resolved = resolvedTender

        // Propina prohibida en un tipo configurado sin propina (Uber Eats ya la cobró en
        // su app). El POS no debería ofrecerla, pero la frontera no confía en la UI.
        if (resolvedTender && !resolvedTender.tenderCaptureTip && tipAmount > 0) {
          throw new BadRequestError(`El tipo de pago "${resolvedTender.tenderLabel}" no acepta propina.`)
        }

        const effectiveMethod = (resolvedTender?.method ?? paymentData.method) as PaymentMethod

        // Create the fast payment record
        const newPayment = await tx.payment.create({
          data: {
            venueId,
            orderId: order.id, // Fast payment - no order association
            amount: totalAmount,
            tipAmount,
            method: effectiveMethod,
            // El detalle del cobro declarado a mano sólo tiene sentido si el dinero NO
            // pasó por Avoqado; en efectivo se guarda null para no ensuciar el arqueo.
            // Con un tipo del catálogo el nombre vive en `tenderLabel`, no aquí: mezclarlos
            // haría que el desglose del corte contara el mismo cobro dos veces.
            externalSource: resolvedTender
              ? null
              : paymentData.method === 'CASH'
                ? null
                : paymentData.externalSource?.trim()?.slice(0, 50) || null,
            // Snapshots inmutables del tender, todos resueltos por el server.
            tenderTypeId: resolvedTender?.tenderTypeId,
            tenderRevision: resolvedTender?.tenderRevision,
            tenderLabel: resolvedTender?.tenderLabel,
            tenderCountsAsCash: resolvedTender?.tenderCountsAsCash,
            tenderCaptureTip: resolvedTender?.tenderCaptureTip,
            tenderSatFormaPago: resolvedTender?.tenderSatFormaPago,
            tenderCommissionPercent: resolvedTender?.tenderCommissionPercent,
            tenderCommissionAmount: resolvedTender
              ? computeTenderCommission(resolvedTender.tenderCommissionPercent, new Prisma.Decimal(totalAmount))
              : undefined,
            fundsFlow: resolvedTender?.fundsFlow,
            status: paymentStatusSnapshot as any, // Direct enum mapping since frontend sends correct values
            splitType: 'FULLPAYMENT' as SplitType, // Fast payments are always full payments
            source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
            processor: 'TBD',
            type: 'FAST',
            // Snapshot de MERCHANT_ROUTING_RULES (por qué la TPV mostró/eligió este merchant)
            routingEvaluation: paymentData.routingEvaluation ?? undefined,
            processorId: paymentData.mentaOperationId,
            processorData: {
              cardBrand: paymentData.cardBrand,
              last4: paymentData.last4,
              typeOfCard: paymentData.typeOfCard,
              bank: paymentData.bank,
              currency: paymentData.currency,
              authorizationNumber: paymentData.authorizationNumber,
              referenceNumber: paymentData.referenceNumber,
              isInternational: paymentData.isInternational,
              ...(paymentData.issuerCountryCode && paymentData.issuerCountrySource
                ? {
                    issuerCountryEvidence: {
                      code: paymentData.issuerCountryCode,
                      source: paymentData.issuerCountrySource,
                    },
                  }
                : {}),
              // ⭐ Blumon serial for reconciliation (matches dashboard de Blumon)
              blumonSerialNumber: paymentData.blumonSerialNumber || null,
              // 💸 Blumon Operation Number (2025-12-16) - For CancelIcc refunds without webhook
              blumonOperationNumber: paymentData.blumonOperationNumber || null,
              // Procedencia AUTENTICADA del cobro (serial del token). Aditivo: conserva la identidad del
              // aparato aunque `terminalId` no resuelva, para la atribución y la recuperación del
              // arbitraje POS→terminal.
              // Codex R2 (P1-1): el serial que se conserva es el ACREDITADO por el JWT (T10); el del cuerpo sólo cuando no hay otro.
              deviceSerialNumber: paymentData.authenticatedTerminalSerial ?? (paymentData.deviceSerialNumber || null),
              pricingSlot: paymentData.pricingSlot ?? null,
              pricing: tarifaComoJson(paymentData.pricing),
              // S2: nacido del webhook ⇒ método provisional y costo pendiente hasta acreditar la marca (o vencer el plazo).
              ...(paymentData.registradoVia === 'webhook' ? { registradoVia: 'webhook', methodProvisional: true } : {}),
              // Codex R6 (diseño B): `costPending` = «la obligación de costo todavía no ha convergido» — nace con la obligación
              // (todo cobro COMPLETED que no es efectivo, por REST o por webhook) y sólo la convergencia lo pone en false.
              ...(paymentStatusSnapshot === 'COMPLETED' && paymentData.method !== 'CASH' ? { costPending: true } : {}),
              ...(afiliacion.merchantAccountIdDelApk !== afiliacion.merchantAccountId
                ? { merchantAccountIdFromApk: afiliacion.merchantAccountIdDelApk ?? null, merchantResolvedVia: afiliacion.via }
                : {}),
            },
            // New enhanced fields in the Payment table
            authorizationNumber: paymentData.authorizationNumber,
            referenceNumber: paymentData.referenceNumber,
            // 🛡️ Idempotency key (2026-04-08) - Stripe/Square/Toast pattern
            idempotencyKey: paymentData.idempotencyKey,
            maskedPan: paymentData.maskedPan,
            cardBrand: paymentData.cardBrand ? (paymentData.cardBrand.toUpperCase().replace(' ', '_') as any) : null,
            entryMode: paymentData.entryMode ? (paymentData.entryMode.toUpperCase() as any) : null,
            internationalityStatus: internationalityShadow?.status,
            internationalitySource: internationalityShadow?.source,
            issuerCountryCode: internationalityShadow?.issuerCountryCode,
            internationalityClassificationVersion: internationalityShadow?.classificationVersion,
            internationalityClassifiedAt,
            // ⭐ Provider-agnostic merchant account tracking
            merchantAccountId,
            // ⭐ Terminal that processed this payment (resolved from deviceSerialNumber)
            terminalId,
            processedById: validatedStaffId, // ✅ CORRECTED: Use validated staff ID
            shiftId: shiftClaim?.shiftId ?? null,
            feePercentage: 0, // TODO: Calculate based on payment processor
            feeAmount: 0, // TODO: Calculate based on amount and percentage
            netAmount: totalAmount + tipAmount, // For now, net amount = total
            posRawData: {
              splitType: 'FULLPAYMENT',
              staffId: validatedStaffId, // identidad efectiva validada (POS en relay; TPV en cobro directo)
              source: mapPaymentSource(paymentData.source), // ✅ Map Android app source to enum value
              paymentType: 'FAST',
              ...(effectiveReviewRating && { reviewRating: effectiveReviewRating }),
            },
          },
          include: {
            processedBy: true,
          },
        })

        if (shiftClaim) {
          await recordPendingPaymentShiftReconciliation(tx, {
            reconciliationEnabled,
            claim: shiftClaim,
            venueId,
            paymentId: newPayment.id,
            orderId: order.id,
            staffId: validatedStaffId ?? null,
            channel: 'recordFastPayment',
            amountPesos: shiftAmount,
            tipPesos: shiftTip,
          })
        }

        // Create VenueTransaction for financial tracking and settlement
        //
        // 🔴 `PENDING` significa "Avoqado todavía le debe este dinero al negocio". Estaba
        // FIJO, así que el efectivo del cajón —y ahora un cobro de Uber Eats, que Avoqado
        // jamás va a depositar— entraban a la cola de liquidación como saldo por depositar.
        // El lado de lectura (`availableBalance`) ya filtra con este mismo predicado, o sea
        // que el número que ve el dueño estaba bien; la FILA era la que mentía, y cualquier
        // consumidor nuevo la leería mal. "¿Esto lo deposita Avoqado?" tiene UNA autoridad:
        // `paymentIsAvoqadoSettled`. Sin tender reproduce el histórico para tarjeta
        // (PENDING) y corrige el efectivo a SETTLED — que es justo lo que ya hace el cobro
        // en efectivo del POS ("Cash is immediately settled").
        await tx.venueTransaction.create({
          data: {
            venueId,
            paymentId: newPayment.id,
            type: 'PAYMENT',
            grossAmount: totalAmount + tipAmount,
            feeAmount: newPayment.feeAmount,
            netAmount: newPayment.netAmount,
            // Lo que no pasa por Avoqado no tiene nada pendiente: nace liquidado.
            status: paymentIsAvoqadoSettled(newPayment) ? 'PENDING' : 'SETTLED',
          },
        })

        // Create a general allocation for the fast payment
        await tx.paymentAllocation.create({
          data: {
            paymentId: newPayment.id,
            orderId: order.id,
            amount: totalAmount,
          },
        })

        // 📸 Create SaleVerification if verification photos or barcodes were provided
        // This links the pre-uploaded Firebase photos to the payment record
        if (
          validatedStaffId &&
          ((paymentData.verificationPhotos && paymentData.verificationPhotos.length > 0) ||
            (paymentData.verificationBarcodes && paymentData.verificationBarcodes.length > 0))
        ) {
          await tx.saleVerification.create({
            data: {
              venueId,
              paymentId: newPayment.id,
              staffId: validatedStaffId,
              photos: paymentData.verificationPhotos || [],
              scannedProducts: paymentData.verificationBarcodes
                ? paymentData.verificationBarcodes.map((barcode: string) => ({
                    barcode,
                    format: 'UNKNOWN',
                    inventoryDeducted: false,
                  }))
                : [],
              status: 'PENDING', // Will be processed for inventory deduction later
            },
          })
          logger.info('📸 SaleVerification created for fast payment', {
            paymentId: newPayment.id,
            photosCount: paymentData.verificationPhotos?.length || 0,
            barcodesCount: paymentData.verificationBarcodes?.length || 0,
          })
        }

        // Close the POS→TPV arbitration row (frees the terminal slot) atomically
        // with the Payment — the robust recovery path (survives socket loss/restart).
        // S0: sólo el GANADOR liga la fila (el arbitraje ya excluyó las asociaciones inválidas), y se comprueba el
        // desenlace: «no lanzó» no es «ligó». Un ganador sin vínculo queda registrado y la fila, recuperable.
        if (ligarSolicitud && paymentData.terminalPaymentRequestId) {
          const cierre = await terminalPaymentService.closeRowFromPaymentTx(
            tx,
            paymentData.terminalPaymentRequestId,
            newPayment.id,
            venueId,
            { amountCents: paymentData.amount, tipCents: paymentData.tip },
            'REST',
            // Serial AUTENTICADO (el controlador lo toma del token): la identidad del aparato que cobró aunque la FK
            // `terminalId` no haya resuelto en este venue. `deviceSerialNumber` del body sólo como respaldo legacy.
            paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
            paymentData.registradoVia === 'webhook' ? 'webhook' : 'terminal',
          )
          s0.cierre = cierre
          // Checkpoint 2 · N0b (Codex, diseño v3): la terminal acredita al GANADOR de la solicitud por la columna
          // `Payment.terminalPaymentRequestId`, que sólo escribe `closeRowFromPaymentTx` al ligar. El objeto del `create` nació sin
          // ella: se refleja aquí para que el 2xx la lleve (la relectura idempotente ya la trae de la fila). Sin ligar, va null.
          if (cierre.bound) newPayment.terminalPaymentRequestId = paymentData.terminalPaymentRequestId ?? null
          if (!cierre.bound) {
            logger.error(
              '🚨 [Terminal-payment] El ganador quedó REGISTRADO pero la solicitud NO se ligó — la fila queda para recuperación',
              {
                venueId,
                requestId: paymentData.terminalPaymentRequestId,
                paymentId: newPayment.id,
                reason: cierre.reason,
              },
            )
          }
        }

        if (newPayment.status === 'COMPLETED') {
          await tx.order.update({ where: { id: order.id }, data: { loyaltyEligibleAt: new Date(), loyaltyStaffId: validatedStaffId } })
          await enqueueCommittedPaymentEffects(tx, newPayment, effectiveReviewRating, validatedStaffId, true)
          await encolarObligacionDeCosto(tx, newPayment, paymentData.registradoVia === 'webhook' ? 'webhook' : 'terminal')
        }
        return { payment: newPayment, fastOrder: order }
      }, OPCIONES_DE_TRANSACCION_DEL_INTENTO),
    )
    payment = result.payment
    fastOrder = result.fastOrder
  } catch (error) {
    if (error instanceof RegistroYaExistentePorReferencia) return devolverExistentePorReferencia(error.registro)
    if (error instanceof ReintentoDelGanadorDeLaSolicitud) {
      const ganador = await prisma.payment.findUnique({ where: { id: error.winnerPaymentId }, include: { receipts: true } })
      if (ganador) {
        logger.info('🔄 [S0] Bajo el candado de la solicitud, el ganador ya era este mismo intento — se devuelve el existente', {
          venueId,
          winnerPaymentId: ganador.id,
        })
        // Codex R1 (P1-4): el REST que perdió la carrera bajo el candado trae marca, PAN, modo y método REALES — se
        // consolidan sobre el ganador (S3) igual que en los retornos idempotentes; devolverlo tal cual los perdía.
        return {
          ...((await consolidarRegistroRepetido(ganador, paymentData as RegistroEntrante, venueId, null)) ?? ganador),
          digitalReceipt: await ensureDigitalReceiptResponse(ganador.id, ganador.receipts[0]),
        }
      }
      throw error
    }
    // 🛡️ P2002 safety net: unique constraint violation on (venueId, idempotencyKey)
    // means another concurrent request already created this payment. Return the
    // winner as if this was a normal idempotent retry.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = (error.meta as { target?: string[] } | undefined)?.target
      const isIdempotencyConflict = Array.isArray(target) && target.includes('idempotencyKey')

      if (isIdempotencyConflict && paymentData.idempotencyKey) {
        logger.warn('🛡️ [recordFastPayment] Concurrent race blocked by unique index — returning winner', {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
          target,
        })

        const winner = await prisma.payment.findUnique({
          where: {
            venueId_idempotencyKey: {
              venueId,
              idempotencyKey: paymentData.idempotencyKey,
            },
          },
          include: { receipts: true },
        })

        if (winner) {
          // La carrera la ganó otra petición: su orden ya existe, así que el cliente se
          // rellena (nunca se reasigna) igual que en cualquier reintento idempotente.
          const winnerCustomerLink = await linkCustomerToExistingOrder(venueId, ordenPropia(winner), effectiveCustomerId)
          return {
            ...((await consolidarRegistroRepetido(winner, paymentData as RegistroEntrante, venueId, null)) ?? winner),
            digitalReceipt: await ensureDigitalReceiptResponse(winner.id, winner.receipts[0]),
            customerLink: winnerCustomerLink,
          }
        }

        logger.error('🚨 [recordFastPayment] P2002 on idempotencyKey but winner not found — should be impossible', {
          venueId,
          idempotencyKey: paymentData.idempotencyKey,
        })
      }
    }
    throw error
  }

  // Ventana de confirmación (Task 3): mismo aviso post-commit que en el cobro con orden (REST o webhook).
  if (paymentData.terminalPaymentRequestId) {
    avisarAprobacionTardiaTrasVentana(s0.cierre, {
      requestId: paymentData.terminalPaymentRequestId,
      venueId,
      paymentId: payment.id,
      terminalId: paymentData.authenticatedTerminalSerial ?? paymentData.deviceSerialNumber ?? null,
      orderId: fastOrder.id,
    })
  }
  // Ronda 2 (P1): mismo punto que en el cobro con orden.
  if (!s0.cierre?.bound && !s0.segundaCaptura && !s0.colision) await retenerSiQuedoSinLigar(payment, paymentData)

  // Ronda 3 (P1-B): la colisión también es una señal positiva sobre la solicitud — si ésta ya estaba liberada, se re-retiene.
  if (s0.colision) await retenerSiHayColisionSobreUnaLiberada(payment, paymentData)

  if (s0.segundaCaptura) return await responderSegundaCaptura(venueId, payment, s0.segundaCaptura)
  if (s0.colision) return await responderColisionDeReferencia(venueId, payment, s0.colision)

  logger.info('VenueTransaction created for fast payment', {
    paymentId: payment.id,
    grossAmount: totalAmount + tipAmount,
    feeAmount: payment.feeAmount,
    netAmount: payment.netAmount,
  })
  logPaymentInternationalityShadow(payment.id, paymentData.isInternational, internationalityShadow)

  // 🔴 EL CAJÓN SUMA LA VENTA EN EFECTIVO. Esta función NO es sólo de la TPV: el POS
  // móvil también cobra la venta rápida por aquí (`POST /mobile/venues/:venueId/fast`),
  // así que sin este enganche la venta sin cuenta se quedaba fuera del arqueo.
  await timing.time('drawer', () =>
    postCashSaleToDrawer({
      venueId,
      paymentId: payment.id,
      method: payment.method,
      fundsFlow: payment.fundsFlow,
      tenderTypeId: payment.tenderTypeId,
      tenderCountsAsCash: payment.tenderCountsAsCash,
      status: payment.status,
      type: payment.type,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      staffId: payment.processedById,
      orderId: fastOrder.id,
    }),
  )

  // Create TransactionCost for financial tracking (only for Avoqado-processed non-cash payments)
  if (paymentData.registradoVia === 'webhook') {
    logger.info('⏳ [S2] Costo de transacción PENDIENTE (Payment nacido del webhook, sin marca acreditada)', { paymentId: payment.id })
    registrarConfirmacionAnomalaPorWebhook(s0.cierre, {
      venueId,
      requestId: paymentData.terminalPaymentRequestId ?? null,
      paymentId: payment.id,
      attemptId: paymentData.idempotencyKey ?? null,
      staffId: payment.processedById ?? null,
      amountCents: paymentData.amount,
      tipCents: paymentData.tip ?? 0,
    })
  } else {
    // Codex R4-4 / R5-3: UN solo criterio de cumplimiento para el costo síncrono — el MISMO del worker (costo persistido →
    // proyecciones en Payment y VenueTransaction → liquidación → reembolsos). La obligación se cierra SÓLO al converger; si
    // falta la liquidación o la tarifa no es acreditable, queda PENDIENTE y visible con su motivo. Nunca interrumpe el cobro.
    await timing.time('transaction_cost', () => asegurarCostoSincrono(payment.id))
  }

  // Create Review record if reviewRating is provided
  if (payment.status !== 'COMPLETED' && effectiveReviewRating) {
    try {
      const rating = mapTpvRatingToNumeric(effectiveReviewRating)
      if (rating !== null) {
        await prisma.review.create({
          data: {
            venueId: venueId,
            paymentId: payment.id,
            overallRating: rating,
            source: 'TPV',
            servedById: validatedStaffId, // vendedor congelado por el POS cuando el cobro fue remoto
          },
        })
        logger.info('Review created successfully for fast payment', {
          paymentId: payment.id,
          rating,
          originalRating: effectiveReviewRating,
        })
      } else {
        logger.warn('Invalid review rating provided for fast payment', { paymentId: payment.id, rating: effectiveReviewRating })
      }
    } catch (error) {
      logger.error('Failed to create review for fast payment', { paymentId: payment.id, error })
      // Don't fail the payment if review creation fails
    }
  }

  // Generate digital receipt for fast TPV payments (AVOQADO origin)
  let digitalReceipt = null
  try {
    digitalReceipt = await timing.time('canonical_receipt', () => generateDigitalReceipt(payment.id))
    logger.info('Digital receipt generated for fast payment', {
      paymentId: payment.id,
      receiptId: digitalReceipt.id,
      accessKey: digitalReceipt.accessKey,
    })
  } catch (error) {
    logger.error('Failed to generate digital receipt for fast payment', { paymentId: payment.id, error })
    // Don't fail the payment if receipt generation fails
  }

  // 🔴 La lealtad de la venta rápida, al momento — es lo que el POS le promete a la clienta en
  // pantalla («esta compra le suma otro»). Misma llamada que `updateOrderTotalsForStandalonePayment`.
  // `awardLoyaltyForPaidOrder` nunca lanza, y marca `loyaltyProcessedAt` al terminar, así que el
  // job `loyalty-reconciliation` no la repite; el sello además tiene índice único por orden. La propina
  // no genera lealtad. (Hotfix e00677cc de `main`, 14-sep-2026 — Amaena; el referido de la venta rápida
  // ya NO va aquí: viaja como efecto REFERRAL del outbox encolado dentro de la transacción del dinero.)
  if (payment.status === 'COMPLETED') {
    await awardLoyaltyForPaidOrder({
      venueId: fastOrder.venueId,
      orderId: fastOrder.id,
      orderTotal: Math.max(0, Number(fastOrder.total) - Number(fastOrder.tipAmount ?? 0)),
      staffId: validatedStaffId,
      legacyCustomer: fastOrder.customerId ? { id: fastOrder.customerId, firstName: null, lastName: null } : null,
    })
  }

  // 🔌 REAL-TIME: Emit socket events based on payment status (fast payment)
  try {
    const paymentPayload = {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      method: payment.method,
      status: payment.status.toLowerCase(), // Convert to lowercase for Android compatibility
      type: 'FAST',
      timestamp: new Date().toISOString(),
      metadata: {
        cardBrand: paymentData.cardBrand,
        last4: paymentData.last4,
      },
    }

    // Emit appropriate event based on payment status
    if (payment.status === 'COMPLETED') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_COMPLETED, paymentPayload)
      logger.info('🔌 PAYMENT_COMPLETED event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })

      // Create commission calculation for this fast payment (non-blocking)
      if (payment.type !== 'TEST') {
        // Real-time auto-reorder (see recordOrderPayment for rationale). Non-blocking + self-gated.
        runAutoReorderForVenue(venueId).catch(err => {
          logger.error('Failed to run real-time auto-reorder after fast payment', {
            paymentId: payment.id,
            venueId,
            error: err instanceof Error ? err.message : String(err),
          })
        })
      }
    } else if (payment.status === 'PROCESSING') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_PROCESSING, paymentPayload)
      logger.info('🔌 PAYMENT_PROCESSING event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })
    } else if (payment.status === 'FAILED') {
      socketManager.broadcastToVenue(venueId, SocketEventType.PAYMENT_FAILED, {
        ...paymentPayload,
        errorMessage: 'Fast payment failed during processing',
      })
      logger.warn('🔌 PAYMENT_FAILED event emitted (fast payment)', {
        paymentId: payment.id,
        orderId: fastOrder.id,
        amount: payment.amount,
      })
    }

    // Emit order updated event to venue room for the fast order
    socketManager.broadcastToVenue(venueId, SocketEventType.ORDER_UPDATED, {
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      status: fastOrder.status,
      paymentStatus: fastOrder.paymentStatus,
      type: 'FAST',
      timestamp: new Date().toISOString(),
    })

    logger.info('Socket events emitted successfully for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      orderNumber: fastOrder.orderNumber,
      venueId: venueId,
      paymentStatus: payment.status,
    })
  } catch (error) {
    logger.error('Failed to emit socket events for fast payment', {
      paymentId: payment.id,
      orderId: fastOrder.id,
      error,
    })
    // Don't fail the payment if socket emission fails
  }

  t.mark('transaccionSocketsYComisiones')
  logger.info('Fast payment recorded successfully', { paymentId: payment.id, amount: totalAmount })

  // 🪝 Backfill any Blumon webhook that arrived BEFORE this Payment was recorded.
  // Fire-and-forget — never block the API response on reconciliation. The cron
  // worker (`BlumonWebhookReconciliationJob`) is the safety net if this fails.
  void import('./blumon-webhook.service').then(({ reconcileWebhooksForPayment }) =>
    reconcileWebhooksForPayment({
      id: payment.id,
      processorId: payment.processorId,
      referenceNumber: payment.referenceNumber,
      venueId,
    }).catch(err => {
      logger.error('🪝 [Blumon backfill] Failed to reconcile pending webhooks for fast payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // 🪝 Backfill any AngelPay webhook that arrived BEFORE this Payment was recorded.
  // AngelPay fires on charge-approval; the TPV records only after the cashier
  // dismisses AngelPay's success screen — often minutes later. No-op for non-AngelPay
  // payments (no matching pending webhook will exist).
  void import('./angelpay-webhook.service').then(({ reconcileAngelPayWebhookForPayment }) =>
    reconcileAngelPayWebhookForPayment({
      id: payment.id,
      idempotencyKey: payment.idempotencyKey,
      referenceNumber: payment.referenceNumber,
      venueId,
      amount: payment.amount,
      tipAmount: payment.tipAmount,
      merchantAccountId: payment.merchantAccountId,
    }).catch(err => {
      logger.error('🪝 [AngelPay backfill] Failed to reconcile pending webhooks for fast payment', {
        paymentId: payment.id,
        error: err instanceof Error ? err.message : err,
      })
    }),
  )

  // Add digital receipt info to payment response
  const autofacturaAvailable = digitalReceipt ? await timing.time('autofactura', () => resolveAutofacturaAvailable(fastOrder?.id)) : false
  t.end({ paymentId: payment.id })
  timing.end(payment.id)

  return {
    ...payment,
    digitalReceipt: digitalReceipt
      ? {
          id: digitalReceipt.id,
          accessKey: digitalReceipt.accessKey,
          receiptUrl: `${process.env.FRONTEND_URL || 'https://dashboardv2.avoqado.io'}/receipts/public/${digitalReceipt.accessKey}`,
          autofacturaAvailable,
        }
      : null,
    // Campo ADITIVO: qué pasó con el cliente de esta venta. Un POS viejo lo ignora; los
    // nuevos pueden avisar al cajero y ofrecerle reasignar sin volver a cobrar.
    customerLink,
  }
}

/**
 * Get available merchant accounts for a venue
 * Returns active merchant accounts configured for the venue with display information
 * @param venueId Venue ID to get merchant accounts for
 * @param orgId Organization ID for authorization
 * @returns Array of available merchant accounts with display info
 */
export async function getVenueMerchantAccounts(venueId: string, _orgId?: string): Promise<any[]> {
  // Validate venue exists
  const venue = await prisma.venue.findFirst({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  // Use inheritance: venue config → org config fallback
  const effective = await getEffectivePaymentConfig(venueId)

  if (!effective) {
    logger.warn('No payment configuration found for venue (checked venue + org)', { venueId })
    return []
  }

  const { config: paymentConfig, source } = effective
  logger.info('Resolved payment config for venue', { venueId, source })

  const accounts = []

  // Helper function to create account response object
  const createAccountResponse = (account: any, accountType: string) => {
    if (!account || !account.active) return null

    // Check if account has required credentials
    const credentials = account.credentialsEncrypted
    const hasValidCredentials = !!(credentials && credentials.merchantId && credentials.apiKey)

    return {
      id: account.id,
      accountType,
      displayName: account.displayName || `${account.provider.name} ${accountType}`,
      providerName: account.provider.name,
      providerCode: account.provider.code,
      active: account.active,
      hasValidCredentials,
      displayOrder: account.displayOrder,
      ecommerceMerchantId: account.ecommerceMerchantId,
      // 🚀 OPTIMIZATION: Include decrypted credentials for POS terminals
      // This eliminates the need for getMentaRoute API calls during payment
      credentials: hasValidCredentials
        ? {
            apiKey: credentials.apiKey,
            merchantId: credentials.merchantId,
            customerId: credentials.customerId || null,
          }
        : null,
    }
  }

  // Add primary account if exists and active
  if (paymentConfig.primaryAccount) {
    const primaryAccount = createAccountResponse(paymentConfig.primaryAccount, 'PRIMARY')
    if (primaryAccount) accounts.push(primaryAccount)
  }

  // Add secondary account if exists and active
  if (paymentConfig.secondaryAccount) {
    const secondaryAccount = createAccountResponse(paymentConfig.secondaryAccount, 'SECONDARY')
    if (secondaryAccount) accounts.push(secondaryAccount)
  }

  // Add tertiary account if exists and active
  if (paymentConfig.tertiaryAccount) {
    const tertiaryAccount = createAccountResponse(paymentConfig.tertiaryAccount, 'TERTIARY')
    if (tertiaryAccount) accounts.push(tertiaryAccount)
  }

  // Filter only accounts with valid credentials and sort by display order
  const validAccounts = accounts.filter(account => account.hasValidCredentials).sort((a, b) => a.displayOrder - b.displayOrder)

  logger.info('Retrieved merchant accounts for venue', {
    venueId,
    totalAccounts: accounts.length,
    validAccounts: validAccounts.length,
  })

  return validAccounts
}

/**
 * Interface for payment routing request data
 */
interface PaymentRoutingData {
  amount: number // Amount in cents
  merchantAccountId: string // Selected merchant account ID (user has already chosen primary/secondary/tertiary)
  terminalSerial: string // Terminal identifier
  bin?: string // Optional BIN for card routing
}

/**
 * Get payment routing configuration for the selected merchant account
 * This method retrieves the credentials and routing info for the merchant account selected by the user in TPV
 * @param venueId Venue ID
 * @param routingData Routing parameters from the request (includes user-selected merchant account)
 * @param orgId Organization ID for authorization
 * @returns Payment routing configuration with credentials and routing info for the selected account
 */
export async function getPaymentRouting(venueId: string, routingData: PaymentRoutingData, _orgId?: string): Promise<any> {
  logger.info('Getting payment routing configuration for user-selected merchant account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    amount: routingData.amount,
  })

  // Validate venue exists
  const venue = await prisma.venue.findFirst({
    where: { id: venueId },
    select: { id: true },
  })

  if (!venue) {
    throw new NotFoundError('Venue not found or not accessible')
  }

  // Use inheritance: venue config → org config fallback
  const effective = await getEffectivePaymentConfig(venueId)

  if (!effective) {
    throw new BadRequestError('Venue payment configuration not found (checked venue + org)')
  }

  const { config: paymentConfig, source } = effective
  logger.info('Resolved payment config for routing', { venueId, source })

  // Find the specific merchant account by ID from the venue's configured accounts
  // The user has already selected which account they want to use (primary/secondary/tertiary)
  let selectedAccount: any = null
  let accountType: string = 'UNKNOWN'

  if (paymentConfig.primaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.primaryAccount
    accountType = 'PRIMARY'
  } else if (paymentConfig.secondaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.secondaryAccount
    accountType = 'SECONDARY'
  } else if (paymentConfig.tertiaryAccount?.id === routingData.merchantAccountId) {
    selectedAccount = paymentConfig.tertiaryAccount
    accountType = 'TERTIARY'
  }

  if (!selectedAccount || !selectedAccount.active) {
    throw new NotFoundError('Selected merchant account not found or not active for this venue')
  }

  // Check if account has valid credentials
  const credentials = selectedAccount.credentialsEncrypted as any
  if (!credentials || !credentials.merchantId || !credentials.apiKey || !credentials.customerId) {
    throw new BadRequestError('Selected merchant account does not have valid payment processor credentials')
  }

  // Simple routing based on account type - the user has already made the routing decision by selecting the account
  const route = accountType.toLowerCase() // 'primary', 'secondary', or 'tertiary'
  const acquirer = selectedAccount.provider.code.toUpperCase() // 'MENTA', etc.

  // 🚨 CRITICAL FIX: Get proper terminal UUID instead of hardware serial
  // Fetch terminal record by serial number to get the proper UUID
  const terminal = await prisma.terminal.findFirst({
    where: {
      serialNumber: routingData.terminalSerial,
      venueId: venueId,
    },
  })

  if (!terminal) {
    throw new NotFoundError(`Terminal with serial ${routingData.terminalSerial} not found for venue ${venueId}`)
  }

  // Use Menta terminal UUID if available, otherwise use terminal's own UUID
  const terminalUuid = terminal.mentaTerminalId
  logger.info(`🎯 Using terminal UUID for payments: ${terminalUuid} (serial: ${routingData.terminalSerial})`)

  // The routing response contains the credentials for the user-selected merchant account
  const routingResponse = {
    route,
    acquirer,
    merchantId: credentials.merchantId,
    apiKeyMerchant: credentials.apiKey,
    customerId: credentials.customerId,
    terminalSerial: terminalUuid, // 🎯 CRITICAL: Return UUID instead of serial number
    amount: routingData.amount,
    // Additional routing metadata
    routingMetadata: {
      accountType,
      providerCode: selectedAccount.provider.code,
      ecommerceMerchantId: selectedAccount.ecommerceMerchantId,
      userSelected: true, // This routing was based on user selection, not automatic rules
      timestamp: new Date().toISOString(),
    },
  }

  logger.info('Payment routing configuration generated for user-selected account', {
    venueId,
    merchantAccountId: routingData.merchantAccountId,
    accountType,
    route,
    acquirer,
    userSelected: true,
    merchantId: credentials.merchantId.substring(0, 8) + '...',
  })

  return routingResponse
}

/**
 * ✅ NUEVO: Mapea métodos de pago del backend a códigos de POS
 * Convierte los métodos de pago de Avoqado a los códigos que entiende SoftRestaurant
 */
function mapPaymentMethodToPOS(method: PaymentMethod): string {
  logger.info('Mapping payment method to POS', { method })
  const paymentMethodMap: Record<PaymentMethod, string> = {
    CASH: 'ACARD', // ✅ CHANGED: Use DEB instead of AEF (tipo=2 CARD) to prevent $0.00 archiving issue
    CREDIT_CARD: 'CRE', // TAR. CREDITO
    DEBIT_CARD: 'DEB', // TAR. DEBITO
    DIGITAL_WALLET: 'MPY', // MARC PAYMENTS (como genérico para wallets)
    BANK_TRANSFER: 'DEB', // ✅ CHANGED: Use DEB instead of AEF to prevent $0.00 archiving
    CRYPTOCURRENCY: 'ACARD', // 🪙 B4Bit crypto payments - map to generic card type
    OTHER: 'ACARD', // ✅ CHANGED: Default to DEB instead of AEF
  }

  return paymentMethodMap[method] || 'ACARD' // ✅ CHANGED: Default fallback to DEB
}

// ==========================================
// COUPON FINALIZATION
// ==========================================

/**
 * Finalize coupon redemptions when order payment completes.
 * Called ONLY when order is fully paid - not on partial payments.
 *
 * This follows Toast/Square best practice: coupons are "applied" at checkout
 * but only "redeemed" (counted against limits) when payment succeeds.
 *
 * @param venueId Venue ID for logging
 * @param orderId Order ID to finalize coupons for
 */
async function finalizeCouponsForOrder(venueId: string, orderId: string): Promise<void> {
  // Find all coupon-based discounts on this order
  const couponDiscounts = await prisma.orderDiscount.findMany({
    where: {
      orderId,
      couponCodeId: { not: null },
    },
    include: {
      couponCode: {
        include: { discount: true },
      },
    },
  })

  if (couponDiscounts.length === 0) {
    logger.debug('🎟️ No coupons to finalize for order', { orderId })
    return
  }

  // Get order for customerId
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { customerId: true },
  })

  for (const orderDiscount of couponDiscounts) {
    if (!orderDiscount.couponCodeId || !orderDiscount.couponCode) continue

    // Check if already redeemed (idempotency - prevents double counting on retries)
    const existingRedemption = await prisma.couponRedemption.findUnique({
      where: { orderId },
    })
    if (existingRedemption) {
      logger.debug('🎟️ Coupon already redeemed for order, skipping', {
        orderId,
        couponCodeId: orderDiscount.couponCodeId,
      })
      continue
    }

    // Create redemption record
    await prisma.couponRedemption.create({
      data: {
        couponCodeId: orderDiscount.couponCodeId,
        orderId,
        customerId: order?.customerId,
        amountSaved: orderDiscount.amount,
      },
    })

    // Increment CouponCode.currentUses
    await prisma.couponCode.update({
      where: { id: orderDiscount.couponCodeId },
      data: { currentUses: { increment: 1 } },
    })

    // Increment Discount.currentUses
    if (orderDiscount.couponCode.discountId) {
      await prisma.discount.update({
        where: { id: orderDiscount.couponCode.discountId },
        data: { currentUses: { increment: 1 } },
      })
    }

    logger.info('✅ Coupon finalized on payment completion', {
      orderId,
      venueId,
      couponCode: orderDiscount.couponCode.code,
      couponCodeId: orderDiscount.couponCodeId,
      amountSaved: orderDiscount.amount.toString(),
    })
  }
}
