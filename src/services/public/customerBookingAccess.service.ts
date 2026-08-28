/**
 * Fase 1 — Aprobación de clientes por el venue.
 *
 * El venue decide a quién le deja reservar: alguien activa su cuenta (password, OTP o Consumer),
 * queda PENDING, y hasta que un OWNER/ADMIN aprueba no puede apartar lugar. Con el switch
 * `requireCustomerApproval` apagado —el caso normal— nada de esto corre.
 *
 * 🔴 Tres invariantes que cuestan caro si se rompen:
 *
 * 1. **Ningún Customer existente pasa a PENDING jamás.** Ni la migración ni mover el switch
 *    recalculan a nadie: `approvalStatus` sólo se decide al ACTIVAR una cuenta que nunca lo
 *    estuvo. Alguien que ya reservaba no puede quedarse fuera porque se prendió una casilla.
 *
 * 2. **Leer no compite; escribir sí** (auditoría de diseño): el gate toma `FOR UPDATE` sobre la
 *    fila del Customer dentro de la transacción de la reserva, y la decisión hace un write-CAS
 *    sobre `approvalVersion`. Sin ese lock, "leo APPROVED → la dueña rechaza → inserto" commitea
 *    igual: Postgres puede serializarlo como "la reserva ocurrió antes del rechazo".
 *
 * 3. **Contacto de CRM ≠ preaprobado.** Ambos están APPROVED por default. Se distinguen por
 *    `approvalDecidedAt`: si alguien decidió explícitamente (preaprobación), se respeta al
 *    activar; si nunca nadie decidió, la activación con el switch prendido pide aprobación.
 */
import { Prisma, CustomerApprovalStatus } from '@prisma/client'
import { ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from '@/errors/AppError'
import { dedupeKey } from '@/services/reservation/customerApprovalOutbox.service'

export const CUSTOMER_APPROVAL_PENDING = 'CUSTOMER_APPROVAL_PENDING' as const
export const CUSTOMER_APPROVAL_REJECTED = 'CUSTOMER_APPROVAL_REJECTED' as const
export const CUSTOMER_APPROVAL_CONFLICT = 'CUSTOMER_APPROVAL_CONFLICT' as const
export const CUSTOMER_INACTIVE = 'CUSTOMER_INACTIVE' as const

/** De dónde nace la activación de la cuenta. `STAFF` nunca pide aprobación: ya la dio quien la creó. */
export type ActivationOrigin = 'PASSWORD' | 'OTP' | 'CONSUMER' | 'STAFF'

export type ApprovalEvent = 'REQUESTED_STAFF' | 'PENDING_CUSTOMER' | 'APPROVED_CUSTOMER' | 'REJECTED_CUSTOMER'

type CustomerApprovalShape = {
  accountActivatedAt: Date | null
  approvalDecidedAt: Date | null
  approvalStatus: CustomerApprovalStatus | string
}

/**
 * Pura: qué estado de aprobación le toca a una cuenta que se ACTIVA ahora. Probada sola.
 *
 * - `alreadyActivated`: la cuenta ya existía ⇒ no se recalcula NADA (invariante 1).
 * - `requestsApproval`: hay que avisar al staff y mostrarle al cliente "en espera".
 */
export function resolveApprovalOnActivation(
  input: CustomerApprovalShape & { requireCustomerApproval: boolean; origin: ActivationOrigin },
): {
  approvalStatus: CustomerApprovalStatus
  requestsApproval: boolean
  alreadyActivated: boolean
} {
  const current = input.approvalStatus as CustomerApprovalStatus

  // La cuenta ya estaba activa: su estado es historia, no se toca.
  if (input.accountActivatedAt) {
    return { approvalStatus: current, requestsApproval: false, alreadyActivated: true }
  }
  // Switch apagado, o la creó el staff, o alguien ya la preaprobó explícitamente.
  if (!input.requireCustomerApproval || input.origin === 'STAFF' || input.approvalDecidedAt) {
    return { approvalStatus: current, requestsApproval: false, alreadyActivated: false }
  }
  return { approvalStatus: CustomerApprovalStatus.PENDING, requestsApproval: true, alreadyActivated: false }
}

async function venueRequiresApproval(tx: Prisma.TransactionClient, venueId: string): Promise<boolean> {
  const settings = await tx.reservationSettings.findUnique({ where: { venueId }, select: { requireCustomerApproval: true } })
  return settings?.requireCustomerApproval === true
}

type LockedCustomer = {
  approvalStatus: string
  approvalVersion: number
  active: boolean
  approvalDecidedAt: Date | null
  accountActivatedAt: Date | null
}

/**
 * 🔴 ORDEN DE LOCKS (auditoría de diseño 16 §2) — romperlo produce deadlocks intermitentes:
 *
 *   1. `Customer`  ← aquí, SIEMPRE primero
 *   2. `ClassSession` / advisory lock de la cita
 *   3. `CreditItemBalance` (orden determinista si son varios)
 *
 * Y el MODO importa tanto como el orden:
 * - **Gate de lectura → `FOR SHARE`.** `FOR UPDATE` bloquearía también los `KEY SHARE` que los
 *   INSERT de `Reservation`/`CreditTransaction` toman sobre el FK a Customer: la reserva pública
 *   iba Customer→ClassSession mientras la del staff iba ClassSession→FK Customer. Ciclo.
 * - **Escritura (activar/decidir) → `FOR NO KEY UPDATE`.** Compite con el gate y con la otra
 *   escritura, pero deja pasar los FK.
 */
async function lockCustomer(
  tx: Prisma.TransactionClient,
  customerId: string,
  venueId: string,
  mode: 'SHARE' | 'NO KEY UPDATE',
): Promise<LockedCustomer | null> {
  // El modo NO puede parametrizarse con $queryRaw (sería inyección); dos consultas literales.
  const rows =
    mode === 'SHARE'
      ? await tx.$queryRaw<LockedCustomer[]>`
          SELECT "approvalStatus", "approvalVersion", "active", "approvalDecidedAt", "accountActivatedAt"
          FROM "Customer" WHERE "id" = ${customerId} AND "venueId" = ${venueId}
          FOR SHARE
        `
      : await tx.$queryRaw<LockedCustomer[]>`
          SELECT "approvalStatus", "approvalVersion", "active", "approvalDecidedAt", "accountActivatedAt"
          FROM "Customer" WHERE "id" = ${customerId} AND "venueId" = ${venueId}
          FOR NO KEY UPDATE
        `
  return rows[0] ?? null
}

// La clave de dedupe la define el outbox, que es quien la consume. Definirla dos veces es
// exactamente cómo se desincronizan: un cambio de formato de un lado y el otro deja de
// deduplicar, en silencio y sólo en producción.

/**
 * Sella la activación de una cuenta y decide si pide aprobación. Corre DENTRO de la misma
 * transacción que crea/actualiza el Customer (password, OTP o Consumer): si el registro se
 * revierte, la solicitud de aprobación se revierte con él.
 */
export async function activateCustomerAccount(
  tx: Prisma.TransactionClient,
  input: { customerId: string; venueId: string; origin: ActivationOrigin },
): Promise<{ approvalStatus: CustomerApprovalStatus; requestsApproval: boolean; approvalVersion: number }> {
  const requireCustomerApproval = await venueRequiresApproval(tx, input.venueId)
  // Con lock de escritura: sin él, una preaprobación concurrente se perdía (esta lectura no la
  // veía y escribía PENDING encima). Auditoría 16 §1.1.
  const customer = await lockCustomer(tx, input.customerId, input.venueId, 'NO KEY UPDATE')
  if (!customer) throw new NotFoundError('Cliente no encontrado')

  const resolved = resolveApprovalOnActivation({ ...customer, requireCustomerApproval, origin: input.origin })
  if (resolved.alreadyActivated) {
    return { approvalStatus: resolved.approvalStatus, requestsApproval: false, approvalVersion: customer.approvalVersion }
  }

  const now = new Date()
  await tx.customer.update({
    where: { id: input.customerId },
    data: {
      accountActivatedAt: now,
      approvalStatus: resolved.approvalStatus,
      ...(resolved.requestsApproval ? { approvalRequestedAt: now } : {}),
    },
  })

  if (resolved.requestsApproval) {
    // Los dos correos se encolan DENTRO de esta tx: si el registro falla, nadie recibe nada.
    for (const event of ['REQUESTED_STAFF', 'PENDING_CUSTOMER'] as const) {
      await tx.customerApprovalOutbox.create({
        data: {
          venueId: input.venueId,
          customerId: input.customerId,
          event,
          approvalVersion: customer.approvalVersion,
          dedupeKey: dedupeKey(event, input.customerId, customer.approvalVersion),
        },
      })
    }
  }

  return { approvalStatus: resolved.approvalStatus, requestsApproval: resolved.requestsApproval, approvalVersion: customer.approvalVersion }
}

/**
 * Gate de escritura: ¿este cliente puede consumir capacidad o dinero ahora?
 *
 * DEBE correr dentro de la transacción que toma la capacidad (la serializable de clase/cita, el
 * hold, el checkout). Toma `FOR UPDATE` sobre la fila del Customer: así una decisión concurrente
 * espera, y `withSerializableRetry` reintenta al perdedor. Con el switch apagado no lee nada.
 */
export async function assertCustomerCanCreateReservation(
  tx: Prisma.TransactionClient,
  input: { customerId: string | null | undefined; venueId: string },
): Promise<void> {
  if (!(await venueRequiresApproval(tx, input.venueId))) return // switch apagado: ni se lee

  // 🔴 Con el switch prendido, un invitado NO pasa (auditoría 16 §1.2): el CHECK de la migración
  // ya obliga `requireAccount`, así que llegar sin sesión es un hueco de la superficie (holds y
  // checkout de paquetes eran exactamente esa puerta), no un caso legítimo.
  if (!input.customerId) {
    throw new UnauthorizedError('Este negocio requiere iniciar sesión para reservar.', 'CUSTOMER_AUTH_REQUIRED')
  }

  const row = await lockCustomer(tx, input.customerId, input.venueId, 'SHARE')
  if (!row) throw new NotFoundError('Cliente no encontrado en este negocio')
  if (row.active === false) throw new UnauthorizedError('Esta cuenta está desactivada', CUSTOMER_INACTIVE)

  if (row.approvalStatus === CustomerApprovalStatus.PENDING) {
    throw new ForbiddenError(
      'Tu cuenta está en espera de aprobación del negocio. Te avisaremos en cuanto la revisen.',
      CUSTOMER_APPROVAL_PENDING,
    )
  }
  if (row.approvalStatus === CustomerApprovalStatus.REJECTED) {
    throw new ForbiddenError(
      'Este negocio no aprobó tu cuenta para reservar en línea. Contáctalos directamente.',
      CUSTOMER_APPROVAL_REJECTED,
    )
  }
}

/**
 * Decisión del staff. Write-CAS sobre `approvalVersion`: si otro decidió primero, 409.
 * Repetir la MISMA decisión es idempotente (no sube la versión, no duplica audit ni correo).
 * Acepta un Customer SIN cuenta activada: es la preaprobación anticipada (§3ter del diseño).
 */
export async function decideCustomerApproval(
  tx: Prisma.TransactionClient,
  input: {
    customerId: string
    venueId: string
    organizationId: string
    decision: 'APPROVED' | 'REJECTED'
    reason?: string
    expectedVersion: number
    actorStaffId: string
  },
): Promise<{ approvalStatus: CustomerApprovalStatus; approvalVersion: number; changed: boolean }> {
  const row = await lockCustomer(tx, input.customerId, input.venueId, 'NO KEY UPDATE')
  if (!row) throw new NotFoundError('Cliente no encontrado en este negocio')

  // 🔴 Idempotente SÓLO si la decisión ya fue tomada de verdad (auditoría 16 §1.3). Un contacto
  // de CRM está APPROVED por DEFAULT sin que nadie decidiera: "aprobarlo" no es un no-op, es la
  // PREAPROBACIÓN — justo lo que lo protege de caer en PENDING al activar su cuenta.
  if (row.approvalStatus === input.decision && row.approvalDecidedAt) {
    return { approvalStatus: input.decision as CustomerApprovalStatus, approvalVersion: row.approvalVersion, changed: false }
  }

  const nextVersion = input.expectedVersion + 1
  const now = new Date()
  const cas = await tx.customer.updateMany({
    where: { id: input.customerId, venueId: input.venueId, approvalVersion: input.expectedVersion },
    data: {
      approvalStatus: input.decision as CustomerApprovalStatus,
      approvalVersion: nextVersion,
      approvalDecidedAt: now,
      approvalDecidedByStaffId: input.actorStaffId,
      approvalDecisionReason: input.reason ?? null,
    },
  })
  if (cas.count === 0) {
    throw new ConflictError('Alguien más decidió sobre este cliente. Recarga y vuelve a intentar.', CUSTOMER_APPROVAL_CONFLICT)
  }

  // Rastro y correo, ambos dentro de la tx: si el audit falla, la decisión se revierte.
  await tx.activityLog.create({
    data: {
      action: input.decision === 'APPROVED' ? 'CUSTOMER_APPROVAL_APPROVED' : 'CUSTOMER_APPROVAL_REJECTED',
      entity: 'Customer',
      entityId: input.customerId,
      actorType: 'HUMAN',
      staffId: input.actorStaffId,
      actorStaffId: input.actorStaffId, // la constraint EXIGE actorStaffId = staffId
      servicePrincipalId: null,
      organizationId: input.organizationId,
      venueId: input.venueId,
      data: { from: row.approvalStatus, to: input.decision, reason: input.reason ?? null, approvalVersion: nextVersion },
    },
  })

  const event: ApprovalEvent = input.decision === 'APPROVED' ? 'APPROVED_CUSTOMER' : 'REJECTED_CUSTOMER'
  await tx.customerApprovalOutbox.create({
    data: {
      venueId: input.venueId,
      customerId: input.customerId,
      event,
      approvalVersion: nextVersion,
      dedupeKey: dedupeKey(event, input.customerId, nextVersion),
      ...(input.decision === 'REJECTED' ? { payload: { reason: input.reason ?? null } } : {}),
    },
  })

  return { approvalStatus: input.decision as CustomerApprovalStatus, approvalVersion: nextVersion, changed: true }
}
