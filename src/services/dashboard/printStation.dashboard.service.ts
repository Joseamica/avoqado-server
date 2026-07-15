/**
 * CRUD de PRINT_STATIONS para el dashboard (admin del negocio).
 *
 * - Feature GRATIS/core — sin gating de tier. Permiso: printers:read / printers:manage.
 * - Todo scoped por venueId (aislamiento multi-tenant, sin excepciones).
 * - Toda mutación escribe ActivityLog (fire-and-forget, con `previous` para reversibilidad).
 * - I9: máximo UN default por venue (índice único parcial en DB) — al marcar un default
 *   se limpia el anterior en la MISMA transacción para no violar el índice.
 * - v1.1: impresoras NETWORK y BLUETOOTH son ruteables por el gateway de impresión del
 *   POS Android (su PrinterService ya implementa el transporte BT/SPP). USB_SPOOLER
 *   (POS de escritorio/Windows) y TERMINAL_INTERNAL (impresora interna del PAX) siguen
 *   rechazadas — el gateway Android no puede servir esas rutas ("rechazar rutas no
 *   servibles", spec v3).
 * - El preview delega en el MISMO motor puro que consumirá la app (simulador honesto).
 */
import { Prisma, PrinterConnectionType } from '@prisma/client'
import { BadRequestError, NotFoundError } from '../../errors/AppError'
import prisma from '../../utils/prismaClient'
import { logAction } from './activity-log.service'
import { buildPrintConfig, routingConfigFrom } from '../printing/printConfig.service'
import { buildTicketPlans, RoutingItemInput } from '../printing/printRouting.engine'
import {
  BLUETOOTH_ADDRESS_MESSAGE,
  isValidBluetoothAddress,
  isValidNetworkAddress,
  NETWORK_ADDRESS_MESSAGE,
} from '../../schemas/dashboard/printStation.schema'
import type {
  AssignRoutingInput,
  CreatePrinterInput,
  CreateStationInput,
  PreviewRoutingInput,
  UpdatePrinterInput,
  UpdateStationInput,
  UpsertGatewayInput,
} from '../../schemas/dashboard/printStation.schema'

async function assertVenue(venueId: string): Promise<void> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')
}

// Motivo por el que el gateway de impresión del POS (Android) no puede servir estos tipos
// de conexión — cada uno pertenece a un cliente distinto que no es el gateway Android.
const UNSERVICEABLE_CONNECTION_MESSAGES: Partial<Record<PrinterConnectionType, string>> = {
  USB_SPOOLER:
    'El gateway de impresión del POS (Android) no puede imprimir por USB — ese tipo de conexión es exclusivo del POS de escritorio (Windows).',
  TERMINAL_INTERNAL:
    'El gateway de impresión del POS (Android) no puede usar la impresora interna del terminal — TERMINAL_INTERNAL es exclusiva de la app del PAX.',
}

function assertServiceableConnectionType(connectionType: PrinterConnectionType): void {
  const message = UNSERVICEABLE_CONNECTION_MESSAGES[connectionType]
  if (message) throw new BadRequestError(message)
}

function assertValidAddressShape(connectionType: PrinterConnectionType, address: string | null | undefined): void {
  if (!address) return
  if (connectionType === 'NETWORK' && !isValidNetworkAddress(address)) {
    throw new BadRequestError(NETWORK_ADDRESS_MESSAGE)
  }
  if (connectionType === 'BLUETOOTH' && !isValidBluetoothAddress(address)) {
    throw new BadRequestError(BLUETOOTH_ADDRESS_MESSAGE)
  }
}

// ── Printers ────────────────────────────────────────────────────────
export async function listPrinters(venueId: string) {
  await assertVenue(venueId)
  return prisma.printer.findMany({ where: { venueId }, orderBy: { name: 'asc' } })
}

export async function createPrinter(venueId: string, input: CreatePrinterInput, performedBy?: string) {
  await assertVenue(venueId)
  const connectionType = (input.connectionType ?? 'NETWORK') as PrinterConnectionType
  // Solo NETWORK y BLUETOOTH son ruteables por el gateway de impresión del POS Android.
  assertServiceableConnectionType(connectionType)
  // Shape ya validada en Zod (createPrinterSchema.superRefine) cuando ambos campos
  // llegan en el mismo body — se revalida aquí también por si el caller es interno/script.
  assertValidAddressShape(connectionType, input.address ?? null)
  const printer = await prisma.printer.create({
    data: {
      venueId,
      name: input.name,
      connectionType,
      address: input.address ?? null,
      stableKey: input.stableKey ?? null,
      paperWidthMm: input.paperWidthMm ?? 80,
      charset: input.charset ?? 'CP858',
    },
  })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINTER_CREATED',
    entity: 'Printer',
    entityId: printer.id,
    data: { name: printer.name, connectionType: printer.connectionType, address: printer.address } as Prisma.InputJsonValue,
  })
  return printer
}

export async function updatePrinter(venueId: string, printerId: string, input: UpdatePrinterInput, performedBy?: string) {
  const previous = await prisma.printer.findFirst({ where: { id: printerId, venueId } })
  if (!previous) throw new NotFoundError('Impresora no encontrada')
  // El tipo efectivo puede venir del input o (si no se envía) del registro existente —
  // Zod no ve `previous`, así que la validación de forma de dirección vive aquí.
  const effectiveConnectionType = (input.connectionType ?? previous.connectionType) as PrinterConnectionType
  assertServiceableConnectionType(effectiveConnectionType)
  const effectiveAddress = input.address === undefined ? previous.address : input.address
  assertValidAddressShape(effectiveConnectionType, effectiveAddress)
  const printer = await prisma.printer.update({
    where: { id: printerId },
    data: {
      name: input.name ?? undefined,
      connectionType: input.connectionType ?? undefined,
      address: input.address === undefined ? undefined : input.address,
      stableKey: input.stableKey === undefined ? undefined : input.stableKey,
      paperWidthMm: input.paperWidthMm ?? undefined,
      charset: input.charset ?? undefined,
      active: input.active ?? undefined,
    },
  })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINTER_UPDATED',
    entity: 'Printer',
    entityId: printer.id,
    data: {
      changes: input,
      previous: { name: previous.name, active: previous.active, address: previous.address },
    } as Prisma.InputJsonValue,
  })
  return printer
}

export async function deletePrinter(venueId: string, printerId: string, performedBy?: string) {
  const printer = await prisma.printer.findFirst({ where: { id: printerId, venueId } })
  if (!printer) throw new NotFoundError('Impresora no encontrada')
  // FK SetNull en PrintStation.printerId / PrintJob.printerId → borrar no huérfana datos.
  await prisma.printer.delete({ where: { id: printerId } })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINTER_DELETED',
    entity: 'Printer',
    entityId: printerId,
    data: { name: printer.name } as Prisma.InputJsonValue,
  })
  return { id: printerId, deleted: true }
}

// ── Print stations ──────────────────────────────────────────────────
export async function listStations(venueId: string) {
  await assertVenue(venueId)
  return prisma.printStation.findMany({
    where: { venueId },
    orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
    include: { printer: { select: { id: true, name: true, active: true, lastStatus: true } } },
  })
}

async function assertPrinterInVenue(venueId: string, printerId: string | null | undefined): Promise<void> {
  if (!printerId) return
  const printer = await prisma.printer.findFirst({ where: { id: printerId, venueId }, select: { id: true } })
  if (!printer) throw new BadRequestError('La impresora seleccionada no pertenece a este venue')
}

export async function createStation(venueId: string, input: CreateStationInput, performedBy?: string) {
  await assertVenue(venueId)
  await assertPrinterInVenue(venueId, input.printerId ?? null)

  const station = await prisma.$transaction(async tx => {
    if (input.isDefault) {
      // I9: solo un default por venue → limpiar el anterior antes de crear.
      await tx.printStation.updateMany({ where: { venueId, isDefault: true }, data: { isDefault: false } })
    }
    return tx.printStation.create({
      data: {
        venueId,
        name: input.name,
        printerId: input.printerId ?? null,
        copies: input.copies ?? 1,
        isDefault: input.isDefault ?? false,
        displayOrder: input.displayOrder ?? 0,
      },
    })
  })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINT_STATION_CREATED',
    entity: 'PrintStation',
    entityId: station.id,
    data: { name: station.name, printerId: station.printerId, isDefault: station.isDefault } as Prisma.InputJsonValue,
  })
  return station
}

export async function updateStation(venueId: string, stationId: string, input: UpdateStationInput, performedBy?: string) {
  const previous = await prisma.printStation.findFirst({ where: { id: stationId, venueId } })
  if (!previous) throw new NotFoundError('Estación no encontrada')
  await assertPrinterInVenue(venueId, input.printerId ?? null)

  const station = await prisma.$transaction(async tx => {
    if (input.isDefault === true) {
      await tx.printStation.updateMany({ where: { venueId, isDefault: true, NOT: { id: stationId } }, data: { isDefault: false } })
    }
    return tx.printStation.update({
      where: { id: stationId },
      data: {
        name: input.name ?? undefined,
        printerId: input.printerId === undefined ? undefined : input.printerId,
        copies: input.copies ?? undefined,
        isDefault: input.isDefault ?? undefined,
        displayOrder: input.displayOrder ?? undefined,
        active: input.active ?? undefined,
      },
    })
  })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINT_STATION_UPDATED',
    entity: 'PrintStation',
    entityId: station.id,
    data: {
      changes: input,
      previous: { name: previous.name, isDefault: previous.isDefault, active: previous.active },
    } as Prisma.InputJsonValue,
  })
  return station
}

export async function deleteStation(venueId: string, stationId: string, performedBy?: string) {
  const station = await prisma.printStation.findFirst({ where: { id: stationId, venueId } })
  if (!station) throw new NotFoundError('Estación no encontrada')
  // FK SetNull en MenuCategory/Product/OrderItem/PrintJob.printStationId.
  await prisma.printStation.delete({ where: { id: stationId } })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINT_STATION_DELETED',
    entity: 'PrintStation',
    entityId: stationId,
    data: { name: station.name, wasDefault: station.isDefault } as Prisma.InputJsonValue,
  })
  return { id: stationId, deleted: true }
}

// ── Gateway ─────────────────────────────────────────────────────────
export async function getGateway(venueId: string) {
  await assertVenue(venueId)
  return prisma.printGateway.findUnique({ where: { venueId } })
}

export async function upsertGateway(venueId: string, input: UpsertGatewayInput, performedBy?: string) {
  await assertVenue(venueId)
  const gateway = await prisma.printGateway.upsert({
    where: { venueId },
    create: { venueId, terminalId: input.terminalId, address: input.address ?? null, active: input.active ?? true },
    update: {
      terminalId: input.terminalId,
      address: input.address === undefined ? undefined : input.address,
      active: input.active ?? undefined,
    },
  })
  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINT_GATEWAY_UPSERTED',
    entity: 'PrintGateway',
    entityId: gateway.id,
    data: { terminalId: gateway.terminalId, active: gateway.active } as Prisma.InputJsonValue,
  })
  return gateway
}

// ── Routing (category/product → station) ────────────────────────────
export async function getRouting(venueId: string) {
  await assertVenue(venueId)
  const [categories, products] = await Promise.all([
    prisma.menuCategory.findMany({
      where: { venueId },
      select: { id: true, name: true, printStationId: true },
      orderBy: { displayOrder: 'asc' },
    }),
    prisma.product.findMany({
      where: { venueId },
      select: { id: true, name: true, categoryId: true, printStationId: true },
      orderBy: { name: 'asc' },
    }),
  ])
  const stations = await prisma.printStation.findMany({ where: { venueId, active: true }, select: { id: true, isDefault: true } })
  const hasDefault = stations.some(s => s.isDefault)
  const activeStationIds = new Set(stations.map(s => s.id))
  // "Sin ruta" = categorías sin estación ACTIVA propia Y sin default del venue (mismo criterio que el motor:
  // una categoría apuntando a una estación desactivada/borrada también cuenta como sin ruta).
  const unroutedCategories = hasDefault ? 0 : categories.filter(c => !c.printStationId || !activeStationIds.has(c.printStationId)).length
  return { categories, products, unroutedCategories, hasDefault }
}

export async function assignRouting(venueId: string, input: AssignRoutingInput, performedBy?: string) {
  await assertVenue(venueId)

  // Validar que todas las estaciones destino existan y sean de este venue.
  const targetStationIds = [
    ...(input.categories ?? []).map(c => c.printStationId),
    ...(input.products ?? []).map(p => p.printStationId),
  ].filter((id): id is string => !!id)
  if (targetStationIds.length > 0) {
    const found = await prisma.printStation.findMany({
      where: { venueId, id: { in: [...new Set(targetStationIds)] } },
      select: { id: true },
    })
    const foundIds = new Set(found.map(s => s.id))
    const missing = [...new Set(targetStationIds)].filter(id => !foundIds.has(id))
    if (missing.length > 0) throw new BadRequestError('Una o más estaciones destino no pertenecen a este venue')
  }

  let categoriesUpdated = 0
  let productsUpdated = 0
  await prisma.$transaction(async tx => {
    for (const entry of input.categories ?? []) {
      // venueId en el where = aislamiento multi-tenant (ignora ids ajenos).
      const r = await tx.menuCategory.updateMany({ where: { id: entry.id, venueId }, data: { printStationId: entry.printStationId } })
      categoriesUpdated += r.count
    }
    for (const entry of input.products ?? []) {
      const r = await tx.product.updateMany({ where: { id: entry.id, venueId }, data: { printStationId: entry.printStationId } })
      productsUpdated += r.count
    }
  })

  void logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'PRINT_ROUTING_ASSIGNED',
    entity: 'PrintStation',
    entityId: venueId,
    data: { categoriesUpdated, productsUpdated } as Prisma.InputJsonValue,
  })
  return { categoriesUpdated, productsUpdated }
}

// ── Simulator (preview) ─────────────────────────────────────────────
export async function previewRouting(venueId: string, input: PreviewRoutingInput) {
  const config = await buildPrintConfig(venueId)
  const stationName = new Map(config.stations.map(s => [s.id, s.name]))

  const productIds = [...new Set(input.items.map(i => i.productId))]
  const products = await prisma.product.findMany({
    where: { id: { in: productIds }, venueId },
    select: { id: true, name: true, printStationId: true, category: { select: { printStationId: true } } },
  })
  const productById = new Map(products.map(p => [p.id, p]))

  const missing = productIds.filter(id => !productById.has(id))
  if (missing.length > 0) throw new BadRequestError('Uno o más productos no pertenecen a este venue')

  const items: RoutingItemInput[] = input.items.map((i, idx) => {
    const p = productById.get(i.productId)!
    return {
      orderItemId: `preview_${idx}`,
      productId: p.id,
      productStationId: p.printStationId ?? null,
      categoryStationId: p.category?.printStationId ?? null,
      productName: p.name,
      quantity: i.quantity,
      modifiers: [],
      notes: null,
    }
  })

  const plans = buildTicketPlans(items, routingConfigFrom(config))
  return {
    plans: plans.map(plan => ({
      stationId: plan.stationId,
      stationName: plan.stationId ? (stationName.get(plan.stationId) ?? null) : null,
      unrouted: plan.unrouted,
      lines: plan.lines.map(l => ({ productName: l.productName, quantity: l.quantity })),
    })),
    unrouted: plans.some(p => p.unrouted),
  }
}
