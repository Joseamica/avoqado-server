/**
 * Tarjetas de regalo — piezas de SUPERFICIE que comparten las rutas del POS y del dashboard (índice C3):
 *   · la bitácora (`ActivityLog`) de las mutaciones cuyo servicio no la escribe (vender, cobrar con saldo, regresarlo,
 *     operaciones de gerente), FUERA de la transacción y sin esperar (`void logAction`). Ajustes (A5) y cancelar/liberar
 *     una venta (B2) ya la escriben en su servicio: aquí no se repite. «Nuevo o reintento» lo dice el RESULTADO de la
 *     operación decidida bajo candado (F9), nunca una lectura previa;
 *   · el estado de VENTA de un negocio (por qué el botón está apagado y cómo prenderlo) con el tope de hoy;
 *   · la envoltura con transacción de las operaciones de gerente sobre la libreta (A4).
 * No mueve saldo por su cuenta: la libreta (A4) es la única que lo hace.
 */
import { Prisma, type GiftCardReason, type PrismaClient } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { ORDER_LOCK_WAIT_BUDGET } from '@/services/shared/paymentShiftClaim'
import { GiftCardError, type GiftCardErrorCode } from './giftCardErrors'
import { operarSobreDeGerenteEnTx, type OperacionDeGerente } from './giftCardLedger'
import { topePorOperacion } from './giftCardLimits'
import { assertGiftCardsSellable } from './giftCardSettings.service'
import type { ResultadoDeReenvio } from './giftCardCuenta.service'

export type GiftCardAuditAction =
  | 'GIFT_CARD_SALE_CREATED'
  | 'GIFT_CARD_REDEEMED'
  | 'GIFT_CARD_BALANCE_RETURNED_ORDER_CANCELLED'
  | 'GIFT_CARD_ADJUSTED'
  | 'GIFT_CARD_BLOCKED'
  | 'GIFT_CARD_UNBLOCKED'
  | 'GIFT_CARD_CODE_REPLACED'
  // 1b S4 (S-9)
  | 'GIFT_CARD_RESENT'
  | 'GIFT_CARD_DESTINATION_CHANGED'
  | 'GIFT_CARD_CODE_REVEALED'
  | 'GIFT_CARD_RESEND_DENIED'
  | 'GIFT_CARD_REVEAL_DENIED'

export interface AuditoriaDeTarjetas {
  venueId: string
  /** `Staff.id` (authContext.userId), nunca `StaffVenue.id`. */
  staffId: string | null
  action: GiftCardAuditAction
  entity: 'GiftCard' | 'Order' | 'Payment'
  entityId: string
  /** Contexto de la operación. 🔴 Nunca el código de la tarjeta, su `pageToken` ni el código nuevo de una reposición. */
  data: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

/** Fire-and-forget: `logAction` nunca lanza, y una falla de bitácora jamás deshace dinero ya movido. */
export function auditarTarjetas(a: AuditoriaDeTarjetas): void {
  void logAction({
    venueId: a.venueId,
    staffId: a.staffId,
    action: a.action,
    entity: a.entity,
    entityId: a.entityId,
    data: a.data as Prisma.InputJsonValue,
    ipAddress: a.ipAddress,
    userAgent: a.userAgent,
  })
}

/**
 * 🔴 Q102: la bitácora de una SALIDA DEL SECRETO (código, `pageToken` o liga hacia quien llama). A diferencia de
 * `auditarTarjetas`, espera y LANZA: si el renglón no se guarda, el secreto no sale (la ruta responde 503). Directo con
 * `createMany` (una fila por tarjeta) y el `Staff.id` tal cual, sin la normalización ni el reintento sin actor de `logAction`.
 * Con el `tx` de la transacción del secreto, o con `prisma` en el reenvío de la venta (una sola sentencia).
 */
export async function registrarSalidaDelSecreto(
  db: Prisma.TransactionClient | PrismaClient,
  filas: Array<AuditoriaDeTarjetas & { action: 'GIFT_CARD_CODE_REVEALED' }>,
): Promise<void> {
  if (filas.length === 0) return
  await db.activityLog.createMany({
    data: filas.map(a => ({
      venueId: a.venueId,
      staffId: a.staffId,
      action: a.action,
      entity: a.entity,
      entityId: a.entityId,
      data: a.data as Prisma.InputJsonValue,
      ipAddress: a.ipAddress ?? null,
      userAgent: a.userAgent ?? null,
    })),
  })
}

/** RF3: los rechazos de reenviar o cambiar el destino que dejan `GIFT_CARD_RESEND_DENIED` (la guardada sale como ALREADY_USED). */
const RECHAZOS_DE_REENVIO = new Set(['GIFT_CARD_NOT_DELIVERABLE', 'GIFT_CARD_ALREADY_USED', 'GIFT_CARD_USE_CHANGE_DESTINATION'])

/**
 * UNA traducción de resultado o rechazo de un reenvío a bitácora, para el POS y el panel (S7): `GIFT_CARD_RESENT`,
 * `GIFT_CARD_DESTINATION_CHANGED` (con los destinos ya enmascarados) o `GIFT_CARD_RESEND_DENIED`; nada en un replay. De mejor
 * esfuerzo, como el resto: aquí no sale ningún secreto.
 */
export function auditarReenvio(a: {
  venueId: string
  staffId: string
  giftCardId: string
  operationKey: string
  ruta: string
  resultado?: ResultadoDeReenvio
  rechazo?: { code?: string }
  overrideAuthorizedBy?: string | null
  ipAddress?: string
  userAgent?: string
}): void {
  const comun = {
    venueId: a.venueId,
    staffId: a.staffId,
    entity: 'GiftCard' as const,
    entityId: a.giftCardId,
    ipAddress: a.ipAddress,
    userAgent: a.userAgent,
  }
  const data = {
    operationKey: a.operationKey,
    ruta: a.ruta,
    ...(a.overrideAuthorizedBy ? { overrideAuthorizedBy: a.overrideAuthorizedBy } : {}),
  }
  if (a.rechazo) {
    if (a.rechazo.code && RECHAZOS_DE_REENVIO.has(a.rechazo.code)) {
      auditarTarjetas({ ...comun, action: 'GIFT_CARD_RESEND_DENIED', data: { code: a.rechazo.code, ...data } })
    }
    return
  }
  const r = a.resultado
  if (!r || r.replay) return
  if (r.repuesta) {
    auditarTarjetas({
      ...comun,
      action: 'GIFT_CARD_DESTINATION_CHANGED',
      data: { ...data, destinoAnterior: r.destinoAnterior, destinoNuevo: r.destinoNuevo },
    })
    return
  }
  auditarTarjetas({ ...comun, action: 'GIFT_CARD_RESENT', data })
}

/**
 * Decisión 1 del coordinador (conciliación 14-oct): `hasCards` de los ajustes del dashboard. ¿El negocio vendió alguna vez una
 * tarjeta (de cualquier estado)? Decide si sin plan se ve el cartel o la lista: bajar de plan nunca esconde saldos. Una sola
 * consulta `EXISTS` (se detiene en la primera fila, usa `@@index([venueId, status, createdAt])`).
 */
export async function negocioTieneTarjetas(venueId: string): Promise<boolean> {
  const [fila] = await prisma.$queryRaw<Array<{ existe: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "GiftCard" WHERE "venueId" = ${venueId}) AS existe`
  return fila?.existe === true
}

/** 1b S1: lo que este servidor sabe hacer y el POS lee en sus ajustes para prender sus pantallas nuevas. */
export const CAPACIDADES_DEL_POS = ['ENTREGA', 'PAGE_TOKEN', 'TELEFONO'] as const

/** 1b S1 (`tieneTarjetas` de los ajustes del POS): ¿el negocio ya ACTIVÓ alguna tarjeta? Una sólo PENDING no cuenta. */
export async function negocioHaActivadoTarjetas(venueId: string): Promise<boolean> {
  const [fila] = await prisma.$queryRaw<Array<{ existe: boolean }>>`
    SELECT EXISTS (SELECT 1 FROM "GiftCard" WHERE "venueId" = ${venueId} AND "activatedAt" IS NOT NULL) AS existe`
  return fila?.existe === true
}

export interface EstadoDeVenta {
  sellable: boolean
  code: GiftCardErrorCode | null
  /** El texto que el POS y el dashboard muestran tal cual. */
  message: string | null
  howToEnable: 'DASHBOARD_SETTINGS' | 'PLAN' | 'CONTACT_AVOQADO' | null
  /** Tope por operación de hoy en pesos: la suma de una venta de tarjetas debe quedar ESTRICTAMENTE debajo. */
  operationLimit: number | null
}

const COMO_PRENDER: Partial<Record<GiftCardErrorCode, NonNullable<EstadoDeVenta['howToEnable']>>> = {
  GIFT_CARDS_DISABLED: 'DASHBOARD_SETTINGS',
  GIFT_CARDS_NOT_IN_PLAN: 'PLAN',
  GIFT_CARD_KEYS_MISSING: 'CONTACT_AVOQADO',
}

/**
 * «Apagado se ve y se explica» (feature-gating §4): el mismo `assertGiftCardsSellable` que protege la venta dice por qué no
 * se puede vender. Un error que no es de tarjetas se propaga: una base caída no se disfraza de «función apagada».
 */
export async function estadoDeVentaDeTarjetas(venueId: string, ahora: Date = new Date()): Promise<EstadoDeVenta> {
  let operationLimit: number | null
  try {
    operationLimit = Number(topePorOperacion(ahora).toFixed(2))
  } catch {
    operationLimit = null // la tabla de UMA no cubre hoy: vender falla con su propio error; los ajustes siguen leyéndose
  }
  try {
    await assertGiftCardsSellable(venueId)
    return { sellable: true, code: null, message: null, howToEnable: null, operationLimit }
  } catch (error) {
    if (!(error instanceof GiftCardError)) throw error
    const code = error.code as GiftCardErrorCode
    return { sellable: false, code, message: error.message, howToEnable: COMO_PRENDER[code] ?? null, operationLimit }
  }
}

/** Motivos que un gerente puede elegir; los de sistema (cancelación, revocación en línea) sólo los escribe B2. */
type MotivoDeGerente = Exclude<GiftCardReason, 'SALE_CANCELLED' | 'ONLINE_REVOCATION' | 'CANCEL_IN_PROGRESS'>

/** El cuerpo ya validado de `POST /dashboard/venues/:venueId/gift-cards/:giftCardId/operations`. */
export type OperacionDeGerenteHttp =
  | {
      operationKey: string
      tipo: 'AJUSTE'
      direccion: 'INCREMENT' | 'DECREMENT'
      amount: Prisma.Decimal
      reason: MotivoDeGerente
      note: string
    }
  | { operationKey: string; tipo: 'BLOQUEAR' | 'DESBLOQUEAR'; reason: MotivoDeGerente; note?: string }
  | { operationKey: string; tipo: 'REEMPLAZAR_CODIGO'; reason: 'LOST_CARD'; folio: string; note?: string }

function aOperacionDeLaLibreta(o: OperacionDeGerenteHttp): OperacionDeGerente {
  const nota = o.note ? { note: o.note } : {}
  switch (o.tipo) {
    case 'AJUSTE':
      return { tipo: 'AJUSTE', direccion: o.direccion, amount: o.amount, reason: o.reason, ...nota }
    case 'BLOQUEAR':
    case 'DESBLOQUEAR':
      return { tipo: o.tipo, reason: o.reason, ...nota }
    case 'REEMPLAZAR_CODIGO':
      return { tipo: 'REEMPLAZAR_CODIGO', reason: 'LOST_CARD', ...nota }
  }
}

/**
 * La envoltura con transacción que pide la tabla de rutas del índice. `replayed` = el `replay` que la libreta (A4) decidió
 * BAJO el candado del sobre (la llave ya tenía su renglón con la misma huella: devuelve el resultado original sin mover
 * saldo). F9 (auditoría r1 C-2): sin prelectura de la llave; dos peticiones simultáneas se serializan en el candado y sólo
 * la primera sale como nueva, así la ruta escribe la bitácora una vez.
 * La espera de candados usa el MISMO presupuesto que las cuentas (`ORDER_LOCK_WAIT_BUDGET`).
 */
export async function operarSobreDeGerente(
  venueId: string,
  giftCardId: string,
  staffId: string,
  input: OperacionDeGerenteHttp,
): Promise<{ activityIds: string[]; nuevoCodigo?: { display: string; last4: string }; replayed: boolean }> {
  return prisma.$transaction(async tx => {
    // Spec § 5.7: reponer se hace «con el folio de compra». Decisión del coordinador: folio de compra = `Order.orderNumber`
    // de la cuenta que vendió el sobre (el número de cuenta que trae el comprobante); se compara sin importar mayúsculas ni
    // espacios. No es secreto y la ruta exige `giftCards:manage`: basta la comparación directa (nota 4 del coordinador).
    // La libreta (A4) no lo recibe.
    if (input.tipo === 'REEMPLAZAR_CODIGO') {
      const venta = await tx.orderItem.findFirst({
        where: { giftCardId, order: { venueId } },
        select: { order: { select: { orderNumber: true } } },
      })
      if (!venta || venta.order.orderNumber.trim().toUpperCase() !== input.folio.trim().toUpperCase()) {
        throw new GiftCardError('GIFT_CARD_FOLIO_MISMATCH', 'Ese folio no es el número de cuenta de la compra de esta tarjeta.', 422)
      }
    }
    const { replay, ...resultado } = await operarSobreDeGerenteEnTx(tx, {
      venueId,
      giftCardId,
      staffId,
      operationKey: input.operationKey,
      op: aOperacionDeLaLibreta(input),
    })
    // ⭐ (D4, estado de HOY): repetir un bloqueo o un desbloqueo con su llave responde «hecho» sólo si la tarjeta sigue como esa
    // operación la dejó. Un bloqueo en duda que sí llegó y que otra pestaña ya desbloqueó no se vuelve a anunciar: 409. El sobre
    // ya está bloqueado por la libreta en esta transacción: la lectura es la de hoy.
    if (replay && (input.tipo === 'BLOQUEAR' || input.tipo === 'DESBLOQUEAR')) {
      const hoy = await tx.giftCard.findFirst({ where: { id: giftCardId, venueId }, select: { status: true } })
      const bloqueo = input.tipo === 'BLOQUEAR'
      if (hoy?.status !== (bloqueo ? 'BLOCKED' : 'ACTIVE')) {
        // r1 (M2): code propio; `GIFT_CARD_BLOCKED` diría lo contrario del texto («hoy no está bloqueada»).
        throw new GiftCardError(
          'GIFT_CARD_STATE_CHANGED',
          bloqueo
            ? 'Este bloqueo ya se había registrado, pero la tarjeta cambió después: hoy no está bloqueada. Vuelve a abrirla para ver su estado.'
            : 'Este desbloqueo ya se había registrado, pero la tarjeta cambió después: hoy no está activa. Vuelve a abrirla para ver su estado.',
          409,
        )
      }
    }
    return { ...resultado, replayed: replay }
  }, ORDER_LOCK_WAIT_BUDGET)
}
