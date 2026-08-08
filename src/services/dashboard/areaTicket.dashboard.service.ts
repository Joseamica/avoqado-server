import {
  AreaTicketCheckoutStatus,
  AreaTicketStatus,
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
  UpdateAreaTicketSettingsInput,
  UpdateAreaTicketTerminalInput,
  UpdateFulfillmentAreaInput,
  UpdateScaleProfileInput,
  UpdateScaleSettingsInput,
} from '../../schemas/dashboard/areaTicket.schema'
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
