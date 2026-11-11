/**
 * Etapa 3 del KDS — las estaciones del negocio vistas desde la pantalla de cocina.
 * Vive aparte de `kds.mobile.service` porque también lo consultan los cobros y las rondas.
 */
import type { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import type { RoutingConfig } from '../printing/printRouting.engine'
import type { ScreenStation } from './kitchenTicketPlanning'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { ForbiddenError } from '../../errors/AppError'

type Db = Prisma.TransactionClient | typeof prisma

type PreparationInput = {
  serviceCourse?: { preparationVersion?: number; kind?: string } | null
  promotionRef?: { selections: Array<{ serviceCourse?: { preparationVersion?: number } | null }> }
}

/** Validate before creating new preparation rows; payment retries of an existing sale remain compatible. */
export async function assertPreparationAuthoringAccess(venueId: string, items: PreparationInput[]): Promise<void> {
  const requested = items.some(
    item =>
      item.serviceCourse?.preparationVersion === 1 ||
      item.promotionRef?.selections.some(selection => selection.serviceCourse?.preparationVersion === 1),
  )
  if (requested && !(await venueHasFeatureAccess(venueId, 'KITCHEN_DISPLAY'))) {
    throw new ForbiddenError('La preparación por producto requiere Pro.', 'FEATURE_ACCESS_REQUIRED')
  }
}

/**
 * ¿El negocio atiende alguna estación ACTIVA con pantalla de cocina? (spec 2026-09-24, etapa 1).
 * `!= null` y no `!== null`: un doble de prueba que devuelve `undefined` cuenta como «no hay».
 */
export async function venueTienePantallaDeCocina(venueId: string, db: Db = prisma): Promise<boolean> {
  const estacion = await db.printStation.findFirst({
    where: { venueId, active: true, hasKitchenDisplay: true },
    select: { id: true },
  })
  return estacion != null
}

export interface EstacionesDelNegocio {
  /** La MISMA regla que la print-config de la caja (`buildPrintConfig` → `routingConfigFrom`). */
  routing: RoutingConfig
  /** Estaciones activas con pantalla, con su «cuenta nueva». */
  screens: ScreenStation[]
}

/** Las estaciones en UNA consulta. Un negocio real tiene 1-5; el tope es defensa. */
export async function estacionesDelNegocio(venueId: string, db: Db = prisma): Promise<EstacionesDelNegocio> {
  const filas = await db.printStation.findMany({
    where: { venueId },
    select: { id: true, active: true, isDefault: true, hasKitchenDisplay: true, kitchenDisplaySince: true, createdAt: true },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    take: 100,
  })
  const activas = filas.filter(f => f.active)
  return {
    routing: {
      defaultStationId: activas.find(f => f.isDefault)?.id ?? null,
      activeStationIds: new Set(activas.map(f => f.id)),
    },
    // Sin sello (no debería pasar tras el relleno de la migración): cuenta desde que se creó la estación.
    screens: activas.filter(f => f.hasKitchenDisplay).map(f => ({ id: f.id, since: f.kitchenDisplaySince ?? f.createdAt })),
  }
}

/**
 * Uber: su comanda (una por pedido, sin partir) va a la estación DEFAULT con pantalla, o a la primera con
 * pantalla. Así sólo esa pantalla puede avisarle a Uber «listo». Nunca lanza: si falla, la comanda nace
 * «Sin estación» (sale en todas) en vez de no nacer.
 */
export async function estacionDePantallaParaReparto(venueId: string): Promise<string | null> {
  try {
    const fila = await prisma.printStation.findFirst({
      where: { venueId, active: true, hasKitchenDisplay: true },
      orderBy: [{ isDefault: 'desc' }, { displayOrder: 'asc' }, { name: 'asc' }],
      select: { id: true },
    })
    return fila?.id ?? null
  } catch (error) {
    logger.warn('[KDS] no se pudo elegir la estación del pedido de reparto; sale «Sin estación»', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}

/**
 * ¿Esta venta o ronda necesita comanda de pantalla? Se resuelve FUERA de la transacción de dinero y nunca
 * lanza: saber si hay pantalla no puede tumbar un cobro.
 *
 * 🔴 hz:ce654971:D5 (Codex r4 B12): si no se puede saber, contesta `true` («en duda, manda»). Antes contestaba `false` y la venta
 * se confirmaba sin marca ni aviso: se perdía el único aviso a cocina. De más no cuesta nada: el autor relee las estaciones cuando
 * la base conteste y, sin pantalla, limpia la marca sin armar nada.
 */
export async function debeMarcarCocina(venueId: string, options: { hasPreparation?: boolean; orderId?: string } = {}): Promise<boolean> {
  return (await consultarCocina(venueId, options)) !== false
}

/**
 * Lo mismo que `debeMarcarCocina`, distinguiendo la duda: `null` = no se pudo saber. Para quien AFIRMA algo con la respuesta
 * (la bitácora «comanda omitida» de una venta tardía, Codex r1 #2): en duda se marca, pero no se afirma que había cocina.
 */
export async function consultarCocina(
  venueId: string,
  options: { hasPreparation?: boolean; orderId?: string } = {},
): Promise<boolean | null> {
  try {
    if (await venueTienePantallaDeCocina(venueId)) return true
    const hasPreparation =
      options.hasPreparation ||
      (options.orderId &&
        (await prisma.orderItem.findFirst({
          where: { orderId: options.orderId, order: { venueId }, serviceCourse: { path: ['preparationVersion'], equals: 1 } },
          select: { id: true },
        })))
    return Boolean(hasPreparation) && (await venueHasFeatureAccess(venueId, 'KITCHEN_DISPLAY'))
  } catch (error) {
    logger.warn('[KDS] no se pudo saber si el negocio tiene pantalla; la venta deja la marca de cocina y el armado decide después', {
      venueId,
      error: error instanceof Error ? error.message : String(error),
    })
    return null
  }
}
