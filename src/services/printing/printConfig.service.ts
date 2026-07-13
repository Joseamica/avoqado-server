/**
 * PRINT_STATIONS — shared print-config loader.
 * ===================================================================
 * Assembles the venue's printing configuration (gateway, printers, stations,
 * category/product routing) into ONE payload, plus a content-hash `version`
 * used by clients for anti-staleness (spec v3). Reused by:
 *   - the mobile print-config endpoint (what the POS caches),
 *   - the dashboard routing simulator (honest preview == what the client sees).
 *
 * The natural feature gate lives here: a venue with NO stations returns
 * `stations: []`, so unconfigured venues (and old clients) behave exactly as
 * today.
 */
import { createHash } from 'crypto'
import prisma from '../../utils/prismaClient'
import type { RoutingConfig } from './printRouting.engine'

export interface PrintConfigPayload {
  gateway: { terminalId: string; address: string | null; active: boolean } | null
  printers: Array<{
    id: string
    name: string
    connectionType: string
    address: string | null
    stableKey: string | null
    paperWidthMm: number
    charset: string
    active: boolean
    lastStatus: string | null
    lastSeenAt: Date | null
  }>
  stations: Array<{
    id: string
    name: string
    printerId: string | null
    copies: number
    isDefault: boolean
    active: boolean
    displayOrder: number
  }>
  defaultStationId: string | null
  /** Only categories that have an explicit station set. */
  categoryRouting: Array<{ categoryId: string; printStationId: string }>
  /** Only products that have an explicit override set. */
  productOverrides: Array<{ productId: string; printStationId: string }>
  version: string
}

export async function buildPrintConfig(venueId: string): Promise<PrintConfigPayload> {
  const [gateway, printers, stations, categories, products] = await Promise.all([
    prisma.printGateway.findUnique({ where: { venueId } }),
    prisma.printer.findMany({ where: { venueId }, orderBy: { name: 'asc' } }),
    prisma.printStation.findMany({ where: { venueId }, orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }] }),
    prisma.menuCategory.findMany({
      where: { venueId, printStationId: { not: null } },
      select: { id: true, printStationId: true },
      orderBy: { id: 'asc' },
    }),
    prisma.product.findMany({
      where: { venueId, printStationId: { not: null } },
      select: { id: true, printStationId: true },
      orderBy: { id: 'asc' },
    }),
  ])

  const defaultStation = stations.find(s => s.isDefault && s.active) ?? null

  const payload: Omit<PrintConfigPayload, 'version'> = {
    gateway: gateway ? { terminalId: gateway.terminalId, address: gateway.address, active: gateway.active } : null,
    printers: printers.map(p => ({
      id: p.id,
      name: p.name,
      connectionType: p.connectionType,
      address: p.address,
      stableKey: p.stableKey,
      paperWidthMm: p.paperWidthMm,
      charset: p.charset,
      active: p.active,
      lastStatus: p.lastStatus,
      lastSeenAt: p.lastSeenAt,
    })),
    stations: stations.map(s => ({
      id: s.id,
      name: s.name,
      printerId: s.printerId,
      copies: s.copies,
      isDefault: s.isDefault,
      active: s.active,
      displayOrder: s.displayOrder,
    })),
    defaultStationId: defaultStation?.id ?? null,
    categoryRouting: categories.map(c => ({ categoryId: c.id, printStationId: c.printStationId as string })),
    productOverrides: products.map(p => ({ productId: p.id, printStationId: p.printStationId as string })),
  }

  return { ...payload, version: hashConfig(payload) }
}

/** Content hash → clients refetch when it changes (anti-staleness). Excludes volatile telemetry. */
function hashConfig(p: Omit<PrintConfigPayload, 'version'>): string {
  const stable = {
    gateway: p.gateway,
    // exclude lastStatus/lastSeenAt (telemetry churns without a config change)
    printers: p.printers.map(({ lastStatus, lastSeenAt, ...rest }) => rest),
    stations: p.stations,
    defaultStationId: p.defaultStationId,
    // sort for determinism → the version hash is a stable function of CONTENT, not DB row order
    categoryRouting: [...p.categoryRouting].sort((a, b) => a.categoryId.localeCompare(b.categoryId)),
    productOverrides: [...p.productOverrides].sort((a, b) => a.productId.localeCompare(b.productId)),
  }
  return createHash('sha1').update(JSON.stringify(stable)).digest('hex').slice(0, 16)
}

/** Distil the routing inputs the pure engine needs from a loaded config. */
export function routingConfigFrom(payload: PrintConfigPayload): RoutingConfig {
  return {
    defaultStationId: payload.defaultStationId,
    activeStationIds: new Set(payload.stations.filter(s => s.active).map(s => s.id)),
  }
}
