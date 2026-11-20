// src/services/online-ordering/card/draft.service.ts
/**
 * Fase 2 — pedir con tarjeta: el carrito ya cotizado se guarda en un BORRADOR (`OnlineOrderCharge`, `PENDING_AUTH`) y se abre la
 * página de pago de Stripe (captura manual). La cuenta (`Order` + `OnlineOrder`) todavía NO existe: nace cuando Stripe confirma
 * que la tarjeta quedó apartada (tarea 5). Mismo candado y mismo `externalId` (`web:<llave>`) que pagar al recoger: una llave es
 * de UN solo pedido, en cualquier modo (Codex r2 #5).
 */
import { OnlineOrderChargeStatus, OnlineOrderPaymentMode, Prisma, type OnlineOrderCharge } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import AppError, { BadRequestError, ConflictError, UnauthorizedError } from '@/errors/AppError'
import { withDeadlockRetry } from '@/utils/serializableRetry'
import { getProvider } from '@/services/payments/provider-registry'
import {
  calculateApplicationFeeWithVAT,
  getStripeChargeBoundsCents,
  fromStripeAmount,
  toStripeAmount,
} from '@/services/payments/providers/money'
import { getVatRateBps } from '@/services/superadmin/platformSettings.service'
import { canonicalPhoneE164, phonesMatch } from '@/utils/phone'
import {
  CARD_CHECKOUT_TTL_MINUTES,
  MAX_PENDING_PER_PHONE,
  MAX_PENDING_PER_VENUE,
  SIN_TELEFONO_NADIE,
  apartadosNadieWhere,
  awaitingAcceptanceWhere,
  borradoresNadieWhere,
  liveCardDraftsWhere,
} from '../constants'
import { storefrontBase } from '../notifications.service'
import {
  TX_OPTIONS,
  cardDraftTrackingStatus,
  decisionDePrecio,
  eleccionNormalizada,
  final,
  guardarDecisionDePrecio,
  isDefinitiveRejection,
  leerDecisionDePrecio,
  loDecididoOEste,
  lockAdmission,
  lockKey,
  onlineOrderRequestHash,
  sinSesion,
  toQuoteSnapshot,
  type CreateOnlineOrderOptions,
  type PublicTracking,
} from '../order.service'
import { cedeLaSimulacion, simularBeneficios, type EleccionDeBeneficios } from '../beneficios.service'
import { getAcceptingStatus } from '../presence.service'
import { quoteCart, toPublicQuote, type CartItemInput } from '../quote.service'
import { generateTrackingToken } from '../trackingToken'
import { cardOnlineAvailable, chargeMerchant, findCardMerchant, type MerchantSnapshot } from './merchant'

export interface CreateCardDraftInput {
  venueId: string
  venueSlug: string
  idempotencyKey: string
  items: CartItemInput[]
  expectedTotal: string
  /** D661 (r1 #12): el teléfono es opcional; «Mi equipo» lo exige aquí (400 como hoy) y «Nadie» usa el de la sesión. */
  customer: { name: string; phone?: string | null; email?: string | null }
  note?: string | null
  whatsappConsent?: boolean
  now?: Date
  /**
   * S11: la clienta de la sesión (`clientaDeLaSesion`). En «Mi equipo» cuenta sólo si su teléfono probado es el del pedido; en «Nadie»
   * (D661) es LA clienta del borrador y sin ella no hay tarjeta.
   */
  customerId?: string | null
  /** El teléfono que probó la sesión (OTP de WhatsApp). */
  verifiedPhone?: string | null
  /** S11 (P2-4): lo que eligió usar; sin sesión es `PRICE_CHANGED` (`SIN_SESION`). */
  beneficios?: EleccionDeBeneficios | null
}

export interface CardDraftResult {
  trackingToken: string
  checkoutUrl: string
  /** Nuevo: `AWAITING_PAYMENT`. Una repetición dice el estado real, el mismo que el seguimiento (tarea 5). */
  status: PublicTracking['status']
  total: string
  replay: boolean
}

/** Lo que el borrador guarda en `request`: con esto la tarea 5 arma la cuenta y la sesión se repite con los mismos datos. */
export interface CardDraftRequest {
  quote: ReturnType<typeof toQuoteSnapshot>
  /** En «Nadie» (D661) el teléfono es el que probó la sesión, o `null`: uno tecleado sin probar no se guarda (como el folio). */
  customer: { name: string; phone: string | null; email: string | null }
  note: string | null
  whatsappConsent: boolean
  externalId: string
  successUrl: string
  cancelUrl: string
  /** S11: la clienta y su elección; al confirmar, el pedido nace con ellas (un borrador de antes no las trae: nace como hoy). */
  customerId?: string | null
  beneficios?: EleccionDeBeneficios | null
  /** D661: nació en «Nadie» (siempre con la clienta de la sesión en `customerId`). Sin el campo, es de «Mi equipo». */
  nadie?: true
  /** D661: el teléfono que la sesión probó al pagar, canónico; ausente si la sesión no probó ninguno. Lo usa el saldo a favor. */
  telefonoVerificado?: string
}

/** Codex r2 #4: 5 min de margen sobre los 30 que Stripe exige como mínimo para `expires_at`. */
const CHECKOUT_EXPIRES_MINUTES = CARD_CHECKOUT_TTL_MINUTES + 5
const expiresFrom = (now: Date) => new Date(now.getTime() + CHECKOUT_EXPIRES_MINUTES * 60_000)
/** La huella de la tarjeta no lleva cliente (no hay OTP): se marca `'card'` para que nunca empate con la de pagar al recoger. */
const CARD_CUSTOMER = 'card'
/** D661: la huella de «Nadie» lleva a la clienta de la sesión con su propio prefijo: nunca empata con una de «Mi equipo». */
const CARD_NADIE_CUSTOMER = 'card-nadie'
const CHECKOUT_DESCRIPTION = 'Pedido en línea'

const keyConflict = () =>
  final(new ConflictError('Esa llave ya se usó para otro pedido. Vuelve a armar tu pedido.', 'IDEMPOTENCY_KEY_CONFLICT'))
const notAccepted = () => new BadRequestError('Este negocio no acepta pagar con tarjeta en línea.', 'CARD_PAYMENT_NOT_ACCEPTED')
/** D661 (r1 #12): «Mi equipo» con tarjeta sigue pidiendo el teléfono, con el MISMO 400 (texto y sin código) que daba el esquema. */
const faltaTelefono = () => new BadRequestError('Error de validación: Escribe tu teléfono')
/** D661: en «Nadie» la tarjeta pide sesión; el código es el del pedido sin sesión de «Mi equipo», que la tienda ya conoce. */
const sinSesionEnNadie = () => new UnauthorizedError('Entra a tu cuenta para pagar con tarjeta en línea.', 'PHONE_VERIFICATION_REQUIRED')
/** D661 (r6 #6): el cupo de tarjeta de la sucursal está lleno. Nunca `ORDERING_*`: la tienda no se pausa y pagar en caja sigue. */
const tarjetaLlena = () =>
  new ConflictError(
    'Por ahora hay muchos pagos con tarjeta esperando. Puedes pedir para pagar en caja o intentar en unos minutos.',
    'CARD_ONLINE_QUEUE_FULL',
  )
const telefonoCanonico = (t: string) => canonicalPhoneE164(t) ?? `+${t.replace(/\D/g, '')}`

/**
 * D661 (r1 #12, r2 #12, r3 #12, r5, r6 #6): los topes de la tarjeta en «Nadie», bajo el candado de admisión. Cuentan lo de tarjeta de
 * «Nadie» que aún no se resuelve: borradores `PENDING_AUTH` (aunque su página ya venció: Stripe pudo autorizar; los libera el
 * conciliador) y apartados que ninguna caja ha abierto. Por clienta (no por número: hay clientas sin teléfono) y por sucursal. Los
 * folios de caja no cuentan aquí, y este cupo no cuenta en el de ellos ni en la saturación de la tienda.
 */
async function admitirTarjetaEnNadie(tx: Prisma.TransactionClient, venueId: string, clienta: string): Promise<void> {
  const deLaClienta =
    (await tx.onlineOrderCharge.count({
      where: { ...borradoresNadieWhere(venueId), request: { path: ['customerId'], equals: clienta } },
    })) + (await tx.onlineOrder.count({ where: { ...apartadosNadieWhere(venueId), order: { customerId: clienta } } }))
  if (deLaClienta >= MAX_PENDING_PER_PHONE) {
    throw new ConflictError('Ya tienes pedidos esperando respuesta en este negocio.', 'TOO_MANY_PENDING_ORDERS')
  }
  const enLaSucursal =
    (await tx.onlineOrderCharge.count({ where: borradoresNadieWhere(venueId) })) +
    (await tx.onlineOrder.count({ where: apartadosNadieWhere(venueId) }))
  if (enLaSucursal >= MAX_PENDING_PER_VENUE) throw tarjetaLlena()
}
/** S11 (R2'', R2'''): sin lugar para simular o con la base saturada: reintentable, nunca un precio inventado ni una decisión bajo la llave. */
const beneficiosOcupados = () =>
  new AppError('No pudimos calcular tus beneficios. Intenta de nuevo en un momento.', 503, true, 'BENEFITS_CALCULATION_UNAVAILABLE')

/** Codex r2 #4: Stripe rechazó `expires_at` (ya no quedan 30 min). Sólo pasa si la clave NUNCA se ejecutó: su repetición no revalida. */
export const expiresAtRejected = (e: any): boolean => e?.type === 'StripeInvalidRequestError' && (e.param ?? e.raw?.param) === 'expires_at'

/** Parámetros de la sesión derivados SÓLO de la fila guardada: la misma clave siempre lleva los mismos datos (Stripe los compara). */
export function checkoutParams(charge: OnlineOrderCharge) {
  const request = charge.request as unknown as CardDraftRequest
  return {
    amountCents: toStripeAmount(new Prisma.Decimal(charge.amount)),
    currency: 'MXN' as const,
    description: CHECKOUT_DESCRIPTION,
    successUrl: request.successUrl,
    cancelUrl: request.cancelUrl,
    expiresAt: charge.checkoutExpiresAt,
    customerEmail: request.customer.email ?? undefined,
    metadata: { type: 'online_order', chargeId: charge.id, venueId: charge.venueId },
    idempotencyKey: `online-order-charge:${charge.id}:checkout:${charge.checkoutAttempt}`,
  }
}

/**
 * Pide (o recupera) la sesión de pago del borrador y la guarda. Ningún error de aquí marca `ABANDONED`: eso lo decide el
 * conciliador cuando la sesión venció sin autorización (tarea 7). Exportada para que el conciliador repita lo mismo.
 */
export async function requestCardCheckout(charge: OnlineOrderCharge, now: Date, bumped = false): Promise<OnlineOrderCharge> {
  const merchant = chargeMerchant(charge)
  let session: { id: string; url: string }
  try {
    session = await getProvider(merchant).createAuthorizationCheckout(merchant, checkoutParams(charge))
  } catch (error: any) {
    if (!bumped && expiresAtRejected(error)) {
      // El intento N nunca se ejecutó: se abre el N+1 con vencimiento nuevo. CAS: si otro envío ya subió, se usa el suyo.
      await prisma.onlineOrderCharge.updateMany({
        where: {
          id: charge.id,
          checkoutAttempt: charge.checkoutAttempt,
          checkoutSessionId: null,
          status: OnlineOrderChargeStatus.PENDING_AUTH,
        },
        data: { checkoutAttempt: charge.checkoutAttempt + 1, checkoutExpiresAt: expiresFrom(now) },
      })
      const fresh = await prisma.onlineOrderCharge.findUniqueOrThrow({ where: { id: charge.id } })
      if (fresh.checkoutUrl) return fresh
      return requestCardCheckout(fresh, now, true)
    }
    // Un gemelo que falla nunca escribe encima de una sesión que otro envío ya guardó.
    await prisma.onlineOrderCharge.updateMany({
      where: { id: charge.id, checkoutSessionId: null },
      data: { lastError: String(error?.message ?? error).slice(0, 500), attempts: { increment: 1 } },
    })
    throw new AppError('No pudimos abrir la página de pago. Intenta de nuevo en un momento.', 502, true, 'CARD_PROVIDER_UNAVAILABLE')
  }
  // Dos reintentos a la vez reciben la MISMA sesión (misma clave): el segundo no pisa nada.
  await prisma.onlineOrderCharge.updateMany({
    where: { id: charge.id, checkoutSessionId: null },
    data: { checkoutSessionId: session.id, checkoutUrl: session.url, lastError: null },
  })
  return { ...charge, checkoutSessionId: session.id, checkoutUrl: session.url }
}

/** El estado que daría el seguimiento: el del pedido si ya nació, si no el del borrador. */
async function trackingStatus(charge: OnlineOrderCharge): Promise<PublicTracking['status']> {
  if (!charge.onlineOrderId) return cardDraftTrackingStatus(charge)
  const order = await prisma.onlineOrder.findUnique({ where: { id: charge.onlineOrderId }, select: { status: true } })
  return order?.status ?? cardDraftTrackingStatus(charge)
}

/**
 * S7 (Codex plan r2 #5): la página de pago de un borrador que sigue esperando pero ya venció no se vuelve a mandar: la tienda va
 * al seguimiento, que confirma el borrador y da su estado real.
 */
const checkoutExpired = (charge: OnlineOrderCharge, now: Date) =>
  charge.status === OnlineOrderChargeStatus.PENDING_AUTH && charge.checkoutExpiresAt.getTime() <= now.getTime()

const toResult = (charge: OnlineOrderCharge, replay: boolean, status: PublicTracking['status'], now: Date): CardDraftResult => ({
  trackingToken: charge.trackingToken,
  // ponytail: un borrador que el conciliador cerró sin sesión responde sin liga; la tienda sigue el seguimiento.
  checkoutUrl: checkoutExpired(charge, now) ? '' : (charge.checkoutUrl ?? ''),
  status,
  total: new Prisma.Decimal(charge.amount).toFixed(2),
  replay,
})

const findCharge = (db: Prisma.TransactionClient, venueId: string, idempotencyKey: string) =>
  db.onlineOrderCharge.findUnique({ where: { venueId_idempotencyKey: { venueId, idempotencyKey } } })

export async function createCardOnlineDraft(input: CreateCardDraftInput, opts: CreateOnlineOrderOptions): Promise<CardDraftResult> {
  const now = input.now ?? new Date()
  const { venueId, idempotencyKey } = input
  const externalId = `web:${idempotencyKey}`
  // R23: la forma canónica de la casa; si no la entiende, «+» y sólo dígitos (igual que pagar al recoger). D661: puede no venir.
  const phone = input.customer.phone ? telefonoCanonico(input.customer.phone) : null
  const expectedTotal = new Prisma.Decimal(input.expectedTotal)
  // S11, «Mi equipo»: la clienta cuenta sólo si su teléfono probado es el del pedido (sin sesión, como hoy: sin ficha).
  const customerId =
    input.customerId && input.verifiedPhone && phonesMatch(input.verifiedPhone, input.customer.phone) ? input.customerId : null
  // D661, «Nadie»: la clienta es la de la sesión (cualquier contacto probado) y su teléfono, sólo el que la sesión probó.
  const clientaDeLaSesion = input.customerId ?? null
  const telefonoVerificado = input.verifiedPhone ? telefonoCanonico(input.verifiedPhone) : null
  const eleccion = eleccionNormalizada(input.beneficios)
  const huella = (cliente: string, telefono: string) =>
    onlineOrderRequestHash({
      venueId,
      customerId: cliente,
      paymentMode: OnlineOrderPaymentMode.CARD_ONLINE,
      expectedTotal,
      items: input.items,
      customerName: input.customer.name,
      customerPhone: telefono,
      beneficios: eleccion,
    })
  // La huella de «Mi equipo» es la de hoy, byte por byte (una repetición de un borrador de antes sigue empatando).
  const requestHash = huella(customerId ? `${CARD_CUSTOMER}:${customerId}` : CARD_CUSTOMER, phone ?? '')
  const requestHashNadie = clientaDeLaSesion
    ? huella(`${CARD_NADIE_CUSTOMER}:${clientaDeLaSesion}`, telefonoVerificado ?? SIN_TELEFONO_NADIE)
    : null
  /**
   * r4 (Codex): la misma solicitud leída como cada modo. La llave se resuelve ANTES de leer el modo de la tienda (que pudo cambiar
   * desde el envío original): un borrador con la huella de cualquiera de las dos lecturas es SU borrador.
   */
  const huellas = requestHashNadie ? [requestHash, requestHashNadie] : [requestHash]

  // Codex r4 #8: ANTES de cualquier validación que pueda cambiar (tienda, switch, plan, comercio, precios, monto), una llave que ya
  // tiene borrador es una repetición: va directo a su camino (la huella se compara bajo el candado).
  let fresh: {
    quote: Awaited<ReturnType<typeof quoteCart>>
    /** S11 (R2''): lo que se autoriza: el total estricto de la simulación con sesión; sin ella, el de lista. */
    amount: Prisma.Decimal
    merchant: NonNullable<Awaited<ReturnType<typeof findCardMerchant>>> & { connectAccountId: string }
    applicationFeeCents: number
  } | null = null
  /** D661: el modo con que se validó («Nadie» = `true`). Decide la clienta, la huella, los topes y lo que guarda el borrador. */
  let enNadie = false
  const clientaDelModo = () => (enNadie ? clientaDeLaSesion : customerId)
  const huellaDelModo = () => (enNadie && requestHashNadie ? requestHashNadie : requestHash)
  /** S11 (R1'): un `PRICE_CHANGED` previo al borrador se decide (y se guarda) bajo la llave, como LA decisión de esa llave. */
  let rechazoDePrecio: AppError | null = null
  /**
   * Lo ya decidido sobre la llave, bajo su candado: SU borrador (repetición; con otra huella, choca), la llave ya tomada por un pedido
   * al recoger, o la decisión de precio de negocio + llave (R1'). `null` = la llave está libre.
   */
  const decisionDeLaLlave = async (tx: Prisma.TransactionClient): Promise<OnlineOrderCharge | null> => {
    await lockKey(tx, venueId, externalId)
    const existing = await findCharge(tx, venueId, idempotencyKey)
    if (existing) {
      if (!huellas.includes(existing.requestHash)) throw keyConflict()
      return existing
    }
    if (await tx.order.findUnique({ where: { venueId_externalId: { venueId, externalId } }, select: { id: true } })) throw keyConflict()
    await leerDecisionDePrecio(tx, venueId, idempotencyKey, await huellaDeLaDecisionDePrecio(tx))
    return null
  }
  /** La decisión de precio se guardó con la huella del modo en que se tomó: es de ESTA solicitud si es la de cualquiera de sus lecturas. */
  const huellaDeLaDecisionDePrecio = async (tx: Prisma.TransactionClient): Promise<string> => {
    if (huellas.length === 1) return requestHash
    const fila = await tx.idempotencyRequest.findUnique({
      where: { organizationId_actorStaffId_endpoint_idempotencyKey: decisionDePrecio(venueId, idempotencyKey) },
      select: { requestHash: true },
    })
    return fila && huellas.includes(fila.requestHash) ? fila.requestHash : requestHash
  }
  // S11 (R1', Codex r4 #1 y r5): lo ya decidido va PRIMERO, en una transacción corta: antes de la tienda, el plan, el comercio y el
  // semáforo de la simulación (cualquiera puede salir con un 503 o haber cambiado). Una repetición se salta las validaciones.
  if (!(await prisma.$transaction(tx => decisionDeLaLlave(tx), TX_OPTIONS))) {
    try {
      // El switch se lee directo de la fila (unas columnas, sin armar los ajustes completos en este camino caliente).
      const settings = await prisma.onlineOrderingSettings.findUnique({
        where: { venueId },
        select: { acceptsCardOnline: true, requiresAcceptance: true, cardOnlineNadie: true },
      })
      // «Nadie» sólo con `=== false` (como `getAcceptingStatus`): un ajuste sin el campo es «Mi equipo».
      enNadie = settings?.requiresAcceptance === false
      // «Mi equipo»: el teléfono primero, como cuando lo exigía el esquema (r1 #12).
      if (!enNadie && !phone) throw faltaTelefono()
      await opts.assertCanCreate()
      const state = await getAcceptingStatus(venueId, now)
      if (state.status !== 'OPEN') {
        throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', `ORDERING_${state.status}`, {
          status: state.status,
          reason: state.reason,
        })
      }
      // La MISMA regla que `paymentModes.cardOnline` de GET /info (en «Nadie», su propio interruptor y una caja que avise).
      if (!settings || !(await cardOnlineAvailable(settings, prisma, venueId))) throw notAccepted()
      // D661: en «Nadie» la tarjeta es de la clienta de la sesión (su tope, su saldo a favor). Sin sesión, a entrar; nada se crea.
      if (enNadie && !clientaDeLaSesion) throw sinSesionEnNadie()
      const clienta = clientaDelModo()
      const merchant = await findCardMerchant(prisma, venueId)
      const connectAccountId = (merchant?.providerCredentials as { connectAccountId?: unknown } | null)?.connectAccountId
      if (!merchant || typeof connectAccountId !== 'string' || !connectAccountId) throw notAccepted()

      const quote = await quoteCart(venueId, input.items, { now })
      if (!quote.ok) {
        throw new BadRequestError('Tu pedido tiene productos que ya no están disponibles o datos incompletos.', 'CART_INVALID', {
          issues: quote.issues,
        })
      }
      let amount = quote.total
      if (clienta) {
        // R2'' (S11): con sesión, el total que se autoriza es el ESTRICTO de la MISMA cadena, simulado y deshecho (R9), con su lugar
        // del semáforo de S10 (R2''') y sin su degradación. Termina antes de abrir la transacción del borrador.
        let sim: Awaited<ReturnType<typeof simularBeneficios>>
        try {
          sim = await simularBeneficios(venueId, quote, clienta, eleccion ?? {})
        } catch (error) {
          if (cedeLaSimulacion(error)) throw beneficiosOcupados()
          throw error
        }
        if (!sim) throw beneficiosOcupados()
        if (!sim.total.equals(expectedTotal) || sim.descartados.length > 0) {
          const conBeneficios = {
            ...quote,
            totalConBeneficios: sim.total,
            aplicados: sim.aplicados,
            descartados: sim.descartados,
            // Codex r8: con el desglose recortado, `toPublicQuote` publica la cotización degradada; `totalEstricto` sigue abajo.
            aplicadosCompletos: sim.aplicadosCompletos,
          }
          throw new ConflictError('El precio de tu pedido cambió. Revisa el nuevo total antes de confirmar.', 'PRICE_CHANGED', {
            quote: toPublicQuote({ ...conBeneficios, beneficios: { calculados: true } }),
            totalEstricto: Number(sim.total.toFixed(2)),
            descartados: sim.descartados,
          })
        }
        if (sim.total.isZero()) {
          throw new BadRequestError('Con tus beneficios tu pedido no tiene costo: pídelo para pagar al recoger.', 'ZERO_TOTAL')
        }
        amount = sim.total
      } else {
        if (eleccion) throw sinSesion(quote)
        if (!quote.total.equals(expectedTotal)) {
          throw new ConflictError('El precio de tu pedido cambió. Revisa el nuevo total antes de confirmar.', 'PRICE_CHANGED', {
            quote: toPublicQuote(quote),
          })
        }
      }
      const cents = toStripeAmount(amount)
      const bounds = getStripeChargeBoundsCents()
      if (cents < bounds.min || cents > bounds.max) {
        throw new BadRequestError('El total de tu pedido no se puede pagar con tarjeta en línea.', 'CARD_AMOUNT_OUT_OF_RANGE', {
          minAmount: fromStripeAmount(bounds.min).toFixed(2),
          maxAmount: fromStripeAmount(bounds.max).toFixed(2),
        })
      }
      // Codex r1 #8: la comisión se calcula UNA vez aquí y queda congelada en el borrador.
      const applicationFeeCents = calculateApplicationFeeWithVAT(cents, merchant.platformFeeBps, await getVatRateBps())
      fresh = { quote, amount, merchant: { ...merchant, connectAccountId }, applicationFeeCents }
    } catch (error) {
      // El PRICE_CHANGED se decide (y se guarda) en la transacción del borrador, que relee la llave primero.
      if (isDefinitiveRejection(error) && error.code === 'PRICE_CHANGED') rechazoDePrecio = error
      // S11 (Codex r6): cualquier otro error (503, 500, Prisma, o un rechazo que no se guarda) pasa por la MISMA regla que pagar al
      // recoger: lo que otro decidió sobre la llave mientras éste validaba gana. Un borrador gemelo ya creado es SU pedido: sigue al
      // camino de la repetición.
      else await loDecididoOEste(decisionDeLaLlave, error)
    }
  }

  // R3 (S11): llave → admisión, como pagar al recoger, y con la red por traba.
  const decided = await withDeadlockRetry(
    async tx => {
      // PRIMERO la repetición propia: SU pedido aunque ya tenga cuenta (Codex r3 #1); después la llave de un pedido al recoger y la
      // decisión de precio (R1'), otra vez bajo el candado: un gemelo pudo decidir mientras éste validaba.
      const existing = await decisionDeLaLlave(tx)
      if (existing) return { charge: existing, replay: true }
      if (rechazoDePrecio) {
        return {
          rechazo: await guardarDecisionDePrecio(tx, {
            venueId,
            idempotencyKey,
            requestHash: huellaDelModo(),
            error: rechazoDePrecio,
            now,
          }),
        }
      }
      const f = fresh
      if (!f) throw new Error('Borrador de tarjeta sin validar y sin repetición') // inalcanzable: no se borran borradores
      const clienta = clientaDelModo()

      await lockAdmission(tx, venueId)
      if (enNadie) {
        await admitirTarjetaEnNadie(tx, venueId, clienta!) // con `enNadie`, la sesión ya se exigió al validar
      } else {
        // Topes de «Mi equipo»: pedidos por aceptar MÁS borradores con su sesión vigente. El teléfono ya se exigió al validar.
        const liveDrafts = liveCardDraftsWhere(venueId, now)
        const byPhone =
          (await tx.onlineOrder.count({ where: { ...awaitingAcceptanceWhere(venueId), order: { customerPhone: phone } } })) +
          (await tx.onlineOrderCharge.count({ where: { ...liveDrafts, customerPhone: phone! } }))
        if (byPhone >= MAX_PENDING_PER_PHONE) {
          throw new ConflictError('Ya tienes pedidos esperando respuesta en este negocio.', 'TOO_MANY_PENDING_ORDERS')
        }
        const inVenue =
          (await tx.onlineOrder.count({ where: awaitingAcceptanceWhere(venueId) })) +
          (await tx.onlineOrderCharge.count({ where: liveDrafts }))
        if (inVenue >= MAX_PENDING_PER_VENUE) {
          throw new ConflictError('La tienda no está recibiendo pedidos en este momento.', 'ORDERING_PAUSED', {
            status: 'PAUSED',
            reason: 'TOO_BUSY',
          })
        }
      }

      const trackingToken = generateTrackingToken()
      const trackUrl = `${storefrontBase()}/${encodeURIComponent(input.venueSlug)}/pedido/${encodeURIComponent(trackingToken)}`
      const request: CardDraftRequest = {
        quote: toQuoteSnapshot(f.quote),
        // D661: en «Nadie» el teléfono de la cuenta es sólo el que probó la sesión (uno tecleado sin probar no se guarda, como el folio).
        customer: { name: input.customer.name, phone: enNadie ? telefonoVerificado : phone, email: input.customer.email ?? null },
        note: input.note?.trim() ? input.note.trim() : null,
        whatsappConsent: input.whatsappConsent === true,
        externalId,
        successUrl: `${trackUrl}?pago=1`,
        cancelUrl: `${trackUrl}?pago=cancelado`,
        customerId: clienta,
        beneficios: clienta ? eleccion : null,
        ...(enNadie ? { nadie: true as const, ...(telefonoVerificado ? { telefonoVerificado } : {}) } : {}),
      }
      const merchantSnapshot: MerchantSnapshot = {
        connectAccountId: f.merchant.connectAccountId,
        sandboxMode: f.merchant.sandboxMode,
        providerCode: f.merchant.provider!.code,
      }
      // C9: el cargo no se liga a una ficha (sin `customerId`); la clienta probada viaja en `request` y la liga el pedido al confirmar.
      const charge = await tx.onlineOrderCharge.create({
        data: {
          venueId,
          ecommerceMerchantId: f.merchant.id,
          idempotencyKey,
          trackingToken,
          // D661: el de «Nadie» va vacío: su tope es por clienta (`SIN_TELEFONO_NADIE`), su teléfono probado viaja en `request`.
          customerPhone: enNadie ? SIN_TELEFONO_NADIE : phone!,
          request: request as unknown as Prisma.InputJsonValue,
          requestHash: huellaDelModo(),
          checkoutExpiresAt: expiresFrom(now),
          amount: f.amount,
          platformFeeBps: f.merchant.platformFeeBps,
          applicationFeeCents: f.applicationFeeCents,
          merchantSnapshot: merchantSnapshot as unknown as Prisma.InputJsonValue,
        },
      })
      return { charge, replay: false }
    },
    { etiqueta: 'createCardOnlineDraft', ...TX_OPTIONS },
  )
  if ('rechazo' in decided) throw decided.rechazo

  const { charge, replay } = decided
  const ready =
    charge.checkoutUrl || charge.status !== OnlineOrderChargeStatus.PENDING_AUTH ? charge : await requestCardCheckout(charge, now)
  return toResult(ready, replay, replay ? await trackingStatus(ready) : 'AWAITING_PAYMENT', now)
}
