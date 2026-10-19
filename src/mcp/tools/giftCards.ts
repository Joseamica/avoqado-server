/**
 * Tarjetas de regalo — herramientas del MCP de clientes (spec §7; índice C5; pendientes 1a, tarea 4). Sólo en `/mcp` (modo
 * libre); el directorio certificado necesita su propia revisión. Sin candado de plan: un negocio que bajó de plan sigue
 * debiendo el saldo vendido y tiene que poder leerlo y operarlo (spec §6, R9). Dinero en PESOS; fechas = días del negocio.
 * Nunca devuelven el código: sólo sus últimos 4.
 * Las de operación del gerente (bloquear, ajustar, cancelar la venta, reglas) siguen el patrón de escritura del catálogo
 * (vista previa → confirmación con token atado a los argumentos) y NO reponen el código (el nuevo pasaría por el chat) ni
 * prenden la función (los términos se aceptan en el panel).
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Prisma } from '@prisma/client'
import { z } from 'zod'
import AppError from '@/errors/AppError'
import type { McpScope } from '../scope'
import { createGuard } from '../guard'
import { text } from '../respond'
import { auditMcpWrite } from '../audit'
import {
  getGiftCardDetail,
  getGiftCardLiabilityAging,
  getGiftCardSummary,
  listGiftCards,
  type GiftCardRow,
} from '@/services/giftCards/giftCardReports.service'
import { operarSobreDeGerente, type GiftCardAuditAction, type OperacionDeGerenteHttp } from '@/services/giftCards/giftCardSurface.service'
import { iniciarCancelacionDeVenta, liberarCancelacionDeVenta } from '@/services/giftCards/giftCardCancel.service'
import {
  getGiftCardSettings,
  updateGiftCardSettings,
  type UpdateGiftCardSettingsInput,
} from '@/services/giftCards/giftCardSettings.service'
import { GiftCardError } from '@/services/giftCards/giftCardErrors'
import { formatoPesos } from '@/services/giftCards/giftCardLimits'
import { MOTIVOS_DE_GERENTE, operationSchema, updateSettingsSchema } from '@/schemas/dashboard/giftCard.schema'
import { MENSAJE_CONFIRMAR_NO_DEVUELTO } from '@/schemas/common/giftCard.common.schema'
import { getVenueTimezone } from '@/services/dashboard/commission/commission-utils'
import { formatInVenueTimezone } from '@/utils/datetime'

const DIA = /^\d{4}-\d{2}-\d{2}$/
const ULTIMOS_4 = /^[0-9A-Za-z]{4}$/
const MAX_COINCIDENCIAS = 10

type Respuesta = ReturnType<typeof text>
type OperacionDelAsistente = Exclude<OperacionDeGerenteHttp, { tipo: 'REEMPLAZAR_CODIGO' }>

/** Reponer el código NO se ofrece: devolvería el código completo por el chat (spec §2 de los pendientes). */
const ACCIONES = { block: 'BLOQUEAR', unblock: 'DESBLOQUEAR', adjust: 'AJUSTE' } as const
/** Las primeras reglas de la libreta por estado: la vista previa no promete lo que la confirmación rechazaría. */
const ESTADOS_QUE_ADMITEN: Record<keyof typeof ACCIONES, string[]> = {
  block: ['ACTIVE'],
  unblock: ['BLOCKED'],
  adjust: ['ACTIVE', 'BLOCKED'],
}
const VERBO: Record<keyof typeof ACCIONES, string> = { block: 'bloquear', unblock: 'desbloquear', adjust: 'ajustar' }
const ESTADO: Record<string, string> = { PENDING: 'sin cobrar', ACTIVE: 'activa', BLOCKED: 'bloqueada', DEACTIVATED: 'desactivada' }
/** Las mismas acciones de bitácora que escribe la ruta del panel (`giftCard.dashboard.controller.ts`, `operate`). */
const ACCION_EN_BITACORA: Record<OperacionDelAsistente['tipo'], GiftCardAuditAction> = {
  AJUSTE: 'GIFT_CARD_ADJUSTED',
  BLOQUEAR: 'GIFT_CARD_BLOCKED',
  DESBLOQUEAR: 'GIFT_CARD_UNBLOCKED',
}
const PRENDER_EN_EL_PANEL =
  'Las tarjetas de regalo se prenden desde el panel (Ajustes › Tarjetas de regalo), porque hay que aceptar los términos.'
const CONFIRMA = ' Confirma con el usuario; luego vuelve a llamar con confirm:true.'

const llave = z
  .string()
  .regex(/^[A-Za-z0-9_-]{8,64}$/)
  .optional()
  .describe('Llave única por operación; genera una vez y reutiliza en preview, confirmación y reintentos')
const pideLlave = (): Respuesta =>
  text({
    ok: false,
    needsInput: true,
    field: 'idempotencyKey',
    instruction:
      'Genera una llave única (UUID) para esta operación y consérvala en la vista previa, la confirmación y todos sus reintentos. No hace falta pedirla al usuario.',
  })
const enmascarada = (last4: string) => `••••${last4}`
const mismoFolio = (a: string, b: string) => a.trim().toUpperCase() === b.trim().toUpperCase()
const laVenta = (folio: string, venta: { cards: number; amount: number } | null) =>
  `Venta #${folio}` + (venta ? ` · ${venta.cards} tarjeta${venta.cards === 1 ? '' : 's'} · ${formatoPesos(venta.amount)}` : '')
const noEncontrada = (): Respuesta =>
  text({ ok: false, code: 'GIFT_CARD_NOT_FOUND', error: 'No encontré una tarjeta de regalo con esos datos en este negocio.' })

/** Un rechazo de negocio (tarjetas o validación del servicio) viaja con su code y su texto; lo demás se propaga. */
function rechazo(err: unknown): Respuesta {
  if (!(err instanceof AppError)) throw err
  return text({
    ok: false,
    ...(err.code ? { code: err.code } : {}),
    error: err.message,
    ...(err.details !== undefined ? { details: err.details } : {}),
  })
}

/**
 * La tarjeta sobre la que se opera: por sus últimos 4 y/o el folio de su venta (filtrados en la base), o por su `cardRef` (su
 * id: no es secreto, el secreto es el código). Nunca se adivina: con varias candidatas responde `ambiguous` con cada una para
 * que el usuario escoja. Un `cardRef` se busca DENTRO del negocio (otro negocio ⇒ «no encontrada») y debe cuadrar con los 4 y
 * el folio que lleguen.
 */
async function resolverTarjeta(
  venueId: string,
  p: { cardRef?: string; last4?: string; saleFolio?: string },
): Promise<{ tarjeta: GiftCardRow } | { respuesta: Respuesta }> {
  if (p.cardRef) {
    const tarjeta = await getGiftCardDetail(venueId, p.cardRef, { limit: 1 }).catch(err => {
      if (err instanceof GiftCardError && err.code === 'GIFT_CARD_NOT_FOUND') return null
      throw err
    })
    const cuadra =
      tarjeta &&
      (!p.last4 || tarjeta.last4.toUpperCase() === p.last4.toUpperCase()) &&
      (!p.saleFolio || (tarjeta.order !== null && mismoFolio(tarjeta.order.orderNumber, p.saleFolio)))
    return cuadra ? { tarjeta } : { respuesta: noEncontrada() }
  }
  const pagina = await listGiftCards(venueId, { last4: p.last4, folio: p.saleFolio, pageSize: MAX_COINCIDENCIAS })
  if (pagina.total === 0) return { respuesta: noEncontrada() }
  if (pagina.total === 1) return { tarjeta: pagina.items[0] }
  return {
    respuesta: text({
      ok: false,
      ambiguous: true,
      total: pagina.total,
      moreThanShown: pagina.total > pagina.items.length,
      error: `Hay ${pagina.total} tarjetas con esos datos y no escojo una por mi cuenta. Muéstrale al usuario las candidatas y pregúntale cuál es; vuelve a llamar con el folio de su venta (saleFolio) o, si dos son de la misma venta, con su cardRef.`,
      candidates: pagina.items.map(t => ({
        cardRef: t.id,
        last4: t.last4,
        status: t.status,
        balance: t.balance,
        saleFolio: t.order?.orderNumber ?? null,
      })),
    }),
  }
}

export function registerGiftCardTools(server: McpServer, scope: McpScope) {
  const guard = createGuard(scope)

  server.tool(
    'gift_cards_summary',
    'Gift cards (tarjetas de regalo) of a venue you can access, in PESOS: how many were SOLD (activated) in the period and for how much, how much balance customers USED (net of reversals), sales CANCELLED, manager adjustments, the LIVE BALANCE the business still owes today (and how much of it is already expired), and that balance by AGE since activation (0-30, 31-90, 91-180, 181-365, 366+ days) at the end of the period. Answers "¿cuánto vendí en tarjetas de regalo este mes?", "¿cuánto saldo deben mis tarjetas?", "¿qué tan viejo es ese saldo?". Dates are the venue\'s own calendar days (YYYY-MM-DD); by default, the current month up to today. Pass venueId. Requires giftCards:read. Works even if the business no longer has the plan: existing balances can always be read.',
    {
      venueId: z.string().describe('Venue whose gift cards to summarize (must be in your scope)'),
      fromDate: z
        .string()
        .regex(DIA, 'Usa AAAA-MM-DD')
        .optional()
        .describe('First day (YYYY-MM-DD, venue-local). Default: day 1 of the month of toDate (of the current month without toDate)'),
      toDate: z
        .string()
        .regex(DIA, 'Usa AAAA-MM-DD')
        .optional()
        .describe('Last day (YYYY-MM-DD, venue-local); the aging is measured at the end of this day. Default: today'),
    },
    async ({ venueId, fromDate, toDate }) => {
      guard.venueFilter(venueId) // lanza ScopeError fuera de alcance
      guard.requirePermission('giftCards:read', venueId) // espejo de las rutas del dashboard
      const timezone = await getVenueTimezone(venueId)
      const hoy = formatInVenueTimezone(new Date(), timezone, 'yyyy-MM-dd')
      const hasta = toDate ?? hoy
      // ⭐ (C5 menor 4): el inicio por defecto es el día 1 del mes de `hasta`; con sólo un toDate de un mes anterior, el día 1 del
      // mes actual quedaba después del fin (GIFT_CARD_RANGE_INVALID).
      const desde = fromDate ?? `${hasta.slice(0, 8)}01`
      const [resumen, antiguedad] = await Promise.all([
        getGiftCardSummary(venueId, { from: desde, to: hasta }),
        getGiftCardLiabilityAging(venueId, hasta),
      ])
      return text({ venueId, currency: 'MXN', ...resumen, aging: antiguedad })
    },
  )

  server.tool(
    'gift_card_lookup',
    'Find gift cards (tarjetas de regalo) of a venue you can access by the LAST 4 characters of their code, or by the customer, recipient or buyer (name, phone or email). For each card: last 4, status (PENDING = sold but not paid yet, ACTIVE, BLOCKED, DEACTIVATED), expired (true = its expiry already passed: it can NOT be used even if status is ACTIVE), initial amount and current balance in PESOS, activation and expiry days (venue-local), who it belongs to and its sale ticket. NEVER returns the full code. Up to 10 matches plus the total; if there are more, ask the user to be more specific. Pass venueId and last4 or customer. Requires giftCards:read.',
    {
      venueId: z.string().describe('Venue that issued the cards (must be in your scope)'),
      last4: z
        .string()
        .regex(ULTIMOS_4, 'Son los últimos 4 caracteres del código')
        .optional()
        .describe('Last 4 characters of the card code'),
      customer: z.string().min(2).max(80).optional().describe('Customer, recipient or buyer: name, phone or email (partial)'),
    },
    async ({ venueId, last4, customer }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('giftCards:read', venueId)
      if (!last4 && !customer)
        return text({ found: false, error: 'Dime los últimos 4 caracteres del código, o el nombre, teléfono o correo del cliente.' })
      const timezone = await getVenueTimezone(venueId)
      const dia = (instante: string | null) => (instante ? formatInVenueTimezone(new Date(instante), timezone, 'yyyy-MM-dd') : null)
      const pagina = await listGiftCards(venueId, { last4, search: customer, pageSize: MAX_COINCIDENCIAS })
      const ahora = Date.now()
      if (pagina.total === 0) return text({ found: false, error: 'No encontré tarjetas de regalo con esos datos en este negocio.' })
      return text({
        found: true,
        venueId,
        currency: 'MXN',
        total: pagina.total,
        showing: pagina.items.length,
        moreThanShown: pagina.total > pagina.items.length,
        cards: pagina.items.map(t => ({
          last4: t.last4,
          status: t.status,
          initialAmount: t.initialAmount,
          balance: t.balance,
          activatedOn: dia(t.activatedAt),
          expiresOn: dia(t.expiresAt),
          // ⭐ (C5 menor 5, aditivo): la misma frontera que el saldo y la lista (vencida ⇔ expiresAt <= ahora), para que la IA nunca
          // le diga a un cliente que una tarjeta vencida sirve.
          expired: t.expiresAt !== null && Date.parse(t.expiresAt) <= ahora,
          customer: t.customer?.name ?? null,
          recipient: t.recipientName,
          buyer: t.purchaserName,
          saleTicket: t.order?.orderNumber ?? null,
        })),
      })
    },
  )

  server.tool(
    'manage_gift_card',
    "Operate ONE gift card (tarjeta de regalo) of a venue you can access, as the manager: BLOCK it (nobody can spend it until it is unblocked), UNBLOCK it, or ADJUST its balance ('add' raises it, 'remove' lowers it; amount in PESOS) with a reason and a REQUIRED note (1 to 500 characters) saying why. Find the card by the LAST 4 characters of its code. If several cards match, the answer lists them (last 4, status, balance, sale ticket and cardRef): NEVER pick one yourself — ask the user and call again with saleFolio (the sale ticket) or that cardRef. By DEFAULT this only PREVIEWS (current balance → new balance); call again with confirm:true to apply it. Replacing a lost card's code is NOT available here (the new code would travel through the chat): it is done in the dashboard. This WRITES — requires giftCards:manage. Works even if the business no longer has the plan.",
    {
      venueId: z.string().describe('Venue that issued the card (must be in your scope)'),
      last4: z.string().regex(ULTIMOS_4, 'Son los últimos 4 caracteres del código').describe('Last 4 characters of the card code'),
      saleFolio: z
        .string()
        .trim()
        .min(1)
        .max(64)
        .optional()
        .describe('Sale ticket of the card (folio / número de cuenta), to choose among cards with the same last 4'),
      cardRef: z
        .string()
        .min(1)
        .max(64)
        .optional()
        .describe('cardRef of the card, exactly as listed when several cards match (two cards of the same sale)'),
      action: z.enum(['block', 'unblock', 'adjust']).describe('block · unblock · adjust'),
      direction: z.enum(['add', 'remove']).optional().describe("adjust only: 'add' raises the balance, 'remove' lowers it"),
      amount: z.number().positive().optional().describe('adjust only: pesos to add or remove, up to 2 decimals (e.g. 50 or 120.50)'),
      reason: z
        .enum(MOTIVOS_DE_GERENTE)
        .describe('Why: SUSPICIOUS_ACTIVITY, CASHIER_ERROR, CUSTOMER_REQUEST, LOST_CARD, CHARGEBACK or OTHER'),
      note: z.string().optional().describe('Explanation for the record. REQUIRED for adjust (1 to 500 characters) and with reason OTHER'),
      idempotencyKey: llave,
      confirm: z.boolean().optional().describe('Must be true to actually apply it; without it you get a preview'),
    },
    async ({ venueId, last4, saleFolio, cardRef, action, direction, amount, reason, note, idempotencyKey, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('giftCards:manage', venueId) // escritura: también exige mcp:write
      if (!idempotencyKey) return pideLlave()
      // El MISMO esquema que valida la ruta del panel: motivo, centavos exactos y nota obligatoria de 1 a 500 en todo ajuste.
      const tipo = ACCIONES[action]
      const crudo = {
        operationKey: idempotencyKey,
        tipo,
        reason,
        ...(note !== undefined ? { note } : {}),
        ...(tipo === 'AJUSTE' && direction ? { direccion: direction === 'add' ? 'INCREMENT' : 'DECREMENT' } : {}),
        ...(tipo === 'AJUSTE' && amount !== undefined ? { amount } : {}),
      }
      const valido = operationSchema.shape.body.safeParse(crudo)
      if (!valido.success) return text({ ok: false, error: valido.error.issues[0].message })
      const op = valido.data as OperacionDelAsistente

      const r = await resolverTarjeta(venueId, { cardRef, last4, saleFolio })
      if ('respuesta' in r) return r.respuesta
      const t = r.tarjeta
      const tarjeta = enmascarada(t.last4)

      if (!confirm) {
        // La vista previa no promete lo que la confirmación rechazaría (las primeras reglas de la libreta). Al confirmar decide la
        // libreta bajo candado: así el reintento de una confirmación que SÍ llegó responde «hecho» en vez de chocar con lo que dejó.
        if (!ESTADOS_QUE_ADMITEN[action].includes(t.status)) {
          return text({
            ok: false,
            code: 'GIFT_CARD_BLOCKED',
            error: `La tarjeta ${tarjeta} está ${ESTADO[t.status] ?? t.status}: no se puede ${VERBO[action]}.`,
          })
        }
        const saldo = new Prisma.Decimal(t.balance)
        const despues = op.tipo === 'AJUSTE' ? (op.direccion === 'INCREMENT' ? saldo.plus(op.amount) : saldo.minus(op.amount)) : null
        if (op.tipo === 'AJUSTE' && despues!.isNegative()) {
          return text({
            ok: false,
            code: 'GIFT_CARD_INSUFFICIENT_BALANCE',
            error: `La tarjeta ${tarjeta} tiene ${formatoPesos(saldo)}: no se le pueden restar ${formatoPesos(op.amount)}.`,
          })
        }
        const efecto =
          op.tipo === 'AJUSTE'
            ? `Esto ${op.direccion === 'INCREMENT' ? 'SUMARÁ' : 'RESTARÁ'} ${formatoPesos(op.amount)} ${op.direccion === 'INCREMENT' ? 'a' : 'de'} la tarjeta ${tarjeta}: su saldo pasa de ${formatoPesos(saldo)} a ${formatoPesos(despues!)}.`
            : op.tipo === 'BLOQUEAR'
              ? `Esto BLOQUEARÁ la tarjeta ${tarjeta} (saldo ${formatoPesos(saldo)}): nadie podrá usarla hasta desbloquearla.`
              : `Esto DESBLOQUEARÁ la tarjeta ${tarjeta} (saldo ${formatoPesos(saldo)}): se podrá volver a usar.`
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: {
            card: tarjeta,
            saleFolio: t.order?.orderNumber ?? null,
            status: t.status,
            balance: t.balance,
            action,
            ...(op.tipo === 'AJUSTE' ? { direction, amount: Number(op.amount.toFixed(2)), balanceAfter: Number(despues!.toFixed(2)) } : {}),
            reason: op.reason,
            note: op.note ?? null,
          },
          message: efecto + CONFIRMA,
        })
      }

      try {
        const hecho = await operarSobreDeGerente(venueId, t.id, scope.staffId, op)
        // Como la ruta del panel: bitácora sólo si la libreta no lo reconoció como repetición, y nunca con un código.
        if (!hecho.replayed) {
          await auditMcpWrite(scope, {
            action: ACCION_EN_BITACORA[op.tipo],
            entity: 'GiftCard',
            entityId: t.id,
            venueId,
            data: {
              operationKey: op.operationKey,
              tipo: op.tipo,
              reason: op.reason,
              note: op.note ?? null,
              ...(op.tipo === 'AJUSTE' ? { direccion: op.direccion, amount: Number(op.amount.toFixed(2)) } : {}),
              activityIds: hecho.activityIds,
            },
          })
        }
        return text({ ok: true, card: tarjeta, action, replayed: hecho.replayed })
      } catch (err) {
        return rechazo(err)
      }
    },
  )

  server.tool(
    'cancel_gift_card_sale',
    "Cancel the SALE of gift cards (tarjetas de regalo) of a venue you can access, in two steps, like the dashboard. action 'start' blocks ALL the cards of that sale so nobody spends them; then the money of the sale must be refunded (issue_refund for cash, refund_card_on_terminal for a card payment) and the cards are deactivated when that refund is recorded. It is only possible the same day of the sale and while no card has been used. action 'release' undoes a started cancellation ONLY when the user CHECKED the refund was NOT made (pass confirmNotRefunded:true); if unsure, leave the cards blocked. Find the sale by the last 4 of one of its cards or by its sale ticket (saleFolio). By DEFAULT this only PREVIEWS (sale ticket, how many cards and for how much); call again with confirm:true. This WRITES — requires giftCards:manage.",
    {
      venueId: z.string().describe('Venue that sold the cards (must be in your scope)'),
      last4: z
        .string()
        .regex(ULTIMOS_4, 'Son los últimos 4 caracteres del código')
        .optional()
        .describe('Last 4 characters of one card of the sale'),
      saleFolio: z.string().trim().min(1).max(64).optional().describe('Sale ticket (folio / número de cuenta) of the sale'),
      cardRef: z.string().min(1).max(64).optional().describe('cardRef of a card of the sale, exactly as listed when several cards match'),
      action: z.enum(['start', 'release']).describe("'start' = begin the cancellation · 'release' = undo it (the refund was NOT made)"),
      confirmNotRefunded: z.boolean().optional().describe('release only: true ONLY if the user checked that the money was NOT refunded'),
      idempotencyKey: llave,
      confirm: z.boolean().optional().describe('Must be true to actually do it; without it you get a preview'),
    },
    async ({ venueId, last4, saleFolio, cardRef, action, confirmNotRefunded, idempotencyKey, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('giftCards:manage', venueId)
      if (!idempotencyKey) return pideLlave()
      if (!last4 && !saleFolio) {
        return text({
          ok: false,
          needsInput: true,
          field: 'saleFolio',
          question: '¿De qué venta? Dime el folio de la venta o los últimos 4 de una de sus tarjetas.',
        })
      }
      // F6 (r1): un timeout de la terminal NO prueba que el dinero no salió; liberar exige que el gerente lo comprobó (la casilla
      // del panel). Se pregunta antes de leer nada.
      if (action === 'release' && confirmNotRefunded !== true) {
        return text({
          ok: false,
          needsInput: true,
          field: 'confirmNotRefunded',
          question: `${MENSAJE_CONFIRMAR_NO_DEVUELTO} Pasa confirmNotRefunded:true sólo si el usuario lo confirma.`,
        })
      }
      const r = await resolverTarjeta(venueId, { cardRef, last4, saleFolio })
      if ('respuesta' in r) return r.respuesta
      const orden = r.tarjeta.order
      if (!orden) {
        return text({ ok: false, error: `La tarjeta ${enmascarada(r.tarjeta.last4)} no viene de una venta: no hay venta que cancelar.` })
      }
      const { cancel, sale } = await getGiftCardDetail(venueId, r.tarjeta.id, { limit: 1 })
      const venta = laVenta(orden.orderNumber, sale)

      if (!confirm) {
        // La MISMA regla que pinta el botón del panel (`cancel` del detalle): la vista previa no promete lo que se rechazaría. Al
        // confirmar decide el servicio, bajo candado, y un reintento con la misma llave responde lo mismo.
        if (action === 'start' && cancel.reason === 'IN_PROGRESS') {
          return text({ ok: false, error: `La cancelación de la ${venta} ya está en curso: falta devolver su cobro, o liberarla.` })
        }
        if (action === 'start' && !cancel.allowed) {
          return text({
            ok: false,
            ...(cancel.reason ? { code: cancel.reason } : {}),
            error: cancel.message ?? 'Esta venta no se puede cancelar.',
          })
        }
        if (action === 'release' && cancel.reason !== 'IN_PROGRESS') {
          return text({ ok: false, error: `La ${venta} no tiene una cancelación en curso: no hay nada que liberar.` })
        }
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { sale: venta, action },
          message:
            (action === 'start'
              ? `Esto INICIARÁ la cancelación de la ${venta}: sus tarjetas quedan bloqueadas para que nadie gaste el saldo. Después hay que devolver el cobro de la venta (issue_refund si fue en efectivo, refund_card_on_terminal si fue con tarjeta); al registrarse la devolución, las tarjetas se desactivan.`
              : `Esto LIBERARÁ la cancelación de la ${venta}: sus tarjetas vuelven a poder usarse. Hazlo sólo si el usuario comprobó que el cobro NO se devolvió.`) +
            CONFIRMA,
        })
      }

      try {
        // Los servicios ya escriben su bitácora; ésta es la evidencia de qué app y quién lo pidió, y va SÓLO si esta llamada escribió
        // algo: un reintento con la misma llave, o una cancelación que otra persona ya inició, no se firma a nombre de esta app.
        if (action === 'start') {
          const { bloqueadas } = await iniciarCancelacionDeVenta(venueId, orden.id, {
            staffId: scope.staffId,
            operationKey: idempotencyKey,
          })
          if (bloqueadas.length > 0) {
            await auditMcpWrite(scope, {
              action: 'GIFT_CARD_SALE_CANCEL_STARTED',
              entity: 'Order',
              entityId: orden.id,
              venueId,
              data: { operationKey: idempotencyKey, giftCardIds: bloqueadas },
            })
          }
          return text({
            ok: true,
            sale: venta,
            action,
            blockedCards: bloqueadas.length,
            ...(bloqueadas.length === 0 ? { note: 'La cancelación ya estaba en curso: esta llamada no cambió nada.' } : {}),
            nextStep:
              'Devuelve el cobro de esa venta (issue_refund si fue en efectivo, refund_card_on_terminal si fue con tarjeta). Si al final no se devuelve, libera la cancelación.',
          })
        }
        const { liberadas } = await liberarCancelacionDeVenta(venueId, orden.id, {
          staffId: scope.staffId,
          operationKey: idempotencyKey,
          confirmacionNoDevuelto: true,
        })
        if (liberadas.length > 0) {
          await auditMcpWrite(scope, {
            action: 'GIFT_CARD_SALE_CANCEL_RELEASED',
            entity: 'Order',
            entityId: orden.id,
            venueId,
            data: { operationKey: idempotencyKey, giftCardIds: liberadas },
          })
        }
        return text({
          ok: true,
          sale: venta,
          action,
          releasedCards: liberadas.length,
          ...(liberadas.length === 0 ? { note: 'No había tarjetas por liberar: esta llamada no cambió nada.' } : {}),
        })
      } catch (err) {
        return rechazo(err)
      }
    },
  )

  server.tool(
    'update_gift_card_settings',
    'Change the gift card (tarjetas de regalo) rules of a venue you can access: suggested amounts (1 to 6), minimum and maximum amount per card in PESOS, and validity (12, 24, 36 or 60 months, or null = no expiry); they apply to the cards sold from now on. Or TURN OFF selling them (enabled:false): the cards already sold keep their balance and can still be used. Turning them ON is NOT possible here: it is done in the dashboard (Ajustes › Tarjetas de regalo), where the terms are accepted. By DEFAULT this only PREVIEWS (current → new); call again with confirm:true to save. This WRITES — requires giftCards:manage.',
    {
      venueId: z.string().describe('Venue whose rules to change (must be in your scope)'),
      enabled: z.boolean().optional().describe('false = turn OFF selling gift cards. true is not accepted here'),
      suggestedAmounts: z.array(z.number()).optional().describe('Suggested amounts in pesos (1 to 6), e.g. [200, 500, 1000]'),
      minAmount: z.number().optional().describe('Minimum amount per card, in pesos'),
      maxAmount: z.number().optional().describe('Maximum amount per card, in pesos'),
      validityMonths: z.number().int().nullable().optional().describe('12, 24, 36 or 60 months; null = no expiry'),
      confirm: z.boolean().optional().describe('Must be true to actually save; without it you get a preview'),
    },
    async ({ venueId, enabled, suggestedAmounts, minAmount, maxAmount, validityMonths, confirm }) => {
      guard.venueFilter(venueId)
      guard.requirePermission('giftCards:manage', venueId)
      if (enabled === true) return text({ ok: false, error: PRENDER_EN_EL_PANEL })
      // El MISMO esquema que valida la ruta del panel; sólo lo que llegó (el servicio escribe sólo eso).
      const llegaron = Object.fromEntries(
        Object.entries({ enabled, suggestedAmounts, minAmount, maxAmount, validityMonths }).filter(([, v]) => v !== undefined),
      )
      const valido = updateSettingsSchema.shape.body.safeParse(llegaron)
      if (!valido.success) return text({ ok: false, error: valido.error.issues[0].message })
      const cambios = valido.data as UpdateGiftCardSettingsInput

      if (!confirm) {
        const actual = await getGiftCardSettings(venueId)
        const changes = Object.fromEntries(
          Object.entries(cambios).map(([campo, nuevo]) => [campo, { from: actual[campo as keyof typeof actual], to: nuevo }]),
        )
        return text({
          ok: false,
          requiresConfirmation: true,
          preview: { changes },
          message:
            (cambios.enabled === false
              ? 'Esto APAGA la venta de tarjetas de regalo: ya no se podrán vender nuevas. Las ya vendidas siguen valiendo: se pueden cobrar y consultar. Volver a prenderla se hace desde el panel. '
              : '') +
            'Las reglas nuevas (antes → después en preview.changes) aplican a las tarjetas que se vendan desde ahora.' +
            CONFIRMA,
        })
      }

      try {
        const guardado = await updateGiftCardSettings(venueId, cambios, scope.staffId)
        await auditMcpWrite(scope, {
          action: 'GIFT_CARD_SETTINGS_UPDATED',
          entity: 'GiftCardSettings',
          entityId: venueId,
          venueId,
          data: { changes: cambios },
        })
        return text({
          ok: true,
          settings: {
            enabled: guardado.enabled,
            suggestedAmounts: guardado.suggestedAmounts,
            minAmount: guardado.minAmount,
            maxAmount: guardado.maxAmount,
            validityMonths: guardado.validityMonths,
          },
        })
      } catch (err) {
        return rechazo(err)
      }
    },
  )
}
