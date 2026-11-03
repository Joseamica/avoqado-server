/**
 * Sales Goal Service
 *
 * Manages sales goals for venues/staff using VenueModule config storage.
 * Goals are stored in VenueModule.config.salesGoals array.
 *
 * This approach:
 * - Works without schema changes
 * - Supports multiple goals per venue
 * - Supports both venue-wide and per-staff goals
 * - Integrates with existing module system
 */

import prisma from '../../../utils/prismaClient'
import { ModuleScope, Prisma } from '@prisma/client'
import { lockModuleScope, MODULE_CODES } from '../../modules/module.service'
import { BadRequestError, NotFoundError } from '../../../errors/AppError'
import { logAction } from '../activity-log.service'
import { asegurarIdsDelNegocio } from './idsDelNegocio'
import { startOfWeek } from 'date-fns'
import { fromZonedTime, toZonedTime } from 'date-fns-tz'
import { venueStartOfDay, venueStartOfMonth, DEFAULT_TIMEZONE } from '../../../utils/datetime'
import { utcTs } from '../../../utils/sqlDates'
import { SQL_COBRO_ORIGINAL_DE_LA_DEVOLUCION, SQL_VENDEDOR_DEL_MOVIMIENTO } from '../../shared/vendedorDelMovimiento'

// ==========================================
// TYPES
// ==========================================

export type SalesGoalPeriod = 'DAILY' | 'WEEKLY' | 'MONTHLY'
export type SalesGoalType = 'AMOUNT' | 'QUANTITY'

export interface SalesGoal {
  id: string
  venueId: string
  staffId: string | null // null = venue-wide goal
  goal: number
  goalType: SalesGoalType // 'AMOUNT' = currency target, 'QUANTITY' = unit count target
  period: SalesGoalPeriod
  currentSales: number // Calculated dynamically (amount or count depending on goalType)
  active: boolean
  createdAt: string
  updatedAt: string
  staff?: {
    id: string
    firstName: string
    lastName: string
  } | null
}

export interface CreateSalesGoalInput {
  staffId?: string | null
  goal: number
  goalType?: SalesGoalType // Defaults to 'AMOUNT' for backward compatibility
  period: SalesGoalPeriod
}

export interface UpdateSalesGoalInput {
  goal?: number
  goalType?: SalesGoalType
  period?: SalesGoalPeriod
  active?: boolean
}

// Storage format in VenueModule.config.salesGoals
interface StoredSalesGoal {
  id: string
  staffId: string | null
  goal: number
  goalType: SalesGoalType
  period: SalesGoalPeriod
  active: boolean
  createdAt: string
  updatedAt: string
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

/**
 * Get or create VenueModule for COMMISSIONS.
 * No org-level enablement required — commissions/goals are available to all venues.
 * Access is controlled by permissions (commissions:read, etc.), not module gating.
 */
async function getOrCreateVenueModule(venueId: string) {
  return prisma.$transaction(async tx => {
    // Definition creation and assignment stay in one transaction so the shared
    // scope lock serializes this legacy writer with control-plane narrowing.
    await tx.module.upsert({
      where: { code: MODULE_CODES.COMMISSIONS },
      update: {},
      create: {
        code: MODULE_CODES.COMMISSIONS,
        name: 'Commissions',
        description: 'Staff commission and sales goal tracking',
        defaultConfig: {},
      },
    })

    const module = await lockModuleScope(tx, { code: MODULE_CODES.COMMISSIONS })
    if (!module) throw new Error(`Module ${MODULE_CODES.COMMISSIONS} not found after upsert`)
    if (module.scope === ModuleScope.ORGANIZATION_ONLY) {
      throw new BadRequestError(`El módulo ${MODULE_CODES.COMMISSIONS} tiene scope ORGANIZATION_ONLY y no admite VenueModule`)
    }

    // Empty update preserves existing salesGoals/config; only a missing row gets
    // the backwards-compatible initial configuration after scope revalidation.
    return tx.venueModule.upsert({
      where: {
        venueId_moduleId: {
          venueId,
          moduleId: module.id,
        },
      },
      update: {},
      create: {
        venueId,
        moduleId: module.id,
        enabled: true,
        config: { salesGoals: [] },
        enabledBy: 'system',
      },
    })
  })
}

/**
 * Get sales goals array from VenueModule config
 */
function getSalesGoalsFromConfig(config: Prisma.JsonValue): StoredSalesGoal[] {
  if (!config || typeof config !== 'object') return []
  const configObj = config as Record<string, unknown>
  if (!Array.isArray(configObj.salesGoals)) return []
  return configObj.salesGoals as StoredSalesGoal[]
}

/**
 * Get timezone for a venue (cached per request via Prisma query cache)
 */
async function getVenueTimezone(venueId: string, db: Prisma.TransactionClient = prisma): Promise<string> {
  const venue = await db.venue.findUnique({
    where: { id: venueId },
    select: { timezone: true },
  })
  return venue?.timezone || DEFAULT_TIMEZONE
}

/**
 * D4: lo que una persona lleva vendido en una tienda desde una fecha (avance de su meta por importe), agregado en Postgres.
 */
export async function ventasDeLaPersonaDesde(
  db: Prisma.TransactionClient | typeof prisma,
  venueId: string,
  staffId: string,
  desde: Date,
): Promise<number> {
  // Una devolución cuenta para quien hizo la venta que devuelve (misma regla que el checador y el mapa de ventas por persona); la de
  // un cobro sin vendedor no es de nadie. Antes: `processedById` del REFUND, que es quien devuelve.
  const [fila] = await db.$queryRaw<Array<{ total: Prisma.Decimal | null }>>`
    SELECT SUM(p."amount") AS "total"
    FROM "Payment" p
    ${SQL_COBRO_ORIGINAL_DE_LA_DEVOLUCION}
    WHERE p."venueId" = ${venueId}
      AND p."status" = 'COMPLETED'
      AND p."createdAt" >= ${utcTs(desde)}
      AND ${SQL_VENDEDOR_DEL_MOVIMIENTO} = ${staffId}
  `
  return Number(fila?.total ?? 0) || 0
}

// Un cobro que de verdad cobró: ni la devolución ni el que no se completó. Alias `c`.
const SQL_COBRO_REAL = Prisma.sql`c."status" = 'COMPLETED' AND (c."type" IS NULL OR c."type" <> 'REFUND')`

/**
 * D10: el renglón `oi` es de esta persona. Cobrado por producto: de quien lo pagó. Sin reparto por producto: de quien cobró la cuenta; por
 * importe entre dos no hay dato de qué pagó cada quien, así que es de los dos.
 */
const sqlRenglonDe = (staffId: string) => Prisma.sql`(
  EXISTS (
    SELECT 1 FROM "PaymentAllocation" a JOIN "Payment" c ON c."id" = a."paymentId"
    WHERE a."orderItemId" = oi."id" AND c."processedById" = ${staffId} AND ${SQL_COBRO_REAL}
  )
  OR (
    NOT EXISTS (
      SELECT 1 FROM "PaymentAllocation" a JOIN "Payment" c ON c."id" = a."paymentId"
      WHERE a."orderItemId" = oi."id" AND ${SQL_COBRO_REAL}
    )
    AND EXISTS (
      SELECT 1 FROM "Payment" c
      WHERE c."orderId" = oi."orderId" AND c."processedById" = ${staffId} AND ${SQL_COBRO_REAL}
        AND NOT EXISTS (SELECT 1 FROM "PaymentAllocation" a WHERE a."paymentId" = c."id" AND a."orderItemId" IS NOT NULL)
    )
  )
)`

/**
 * D10: las piezas de una meta por unidades, desde una fecha: las vendidas menos las devueltas. Un producto por peso cuenta 1 (`quantity`).
 * Una devolución resta sólo si nombra sus productos (`refundedItems`, lo mismo que suman las devoluciones para no devolver de más), en el
 * periodo en que se hace, igual que la meta por importe resta el dinero. Por persona, la pieza se le resta a quien tiene el renglón, no a
 * quien cobró el pago del que salió la devolución: un Cambio puede devolver un producto ajeno. La devolución por importe no dice cuáles
 * fueron: no resta piezas. El renglón de un vale que se volvió a cobrar en otra cuenta ya es de la otra (`releasedAreaTicketLineId`).
 */
async function piezasDesde(db: Prisma.TransactionClient, venueId: string, staffId: string | null, desde: Date): Promise<number> {
  const deQuien = staffId ? Prisma.sql`AND ${sqlRenglonDe(staffId)}` : Prisma.empty
  const [fila] = await db.$queryRaw<Array<{ vendidas: bigint | null; devueltas: Prisma.Decimal | null }>>`
    SELECT
      (
        SELECT SUM(oi."quantity")
        FROM "OrderItem" oi
        JOIN "Order" cuenta ON cuenta."id" = oi."orderId"
        WHERE cuenta."venueId" = ${venueId}
          AND cuenta."status" = 'COMPLETED'
          AND cuenta."createdAt" >= ${utcTs(desde)}
          AND oi."releasedAreaTicketLineId" IS NULL
          ${deQuien}
      ) AS "vendidas",
      (
        SELECT SUM(CASE WHEN jsonb_typeof(r->'quantity') = 'number' THEN (r->>'quantity')::numeric ELSE 0 END)
        FROM "Payment" p
        CROSS JOIN LATERAL jsonb_array_elements(
          CASE WHEN jsonb_typeof(p."processorData"->'refundedItems') = 'array' THEN p."processorData"->'refundedItems' ELSE '[]'::jsonb END
        ) r
        JOIN "OrderItem" oi ON oi."id" = r->>'orderItemId'
        JOIN "Order" cuenta ON cuenta."id" = oi."orderId" AND cuenta."venueId" = p."venueId" AND cuenta."status" = 'COMPLETED'
        WHERE p."venueId" = ${venueId}
          AND p."type" = 'REFUND'
          AND p."status" = 'COMPLETED'
          AND p."createdAt" >= ${utcTs(desde)}
          AND oi."releasedAreaTicketLineId" IS NULL
          ${deQuien}
      ) AS "devueltas"
  `
  return Number(fila?.vendidas ?? 0) - Number(fila?.devueltas ?? 0)
}

/**
 * Calculate current sales for a goal based on period and goal type
 * - AMOUNT: sums Payment.amount (currency total)
 * - QUANTITY: las piezas vendidas menos las devueltas (`piezasDesde`)
 *
 * CRITICAL: Uses venue timezone for date boundaries (not UTC).
 * "Today" means today in the venue's timezone, not UTC.
 */
export async function calculateCurrentSales(
  venueId: string,
  staffId: string | null,
  period: SalesGoalPeriod,
  goalType: SalesGoalType = 'AMOUNT',
  db: Prisma.TransactionClient = prisma,
): Promise<number> {
  const timezone = await getVenueTimezone(venueId, db)
  let startDate: Date

  switch (period) {
    case 'DAILY':
      startDate = venueStartOfDay(timezone)
      break
    case 'WEEKLY': {
      // Start of week (Sunday) in venue timezone → converted to UTC for Prisma
      const venueNow = toZonedTime(new Date(), timezone)
      startDate = fromZonedTime(startOfWeek(venueNow, { weekStartsOn: 0 }), timezone)
      break
    }
    case 'MONTHLY':
      startDate = venueStartOfMonth(timezone)
      break
  }

  // Query payments
  const whereClause: Prisma.PaymentWhereInput = {
    venueId,
    status: 'COMPLETED',
    createdAt: {
      gte: startDate,
    },
  }

  // If staffId is provided, filter by the staff who processed the payment
  if (staffId) {
    whereClause.processedById = staffId
  }

  if (goalType === 'QUANTITY') return piezasDesde(db, venueId, staffId, startDate)

  // AMOUNT: sum of payment amounts. D4: la meta de UNA persona usa la regla del vendedor del movimiento (sus devoluciones, no las que
  // operó); la del negocio suma todo como siempre.
  if (staffId) return ventasDeLaPersonaDesde(db, venueId, staffId, startDate)
  const result = await db.payment.aggregate({
    where: whereClause,
    _sum: {
      amount: true,
    },
  })

  return result._sum.amount?.toNumber() || 0
}

/**
 * Enrich stored goal with staff info and calculated currentSales
 */
async function enrichGoal(venueId: string, storedGoal: StoredSalesGoal, db: Prisma.TransactionClient = prisma): Promise<SalesGoal> {
  let staff = null
  if (storedGoal.staffId) {
    const staffRecord = await db.staff.findUnique({
      where: { id: storedGoal.staffId },
      select: { id: true, firstName: true, lastName: true },
    })
    staff = staffRecord
  }

  const goalType = storedGoal.goalType || 'AMOUNT' // Backward compat: old goals default to AMOUNT
  const currentSales = await calculateCurrentSales(venueId, storedGoal.staffId, storedGoal.period, goalType, db)

  return {
    ...storedGoal,
    goalType,
    venueId,
    currentSales,
    staff,
  }
}

// ==========================================
// SERVICE FUNCTIONS
// ==========================================

/**
 * Get all sales goals for a venue
 */
export async function getSalesGoals(venueId: string, options?: { includeInactive?: boolean }): Promise<SalesGoal[]> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Filter inactive if needed
  const filteredGoals = options?.includeInactive ? storedGoals : storedGoals.filter(g => g.active)

  // Enrich with staff info and calculated sales
  const enrichedGoals = await Promise.all(filteredGoals.map(goal => enrichGoal(venueId, goal)))

  return enrichedGoals
}

/**
 * Get a single sales goal by ID
 */
export async function getSalesGoal(venueId: string, goalId: string): Promise<SalesGoal> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  const storedGoal = storedGoals.find(g => g.id === goalId)
  if (!storedGoal) {
    throw new NotFoundError('Sales goal not found')
  }

  return enrichGoal(venueId, storedGoal)
}

/**
 * Quién hizo el cambio y de qué organización, para la bitácora: sin ellos el asiento no tenía autor
 * (regla del repo: nunca `staffId: null` si se sabe quién fue). Opcional para no romper llamadores.
 */
export interface AuditoriaDeMeta {
  staffId?: string | null
  organizationId?: string | null
}

/**
 * Create a new sales goal
 */
export async function createSalesGoal(venueId: string, input: CreateSalesGoalInput, auditoria?: AuditoriaDeMeta): Promise<SalesGoal> {
  // Validate staff exists if provided
  if (input.staffId) {
    const staff = await prisma.staff.findUnique({
      where: { id: input.staffId },
    })
    if (!staff) {
      throw new NotFoundError('Staff not found')
    }
    // FT-GRAVES T1-hermanos: además de existir, tiene que ser del equipo de ESTA sede (`idsDelNegocio.ts`).
    await asegurarIdsDelNegocio({ venueId }, { staffIds: [input.staffId] })
  }

  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Check for duplicate (same staffId + period)
  const duplicate = storedGoals.find(g => g.staffId === (input.staffId || null) && g.period === input.period && g.active)
  if (duplicate) {
    throw new BadRequestError('A goal with this staff and period already exists')
  }

  const now = new Date().toISOString()
  const newGoal: StoredSalesGoal = {
    id: `goal_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
    staffId: input.staffId || null,
    goal: input.goal,
    goalType: input.goalType || 'AMOUNT',
    period: input.period,
    active: true,
    createdAt: now,
    updatedAt: now,
  }

  // Update config with new goal
  const updatedGoals = [...storedGoals, newGoal]
  const existingConfig = (venueModule.config as Record<string, unknown>) || {}

  await prisma.venueModule.update({
    where: { id: venueModule.id },
    data: {
      config: {
        ...existingConfig,
        salesGoals: updatedGoals,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  logAction({
    staffId: auditoria?.staffId ?? null,
    venueId,
    organizationId: auditoria?.organizationId ?? null,
    action: 'SALES_GOAL_CREATED',
    entity: 'SalesGoal',
    entityId: newGoal.id,
    data: { staffId: newGoal.staffId, goal: newGoal.goal, goalType: newGoal.goalType, period: newGoal.period },
  })

  return enrichGoal(venueId, newGoal)
}

/**
 * Update a sales goal
 */
export async function updateSalesGoal(
  venueId: string,
  goalId: string,
  input: UpdateSalesGoalInput,
  auditoria?: AuditoriaDeMeta,
): Promise<SalesGoal> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  const goalIndex = storedGoals.findIndex(g => g.id === goalId)
  if (goalIndex === -1) {
    throw new NotFoundError('Sales goal not found')
  }

  const now = new Date().toISOString()
  const updatedGoal: StoredSalesGoal = {
    ...storedGoals[goalIndex],
    goalType: storedGoals[goalIndex].goalType || 'AMOUNT', // Ensure backward compat
    ...(input.goal !== undefined && { goal: input.goal }),
    ...(input.goalType !== undefined && { goalType: input.goalType }),
    ...(input.period !== undefined && { period: input.period }),
    ...(input.active !== undefined && { active: input.active }),
    updatedAt: now,
  }

  // Update config
  const updatedGoals = [...storedGoals]
  updatedGoals[goalIndex] = updatedGoal
  const existingConfig = (venueModule.config as Record<string, unknown>) || {}

  await prisma.venueModule.update({
    where: { id: venueModule.id },
    data: {
      config: {
        ...existingConfig,
        salesGoals: updatedGoals,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  logAction({
    staffId: auditoria?.staffId ?? null,
    venueId,
    organizationId: auditoria?.organizationId ?? null,
    action: 'SALES_GOAL_UPDATED',
    entity: 'SalesGoal',
    entityId: goalId,
    data: { changes: Object.keys(input) },
  })

  return enrichGoal(venueId, updatedGoal)
}

/**
 * Delete a sales goal
 */
export async function deleteSalesGoal(venueId: string, goalId: string, auditoria?: AuditoriaDeMeta): Promise<void> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  const goalIndex = storedGoals.findIndex(g => g.id === goalId)
  if (goalIndex === -1) {
    throw new NotFoundError('Sales goal not found')
  }

  // Remove goal
  const updatedGoals = storedGoals.filter(g => g.id !== goalId)
  const existingConfig = (venueModule.config as Record<string, unknown>) || {}

  await prisma.venueModule.update({
    where: { id: venueModule.id },
    data: {
      config: {
        ...existingConfig,
        salesGoals: updatedGoals,
      } as unknown as Prisma.InputJsonValue,
    },
  })

  logAction({
    staffId: auditoria?.staffId ?? null,
    venueId,
    organizationId: auditoria?.organizationId ?? null,
    action: 'SALES_GOAL_DELETED',
    entity: 'SalesGoal',
    entityId: goalId,
  })
}

/**
 * Get the primary sales goal for a venue (for TPV display)
 * Returns the venue-wide goal if exists, otherwise null
 */
export async function getPrimarySalesGoal(venueId: string): Promise<SalesGoal | null> {
  const venueModule = await getOrCreateVenueModule(venueId)
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Find active venue-wide goal (staffId = null)
  const venueGoal = storedGoals.find(g => g.staffId === null && g.active)
  if (!venueGoal) return null

  return enrichGoal(venueId, venueGoal)
}

/**
 * Get sales goal for a specific staff member
 */
export async function getStaffSalesGoal(venueId: string, staffId: string, tx?: Prisma.TransactionClient): Promise<SalesGoal | null> {
  const module = tx ? await tx.module.findUnique({ where: { code: MODULE_CODES.COMMISSIONS }, select: { id: true } }) : null
  const venueModule = tx
    ? module
      ? await tx.venueModule.findUnique({ where: { venueId_moduleId: { venueId, moduleId: module.id } } })
      : null
    : await getOrCreateVenueModule(venueId)
  if (!venueModule) return null
  const storedGoals = getSalesGoalsFromConfig(venueModule.config)

  // Find active goal for this staff
  const staffGoal = storedGoals.find(g => g.staffId === staffId && g.active)
  if (!staffGoal) return null

  return enrichGoal(venueId, staffGoal, tx ?? prisma)
}

/** Policy only: never creates module configuration or enriches reporting values. */
export async function getStaffSalesGoalPolicy(venueId: string, staffId: string, db: Prisma.TransactionClient) {
  const module = await db.module.findUnique({ where: { code: MODULE_CODES.COMMISSIONS }, select: { id: true } })
  if (!module) return null
  const venueModule = await db.venueModule.findUnique({
    where: { venueId_moduleId: { venueId, moduleId: module.id } },
    select: { config: true },
  })
  return venueModule ? (getSalesGoalsFromConfig(venueModule.config).find(g => g.staffId === staffId && g.active) ?? null) : null
}
