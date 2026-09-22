/**
 * Registro DURABLE de obligaciones de cobro en conflicto (diseño v5 de la compra, V5-A paso 2, 22-sep-2026).
 *
 * Cuando la entrega encuentra una suscripción viva que no puede representar sin pisar otra (dos planes, una
 * función duplicada) o que nadie sabe qué vende, NO la descarta: la deja aquí, por `subscriptionId`, pendiente de
 * que una persona la resuelva. Mientras esté pendiente, la regla común de compra la cuenta como obligación viva.
 *
 * No audita: devuelve si la creó, para que el llamador escriba `ActivityLog` DESPUÉS de confirmar su transacción
 * (una transacción revertida no puede dejar rastro de un conflicto que no se guardó).
 */
import type { BillingObligationConflictKind, Prisma, PrismaClient } from '@prisma/client'
import { sendOpsAlert } from '@/services/alerts/opsAlert.service'
import { logAction } from '@/services/dashboard/activity-log.service'

type Db = PrismaClient | Prisma.TransactionClient

export interface ConflictoDeObligacion {
  venueId: string
  subscriptionId: string
  customerId?: string | null
  kind: BillingObligationConflictKind
  conflictsWith: string[]
  featureCode?: string | null
  detectedBy: string
}

/** Tope de lectura: un negocio con más conflictos pendientes que esto ya es un incidente que se atiende a mano. */
const TOPE_PENDIENTES = 100

export async function registrarConflictoDeObligacion(db: Db, c: ConflictoDeObligacion): Promise<'CREADO' | 'ACTUALIZADO'> {
  // INSERT … ON CONFLICT DO NOTHING (`skipDuplicates`): dentro de una transacción de Postgres, atrapar un P2002 la deja
  // ABORTADA y la siguiente sentencia falla (Codex, 22-sep). Así, dos entregas a la vez nunca chocan.
  const { count } = await db.billingObligationConflict.createMany({
    data: [
      {
        venueId: c.venueId,
        subscriptionId: c.subscriptionId,
        customerId: c.customerId ?? null,
        kind: c.kind,
        conflictsWith: c.conflictsWith,
        featureCode: c.featureCode ?? null,
        detectedBy: c.detectedBy,
        status: 'PENDING',
      },
    ],
    skipDuplicates: true,
  })
  if (count === 1) return 'CREADO'

  // 🔴 Codex R12: si la fila existe pero la cerró la ENTREGA (resolución automática), un episodio nuevo la REABRE y
  // vuelve a avisar una vez — antes quedaba resuelta para siempre y el siguiente problema de la misma suscripción no
  // se notificaba a nadie. Una resolución HUMANA (o por terminación) no se reabre sola: el `where` la excluye, así que
  // la condición y la escritura son la misma sentencia y no cabe nada entre leer y escribir.
  const { count: reabierto } = await db.billingObligationConflict.updateMany({
    where: { subscriptionId: c.subscriptionId, status: 'RESOLVED', resolution: 'ENTREGADA' },
    data: {
      status: 'PENDING',
      resolvedAt: null,
      resolution: null,
      resolvedByStaffId: null,
      kind: c.kind,
      conflictsWith: c.conflictsWith,
      featureCode: c.featureCode ?? null,
      detectedBy: c.detectedBy,
      lastSeenAt: new Date(),
    },
  })
  if (reabierto === 1) return 'CREADO'

  // Ya existía y sigue viva (o la resolvió una persona): sólo se refresca cuándo se vio y con quién choca.
  await db.billingObligationConflict.update({
    where: { subscriptionId: c.subscriptionId },
    data: { lastSeenAt: new Date(), conflictsWith: c.conflictsWith },
  })
  return 'ACTUALIZADO'
}

/**
 * 🔴 Codex R12: la suscripción del conflicto TERMINÓ (operaciones canceló el duplicado, o Stripe la dio por muerta).
 * Ya no cobra, así que su conflicto no puede seguir pendiente: los pendientes cuentan para el tope que la regla revisa
 * ANTES de consultar Stripe, y un montón de muertos bloqueaba compras nuevas sin que ninguno cobrara un peso.
 *
 * Se distingue de `ENTREGADA` a propósito: lo TERMINADO no se reabre solo si la misma suscripción reaparece.
 */
export async function cerrarConflictoTerminado(db: Db, subscriptionId: string): Promise<void> {
  await db.billingObligationConflict.updateMany({
    where: { subscriptionId, status: 'PENDING' },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: 'TERMINADA' },
  })
}

/**
 * La entrega por fin CONCEDIÓ por esta suscripción (p. ej. operaciones la corrigió en Stripe): su conflicto pendiente
 * queda resuelto, en la MISMA transacción que concede. Sin esto seguiría «pendiente» para siempre.
 */
export async function cerrarConflictoEntregado(db: Db, subscriptionId: string): Promise<void> {
  await db.billingObligationConflict.updateMany({
    where: { subscriptionId, status: 'PENDING' },
    data: { status: 'RESOLVED', resolvedAt: new Date(), resolution: 'ENTREGADA' },
  })
}

export async function conflictosPendientes(db: Db, venueId: string): Promise<Array<{ subscriptionId: string }>> {
  return db.billingObligationConflict.findMany({
    where: { venueId, status: 'PENDING' },
    select: { subscriptionId: true },
    orderBy: { createdAt: 'asc' },
    take: TOPE_PENDIENTES,
  })
}

/**
 * Después de confirmar la transacción que CREÓ el conflicto: bitácora y correo a operaciones (Codex C11). Mientras esté
 * pendiente, el negocio puede quedarse sin el acceso que paga; si sólo lo sabe el log, nadie lo resuelve. Se llama una
 * vez por suscripción (sólo cuando `registrarConflictoDeObligacion` devolvió 'CREADO'), así que no inunda.
 */
export function avisarConflictoCreado(
  c: Pick<ConflictoDeObligacion, 'venueId' | 'subscriptionId' | 'kind' | 'detectedBy'> & { conflictsWith?: string[] },
): void {
  const duplicado = c.kind === 'DUPLICATE_PLAN'
  logAction({
    venueId: c.venueId,
    action: duplicado ? 'OBLIGACION_DUPLICADA' : 'OBLIGACION_DESCONOCIDA',
    entity: 'BillingObligationConflict',
    entityId: c.subscriptionId,
  })
  void sendOpsAlert({
    subject: `Cobro en conflicto: ${c.subscriptionId} (venue ${c.venueId})`,
    lines: [
      duplicado
        ? `La suscripción ${c.subscriptionId} cobra un plan, pero el negocio ya tiene otro plan vivo (${(c.conflictsWith ?? []).join(', ')}). No se le dio acceso por ella para no encimar los dos.`
        : `La suscripción ${c.subscriptionId} cobra algo que no sabemos representar (un producto que no es del catálogo, o un plan junto con otro cargo). No se le dio acceso por ella.`,
      'Revísala en Stripe: si es un cobro doble, cancélala y reembolsa; si es legítima, déjala con un solo plan. Al guardar el cambio en Stripe, su aviso entrega el acceso solo y cierra el conflicto.',
      `Detectado por: ${c.detectedBy}.`,
    ],
  })
}
