import { fromZonedTime } from 'date-fns-tz'
import {
  AreaSettlementRoute,
  AreaTicketCheckoutStatus,
  AreaTicketExternalIncidentKind,
  AreaTicketExternalIncidentStatus,
  AreaTicketExternalSettlementStatus,
  AreaTicketStatus,
  ExternalConfirmationMode,
  ExternalDeliveryTracking,
  ExternalOfflinePolicy,
  FulfillmentMode,
  Prisma,
  ScaleContext,
  ScaleTransport,
  TerminalWorkspace,
  Unit,
} from '@prisma/client'

import { BadRequestError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import {
  CreateFulfillmentAreaInput,
  CreateScaleProfileInput,
  ListExternalIncidentsQuery,
  ListExternalSettlementsQuery,
  UpdateAreaSettlementRouteInput,
  UpdateAreaTicketSettingsInput,
  UpdateAreaTicketTerminalInput,
  UpdateFulfillmentAreaInput,
  UpdateScaleProfileInput,
  UpdateScaleSettingsInput,
} from '../../schemas/dashboard/areaTicket.schema'
import { DEFAULT_TIMEZONE } from '../../utils/datetime'
import prisma from '../../utils/prismaClient'
import { venueHasFeatureAccess } from '../access/basePlan.service'
import { logAction } from './activity-log.service'

const DEFAULT_SETTINGS = {
  enabled: false,
  allowMixedCart: true,
  claimTtlSeconds: 300,
  checkoutSessionMaxAgeMinutes: 30,
  ticketExpiryPolicy: 'BUSINESS_DAY_CLOSE' as const,
  ticketExpiryMinutes: null,
  deliveryVerificationMode: 'PAPER_OR_SCAN' as const,
  codeSymbology: 'CODE128',
  requireManagerForCancel: true,
  recordWasteOnCancel: false,
  inventoryReservationMode: 'NONE' as const,
}

async function assertVenue(venueId: string): Promise<void> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')
}

async function assertFeature(
  venueId: string,
  featureCode: 'AREA_TICKETS' | 'SCALE_INTEGRATION' | 'VARIABLE_WEIGHT_BARCODE',
): Promise<void> {
  if (!(await venueHasFeatureAccess(venueId, featureCode))) {
    const message =
      featureCode === 'AREA_TICKETS'
        ? 'El plan de este local no incluye vales por área.'
        : featureCode === 'SCALE_INTEGRATION'
          ? 'El plan de este local no incluye integración con básculas.'
          : 'El plan de este local no incluye etiquetas de peso variable.'
    throw new ForbiddenError(message, `${featureCode}_NOT_ENTITLED`)
  }
}

async function assertPrintStation(venueId: string, printStationId: string | null | undefined): Promise<void> {
  if (!printStationId) return
  const station = await prisma.printStation.findFirst({
    where: { id: printStationId, venueId, active: true },
    select: { id: true },
  })
  if (!station) throw new BadRequestError('La estación de impresión no pertenece al venue o está inactiva.')
}

async function assertArea(venueId: string, areaId: string | null | undefined): Promise<void> {
  if (!areaId) return
  const area = await prisma.fulfillmentArea.findFirst({
    where: { id: areaId, venueId, active: true },
    select: { id: true },
  })
  if (!area) throw new BadRequestError('El área no pertenece al venue o está inactiva.')
}

async function assertScaleProfile(venueId: string, profileId: string | null | undefined): Promise<void> {
  if (!profileId) return
  const profile = await prisma.scaleProfile.findFirst({
    where: { id: profileId, venueId, active: true },
    select: { id: true },
  })
  if (!profile) throw new BadRequestError('El perfil de báscula no pertenece al venue o está inactivo.')
}

export async function getOverview(venueId: string) {
  await assertVenue(venueId)
  const [
    areaTicketsEntitled,
    scaleIntegrationEntitled,
    variableWeightBarcodeEntitled,
    settings,
    scaleSettings,
    areas,
    terminals,
    scaleProfiles,
    ticketCounts,
    checkoutCounts,
    paymentReconciliationCount,
  ] = await Promise.all([
    venueHasFeatureAccess(venueId, 'AREA_TICKETS'),
    venueHasFeatureAccess(venueId, 'SCALE_INTEGRATION'),
    venueHasFeatureAccess(venueId, 'VARIABLE_WEIGHT_BARCODE'),
    prisma.venueAreaTicketSettings.findUnique({ where: { venueId } }),
    prisma.venueScaleSettings.findUnique({ where: { venueId } }),
    prisma.fulfillmentArea.findMany({
      where: { venueId },
      orderBy: [{ displayOrder: 'asc' }, { name: 'asc' }],
      include: {
        printStation: { select: { id: true, name: true, active: true } },
        _count: { select: { terminals: true, areaTickets: true } },
      },
    }),
    prisma.terminal.findMany({
      where: { venueId },
      orderBy: { name: 'asc' },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        brand: true,
        model: true,
        deviceUid: true,
        fulfillmentAreaId: true,
        canIssueAreaTickets: true,
        canCheckoutAreaTickets: true,
        canDeliverAreaTickets: true,
        defaultWorkspace: true,
        scaleProfileId: true,
      },
    }),
    prisma.scaleProfile.findMany({ where: { venueId }, orderBy: [{ active: 'desc' }, { name: 'asc' }] }),
    prisma.areaTicket.groupBy({ by: ['status'], where: { venueId }, _count: { _all: true } }),
    prisma.areaTicketCheckoutSession.groupBy({ by: ['status'], where: { venueId }, _count: { _all: true } }),
    prisma.areaTicketPaymentAttempt.count({
      where: {
        checkoutSession: { venueId },
        OR: [{ status: 'UNKNOWN' }, { checkoutSession: { status: AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED } }],
      },
    }),
  ])

  return {
    entitlements: {
      areaTickets: areaTicketsEntitled,
      scaleIntegration: scaleIntegrationEntitled,
      variableWeightBarcode: variableWeightBarcodeEntitled,
    },
    effective: {
      areaTickets: areaTicketsEntitled && Boolean(settings?.enabled),
      scales: scaleIntegrationEntitled && Boolean(scaleSettings?.enabled),
      variableWeightBarcode: variableWeightBarcodeEntitled && Boolean(scaleSettings?.variableBarcodeEnabled),
    },
    settings: settings ?? { venueId, ...DEFAULT_SETTINGS },
    scaleSettings: scaleSettings ?? {
      venueId,
      enabled: false,
      variableBarcodeEnabled: false,
      variableBarcodePrefix: '20',
    },
    areas,
    terminals,
    scaleProfiles,
    operations: {
      tickets: Object.fromEntries(ticketCounts.map(row => [row.status, row._count._all])),
      checkouts: Object.fromEntries(checkoutCounts.map(row => [row.status, row._count._all])),
      paymentReconciliationCount,
    },
  }
}

export async function updateSettings(venueId: string, input: UpdateAreaTicketSettingsInput, performedBy?: string) {
  await assertVenue(venueId)
  const previous = await prisma.venueAreaTicketSettings.findUnique({ where: { venueId } })
  const effectivePolicy = input.ticketExpiryPolicy ?? previous?.ticketExpiryPolicy ?? DEFAULT_SETTINGS.ticketExpiryPolicy
  const effectiveMinutes =
    input.ticketExpiryMinutes === undefined
      ? (previous?.ticketExpiryMinutes ?? DEFAULT_SETTINGS.ticketExpiryMinutes)
      : input.ticketExpiryMinutes

  if (input.enabled === true) await assertFeature(venueId, 'AREA_TICKETS')
  if (effectivePolicy === 'FIXED_DURATION' && !effectiveMinutes) {
    throw new BadRequestError('Configura la duración del vale cuando la expiración es por tiempo fijo.')
  }

  const settings = await prisma.venueAreaTicketSettings.upsert({
    where: { venueId },
    create: {
      venueId,
      ...DEFAULT_SETTINGS,
      ...input,
      ticketExpiryMinutes: effectivePolicy === 'BUSINESS_DAY_CLOSE' ? null : effectiveMinutes,
    },
    update: {
      ...input,
      ticketExpiryMinutes: effectivePolicy === 'BUSINESS_DAY_CLOSE' ? null : effectiveMinutes,
    },
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'AREA_TICKET_SETTINGS_UPDATED',
    entity: 'VenueAreaTicketSettings',
    entityId: settings.id,
    data: { previous, changes: input } as unknown as Prisma.InputJsonValue,
  })
  return settings
}

export async function createArea(venueId: string, input: CreateFulfillmentAreaInput, performedBy?: string) {
  await assertVenue(venueId)
  await assertPrintStation(venueId, input.printStationId)
  const area = await prisma.fulfillmentArea.create({
    data: {
      venueId,
      name: input.name,
      fulfillmentMode: (input.fulfillmentMode ?? 'IMMEDIATE') as FulfillmentMode,
      printStationId: input.printStationId ?? null,
      active: input.active ?? true,
      displayOrder: input.displayOrder ?? 0,
    },
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'FULFILLMENT_AREA_CREATED',
    entity: 'FulfillmentArea',
    entityId: area.id,
    data: { name: area.name, fulfillmentMode: area.fulfillmentMode } as Prisma.InputJsonValue,
  })
  return area
}

export async function updateArea(venueId: string, areaId: string, input: UpdateFulfillmentAreaInput, performedBy?: string) {
  const previous = await prisma.fulfillmentArea.findFirst({ where: { id: areaId, venueId } })
  if (!previous) throw new NotFoundError('Área no encontrada')
  await assertPrintStation(venueId, input.printStationId)
  const area = await prisma.fulfillmentArea.update({
    where: { id: areaId },
    data: {
      name: input.name,
      fulfillmentMode: input.fulfillmentMode as FulfillmentMode | undefined,
      printStationId: input.printStationId,
      active: input.active,
      displayOrder: input.displayOrder,
    },
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'FULFILLMENT_AREA_UPDATED',
    entity: 'FulfillmentArea',
    entityId: area.id,
    data: { changes: input } as unknown as Prisma.InputJsonValue,
  })
  return area
}

/**
 * Ruta de cobro externa de un área (§caja externa fase 1). Las cuatro políticas viajan
 * SIEMPRE juntas — el Zod ya las hace todas requeridas — porque prenderlo cambia dónde
 * entra el dinero de esta área: Avoqado deja de crear Order/Payment para sus vales.
 * Audita con `{ from, to }` completos: es exactamente el tipo de cambio que un owner
 * necesita poder reconstruir después ("¿desde cuándo cobra otra caja aquí?").
 */
export async function updateAreaSettlementRoute(
  venueId: string,
  areaId: string,
  input: UpdateAreaSettlementRouteInput,
  performedBy?: string,
) {
  const previous = await prisma.fulfillmentArea.findFirst({ where: { id: areaId, venueId } })
  if (!previous) throw new NotFoundError('Área no encontrada')

  const area = await prisma.fulfillmentArea.update({
    where: { id: areaId },
    data: {
      settlementRoute: input.settlementRoute as AreaSettlementRoute,
      externalConfirmationMode: input.externalConfirmationMode as ExternalConfirmationMode,
      externalOfflinePolicy: input.externalOfflinePolicy as ExternalOfflinePolicy,
      externalDeliveryTracking: input.externalDeliveryTracking as ExternalDeliveryTracking,
    },
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'AREA_SETTLEMENT_ROUTE_CHANGED',
    entity: 'FulfillmentArea',
    entityId: area.id,
    data: {
      from: {
        settlementRoute: previous.settlementRoute,
        externalConfirmationMode: previous.externalConfirmationMode,
        externalOfflinePolicy: previous.externalOfflinePolicy,
        externalDeliveryTracking: previous.externalDeliveryTracking,
      },
      to: {
        settlementRoute: area.settlementRoute,
        externalConfirmationMode: area.externalConfirmationMode,
        externalOfflinePolicy: area.externalOfflinePolicy,
        externalDeliveryTracking: area.externalDeliveryTracking,
      },
    } as unknown as Prisma.InputJsonValue,
  })
  return area
}

export async function updateTerminal(venueId: string, terminalId: string, input: UpdateAreaTicketTerminalInput, performedBy?: string) {
  const terminal = await prisma.terminal.findFirst({
    where: { id: terminalId, venueId },
    select: {
      id: true,
      canIssueAreaTickets: true,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: true,
      defaultWorkspace: true,
    },
  })
  if (!terminal) throw new NotFoundError('Terminal no encontrada')
  await Promise.all([assertArea(venueId, input.fulfillmentAreaId), assertScaleProfile(venueId, input.scaleProfileId)])

  const capabilityWasUpdated =
    input.canIssueAreaTickets !== undefined || input.canCheckoutAreaTickets !== undefined || input.canDeliverAreaTickets !== undefined
  const hasAreaTicketCapability =
    (input.canIssueAreaTickets ?? terminal.canIssueAreaTickets) ||
    (input.canCheckoutAreaTickets ?? terminal.canCheckoutAreaTickets) ||
    (input.canDeliverAreaTickets ?? terminal.canDeliverAreaTickets)
  const inferredWorkspace = capabilityWasUpdated
    ? hasAreaTicketCapability
      ? TerminalWorkspace.AREA_OPERATIONS
      : terminal.defaultWorkspace === TerminalWorkspace.AREA_OPERATIONS
        ? TerminalWorkspace.STANDARD_POS
        : terminal.defaultWorkspace
    : undefined

  const updated = await prisma.terminal.update({
    where: { id: terminalId },
    data: {
      fulfillmentAreaId: input.fulfillmentAreaId,
      canIssueAreaTickets: input.canIssueAreaTickets,
      canCheckoutAreaTickets: input.canCheckoutAreaTickets,
      canDeliverAreaTickets: input.canDeliverAreaTickets,
      // El dashboard presenta capacidades, no una opción técnica de workspace.
      // Mantenerlos sincronizados evita que una terminal de cremería vuelva a
      // abrir Mesas/POS estándar después de configurarla correctamente.
      defaultWorkspace: (input.defaultWorkspace as TerminalWorkspace | undefined) ?? inferredWorkspace,
      scaleProfileId: input.scaleProfileId,
    },
    select: {
      id: true,
      name: true,
      fulfillmentAreaId: true,
      canIssueAreaTickets: true,
      canCheckoutAreaTickets: true,
      canDeliverAreaTickets: true,
      defaultWorkspace: true,
      scaleProfileId: true,
    },
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'AREA_TICKET_TERMINAL_UPDATED',
    entity: 'Terminal',
    entityId: updated.id,
    data: { changes: input } as unknown as Prisma.InputJsonValue,
  })
  return updated
}

export async function updateScaleSettings(venueId: string, input: UpdateScaleSettingsInput, performedBy?: string) {
  await assertVenue(venueId)
  if (input.enabled === true) await assertFeature(venueId, 'SCALE_INTEGRATION')
  if (input.variableBarcodeEnabled === true) await assertFeature(venueId, 'VARIABLE_WEIGHT_BARCODE')
  const settings = await prisma.venueScaleSettings.upsert({
    where: { venueId },
    create: { venueId, ...input },
    update: input,
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'SCALE_SETTINGS_UPDATED',
    entity: 'VenueScaleSettings',
    entityId: settings.id,
    data: { changes: input } as unknown as Prisma.InputJsonValue,
  })
  return settings
}

function scaleProfileUpdateData(input: CreateScaleProfileInput | UpdateScaleProfileInput): Prisma.ScaleProfileUncheckedUpdateInput {
  return {
    name: input.name,
    location: input.location,
    model: input.model,
    allowedContexts: input.allowedContexts as ScaleContext[] | undefined,
    transport: input.transport as ScaleTransport | undefined,
    vendorId: input.vendorId,
    productId: input.productId,
    baudRate: input.baudRate,
    dataBits: input.dataBits,
    parity: input.parity,
    stopBits: input.stopBits,
    frameParser: input.frameParser === null ? Prisma.JsonNull : (input.frameParser as Prisma.InputJsonValue | undefined),
    stableIndicator: input.stableIndicator,
    unit: input.unit as Unit | undefined,
    active: input.active,
  }
}

export async function createScaleProfile(venueId: string, input: CreateScaleProfileInput, performedBy?: string) {
  await assertVenue(venueId)
  await assertFeature(venueId, 'SCALE_INTEGRATION')
  const profile = await prisma.scaleProfile.create({
    data: {
      venueId,
      name: input.name,
      location: input.location,
      model: input.model,
      allowedContexts: input.allowedContexts as ScaleContext[],
      transport: (input.transport ?? 'MANUAL') as ScaleTransport,
      vendorId: input.vendorId,
      productId: input.productId,
      baudRate: input.baudRate,
      dataBits: input.dataBits,
      parity: input.parity,
      stopBits: input.stopBits,
      frameParser: input.frameParser === null ? Prisma.JsonNull : (input.frameParser as Prisma.InputJsonValue | undefined),
      stableIndicator: input.stableIndicator,
      unit: (input.unit ?? 'KILOGRAM') as Unit,
      active: input.active ?? true,
    },
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'SCALE_PROFILE_CREATED',
    entity: 'ScaleProfile',
    entityId: profile.id,
    data: { name: profile.name, location: profile.location, transport: profile.transport },
  })
  return profile
}

export async function updateScaleProfile(venueId: string, profileId: string, input: UpdateScaleProfileInput, performedBy?: string) {
  const previous = await prisma.scaleProfile.findFirst({ where: { id: profileId, venueId }, select: { id: true } })
  if (!previous) throw new NotFoundError('Perfil de báscula no encontrado')
  await assertFeature(venueId, 'SCALE_INTEGRATION')

  const profile = await prisma.scaleProfile.update({
    where: { id: profileId },
    data: scaleProfileUpdateData(input),
  })
  await logAction({
    staffId: performedBy ?? null,
    venueId,
    action: 'SCALE_PROFILE_UPDATED',
    entity: 'ScaleProfile',
    entityId: profile.id,
    data: { changes: input } as unknown as Prisma.InputJsonValue,
  })
  return profile
}

export async function getOperations(venueId: string) {
  await assertVenue(venueId)
  const [pendingDelivery, reconciliation, recentlyIssued] = await Promise.all([
    prisma.areaTicket.findMany({
      where: { venueId, status: AreaTicketStatus.PAID, fulfillment: null },
      orderBy: { paidAt: 'asc' },
      take: 100,
      include: {
        fulfillmentArea: { select: { id: true, name: true } },
        lines: { select: { productNameSnapshot: true, quantity: true, weightKg: true, total: true } },
        order: { select: { id: true, orderNumber: true, areaDeliveryCode: true } },
      },
    }),
    prisma.areaTicketCheckoutSession.findMany({
      where: { venueId, status: AreaTicketCheckoutStatus.RECONCILIATION_REQUIRED },
      orderBy: { updatedAt: 'asc' },
      take: 100,
      include: {
        order: { select: { id: true, orderNumber: true, paymentStatus: true, total: true } },
        paymentAttempts: { orderBy: { sequence: 'desc' }, take: 1 },
      },
    }),
    prisma.areaTicket.findMany({
      where: { venueId },
      orderBy: { issuedAt: 'desc' },
      take: 50,
      include: {
        fulfillmentArea: { select: { id: true, name: true } },
        sourceTerminal: { select: { id: true, name: true } },
      },
    }),
  ])
  return { pendingDelivery, reconciliation, recentlyIssued }
}

// ----------------------------------------------------------------------------
// Colas de sólo lectura de la ruta EXTERNAL (§caja externa fase 1, Task 15) — qué
// cobros nadie confirmó y qué incidencias quedaron abiertas. Ninguna de las dos
// funciones de abajo confirma, resuelve ni reabre nada; eso vive en
// `areaTicketExternal.mobile.service.ts` (piso) y en el job de conciliación
// (Task 12). Sin estas dos pantallas el trabajo que ese job abre nadie lo ve.
// ----------------------------------------------------------------------------

const EXTERNAL_QUEUE_DEFAULT_PAGE_SIZE = 25
const EXTERNAL_QUEUE_MAX_PAGE_SIZE = 100

/**
 * Cursor estable (fecha, id), en el MISMO formato que
 * `encodePendingCursor`/`decodePendingCursor` (`areaTicketV7.mobile.service.ts`), pero
 * copiado localmente a propósito: esas dos son del dominio MOBILE (una terminal, un
 * área) y estas dos son de dashboard (oficina, venue completo) — cruzar esa frontera
 * de capas por dos funciones de cuatro líneas no vale la acoplada.
 */
function encodeQueueCursor(row: { sortAt: Date; id: string }): string {
  return Buffer.from(`${row.sortAt.toISOString()}|${row.id}`).toString('base64url')
}

function decodeQueueCursor(cursor?: string | null): { sortAt: Date; id: string } | null {
  if (!cursor) return null
  try {
    const [date, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|')
    const sortAt = new Date(date)
    if (!id || Number.isNaN(sortAt.getTime())) throw new Error('invalid')
    return { sortAt, id }
  } catch {
    throw new BadRequestError('El cursor de la lista no es válido.')
  }
}

async function assertVenueTimezone(venueId: string): Promise<string> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { timezone: true } })
  if (!venue) throw new NotFoundError('Venue no encontrado')
  // `Venue.timezone` es NOT NULL con default en el schema — el `||` es
  // cinturón-y-tirantes (mismo patrón defensivo que el job de conciliación,
  // Task 12), no una rama alcanzable hoy.
  return venue.timezone || DEFAULT_TIMEZONE
}

/**
 * Filtro de fecha venue-local, opcional en ambos extremos. A propósito NO usa
 * `parseDbDateRange` (que rellena un default de N días cuando no mandan fecha): estas
 * son colas de trabajo pendiente, no un reporte por periodo — un cobro sin confirmar
 * de hace tres semanas debe seguir apareciendo si nadie filtra por fecha. Mismo
 * blindaje de timezone que el resto del repo: `fromZonedTime` sobre un STRING, nunca
 * `new Date('YYYY-MM-DD')` (`.claude/rules/critical-warnings.md`).
 */
function dateRangeFilter(
  dateFrom: string | undefined,
  dateTo: string | undefined,
  timezone: string,
): { gte?: Date; lte?: Date } | undefined {
  if (!dateFrom && !dateTo) return undefined
  const range: { gte?: Date; lte?: Date } = {}
  if (dateFrom) range.gte = fromZonedTime(`${dateFrom}T00:00:00.000`, timezone)
  if (dateTo) range.lte = fromZonedTime(`${dateTo}T23:59:59.999`, timezone)
  return range
}

const staffFullName = (staff: { firstName: string; lastName: string } | null): string | null =>
  staff ? `${staff.firstName} ${staff.lastName}`.trim() : null

/**
 * Cola "Cobros por confirmar". Área/estado/fecha son filtros independientes y
 * opcionales — sin `status`, trae TODOS los estados (incluyendo CONFIRMED/
 * NOT_CHARGED, útil como historial); el default "sólo lo pendiente" lo pide el
 * dashboard mandando `status=PENDING`, no esta función. Paginada por cursor estable
 * (createdAt, id) sobre el mismo índice `@@index([venueId, status, createdAt])` que
 * ya trae el modelo.
 *
 * 🔴 Sólo vales VIVOS (`areaTicket.status === ISSUED`), igual que las otras tres
 * superficies del mismo dominio: `listPendingExternalConfirmation`
 * (`areaTicketExternal.mobile.service.ts`), el tool `pending_external_confirmations`
 * del MCP y el job de conciliación (`areaTicketExternalReconciliation.job.ts`, que
 * explica el porqué en su propio comentario). Sin este filtro, un vale cancelado con
 * el settlement en PENDING quedaba como fila PERMANENTE de esta pantalla: nadie puede
 * resolverla — la pantalla es de sólo lectura y las dos mutaciones del piso
 * (`confirmExternalSettlement`, `markExternalNotCharged`) rechazan con
 * `AREA_TICKET_NOT_ISSUED`.
 *
 * `ISSUED` (igualdad) NO recorta el historial: en la ruta EXTERNAL el vale nunca
 * transiciona de estado — el CHECK `area_ticket_external_no_avoqado_circuit` (Task 2)
 * sólo admite ISSUED/CANCELLED/EXPIRED, y `fulfillAreaTicket` deja explícitamente el
 * vale en ISSUED al entregar (la entrega se lee de la EXISTENCIA del
 * `AreaTicketFulfillment`, no de un estado). O sea que aquí `ISSUED` es exactamente "no
 * está muerto", y un cobro ya confirmado y entregado sigue viéndose en el historial.
 *
 * ⚠️ Esto es la DEFENSA, no la causa raíz: `cancelAreaTicket` todavía no cierra el
 * settlement al cancelar un vale externo, así que la fila sigue diciendo PENDING en la
 * base — sólo deja de contaminar esta cola. Cerrarla de verdad necesita un estado nuevo
 * que se distinga de NOT_CHARGED ("una persona afirmó que la otra caja no cobró", que
 * es un hecho operativo distinto); está levantado en el reporte de cierre de fase.
 */
export async function listExternalSettlements(venueId: string, filters: ListExternalSettlementsQuery) {
  const timezone = await assertVenueTimezone(venueId)
  const cursor = decodeQueueCursor(filters.cursor)
  const take = Math.max(1, Math.min(filters.pageSize ?? EXTERNAL_QUEUE_DEFAULT_PAGE_SIZE, EXTERNAL_QUEUE_MAX_PAGE_SIZE))
  const createdAtRange = dateRangeFilter(filters.dateFrom, filters.dateTo, timezone)

  const rows = await prisma.areaTicketExternalSettlement.findMany({
    where: {
      venueId,
      ...(filters.status ? { status: filters.status as AreaTicketExternalSettlementStatus } : {}),
      // 🔴 UNA sola clave `areaTicket`: el filtro de vale vivo y el de área viajan
      // juntos a propósito. Dos claves `areaTicket` en el mismo objeto literal se
      // pisarían EN SILENCIO (gana la última) — es el mismo bug que la revisión de la
      // Task 10 atrapó con dos `OR` en `listPendingAreaTicketFulfillment`, y aquí
      // habría borrado justo el filtro que arregla esta cola.
      areaTicket: {
        status: AreaTicketStatus.ISSUED,
        ...(filters.areaId ? { fulfillmentAreaId: filters.areaId } : {}),
      },
      ...(createdAtRange ? { createdAt: createdAtRange } : {}),
      ...(cursor ? { OR: [{ createdAt: { gt: cursor.sortAt } }, { createdAt: cursor.sortAt, id: { gt: cursor.id } }] } : {}),
    },
    select: {
      id: true,
      status: true,
      handoffState: true,
      confirmationMode: true,
      referenceAmount: true,
      externalAmount: true,
      externalReference: true,
      notes: true,
      createdAt: true,
      confirmedAt: true,
      confirmedByStaff: { select: { firstName: true, lastName: true } },
      terminal: { select: { id: true, name: true } },
      areaTicket: { select: { id: true, code: true, issuedAt: true, fulfillmentArea: { select: { id: true, name: true } } } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: take + 1,
  })

  const hasMore = rows.length > take
  const page = hasMore ? rows.slice(0, take) : rows

  return {
    items: page.map(row => {
      const reference = new Prisma.Decimal(row.referenceAmount)
      const external = row.externalAmount === null ? null : new Prisma.Decimal(row.externalAmount)
      return {
        id: row.id,
        status: row.status,
        handoffState: row.handoffState,
        confirmationMode: row.confirmationMode,
        // Pesos 1:1, nunca centavos. `variance` se DERIVA aquí (externalAmount menos
        // referenceAmount) — no existe como columna (ver el comentario del modelo en
        // schema.prisma) — con el MISMO signo y redondeo que `confirmExternalSettlement`
        // ya expone al confirmar, para que la oficina y quien confirmó en el piso
        // nunca vean números distintos del mismo vale.
        referenceAmount: reference.toFixed(2),
        externalAmount: external === null ? null : external.toFixed(2),
        variance: external === null ? null : external.sub(reference).toFixed(2),
        externalReference: row.externalReference,
        notes: row.notes,
        createdAt: row.createdAt,
        confirmedAt: row.confirmedAt,
        confirmedBy: staffFullName(row.confirmedByStaff),
        terminal: row.terminal,
        areaTicket: { id: row.areaTicket.id, code: row.areaTicket.code, issuedAt: row.areaTicket.issuedAt },
        area: row.areaTicket.fulfillmentArea,
      }
    }),
    nextCursor: hasMore ? encodeQueueCursor({ sortAt: page[page.length - 1].createdAt, id: page[page.length - 1].id }) : null,
  }
}

/**
 * Cola "Incidencias". Misma regla que arriba: sin `status`, trae TODAS (abiertas y
 * cerradas); el default "sólo lo abierto" lo pide el dashboard mandando
 * `status=OPEN`. Cursor estable (openedAt, id) sobre el mismo índice
 * `@@index([venueId, status, kind, openedAt])` que ya trae el modelo.
 */
export async function listExternalIncidents(venueId: string, filters: ListExternalIncidentsQuery) {
  const timezone = await assertVenueTimezone(venueId)
  const cursor = decodeQueueCursor(filters.cursor)
  const take = Math.max(1, Math.min(filters.pageSize ?? EXTERNAL_QUEUE_DEFAULT_PAGE_SIZE, EXTERNAL_QUEUE_MAX_PAGE_SIZE))
  const openedAtRange = dateRangeFilter(filters.dateFrom, filters.dateTo, timezone)

  const rows = await prisma.areaTicketExternalIncident.findMany({
    where: {
      venueId,
      ...(filters.kind ? { kind: filters.kind as AreaTicketExternalIncidentKind } : {}),
      ...(filters.status ? { status: filters.status as AreaTicketExternalIncidentStatus } : {}),
      ...(filters.areaId ? { areaTicket: { fulfillmentAreaId: filters.areaId } } : {}),
      ...(openedAtRange ? { openedAt: openedAtRange } : {}),
      ...(cursor ? { OR: [{ openedAt: { gt: cursor.sortAt } }, { openedAt: cursor.sortAt, id: { gt: cursor.id } }] } : {}),
    },
    select: {
      id: true,
      kind: true,
      status: true,
      detail: true,
      openedAt: true,
      occurrenceCount: true,
      reopenedAt: true,
      resolvedAt: true,
      resolution: true,
      resolvedByStaff: { select: { firstName: true, lastName: true } },
      areaTicket: { select: { id: true, code: true, fulfillmentArea: { select: { id: true, name: true } } } },
    },
    orderBy: [{ openedAt: 'asc' }, { id: 'asc' }],
    take: take + 1,
  })

  const hasMore = rows.length > take
  const page = hasMore ? rows.slice(0, take) : rows

  return {
    items: page.map(row => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      // Ya viene en pesos, formateada por quien la abrió (confirmar/declarar-no-cobrado
      // en el piso, o el job de conciliación) — se reenvía tal cual, sin recalcularla.
      detail: row.detail,
      openedAt: row.openedAt,
      occurrenceCount: row.occurrenceCount,
      reopenedAt: row.reopenedAt,
      resolvedAt: row.resolvedAt,
      resolution: row.resolution,
      resolvedBy: staffFullName(row.resolvedByStaff),
      areaTicket: row.areaTicket ? { id: row.areaTicket.id, code: row.areaTicket.code } : null,
      area: row.areaTicket?.fulfillmentArea ?? null,
    })),
    nextCursor: hasMore ? encodeQueueCursor({ sortAt: page[page.length - 1].openedAt, id: page[page.length - 1].id }) : null,
  }
}
