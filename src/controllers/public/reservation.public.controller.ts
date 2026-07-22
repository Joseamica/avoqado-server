import { Request, Response, NextFunction } from 'express'
import * as reservationService from '../../services/dashboard/reservation.dashboard.service'
import * as availabilityService from '../../services/dashboard/reservationAvailability.service'
import { countAppointmentOccupancy, effectiveAppointmentPacing } from '../../services/dashboard/reservationAvailability.service'
import { getReservationSettings, isStaffAware, type OperatingHours } from '../../services/dashboard/reservationSettings.service'
import { mergeReservationBranding } from '../../services/dashboard/reservationBranding.service'
import { checkExternalBusyBlock } from '../../services/reservation/external-busy-block.service'
import { BadRequestError, ConflictError, NotFoundError, UnauthorizedError } from '../../errors/AppError'
import { verifyCustomerToken } from '../../jwt.service'
import prisma from '../../utils/prismaClient'
import logger from '../../config/logger'
import { CreditPurchaseStatus, ReservationStatus } from '@prisma/client'
import { Prisma } from '@prisma/client'
import { calculateApplicationFeeWithVAT, toStripeAmount } from '../../services/payments/providers/money'
import { getVatRateBps } from '../../services/superadmin/platformSettings.service'
import { getProvider } from '../../services/payments/provider-registry'
import {
  resolveChargeableStripeMerchant as resolveActiveStripeMerchant,
  canVenueChargeOnline,
} from '../../services/payments/ecommerceCapability'
import { formatInTimeZone, toZonedTime } from 'date-fns-tz'
import { es as esLocale } from 'date-fns/locale'
import emailService from '../../services/email.service'
import { sendReservationConfirmationWhatsApp, formatModifiersForWhatsApp } from '../../services/whatsapp.service'
import { enqueuePush, resolveClassSessionPushTargets } from '../../services/google-calendar/outbox.service'
import { phonesMatch, phoneLast10 } from '../../utils/phone'
import { withSerializableRetry } from '@/utils/serializableRetry'
import { normalizeBookedProductIds, reservationBookedProductIds } from '@/services/reservation/resolveAppointmentWindow'
import { fastFailLiveHold, mintNormalAppointmentHold, SLOT_HOLD_TTL_MS } from '@/services/reservation/appointmentSlotHold.service'

// ==========================================
// PUBLIC RESERVATION CONTROLLER (Unauthenticated)
// For booking widget + public booking page
// ==========================================

/**
 * Whitelist of upfrontPolicy values stored on Product / ReservationSettings.
 * Anything else (legacy NULLs, typos) collapses to 'inherit' so the resolver
 * always falls back to the venue-wide type default.
 */
const UPFRONT_POLICY_VALUES = ['inherit', 'required', 'at_venue', 'optional'] as const
type UpfrontPolicy = Exclude<(typeof UPFRONT_POLICY_VALUES)[number], 'inherit'>

/**
 * Whether a class session's [startsAt, endsAt) interval lies entirely within
 * one of the operating-hours ranges for that day of week. Used by the public
 * class listing to hide sessions an admin created outside of the venue's
 * operating hours (e.g. a 6am Pilates when operatingHours starts at 9am).
 *
 * If the venue's operating hours are mis-configured we err on the side of
 * showing the session — better to expose it than silently hide.
 */
function classSessionFitsOperatingHours(startsAt: Date, endsAt: Date, operatingHours: OperatingHours, timezone: string): boolean {
  const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
  // Convert both endpoints to venue-local wall-clock to compare against the
  // operatingHours config (which is stored as HH:MM strings in venue tz).
  const startLocal = toZonedTime(startsAt, timezone)
  const endLocal = toZonedTime(endsAt, timezone)
  const dayKey = DAY_KEYS[startLocal.getDay()]
  const day = operatingHours[dayKey]
  if (!day || !day.enabled || day.ranges.length === 0) return false
  // HH:MM helpers
  const toMinutes = (d: Date) => d.getHours() * 60 + d.getMinutes()
  const parseHHMM = (s: string) => {
    const [h, m] = s.split(':').map(Number)
    return (Number.isFinite(h) ? h : 0) * 60 + (Number.isFinite(m) ? m : 0)
  }
  const startMin = toMinutes(startLocal)
  // Session that crosses midnight: pin endMin to 24h so we only match against
  // ranges that span past midnight — there are none in the current schema,
  // so a midnight-crossing session is implicitly hidden.
  const endMin = startLocal.toDateString() === endLocal.toDateString() ? toMinutes(endLocal) : 24 * 60
  for (const r of day.ranges) {
    const open = parseHHMM(r.open)
    const close = parseHHMM(r.close)
    if (startMin >= open && endMin <= close) return true
  }
  return false
}

/**
 * Resolve the effective upfront-payment policy for a product.
 *
 * Per-product override always wins (if not 'inherit'). Otherwise we use the
 * venue-wide type default — Square's pattern: classes default to 'required',
 * appointments to 'at_venue'. The legacy `depositMode` field stays untouched
 * for the deposit calculator; this resolver is only for the new public
 * booking UI's payment-method picker.
 */
export function resolveUpfrontPolicy(
  product: { type?: string | null; upfrontPolicy?: string | null },
  settings: { appointmentUpfrontDefault?: string | null; classUpfrontDefault?: string | null },
): UpfrontPolicy {
  const productPolicy = product.upfrontPolicy
  if (productPolicy && productPolicy !== 'inherit' && (UPFRONT_POLICY_VALUES as readonly string[]).includes(productPolicy)) {
    return productPolicy as UpfrontPolicy
  }
  const isClass = product.type === 'CLASS'
  const fallback = isClass ? settings.classUpfrontDefault : settings.appointmentUpfrontDefault
  if (fallback && (UPFRONT_POLICY_VALUES as readonly string[]).includes(fallback) && fallback !== 'inherit') {
    return fallback as UpfrontPolicy
  }
  // Hard fallback so the resolver never returns 'inherit' to consumers.
  return isClass ? 'required' : 'at_venue'
}

/**
 * Opportunistically extract an authenticated customer from a Bearer token on
 * the public booking endpoint. Returns null when no token is present or the
 * token is invalid/expired — the caller decides whether anonymous is allowed
 * (e.g. `settings.publicBooking.requireAccount`).
 */
function tryReadAuthenticatedCustomer(req: Request): { customerId: string; venueId: string } | null {
  const authHeader = req.headers.authorization
  if (!authHeader?.startsWith('Bearer ')) return null
  try {
    const payload = verifyCustomerToken(authHeader.slice(7))
    return { customerId: payload.sub, venueId: payload.venueId }
  } catch {
    return null
  }
}

async function resolveVenueBySlug(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: { slug: venueSlug, active: true },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      type: true,
      timezone: true,
    },
  })
  if (!venue) throw new NotFoundError('Negocio no encontrado')
  return venue
}

// `resolveActiveStripeMerchant` (aliased) + `canVenueChargeOnline` are imported from
// @/services/payments/ecommerceCapability so reservations, credit packs, the public
// venue-info endpoint and the dashboard all share one "can this venue charge?" rule.

async function previewDepositRequirement(venueId: string, body: any, settings: any) {
  if (!settings.deposits?.enabled || settings.deposits.mode === 'none') {
    return { required: false, amount: null as any }
  }

  if (settings.deposits.mode === 'card_hold') {
    throw new BadRequestError('El modo card_hold aun no esta soportado para reservas publicas')
  }

  let servicePrice: number | null = null
  if (body.productId) {
    const product = await prisma.product.findFirst({
      where: { id: body.productId, venueId, active: true },
      select: { price: true },
    })
    servicePrice = product?.price ? Number(product.price) : null
  }

  return reservationService.calculateDepositAmount(settings.deposits, body.partySize ?? 1, servicePrice)
}

function getStripeChargeBounds() {
  return {
    min: Number(process.env.STRIPE_MIN_CHARGE_MXN_CENTS ?? 1000),
    max: Number(process.env.STRIPE_MAX_CHARGE_MXN_CENTS ?? 5000000),
  }
}

/**
 * GET /public/venues/:venueSlug/info
 *
 * Each product returned includes:
 * - `creditCost` (Phase 3) — null = follow legacy 1-credit-per-seat behavior;
 *                            number = explicit credits-per-seat for this product.
 * - `upfrontPolicy` (Phase 3) — RESOLVED policy ('required' | 'at_venue' | 'optional')
 *                                that the widget uses to decide whether to show a card
 *                                form before submitting the reservation. Already merged
 *                                with venue defaults via resolveUpfrontPolicy() so the
 *                                widget never has to reimplement the precedence logic.
 */
export async function getVenueInfo(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    // Hoist settings up so we can both (a) gate public access and (b) feed
    // them into the response below — avoids a second query.
    const settings = await getReservationSettings(venue.id)

    // Hard gate — when the venue admin disabled public booking, refuse to
    // expose the catalog so the host page doesn't render a working storefront
    // that would just bounce the customer at checkout. Mirrors the gates in
    // getAvailability/createReservation/createHold.
    if (settings.publicBooking?.enabled === false) {
      throw new BadRequestError('Las reservaciones en línea están deshabilitadas para este establecimiento.')
    }

    // Get public-safe venue info
    const venueInfo = await prisma.venue.findUnique({
      where: { id: venue.id },
      select: {
        name: true,
        slug: true,
        logo: true,
        logoFull: true, // Wide / horizontal full logo for marketing surfaces (booking page header)
        heroImageUrl: true, // Phase 7: hero photo for the public booking page
        primaryColor: true, // Phase 7: brand accent the widget consumes as --avq-accent
        reservationBranding: true, // Reservation branding overrides (merged + resolved below)
        type: true,
        address: true,
        phone: true,
        // Venue-chat mode — drives whether the booking surfaces expose a
        // "message us" affordance. RELAY = in-widget chat works; WA_ME_FALLBACK
        // = only usable if a phone exists (deep-links to wa.me); DISABLED = off.
        // The widget + host page compute `chat.canMessage` from this below.
        whatsappContactMode: true,
        products: {
          where: { active: true, type: { in: ['APPOINTMENTS_SERVICE', 'EVENT', 'CLASS'] } },
          select: {
            id: true,
            name: true,
            description: true, // Phase 7: surface short description on cards
            imageUrl: true, // Phase 7: product thumbnail
            price: true,
            duration: true,
            eventCapacity: true,
            type: true,
            maxParticipants: true,
            layoutConfig: true,
            requireCreditForBooking: true,
            // New Phase 3 fields — null/inherit by default for existing products.
            creditCost: true,
            upfrontPolicy: true,
            // Category — surfaced so the booking widget can group services + render
            // category chips/headers (Booksy/Vagaro/Fresha pattern). Inactive
            // categories are filtered server-side via the where below.
            category: {
              select: { id: true, name: true, slug: true, displayOrder: true },
            },
            // Modifier groups assigned to this product (booking widget surface).
            // Mirrors Vagaro's add-on model — see venue.consumer.service.ts for the
            // sibling shape used by the dashboard consumer namespace.
            modifierGroups: {
              select: {
                displayOrder: true,
                group: {
                  select: {
                    id: true,
                    name: true,
                    description: true,
                    required: true,
                    allowMultiple: true,
                    minSelections: true,
                    maxSelections: true,
                    active: true,
                    modifiers: {
                      where: { active: true },
                      select: { id: true, name: true, price: true, durationMin: true, active: true },
                      orderBy: { name: 'asc' },
                    },
                  },
                },
              },
              orderBy: { displayOrder: 'asc' },
            },
          },
          orderBy: { name: 'asc' },
        },
      },
    })

    // Resolve upfrontPolicy per product server-side so the widget gets a
    // ready-to-use string and doesn't reimplement the precedence rules.
    const products = (venueInfo?.products ?? []).map(p => ({
      ...p,
      upfrontPolicy: resolveUpfrontPolicy(
        { type: p.type, upfrontPolicy: p.upfrontPolicy },
        {
          appointmentUpfrontDefault: settings.payments.appointmentUpfrontDefault,
          classUpfrontDefault: settings.payments.classUpfrontDefault,
        },
      ),
      modifierGroups: p.modifierGroups
        .filter(pg => pg.group.active)
        .map(pg => ({
          id: pg.group.id,
          name: pg.group.name,
          description: pg.group.description,
          required: pg.group.required,
          allowMultiple: pg.group.allowMultiple,
          minSelections: pg.group.minSelections,
          maxSelections: pg.group.maxSelections,
          displayOrder: pg.displayOrder,
          modifiers: pg.group.modifiers.map(m => ({
            id: m.id,
            name: m.name,
            price: Number(m.price),
            durationMin: m.durationMin,
            active: m.active,
          })),
        })),
    }))

    // Strip the raw reservationBranding out of the spread and expose the merged
    // `branding` (accentColor resolved from primaryColor) the widget consumes.
    const { reservationBranding, whatsappContactMode, ...venueInfoRest } = (venueInfo ?? {}) as NonNullable<typeof venueInfo> & {
      reservationBranding?: unknown
    }

    // Resolve a single `canMessage` the booking surfaces can trust: in-widget
    // chat works in RELAY mode regardless of phone; WA_ME_FALLBACK only works
    // when a phone exists to deep-link into (wa.me); DISABLED is always off.
    // Computing it here keeps the policy in one place — the widget's shadow-DOM
    // FAB and the host page's "message us" pill both read chat.canMessage rather
    // than each re-deriving the rule and risking a silent mismatch.
    const chatMode = whatsappContactMode ?? 'WA_ME_FALLBACK'
    const canMessage = chatMode === 'RELAY' || (chatMode === 'WA_ME_FALLBACK' && !!venueInfoRest.phone)

    // Can this venue actually collect money online? Drives whether the widget
    // offers reservation pre-payment and shows credit packs at all. When false,
    // the widget hides those money surfaces (free booking still works) so the
    // customer never sees a "pay"/"buy" button that would just dead-end at
    // checkout. Single source of truth: canVenueChargeOnline (Stripe Connect today).
    const canCharge = await canVenueChargeOnline(venue.id)
    res.json({
      ...venueInfoRest,
      branding: mergeReservationBranding(reservationBranding, venueInfoRest.primaryColor),
      products,
      timezone: venue.timezone || 'America/Mexico_City',
      publicBooking: settings.publicBooking,
      // Venue-chat availability. `canMessage` is the single gate the booking
      // surfaces use to decide whether to render a "message us" affordance, so
      // a dead-end (no relay + no phone) never shows the customer a button that
      // only fails after they fill out the form. `mode` is exposed for clients
      // that want to branch (e.g. skip the doomed relay POST for wa.me venues).
      chat: { mode: chatMode, canMessage },
      operatingHours: settings.operatingHours,
      payments: settings.payments,
      // Whether the venue can collect money online (has a chargeable e-commerce
      // rail). Widget gate for the pre-pay step + credit-pack storefront.
      canCharge,
      // Scheduling window — exposed so the date picker caps exactly at the
      // venue's booking horizon instead of a hardcoded default. The server
      // already enforces these (enforceBookingWindow); exposing them keeps the
      // UI from offering dates the server rejects (or hiding valid ones).
      scheduling: {
        maxAdvanceDays: settings.scheduling.maxAdvanceDays,
        minNoticeMin: settings.scheduling.minNoticeMin,
        autoConfirm: settings.scheduling.autoConfirm,
      },
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/availability
 *
 * Query params (single-day mode — legacy):
 * - date         YYYY-MM-DD in venue timezone (required if no dateFrom)
 * - productId    optional: scope to one product
 * - duration     optional: override slot duration in minutes
 * - partySize    optional: party-size-aware filtering
 * - type         optional: 'class' | 'appointment'
 *
 * Query params (range mode — used by /clases date-first listing):
 * - dateFrom     YYYY-MM-DD inclusive
 * - dateTo       YYYY-MM-DD inclusive (capped to dateFrom + 60d)
 * - type         must be 'class' (range mode only supports class sessions today)
 *
 * Range-mode response: `{ dateFrom, dateTo, slots: [...] }` flat sorted by startsAt.
 * Each slot includes `productId` + `productName` so the listing UI can label cards.
 */
export async function getAvailability(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)
    const { date, dateFrom, dateTo, duration, partySize, staffId, productId, productIds, includeFull, windowSemantics, type } =
      req.query as any

    const settings = await getReservationSettings(venue.id)
    // Hard gate: when the venue admin has flipped public booking off in
    // settings, the availability endpoint returns nothing. We don't want to
    // leak the schedule (or worse, allow holds/reservations) when the venue
    // intentionally went private. This mirrors createReservation below.
    if (settings.publicBooking?.enabled === false) {
      throw new BadRequestError('Las reservaciones en línea están deshabilitadas para este establecimiento.')
    }
    const tz = venue.timezone || 'America/Mexico_City'

    // Whitelist the type filter so junk values don't trigger arbitrary code paths.
    const flowType: 'class' | 'appointment' | null = type === 'class' || type === 'appointment' ? type : null

    // ── Range mode (Phase 2 stretch — date-first class listing) ────────────
    // Activated when caller passes dateFrom (and implicitly dateTo). Restricted
    // to type=class so we don't accidentally fan out the operating-hours
    // computation across 60 days, which would be expensive and almost never
    // useful (appointments are picked one date at a time).
    if (dateFrom) {
      if (flowType !== 'class') {
        throw new BadRequestError('Range mode requires type=class')
      }
      // YYYY-MM-DD validation — strict to keep the SQL query bounded.
      const dateRe = /^\d{4}-\d{2}-\d{2}$/
      if (!dateRe.test(dateFrom)) {
        throw new BadRequestError('dateFrom must be YYYY-MM-DD')
      }
      const fromDate = new Date(`${dateFrom}T00:00:00Z`)
      if (Number.isNaN(fromDate.getTime())) {
        throw new BadRequestError('dateFrom is not a valid date')
      }
      // Default to +30 days when dateTo missing; cap at +60 days to avoid abuse.
      let toDate: Date
      if (dateTo) {
        if (!dateRe.test(dateTo)) {
          throw new BadRequestError('dateTo must be YYYY-MM-DD')
        }
        toDate = new Date(`${dateTo}T00:00:00Z`)
        if (Number.isNaN(toDate.getTime())) {
          throw new BadRequestError('dateTo is not a valid date')
        }
      } else {
        toDate = new Date(fromDate)
        toDate.setUTCDate(toDate.getUTCDate() + 30)
      }
      const maxTo = new Date(fromDate)
      maxTo.setUTCDate(maxTo.getUTCDate() + 60)
      if (toDate.getTime() > maxTo.getTime()) toDate = maxTo
      if (toDate.getTime() < fromDate.getTime()) {
        throw new BadRequestError('dateTo must be on or after dateFrom')
      }

      const onlinePercent = settings.scheduling?.onlineCapacityPercent ?? 100
      // Skip sessions that are too close to start to satisfy the venue's
      // minimum-notice policy. The customer can't book them anyway —
      // createReservation throws ValidationError once they try — so hiding
      // them here avoids a confusing "requiere X minutos de anticipacion"
      // toast after they've already picked a class.
      const minNoticeMin = settings.scheduling?.minNoticeMin ?? 0
      const earliestStart = minNoticeMin > 0 ? new Date(Date.now() + minNoticeMin * 60 * 1000) : null

      // Mirror the booking-window's other half: cap the window at
      // now + maxAdvanceDays so we don't surface classes the venue would
      // refuse to book "con tanta anticipacion".
      const maxAdvanceDays = settings.scheduling?.maxAdvanceDays ?? 0
      const latestStart = maxAdvanceDays > 0 ? new Date(Date.now() + maxAdvanceDays * 24 * 60 * 60 * 1000) : null
      const requestedEnd = new Date(`${toDate.toISOString().slice(0, 10)}T23:59:59.999`)
      const effectiveEnd = latestStart && latestStart < requestedEnd ? latestStart : requestedEnd

      // Single Prisma query across the whole window — no per-product fan-out.
      // We then enrich with the same enrolled/capacity computation used by
      // getClassSessionSlots() so response shape stays consistent.
      const sessionsRaw = await prisma.classSession.findMany({
        where: {
          venueId: venue.id,
          status: 'SCHEDULED',
          ...(productId ? { productId } : { product: { type: 'CLASS', active: true } }),
          startsAt: {
            gte: earliestStart && earliestStart > new Date(`${dateFrom}T00:00:00`) ? earliestStart : new Date(`${dateFrom}T00:00:00`),
            lte: effectiveEnd,
          },
        },
        include: {
          product: { select: { id: true, name: true, imageUrl: true } },
          assignedStaff: { select: { firstName: true, lastName: true, photoUrl: true } },
          reservations: {
            where: { status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] } },
            select: { partySize: true, spotIds: true },
          },
        },
        orderBy: { startsAt: 'asc' },
      })

      // Hide sessions that fall outside the venue's CONFIGURED operating
      // hours. The normalizer falls back to a default schedule (09-22 Mon-Sat,
      // Sun closed) when the venue admin never touched operatingHours — we
      // don't want to apply that default silently here, because then a venue
      // that scheduled 6am Yoga without restricting hours would see those
      // sessions vanish from the public listing for no obvious reason.
      // Query the raw column to detect "user opted in to hours" vs "default".
      const rawSettings = await prisma.reservationSettings.findUnique({
        where: { venueId: venue.id },
        select: { operatingHours: true },
      })
      const operatingHoursConfigured = rawSettings?.operatingHours != null
      const operatingHours = settings.operatingHours ?? null
      const sessionsInHours =
        operatingHoursConfigured && operatingHours
          ? sessionsRaw.filter(s => classSessionFitsOperatingHours(s.startsAt, s.endsAt, operatingHours, tz))
          : sessionsRaw

      const slots = sessionsInHours.map(session => {
        const enrolled = session.reservations.reduce((sum, r) => sum + r.partySize, 0)
        const effectiveCapacity = Math.floor((session.capacity * onlinePercent) / 100)
        const remaining = Math.max(0, effectiveCapacity - enrolled)
        const takenSpotIds: string[] = []
        for (const r of session.reservations) {
          if (r.spotIds && r.spotIds.length > 0) takenSpotIds.push(...r.spotIds)
        }
        return {
          startsAt: session.startsAt,
          endsAt: session.endsAt,
          available: remaining > 0,
          classSessionId: session.id,
          capacity: effectiveCapacity,
          enrolled,
          remaining,
          takenSpotIds,
          instructor: session.assignedStaff ?? null,
          productId: session.product.id,
          productName: session.product.name,
          productImageUrl: session.product.imageUrl ?? null,
        }
      })

      return res.json({
        dateFrom,
        dateTo: toDate.toISOString().slice(0, 10),
        slots,
      })
    }

    // ── Single-day mode (legacy + per-product flow) ────────────────────────
    // Validate product identity before any single-day catalog or availability
    // read, then use the same canonical lead throughout every branch.
    const canonicalProducts = normalizeBookedProductIds({ productId, productIds })
    const leadProductId = canonicalProducts.leadProductId

    // Branch 1: product-scoped CLASS availability (existing behavior preserved).
    if (leadProductId) {
      const product = await prisma.product.findFirst({
        where: { id: leadProductId, venueId: venue.id, active: true },
        select: { type: true },
      })

      if (product?.type === 'CLASS') {
        const onlinePercent = settings.scheduling?.onlineCapacityPercent ?? 100
        const classSlots = await availabilityService.getClassSessionSlots(venue.id, leadProductId, date!, onlinePercent, tz)
        return res.json({
          date,
          slots: classSlots.map(s => ({
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            available: s.available,
            classSessionId: s.classSessionId,
            capacity: s.capacity,
            enrolled: s.enrolled,
            remaining: s.remaining,
            takenSpotIds: s.takenSpotIds ?? [],
            instructor: s.instructor ?? null,
          })),
        })
      }
    }

    // Branch 2: type=class without productId — aggregate sessions across all
    // CLASS products of the venue for a SINGLE date.
    if (flowType === 'class' && !leadProductId) {
      const onlinePercent = settings.scheduling?.onlineCapacityPercent ?? 100
      const classProducts = await prisma.product.findMany({
        where: { venueId: venue.id, active: true, type: 'CLASS' },
        select: { id: true, name: true },
      })
      const perProduct = await Promise.all(
        classProducts.map(async p => {
          const slots = await availabilityService.getClassSessionSlots(venue.id, p.id, date!, onlinePercent, tz)
          return slots.map(s => ({
            startsAt: s.startsAt,
            endsAt: s.endsAt,
            available: s.available,
            classSessionId: s.classSessionId,
            capacity: s.capacity,
            enrolled: s.enrolled,
            remaining: s.remaining,
            takenSpotIds: s.takenSpotIds ?? [],
            instructor: s.instructor ?? null,
            productId: p.id,
            productName: p.name,
          }))
        }),
      )
      const merged = perProduct.flat().sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime())
      return res.json({ date, slots: merged })
    }

    // Branch 3 (default): operating-hours availability for appointments / services.
    const slots = await availabilityService.getAvailableSlots(
      venue.id,
      date!,
      {
        duration: duration !== undefined ? Number(duration) : undefined,
        partySize: partySize !== undefined ? Number(partySize) : undefined,
        staffId,
        productId: canonicalProducts.leadProductId,
        productIds: canonicalProducts.productIds,
        includeFull,
        windowSemantics,
      },
      settings,
      tz,
    )

    res.json({
      date,
      slots: slots.map(s => ({
        startsAt: s.startsAt,
        endsAt: s.endsAt,
        ...(s.available === false ? { available: false as const, reason: s.reason } : { available: true as const }),
      })),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/reservations
 */
export async function createReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    const settings = await getReservationSettings(venue.id)

    // Check public booking is enabled
    if (!settings.publicBooking.enabled) {
      throw new BadRequestError('Las reservaciones en linea no estan habilitadas')
    }

    // Always bind a valid Bearer JWT to the booking, independent of
    // `requireAccount`. When the customer is logged in, their bookings need
    // to surface in "Mis Reservaciones" and anchor any credit redemption to
    // the same identity — even at venues that allow anonymous guest bookings.
    // We trust the JWT (signed server-side) but verify the embedded venueId
    // matches the URL slug so a token minted for venue A can't be replayed
    // against venue B. Public unauthenticated body.customerId is NEVER
    // trusted to set customerId here — that path is only honored under
    // requireAccount, where the operator has opted in to that contract.
    const authenticatedCustomer = tryReadAuthenticatedCustomer(req)
    if (authenticatedCustomer && authenticatedCustomer.venueId === venue.id) {
      req.body.customerId = authenticatedCustomer.customerId
    }

    if (settings.publicBooking.requireAccount) {
      const bodyCustomerId = typeof req.body?.customerId === 'string' ? req.body.customerId : null
      if (!authenticatedCustomer && !bodyCustomerId) {
        throw new UnauthorizedError('Este negocio requiere iniciar sesion para reservar.')
      }
    }

    // Validate required fields based on config
    if (settings.publicBooking.requirePhone && !req.body.guestPhone) {
      throw new BadRequestError('El telefono es requerido')
    }
    if (settings.publicBooking.requireEmail && !req.body.guestEmail) {
      throw new BadRequestError('El email es requerido')
    }

    const incomingHoldId: string | undefined =
      typeof req.body.holdId === 'string' && req.body.holdId.length > 0 ? req.body.holdId : undefined

    if (!req.body.classSessionId && req.body.staffId && settings.publicBooking.showStaffPicker !== true && !incomingHoldId) {
      throw new BadRequestError('La selección de profesionista no está habilitada para este negocio')
    }

    // ---- Multi-service appointments (Square pattern) -----------------------
    // Normalize the validated wire representation for controller preflights.
    // createReservation repeats this defense-in-depth check and remains the
    // sole authority for the product identity persisted in its transaction.
    const normalizedProducts = normalizeBookedProductIds({
      productId: req.body.productId,
      productIds: req.body.productIds,
    })
    const incomingProductIds = normalizedProducts.productIdsWasProvided ? normalizedProducts.productIds : []
    req.body.productId = normalizedProducts.leadProductId
    if (normalizedProducts.productIdsWasProvided) req.body.productIds = incomingProductIds
    if (incomingProductIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: incomingProductIds }, venueId: venue.id },
        select: { id: true, type: true, duration: true, durationMinutes: true },
      })
      if (products.length !== incomingProductIds.length) {
        throw new BadRequestError('Uno o mas productos no pertenecen a este venue')
      }
      if (products.some(p => p.type === 'CLASS')) {
        throw new BadRequestError('Los productos de tipo clase usan classSessionId, no productIds')
      }
      // Lead service = first picked. Sum durations for the appointment window.
      const summed = products.reduce((acc, p) => acc + (p.duration ?? p.durationMinutes ?? 0), 0)
      if (summed > 0) {
        req.body.duration = summed
      } else if (req.body.startsAt && req.body.endsAt) {
        // Legacy products with NULL duration (admin saved them before the
        // dashboard form required it). /availability already used the venue
        // defaultDurationMin fallback to offer slots, so the picked
        // startsAt/endsAt window is the authoritative duration. Derive it
        // so the request keeps moving instead of dying on a stale Zod check.
        const diffMs = new Date(req.body.endsAt).getTime() - new Date(req.body.startsAt).getTime()
        const diffMin = Math.round(diffMs / 60000)
        if (diffMin >= 5) req.body.duration = diffMin
      }
    }

    // ---- Slot hold validation (Square countdown UX) ------------------------
    // If the widget passed a holdId, ensure it is still alive and matches the
    // booked window. We do NOT delete the hold here — that happens AFTER the
    // reservation row is written so a failed create doesn't strand the
    // customer with no recovery path.
    let leadProductType: string | null = null
    if (req.body.productId && !req.body.classSessionId) {
      const product = await prisma.product.findFirst({
        where: { id: req.body.productId, venueId: venue.id },
        select: { type: true },
      })
      leadProductType = product?.type ?? null
      if (leadProductType === 'CLASS') {
        throw new BadRequestError('classSessionId es requerido para reservar una clase')
      }
    }
    const normalAppointmentHold =
      incomingHoldId && leadProductType === 'APPOINTMENTS_SERVICE'
        ? await fastFailLiveHold({ venueId: venue.id, holdId: incomingHoldId })
        : null
    const legacyHold =
      incomingHoldId && !normalAppointmentHold
        ? await validateHoldForReservation({
            venueId: venue.id,
            holdId: incomingHoldId,
            startsAt: new Date(req.body.startsAt),
            endsAt: new Date(req.body.endsAt),
          })
        : null

    // After-create cleanup burns the hold best-effort. The canonical product
    // list is already co-committed by createReservation.
    async function finalizeReservationSideEffects() {
      if (legacyHold) {
        try {
          await prisma.slotHold.deleteMany({
            where: { id: legacyHold.id, venueId: venue.id },
          })
        } catch (error) {
          logger.warn(`[slot-hold] failed to delete hold ${legacyHold.id} (non-fatal): ${(error as Error).message}`)
        }
      }
    }

    // ---- Slot collision guard for APPOINTMENTS_SERVICE -------------------
    // Tableless studios (Mindform pattern) have no resource model to gate
    // concurrent reservations. The slot-hold endpoint (createHold) wraps its
    // own check in a per-venue advisory lock + transaction, which is the
    // strong serialization layer. This controller guard is the fallback for
    // callers that bypass the hold flow (direct API, expired hold cleared,
    // legacy embed). A small race window between count and insert remains
    // here; for Mindform-scale concurrency it's acceptable, and the hold
    // endpoint closes it for the standard widget path.
    //
    // Classes don't pass through here (handled by the classSessionId branch
    // below) and their per-session capacity guard already prevents overlap.
    if (!normalAppointmentHold && !legacyHold && !req.body.classSessionId && req.body.productId) {
      const product = await prisma.product.findFirst({
        where: { id: req.body.productId, venueId: venue.id },
        select: { type: true },
      })
      if (product?.type === 'APPOINTMENTS_SERVICE') {
        const pacingMax = isStaffAware(settings)
          ? (settings.scheduling?.pacingMaxPerSlot ?? null)
          : effectiveAppointmentPacing(settings.scheduling?.pacingMaxPerSlot)
        if (pacingMax !== null) {
          const { reservations, holds } = await countAppointmentOccupancy(prisma, {
            venueId: venue.id,
            startsAt: new Date(req.body.startsAt),
            endsAt: new Date(req.body.endsAt),
          })
          if (reservations + holds >= pacingMax) {
            throw new ConflictError('Este horario ya no está disponible. Por favor elige otro horario.')
          }
        }
      }
    }

    // CLASS bookings use a dedicated code path with ClassSession capacity checks.
    // Pre-resolve whether the venue has a working Stripe merchant so the inner
    // function can record the right semantic on the reservation: PENDING+Stripe
    // checkout (will charge) vs CONFIRMED + amount-owed-at-venue (no Stripe yet).
    if (req.body.classSessionId) {
      const stripeMerchantPreflight = await resolveActiveStripeMerchant(venue.id)
      const reservation = await createClassReservation(venue.id, req.body, settings, !!stripeMerchantPreflight)

      // When the class requires upfront cash AND the venue has Stripe configured,
      // the reservation landed in PENDING + depositStatus PENDING. Mint a Stripe
      // Checkout session so the customer can pay; the webhook flips the reservation
      // to CONFIRMED+PAID on payment success.
      //
      // When the venue does NOT have Stripe (graceful fallback), the reservation
      // already landed as CONFIRMED with depositAmount set + depositStatus null,
      // meaning "spot is held, customer owes $X at the venue". No checkout to mint.
      let checkoutUrl: string | null = null
      if (reservation.requiresUpfrontCash && reservation.upfrontAmount && stripeMerchantPreflight) {
        const stripeMerchant = stripeMerchantPreflight

        const stripeAmount = toStripeAmount(new Prisma.Decimal(reservation.upfrontAmount))
        const bounds = getStripeChargeBounds()
        if (stripeAmount < bounds.min) {
          throw new BadRequestError('El monto es menor al minimo permitido por Stripe')
        }
        if (stripeAmount > bounds.max) {
          throw new BadRequestError('El monto excede el maximo permitido por transaccion')
        }

        const _vatRateBps = await getVatRateBps()
        const applicationFeeAmount = calculateApplicationFeeWithVAT(stripeAmount, stripeMerchant.platformFeeBps, _vatRateBps)
        const provider = getProvider(stripeMerchant)
        // Default return target: the public booking site (book.avoqado.io/{slug}).
        // FRONTEND_URL points at the dashboard (dashboardv2.avoqado.io) which has
        // a legacy /book/{slug} route — landing the customer there after a Stripe
        // cancel surfaces an unfamiliar UI and was the source of reported confusion.
        const bookingPublicUrl = process.env.BOOKING_PUBLIC_URL || 'http://localhost:5174'
        // Widget can override return URLs (book.avoqado.io vs embed iframe vs dashboard).
        const reqSuccess = (req.body as any).successUrl as string | undefined
        const reqCancel = (req.body as any).cancelUrl as string | undefined
        const baseSuccess = reqSuccess || `${bookingPublicUrl}/${venueSlug}`
        const baseCancel = reqCancel || baseSuccess
        const sep = (u: string) => (u.includes('?') ? '&' : '?')
        const successUrl = `${baseSuccess}${sep(baseSuccess)}payment=success&reservationId=${reservation.id}&session_id={CHECKOUT_SESSION_ID}`
        const cancelUrl = `${baseCancel}${sep(baseCancel)}payment=cancelled&reservationId=${reservation.id}`

        const session = await provider.createCheckoutSession(stripeMerchant, {
          amount: stripeAmount,
          currency: 'mxn',
          applicationFeeAmount,
          successUrl,
          cancelUrl,
          expiresAt: new Date(Date.now() + 30 * 60_000),
          customerEmail: reservation.guestEmail ?? undefined,
          metadata: {
            type: 'class_reservation',
            reservationId: reservation.id,
            venueId: venue.id,
            confirmationCode: reservation.confirmationCode,
          },
          description: `Reserva ${venue.name}`,
          statementDescriptorSuffix: 'RESERVA',
          idempotencyKey: `reservation:${reservation.id}:upfront:v1`,
          paymentMethodTypes: ['card'],
        })

        // Pin the EcommerceMerchant alongside the session id so refunds and
        // reconciliation always route through the same connected account.
        await prisma.reservation.update({
          where: { id: reservation.id },
          data: { checkoutSessionId: session.id, ecommerceMerchantId: stripeMerchant.id },
        })
        checkoutUrl = session.url
      }

      // Burn the slot hold now that the class reservation exists.
      // Best-effort (see helper).
      await finalizeReservationSideEffects()

      // Confirmation (email + WhatsApp) for non-paid classes — free / credit /
      // pay-at-venue, which land CONFIRMED here. Paid classes are PENDING with a
      // Stripe checkout pending, so their confirmation fires from the deposit
      // webhook after payment clears (same as appointments). Without this block,
      // non-paid class reservations never got a confirmation carrying the manage
      // link: this branch returns before the appointment confirmation code below.
      // Best-effort — a mail/Meta failure must never fail a committed booking.
      if (reservation.status === 'CONFIRMED') {
        const classProduct = await prisma.product
          .findFirst({ where: { id: reservation.productId ?? undefined, venueId: venue.id }, select: { name: true } })
          .catch(() => null)
        const className = classProduct?.name ?? 'Clase'
        const tz = venue.timezone || 'America/Mexico_City'
        const dateLongRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
        const dateLong = dateLongRaw.charAt(0).toUpperCase() + dateLongRaw.slice(1)
        const time = formatInTimeZone(reservation.startsAt, tz, 'HH:mm')

        if (reservation.guestEmail) {
          try {
            await emailService.sendReservationConfirmedEmail(reservation.guestEmail, {
              customerName: reservation.guestName ?? 'Cliente',
              venueName: venue.name,
              venueSlug: venue.slug,
              confirmationCode: reservation.confirmationCode,
              cancelSecret: reservation.cancelSecret,
              dateLong,
              time,
              services: [{ name: className, modifiers: [] }],
              owedAtVenueMxn: reservation.owesAtVenue && reservation.upfrontAmount ? Number(reservation.upfrontAmount) : null,
            })
          } catch (error) {
            logger.warn(`[CLASS CONFIRM EMAIL] failed for ${reservation.confirmationCode}: ${(error as Error).message}`)
          }
        }
        if (reservation.guestPhone) {
          try {
            await sendReservationConfirmationWhatsApp(reservation.guestPhone, {
              customerName: reservation.guestName ?? 'Cliente',
              venueName: venue.name,
              date: dateLong,
              time,
              // Classes don't carry add-on modifiers; keep the clean 4-param
              // template. The class name lives in the email body.
              extras: '',
              // Feeds the optional "Gestionar mi cita" WhatsApp button.
              venueSlug: venue.slug,
              cancelSecret: reservation.cancelSecret,
            })
          } catch (error) {
            logger.warn(`[CLASS CONFIRM WHATSAPP] failed for ${reservation.confirmationCode}: ${(error as Error).message}`)
          }
        }
      }

      return res.status(201).json({
        confirmationCode: reservation.confirmationCode,
        cancelSecret: reservation.cancelSecret,
        startsAt: reservation.startsAt,
        endsAt: reservation.endsAt,
        status: reservation.status,
        depositRequired: !!reservation.requiresUpfrontCash,
        depositAmount: reservation.upfrontAmount ?? null,
        creditRedeemed: reservation.creditRedeemed || false,
        creditsUsed: reservation.creditsUsed || 0,
        checkoutUrl,
        // owesAtVenue: true means policy was 'required' but the venue has no Stripe
        // configured. The reservation is CONFIRMED, but the customer is expected
        // to pay `depositAmount` upon arrival. Widget can show a banner.
        owesAtVenue: !!reservation.owesAtVenue,
      })
    }

    // Phase 4: enforce ReservationSettings.payments.appointmentUpfrontDefault
    // (and per-product Product.upfrontPolicy override) for APPOINTMENT bookings.
    // The legacy settings.deposits path only covers % / fixed deposits — the
    // upfront-payment policy is a separate axis. Without this block, setting
    // "Cobro por adelantado en citas: Prepago obligatorio" was silently ignored
    // and the customer could land a CONFIRMED booking with no charge.
    //
    // When the policy resolves to 'required':
    //   • venue has Stripe → inject a synthetic settings.deposits override so
    //     the existing downstream flow creates the reservation as PENDING +
    //     mints a Checkout session for the full service price.
    //   • venue lacks Stripe → mirror the class-booking fallback: confirm the
    //     booking but stamp depositAmount + a "[PAY-AT-VENUE]" note so the
    //     widget shows "Debes $X al llegar" and ops can reconcile.
    let appointmentOwesAtVenue = false
    let appointmentOwesAmount = 0
    let effectiveDeposits = settings.deposits
    // Bind the deposits decision evaluated against the public payment/rail
    // preflight to this write. Core still re-reads scheduling, auto-confirm,
    // capacity, and every non-payment setting inside its transaction.
    let paymentPolicyOverride: NonNullable<reservationService.ReservationWriteContext['paymentPolicyOverride']> = {
      deposits: effectiveDeposits,
    }
    if (req.body.productId && !req.body.classSessionId) {
      const upfrontProduct = await prisma.product.findFirst({
        where: { id: req.body.productId, venueId: venue.id },
        select: { type: true, price: true, upfrontPolicy: true },
      })
      if (upfrontProduct && upfrontProduct.type !== 'CLASS') {
        const effectivePolicy = resolveUpfrontPolicy(
          { type: upfrontProduct.type, upfrontPolicy: upfrontProduct.upfrontPolicy },
          {
            appointmentUpfrontDefault: settings.payments?.appointmentUpfrontDefault,
            classUpfrontDefault: settings.payments?.classUpfrontDefault,
          },
        )
        const cashPrice = Number(upfrontProduct.price ?? 0)
        const willUseCredits =
          (typeof req.body.creditItemBalanceId === 'string' && req.body.creditItemBalanceId.length > 0) ||
          (Array.isArray(req.body.creditItemBalanceIds) && req.body.creditItemBalanceIds.length > 0)
        const requestedPartySize = Number(req.body.partySize ?? 1)
        const policyDemandsUpfrontCash = effectivePolicy === 'required' && !willUseCredits && cashPrice > 0
        if (policyDemandsUpfrontCash) {
          const total = cashPrice * requestedPartySize
          const stripePreflight = await resolveActiveStripeMerchant(venue.id)
          if (stripePreflight) {
            // Synthesize a `prepaid` deposit so calculateDepositAmount returns
            // the full price and reservationService.createReservation stamps
            // depositAmount + status=PENDING. The Stripe checkout block below
            // then mints the session unchanged.
            effectiveDeposits = {
              ...(settings.deposits ?? {}),
              enabled: true,
              mode: 'prepaid',
              fixedAmount: total,
              percentageOfTotal: null,
              requiredForPartySizeGte: null,
              paymentWindowHrs: settings.deposits?.paymentWindowHrs ?? 24,
            }
            paymentPolicyOverride = { deposits: effectiveDeposits }
          } else {
            appointmentOwesAtVenue = true
            appointmentOwesAmount = total
            logger.warn(
              `⚠️ [APPOINTMENT BOOKING] upfrontPolicy=required but venue ${venue.id} has no Stripe merchant — falling back to pay-at-venue (owes ${total})`,
            )
          }
        }
      }
    }

    const depositPreview = await previewDepositRequirement(venue.id, req.body, { ...settings, deposits: effectiveDeposits })
    const stripeMerchant = depositPreview.required ? await resolveActiveStripeMerchant(venue.id) : null

    if (depositPreview.required && !stripeMerchant) {
      // No Stripe rail → we can't collect the deposit online. Don't hard-block the
      // booking (that left deposit-configured-but-Stripe-less venues unable to take
      // ANY reservation). Fall back to pay-at-venue: confirm the spot and record the
      // amount owed on arrival. The dashboard now gates the deposit toggle on an active
      // Stripe Connect channel, so this is the safety net for venues configured before
      // that gate (or via API/seed).
      appointmentOwesAtVenue = true
      appointmentOwesAmount = depositPreview.amount ?? appointmentOwesAmount
      effectiveDeposits = { ...(effectiveDeposits ?? {}), enabled: false, mode: 'none' }
      paymentPolicyOverride = { deposits: effectiveDeposits }
      logger.warn(
        `⚠️ [BOOKING] deposit required but venue ${venue.id} has no Stripe merchant — falling back to pay-at-venue (owes ${appointmentOwesAmount})`,
      )
    }

    // Stripe deposit bounds — only when we actually have a merchant to charge.
    if (depositPreview.required && depositPreview.amount && stripeMerchant) {
      const stripeAmount = toStripeAmount(depositPreview.amount)
      const bounds = getStripeChargeBounds()
      if (stripeAmount < bounds.min) {
        throw new BadRequestError('El deposito es menor al minimo permitido por Stripe')
      }
      if (stripeAmount > bounds.max) {
        throw new BadRequestError('El deposito excede el maximo permitido por transaccion')
      }
    }

    let reservation = await reservationService.createReservation(
      venue.id,
      {
        startsAt: req.body.startsAt,
        endsAt: req.body.endsAt,
        duration: req.body.duration,
        channel: 'WEB' as const,
        customerId: req.body.customerId,
        guestName: req.body.guestName,
        guestPhone: req.body.guestPhone,
        guestEmail: req.body.guestEmail,
        partySize: req.body.partySize,
        productId: normalizedProducts.leadProductId,
        productIds: normalizedProducts.productIdsWasProvided ? incomingProductIds : undefined,
        assignedStaffId: req.body.staffId,
        specialRequests: req.body.specialRequests,
        modifierSelections: req.body.modifierSelections,
      },
      {
        writeOrigin: 'PUBLIC',
        paymentPolicyOverride,
        ...(req.body.windowSemantics === 'base' ? { windowSemantics: req.body.windowSemantics } : {}),
        ...(normalAppointmentHold ? { appointmentHoldId: normalAppointmentHold.id } : {}),
      },
    )

    // Owes-at-venue fallback (policy=required + no Stripe merchant): the
    // reservation was just created CONFIRMED with no deposit. Stamp the
    // expected amount + a "[PAY-AT-VENUE]" note so the widget and email
    // surface "Debes $X al llegar" and ops can reconcile on arrival.
    if (appointmentOwesAtVenue && appointmentOwesAmount > 0) {
      const ownerNote = `[PAY-AT-VENUE] Cliente debe $${appointmentOwesAmount} al llegar (venue sin Stripe configurado)`
      const mergedSpecialRequests = [reservation.specialRequests ?? null, ownerNote].filter(Boolean).join(' • ') || null
      reservation = await prisma.reservation.update({
        where: { id: reservation.id },
        data: {
          depositAmount: new Prisma.Decimal(appointmentOwesAmount),
          specialRequests: mergedSpecialRequests,
        },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
          table: { select: { id: true, number: true, capacity: true } },
          product: { select: { id: true, name: true, price: true } },
          assignedStaff: { select: { id: true, firstName: true, lastName: true } },
        },
      })
    }

    let checkoutUrl: string | null = null
    if (reservation.depositAmount && stripeMerchant) {
      const stripeAmount = toStripeAmount(reservation.depositAmount)
      const _vatRateBps = await getVatRateBps()
      const applicationFeeAmount = calculateApplicationFeeWithVAT(stripeAmount, stripeMerchant.platformFeeBps, _vatRateBps)
      const provider = getProvider(stripeMerchant)
      // Default return target: the public booking site (book.avoqado.io/{slug}).
      // FRONTEND_URL points at the dashboard which has only a legacy /book/{slug}
      // route — landing the customer there after a Stripe cancel surfaces an
      // unfamiliar UI. Widget can still override via req.body.{success,cancel}Url.
      const bookingPublicUrl = process.env.BOOKING_PUBLIC_URL || 'http://localhost:5174'
      const reqSuccess = (req.body as any).successUrl as string | undefined
      const reqCancel = (req.body as any).cancelUrl as string | undefined
      const baseSuccess = reqSuccess || `${bookingPublicUrl}/${venueSlug}`
      const baseCancel = reqCancel || baseSuccess
      const sep = (u: string) => (u.includes('?') ? '&' : '?')
      const successUrl = `${baseSuccess}${sep(baseSuccess)}payment=success&reservationId=${reservation.id}&session_id={CHECKOUT_SESSION_ID}`
      const cancelUrl = `${baseCancel}${sep(baseCancel)}payment=cancelled&reservationId=${reservation.id}`
      const session = await provider.createCheckoutSession(stripeMerchant, {
        amount: stripeAmount,
        currency: 'mxn',
        applicationFeeAmount,
        successUrl,
        cancelUrl,
        expiresAt: reservation.depositExpiresAt ?? new Date(Date.now() + 30 * 60_000),
        customerEmail: reservation.guestEmail ?? undefined,
        metadata: {
          type: 'reservation_deposit',
          reservationId: reservation.id,
          venueId: venue.id,
          confirmationCode: reservation.confirmationCode,
        },
        description: `Reserva ${venue.name}`,
        statementDescriptorSuffix: 'RESERVA',
        idempotencyKey: reservation.idempotencyKey ?? `reservation:${reservation.id}:deposit:v1`,
        paymentMethodTypes: ['card'],
      })

      // Pin the EcommerceMerchant alongside the session id so refunds and
      // reconciliation always route through the same connected account.
      reservation = await prisma.reservation.update({
        where: { id: reservation.id },
        data: { checkoutSessionId: session.id, ecommerceMerchantId: stripeMerchant.id },
        include: {
          customer: { select: { id: true, firstName: true, lastName: true, phone: true, email: true } },
          table: { select: { id: true, number: true, capacity: true } },
          product: { select: { id: true, name: true, price: true } },
          assignedStaff: { select: { id: true, firstName: true, lastName: true } },
        },
      })
      checkoutUrl = session.url
    }

    // Burn the slot hold now that the reservation exists. Best-effort —
    // failures are logged but do not poison the committed booking response.
    await finalizeReservationSideEffects()

    // Credit redemption for non-class appointments. Lives outside the
    // reservation transaction (reservationService.createReservation owns its
    // own tx and doesn't expose it), so on the rare failure case the
    // reservation stands but credits are NOT consumed — the customer's
    // unaffected, ops can reconcile from the [CREDIT REDEEM FAILED] log.
    let creditRedeemed = false
    let creditsUsed = 0
    const balanceIds: string[] = Array.isArray(req.body.creditItemBalanceIds)
      ? req.body.creditItemBalanceIds.filter((id: unknown): id is string => typeof id === 'string')
      : req.body.creditItemBalanceId
        ? [req.body.creditItemBalanceId]
        : []
    if (balanceIds.length > 0) {
      try {
        const seats = (req.body.spotIds?.length || req.body.partySize || 1) as number
        const result = await prisma.$transaction(async tx =>
          redeemCreditsForReservation(tx, {
            venueId: venue.id,
            reservationId: reservation.id,
            confirmationCode: reservation.confirmationCode,
            balanceIds,
            creditsPerBalance: seats,
            customerEmail: req.body.guestEmail,
            customerPhone: req.body.guestPhone,
            expectedProductIds: incomingProductIds.length > 0 ? incomingProductIds : req.body.productId ? [req.body.productId] : undefined,
          }),
        )
        creditRedeemed = result.redeemed
        creditsUsed = result.creditsUsed
      } catch (error) {
        logger.error(
          `[CREDIT REDEEM FAILED] reservation=${reservation.confirmationCode} balances=${balanceIds.join(',')} err=${(error as Error).message}`,
        )
        // Surface the error to the customer so they can fix the input rather
        // than think they paid with credits when they didn't.
        throw error
      }
    }

    // Booking confirmation email — only fires when the reservation is already
    // CONFIRMED at this point (no-deposit flow OR pay-at-venue). For the
    // Stripe deposit path the reservation is PENDING here and the email is
    // fired by the deposit webhook after payment succeeds, to avoid sending
    // "confirmed" mail for a booking that may still be abandoned at checkout.
    if (reservation.status === 'CONFIRMED' && reservation.guestEmail) {
      try {
        const allProductIds = incomingProductIds.length > 0 ? incomingProductIds : reservation.productId ? [reservation.productId] : []
        const products =
          allProductIds.length > 0
            ? await prisma.product.findMany({
                where: { id: { in: allProductIds }, venueId: venue.id },
                select: { id: true, name: true },
              })
            : []
        // Preserve customer's pick order: products[] comes back unordered.
        const nameById = new Map(products.map(p => [p.id, p.name]))
        // Fetch picked modifiers for this reservation so the email shows the
        // full breakdown (e.g. "Manicura tradicional + Esmalte de color +$150").
        const modifierRows = await prisma.reservationModifier.findMany({
          where: { reservationId: reservation.id },
          select: { productId: true, name: true, quantity: true, price: true },
          orderBy: { createdAt: 'asc' },
        })
        const modifiersByProduct = new Map<string, Array<{ name: string; quantity: number; price: number }>>()
        for (const m of modifierRows) {
          if (!m.name) continue
          if (!modifiersByProduct.has(m.productId)) modifiersByProduct.set(m.productId, [])
          modifiersByProduct.get(m.productId)!.push({ name: m.name, quantity: m.quantity, price: Number(m.price) })
        }
        const services = allProductIds
          .map(id => {
            const name = nameById.get(id)
            if (!name) return null
            return { name, modifiers: modifiersByProduct.get(id) ?? [] }
          })
          .filter((s): s is { name: string; modifiers: Array<{ name: string; quantity: number; price: number }> } => !!s)
        const tz = venue.timezone || 'America/Mexico_City'
        const dateLongRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
        const owedAtVenueMxn = reservation.depositAmount ? Number(reservation.depositAmount) : null
        await emailService.sendReservationConfirmedEmail(reservation.guestEmail, {
          customerName: reservation.guestName ?? 'Cliente',
          venueName: venue.name,
          venueSlug: venue.slug,
          confirmationCode: reservation.confirmationCode,
          cancelSecret: reservation.cancelSecret,
          dateLong: dateLongRaw.charAt(0).toUpperCase() + dateLongRaw.slice(1),
          time: formatInTimeZone(reservation.startsAt, tz, 'HH:mm'),
          services,
          // Pay-at-venue case stamps depositAmount + leaves status=CONFIRMED;
          // no charge has cleared today, so it shows as "owed at venue".
          owedAtVenueMxn,
        })
      } catch (error) {
        // Email failures must NEVER fail a successful booking. The customer
        // already has cancelSecret on screen — we log and move on.
        logger.warn(`[BOOKING CONFIRM EMAIL] failed for ${reservation.confirmationCode}: ${(error as Error).message}`)
      }
    }

    // WhatsApp confirmation (parallel to email). Same best-effort posture —
    // a Meta API failure must never fail a successful booking. Routes to
    // `reservation_confirmation_with_extras` template (5 params incl. picked
    // modifiers) when there are modifiers; falls back to legacy 4-param
    // template when there aren't.
    if (reservation.status === 'CONFIRMED' && reservation.guestPhone) {
      try {
        const allProductIds = incomingProductIds.length > 0 ? incomingProductIds : reservation.productId ? [reservation.productId] : []
        const modifierRows = await prisma.reservationModifier.findMany({
          where: { reservationId: reservation.id },
          select: { name: true, quantity: true, price: true, productId: true },
          orderBy: { createdAt: 'asc' },
        })
        const tz = venue.timezone || 'America/Mexico_City'
        const dateLongRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
        await sendReservationConfirmationWhatsApp(reservation.guestPhone, {
          customerName: reservation.guestName ?? 'Cliente',
          venueName: venue.name,
          date: dateLongRaw.charAt(0).toUpperCase() + dateLongRaw.slice(1),
          time: formatInTimeZone(reservation.startsAt, tz, 'HH:mm'),
          extras:
            allProductIds.length > 0
              ? formatModifiersForWhatsApp(modifierRows.map(m => ({ name: m.name, quantity: m.quantity, price: Number(m.price) })))
              : '',
          // Feeds the optional "Gestionar mi cita" WhatsApp button (same
          // self-service manage link as the confirmation email).
          venueSlug: venue.slug,
          cancelSecret: reservation.cancelSecret,
        })
      } catch (error) {
        logger.warn(`[BOOKING CONFIRM WHATSAPP] failed for ${reservation.confirmationCode}: ${(error as Error).message}`)
      }
    }

    // Return only public-safe data + cancelSecret
    res.status(201).json({
      confirmationCode: reservation.confirmationCode,
      cancelSecret: reservation.cancelSecret,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      status: reservation.status,
      // depositRequired: true means Stripe checkout was minted and the widget
      // must redirect. owesAtVenue carries depositAmount but no checkout —
      // the widget shows a "Debes $X al llegar" pill instead.
      depositRequired: !!reservation.depositAmount && !appointmentOwesAtVenue,
      depositAmount: reservation.depositAmount,
      creditRedeemed,
      creditsUsed,
      checkoutUrl,
      owesAtVenue: appointmentOwesAtVenue,
    })
  } catch (error) {
    next(error)
  }
}

/**
 * GET /public/venues/:venueSlug/reservations/:cancelSecret
 */
export async function getReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)

    // Compute the cancellation/refund preview so the widget can show
    // "if you cancel now, you'll get N credits back" before confirming.
    const settings = await getReservationSettings(reservation.venueId)
    const cancellationPreview = computeCancellationPreview({
      startsAt: reservation.startsAt,
      cancellationPolicy: settings.cancellation,
    })

    // Look up how many credits this reservation actually consumed (if any),
    // so we can multiply the policy percent against a real number for the UI.
    const prisma = (await import('../../utils/prismaClient')).default
    const redeems = await prisma.creditTransaction.findMany({
      where: { venueId: reservation.venueId, reservationId: reservation.id, type: 'REDEEM' },
      select: { quantity: true },
    })
    const creditsUsed = redeems.reduce((sum, t) => sum + Math.abs(t.quantity), 0)
    const creditsRefundable = Math.floor((creditsUsed * cancellationPreview.refundPercent) / 100)

    // Fetch modifiers if any were selected on the reservation
    const modifierRows = await prisma.reservationModifier.findMany({
      where: { reservationId: reservation.id },
      select: { id: true, productId: true, name: true, quantity: true, price: true },
      orderBy: { createdAt: 'asc' },
    })

    // Resolve the FULL ordered service list. Multi-service appointments keep it
    // in productIds[] (a scalar array, not a relation), so `product` alone only
    // ever showed the lead service — its extra services vanished from the
    // manage/cancel page. Resolve here so the widget lists every service.
    const serviceIds = reservation.productIds?.length ? reservation.productIds : reservation.productId ? [reservation.productId] : []
    const serviceRows = serviceIds.length
      ? await prisma.product.findMany({
          where: { id: { in: serviceIds } },
          select: { id: true, name: true, price: true, duration: true },
        })
      : []
    const serviceById = new Map(serviceRows.map(p => [p.id, p]))
    const services = serviceIds
      .map(id => serviceById.get(id))
      .filter((p): p is NonNullable<typeof p> => Boolean(p))
      .map(p => ({ id: p.id, name: p.name, price: p.price != null ? Number(p.price) : null, duration: p.duration ?? null }))

    res.json({
      confirmationCode: reservation.confirmationCode,
      status: reservation.status,
      startsAt: reservation.startsAt,
      endsAt: reservation.endsAt,
      duration: reservation.duration,
      partySize: reservation.partySize,
      guestName: reservation.guestName,
      venue: reservation.venue
        ? {
            name: reservation.venue.name,
            slug: reservation.venue.slug,
            timezone: reservation.venue.timezone,
          }
        : null,
      product: reservation.product,
      services, // full ordered list for multi-service appointments (lead kept in `product`)
      assignedStaff: reservation.assignedStaff
        ? {
            firstName: reservation.assignedStaff.firstName,
            lastName: reservation.assignedStaff.lastName,
          }
        : null,
      table: reservation.table ? { number: reservation.table.number } : null,
      specialRequests: reservation.specialRequests,
      depositAmount: reservation.depositAmount,
      depositStatus: reservation.depositStatus,
      cancellation: (() => {
        // `allowed` is the FULL decision (toggle + status + time window), not just
        // the venue toggle — so every frontend that reads it (widget, consumer app)
        // disables the cancel control exactly when the server would reject. Same
        // helper backs the POST guard below.
        const decision = computeCancelDecision({
          status: reservation.status,
          startsAt: reservation.startsAt,
          allowCustomerCancel: settings.cancellation.allowCustomerCancel,
          minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
        })
        return {
          allowed: decision.allowed,
          reason: decision.reason,
          // Raw venue toggle kept separate so the UI can distinguish "venue never
          // allows online cancel" from "too late this time" → show contact info.
          allowCustomerCancel: settings.cancellation.allowCustomerCancel,
          minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
          creditsUsed,
          creditsRefundable,
          refundPercent: cancellationPreview.refundPercent,
          policyLabel: cancellationPreview.label,
        }
      })(),
      // Reschedule eligibility — same window as cancel, plus the venue toggle.
      // Works for BOTH classes (swap session) and appointments (pick new slot).
      // `kind` tells the widget which mini-flow to run.
      reschedule: {
        allowed:
          settings.cancellation.allowCustomerReschedule &&
          (reservation.status === 'CONFIRMED' || reservation.status === 'PENDING') &&
          isWithinWindow(reservation.startsAt, settings.cancellation.minHoursBeforeStart),
        kind: (reservation as any).classSessionId ? 'class' : 'appointment',
        minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
        productId: (reservation as any).productId ?? null,
      },
      modifiers: modifierRows.map(m => ({
        id: m.id,
        productId: m.productId,
        name: m.name,
        quantity: m.quantity,
        price: Number(m.price),
      })),
    })
  } catch (error) {
    next(error)
  }
}

function isWithinWindow(startsAt: Date, minHoursBefore: number | null): boolean {
  if (minHoursBefore == null) return true
  const hoursUntilStart = (startsAt.getTime() - Date.now()) / 3_600_000
  return hoursUntilStart >= minHoursBefore
}

/**
 * Reason a self-service cancellation is blocked. `null` means cancellation IS
 * allowed. Frontends switch on this to show the right message (and the venue
 * contact when they must call instead).
 */
export type CancelBlockedReason = 'NOT_ALLOWED' | 'TOO_LATE' | 'NOT_CANCELLABLE_STATUS' | null

/**
 * SINGLE SOURCE OF TRUTH for "can the customer cancel this reservation right now?".
 *
 * Used by BOTH the GET reservation endpoint (to set `cancellation.allowed`, which
 * every frontend — booking widget, consumer app — reads to enable/disable the
 * cancel control) AND the POST cancel endpoint (the enforcement boundary). Routing
 * both through this helper guarantees the UI never offers a cancel the server will
 * reject, and the rule lives in exactly one place.
 *
 * Three gates, in order: the venue toggle, the reservation status, and the
 * time window. Returns the first failing reason so callers can message precisely.
 */
export function computeCancelDecision(args: {
  status: string
  startsAt: Date
  allowCustomerCancel: boolean
  minHoursBeforeStart: number | null
}): { allowed: boolean; reason: CancelBlockedReason } {
  if (!args.allowCustomerCancel) return { allowed: false, reason: 'NOT_ALLOWED' }
  // Only future, still-active reservations can be cancelled by the customer.
  if (args.status !== 'CONFIRMED' && args.status !== 'PENDING') {
    return { allowed: false, reason: 'NOT_CANCELLABLE_STATUS' }
  }
  if (!isWithinWindow(args.startsAt, args.minHoursBeforeStart)) {
    return { allowed: false, reason: 'TOO_LATE' }
  }
  return { allowed: true, reason: null }
}

/**
 * Shared reschedule guard for the 3 cancelSecret-scoped reschedule handlers.
 * Mirrors the cancellation window + venue toggle + status gate. Throws on any
 * failure so callers stay flat.
 */
function assertCanReschedule(
  reservation: { status: string; startsAt: Date },
  settings: Awaited<ReturnType<typeof getReservationSettings>>,
) {
  if (!settings.cancellation.allowCustomerReschedule) {
    throw new BadRequestError('Este negocio no permite cambiar horarios en línea. Contacta al negocio directamente.')
  }
  if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
    throw new BadRequestError('Esta reservación ya no se puede cambiar.')
  }
  if (settings.cancellation.minHoursBeforeStart != null) {
    const hoursUntilStart = (reservation.startsAt.getTime() - Date.now()) / 3_600_000
    if (hoursUntilStart < settings.cancellation.minHoursBeforeStart) {
      throw new BadRequestError(
        `No puedes cambiar el horario con menos de ${settings.cancellation.minHoursBeforeStart} horas de anticipación.`,
      )
    }
  }
}

/**
 * Assert the requested appointment slot is genuinely offerable (not just "not in
 * the past"). Single source of truth = the booking availability engine, plus
 * explicit window checks `getAvailableSlots` does NOT do (minNotice / maxAdvance /
 * past). `excludeReservationId` keeps the moving reservation from blocking its
 * own target slot. Throws 409/400 on any failure.
 */
async function assertSlotOfferable(args: {
  venueId: string
  productId: string | null
  startsAt: Date
  endsAt: Date
  settings: Awaited<ReturnType<typeof getReservationSettings>>
  timezone: string
  excludeReservationId: string
}): Promise<void> {
  const now = Date.now()
  if (args.startsAt.getTime() < now) {
    throw new ConflictError('Ese horario ya pasó, elige otro.')
  }
  const minNoticeMin = args.settings.scheduling?.minNoticeMin ?? 0
  if (minNoticeMin > 0 && args.startsAt.getTime() < now + minNoticeMin * 60_000) {
    throw new BadRequestError(`Debes reservar con al menos ${minNoticeMin} minutos de anticipación.`)
  }
  const maxAdvanceDays = args.settings.scheduling?.maxAdvanceDays ?? 0
  if (maxAdvanceDays > 0 && args.startsAt.getTime() > now + maxAdvanceDays * 24 * 60 * 60_000) {
    throw new BadRequestError(`No puedes reservar con más de ${maxAdvanceDays} días de anticipación.`)
  }
  // Operating hours + grid alignment + pacing + capacity + staff/table + external
  // blocks — all enforced by membership in the offered set (excluding self).
  const durationMin = Math.round((args.endsAt.getTime() - args.startsAt.getTime()) / 60_000)
  const slots = await availabilityService.getAvailableSlots(
    args.venueId,
    args.startsAt,
    { duration: durationMin, productId: args.productId ?? undefined, excludeReservationId: args.excludeReservationId },
    args.settings,
    args.timezone,
  )
  const offered = slots.some(s => new Date(s.startsAt).getTime() === args.startsAt.getTime())
  if (!offered) {
    throw new ConflictError('Ese horario ya no está disponible, elige otro.')
  }
}

/**
 * GET /public/venues/:venueSlug/reservations/:cancelSecret/reschedule/availability?date=YYYY-MM-DD
 *
 * Appointment reschedule: offered slots of the SAME service for the given date,
 * excluding the reservation being moved (so adjacent/overlapping slots show).
 */
export async function getRescheduleAvailability(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const { date } = req.query as { date?: string }
    if (!date) throw new BadRequestError('date es requerido (YYYY-MM-DD)')

    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)
    const settings = await getReservationSettings(reservation.venueId)
    assertCanReschedule(reservation, settings)
    if ((reservation as any).classSessionId) {
      throw new BadRequestError('Para clases, usa la disponibilidad de sesiones.')
    }

    const tz = reservation.venue?.timezone || 'America/Mexico_City'
    const productIds = reservationBookedProductIds(reservation)
    const slots = await availabilityService.getAvailableSlots(
      reservation.venueId,
      date,
      {
        productId: productIds[0],
        productIds,
        staffId: reservation.assignedStaffId ?? undefined,
        excludeReservationId: reservation.id,
        fixedDurationMin: reservation.duration,
      },
      settings,
      tz,
    )
    res.json({ date, slots: slots.map(s => ({ startsAt: s.startsAt, endsAt: s.endsAt, available: true })) })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/reservations/:cancelSecret/reschedule/hold
 *
 * Body: { startsAt, endsAt } — reserve the target slot for ~10 min before the
 * customer confirms. Re-validates the slot (§5.8) excluding self, then holds it.
 */
export async function createRescheduleHold(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)
    const settings = await getReservationSettings(reservation.venueId)
    assertCanReschedule(reservation, settings)
    if ((reservation as any).classSessionId) {
      throw new BadRequestError('Las clases se reagendan eligiendo otra sesión; no requieren reservar el horario.')
    }

    const body = req.body as { startsAt: string; endsAt: string }
    const startsAt = new Date(body.startsAt)
    const endsAt = new Date(body.endsAt)
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestError('Fechas inválidas')
    }
    if (endsAt <= startsAt) {
      throw new BadRequestError('endsAt debe ser posterior a startsAt')
    }
    // Duration is fixed (same service + same extras) — reject a tampered window.
    const reqDuration = Math.round((endsAt.getTime() - startsAt.getTime()) / 60_000)
    if (Math.abs(reqDuration - reservation.duration) > 1) {
      throw new BadRequestError('La duración del horario no coincide con el servicio.')
    }

    const tz = reservation.venue?.timezone || 'America/Mexico_City'
    await assertSlotOfferable({
      venueId: reservation.venueId,
      productId: reservation.productId,
      startsAt,
      endsAt,
      settings,
      timezone: tz,
      excludeReservationId: reservation.id,
    })

    void pruneExpiredHolds()
    const pacingMax = effectiveAppointmentPacing(settings.scheduling?.pacingMaxPerSlot)
    const hold = await holdAppointmentSlot({
      venueId: reservation.venueId,
      startsAt,
      endsAt,
      productIds: reservation.productId ? [reservation.productId] : [],
      partySize: reservation.partySize,
      fingerprint: null,
      pacingMax,
      excludeReservationId: reservation.id,
    })

    res.status(201).json({ holdId: hold.id, expiresAt: hold.expiresAt, ttlSeconds: Math.floor(SLOT_HOLD_TTL_MS / 1000) })
  } catch (error) {
    next(error)
  }
}

/**
 * POST /public/venues/:venueSlug/reservations/:cancelSecret/reschedule
 *
 * Branches on reservation kind:
 *   - class (`classSessionId` present): same-product session swap (existing).
 *   - appointment: move to `{ startsAt, holdId }` of the same service (new).
 *
 * The cancellation window + venue toggle + status gate apply to both via
 * `assertCanReschedule`. Credit transactions / deposits are untouched.
 */
export async function rescheduleReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)
    const settings = await getReservationSettings(reservation.venueId)
    assertCanReschedule(reservation, settings)

    // ── Class reschedule (existing behavior) ──────────────────────────────
    if ((reservation as any).classSessionId) {
      const { classSessionId, spotIds } = req.body as { classSessionId?: string; spotIds?: string[] }
      if (!classSessionId) {
        throw new BadRequestError('classSessionId es requerido')
      }
      const updated = await reservationService.rescheduleClassReservation({
        venueId: reservation.venueId,
        reservationId: reservation.id,
        newClassSessionId: classSessionId,
        newSpotIds: Array.isArray(spotIds) ? spotIds : undefined,
        rescheduledBy: 'CUSTOMER',
        reason: req.body?.reason,
      })
      return res.json({
        confirmationCode: updated.confirmationCode,
        status: updated.status,
        startsAt: updated.startsAt,
        endsAt: updated.endsAt,
        partySize: updated.partySize,
        spotIds: updated.spotIds,
      })
    }

    // ── Appointment reschedule (new) ──────────────────────────────────────
    const { startsAt: startsAtRaw, holdId } = req.body as { startsAt?: string; holdId?: string }
    if (!startsAtRaw) {
      throw new BadRequestError('startsAt es requerido')
    }
    const newStartsAt = new Date(startsAtRaw)
    if (Number.isNaN(newStartsAt.getTime())) {
      throw new BadRequestError('startsAt inválido')
    }
    const updated = await reservationService.rescheduleAppointmentReservation({
      venueId: reservation.venueId,
      reservationId: reservation.id,
      newStartsAt,
      holdId,
      rescheduledBy: 'CUSTOMER',
      writeOrigin: 'PUBLIC',
    })
    return res.json(updated)
  } catch (error) {
    next(error)
  }
}

/**
 * Pure helper: given a reservation startsAt + venue cancellation policy, compute the
 * refund percent that WOULD apply if cancelled right now. Used both by the GET
 * preview and shown in the widget before the confirm step.
 */
function computeCancellationPreview(args: {
  startsAt: Date
  cancellationPolicy: {
    creditRefundMode: 'NEVER' | 'ALWAYS' | 'TIME_BASED'
    creditFreeRefundHoursBefore: number
    creditLateRefundPercent: number
  }
}): { refundPercent: number; label: string } {
  const { creditRefundMode, creditFreeRefundHoursBefore, creditLateRefundPercent } = args.cancellationPolicy
  if (creditRefundMode === 'NEVER') return { refundPercent: 0, label: 'NEVER' }
  if (creditRefundMode === 'ALWAYS') return { refundPercent: 100, label: 'ALWAYS' }
  const hoursUntilStart = (args.startsAt.getTime() - Date.now()) / 3_600_000
  if (hoursUntilStart >= creditFreeRefundHoursBefore) {
    return { refundPercent: 100, label: `TIME_BASED:free` }
  }
  return { refundPercent: Math.max(0, Math.min(100, creditLateRefundPercent)), label: `TIME_BASED:late` }
}

/**
 * POST /public/venues/:venueSlug/reservations/:cancelSecret/cancel
 */
export async function cancelReservation(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, cancelSecret } = req.params
    const reservation = await reservationService.getReservationByCancelSecret(venueSlug, cancelSecret)

    // Enforcement boundary — SAME helper that powers `cancellation.allowed` in the
    // GET response, so the UI never offers a cancel we reject here (and vice versa).
    const settings = await getReservationSettings(reservation.venueId)
    const decision = computeCancelDecision({
      status: reservation.status,
      startsAt: reservation.startsAt,
      allowCustomerCancel: settings.cancellation.allowCustomerCancel,
      minHoursBeforeStart: settings.cancellation.minHoursBeforeStart,
    })
    if (!decision.allowed) {
      const minHours = settings.cancellation.minHoursBeforeStart
      const message =
        decision.reason === 'TOO_LATE' && minHours != null
          ? `No se puede cancelar con menos de ${minHours} horas de anticipación. Contacta al negocio directamente.`
          : decision.reason === 'NOT_CANCELLABLE_STATUS'
            ? 'Esta reservación ya no se puede cancelar en línea. Contacta al negocio directamente.'
            : 'La cancelación en línea no está permitida. Contacta al negocio directamente.'
      throw new BadRequestError(message)
    }

    const cancelled = await reservationService.cancelReservation(reservation.venueId, reservation.id, 'CUSTOMER', req.body?.reason)

    // Fire the cancellation email best-effort. Customer already has the API
    // response confirming the cancel succeeded — a mail failure shouldn't
    // change that contract.
    if (reservation.guestEmail) {
      try {
        const tz = reservation.venue.timezone || 'America/Mexico_City'
        const dateLongRaw = formatInTimeZone(reservation.startsAt, tz, "EEEE d 'de' MMMM 'de' yyyy", { locale: esLocale })
        await emailService.sendReservationCancelledEmail(reservation.guestEmail, {
          customerName: reservation.guestName ?? 'Cliente',
          venueName: reservation.venue.name,
          venueSlug: reservation.venue.slug,
          confirmationCode: reservation.confirmationCode,
          dateLong: dateLongRaw.charAt(0).toUpperCase() + dateLongRaw.slice(1),
          time: formatInTimeZone(reservation.startsAt, tz, 'HH:mm'),
          reason: typeof req.body?.reason === 'string' ? req.body.reason : null,
          cancelledBy: 'CUSTOMER',
        })
      } catch (mailError) {
        logger.warn(`[CANCEL EMAIL] failed for ${reservation.confirmationCode}: ${(mailError as Error).message}`)
      }
    }

    res.json({
      confirmationCode: cancelled.confirmationCode,
      status: cancelled.status,
      cancelledAt: cancelled.cancelledAt,
      depositStatus: cancelled.depositStatus,
      creditsRefunded: (cancelled as any).creditsRefunded ?? 0,
      refundPolicy: (cancelled as any).policyApplied ?? null,
    })
  } catch (error) {
    next(error)
  }
}

// ==========================================
// CLASS Reservation — Serializable transaction with capacity check
// ==========================================

async function createClassReservation(
  venueId: string,
  body: {
    classSessionId: string
    guestName: string
    guestPhone: string
    guestEmail?: string
    partySize?: number
    spotIds?: string[]
    specialRequests?: string
    creditItemBalanceId?: string
  },
  moduleConfig: any,
  hasStripeMerchant: boolean,
) {
  const requestedSpotIds = body.spotIds ?? []
  // If spotIds provided, partySize = number of spots selected
  const requestedPartySize = requestedSpotIds.length > 0 ? requestedSpotIds.length : (body.partySize ?? 1)
  const onlinePercent = moduleConfig?.scheduling?.onlineCapacityPercent ?? 100
  const autoConfirm = moduleConfig?.scheduling?.autoConfirm ?? true
  const initialStatus: ReservationStatus = autoConfirm ? 'CONFIRMED' : 'PENDING'

  return withSerializableRetry(async tx => {
    // Lock the ClassSession row and verify it exists + belongs to venue
    const sessions = await tx.$queryRaw<
      { id: string; productId: string; startsAt: Date; endsAt: Date; duration: number; capacity: number; status: string }[]
    >`
      SELECT id, "productId", "startsAt", "endsAt", duration, capacity, status
      FROM "ClassSession"
      WHERE id = ${body.classSessionId}
        AND "venueId" = ${venueId}
      FOR UPDATE
    `
    if (sessions.length === 0) {
      throw new NotFoundError('Sesion de clase no encontrada')
    }
    const session = sessions[0]

    if (session.status !== 'SCHEDULED') {
      throw new BadRequestError('Esta sesion de clase ya no acepta reservaciones')
    }

    // External calendar busy-block check (Google Calendar et al.).
    // Class reservations bypass `reservationService.createReservation`, so the
    // check has to be re-applied here. Class sessions are venue-master only
    // (no per-instructor staff field on the booking), so staffId stays null.
    const externalBlock = await checkExternalBusyBlock(tx, {
      venueId,
      staffId: null,
      startsAt: session.startsAt,
      endsAt: session.endsAt,
    })
    if (externalBlock) {
      throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
    }

    // Enforce admin booking-window policy (maxAdvanceDays / minNoticeMin).
    // ValidationError -> 422.
    reservationService.enforceBookingWindow(session.startsAt, moduleConfig?.scheduling)

    // Verify the product is CLASS and active
    const product = await tx.product.findFirst({
      where: { id: session.productId, venueId },
      select: { type: true, active: true, layoutConfig: true, requireCreditForBooking: true, price: true, upfrontPolicy: true },
    })
    if (!product || product.type !== 'CLASS') {
      throw new BadRequestError('El producto asociado no es una clase valida')
    }
    if (!product.active) {
      throw new BadRequestError('Este servicio ya no esta disponible')
    }

    // Block booking if product requires credit and none provided
    if (product.requireCreditForBooking && !body.creditItemBalanceId) {
      throw new BadRequestError('Este servicio requiere un credito para reservar. Compra un paquete de creditos primero.')
    }

    // Resolve effective upfront-payment policy (per-product override or venue default).
    // When 'required' and the customer is paying cash (no creditItemBalanceId), we
    // create the reservation in PENDING + depositStatus PENDING — the wrapper will
    // then create a Stripe Checkout session and the webhook flips it to CONFIRMED
    // when payment succeeds. Without this enforcement the widget could (and did)
    // skip payment entirely and land a CONFIRMED reservation for free.
    const effectiveUpfrontPolicy = resolveUpfrontPolicy(
      { type: product.type, upfrontPolicy: product.upfrontPolicy },
      {
        appointmentUpfrontDefault: moduleConfig?.payments?.appointmentUpfrontDefault,
        classUpfrontDefault: moduleConfig?.payments?.classUpfrontDefault,
      },
    )
    const willUseCredits = !!body.creditItemBalanceId
    const cashPrice = Number(product.price ?? 0)
    const policyDemandsUpfrontCash = effectiveUpfrontPolicy === 'required' && !willUseCredits && cashPrice > 0
    // Only mint a Stripe checkout when the venue actually has a working merchant.
    // Otherwise fall back to "pay at venue" semantics (CONFIRMED + amount owed).
    // This keeps venues that haven't onboarded Stripe yet from breaking when the
    // policy resolves to 'required' — the most honest behavior is "your spot is
    // held, you owe $X at the venue" rather than 400'ing the customer.
    const requiresUpfrontCash = policyDemandsUpfrontCash && hasStripeMerchant
    const owesAtVenue = policyDemandsUpfrontCash && !hasStripeMerchant
    if (owesAtVenue) {
      logger.warn(
        `⚠️ [CLASS BOOKING] upfrontPolicy=required but venue ${venueId} has no Stripe merchant — falling back to pay-at-venue (owes ${cashPrice * requestedPartySize})`,
      )
    }

    // Sum enrolled from active reservations
    // Note: FOR UPDATE cannot be used with aggregate functions in PostgreSQL.
    // The ClassSession row lock above + SERIALIZABLE isolation is sufficient.
    const enrolledResult = await tx.$queryRaw<{ total: bigint }[]>`
      SELECT COALESCE(SUM("partySize"), 0) as total
      FROM "Reservation"
      WHERE "classSessionId" = ${body.classSessionId}
        AND status IN ('PENDING', 'CONFIRMED', 'CHECKED_IN')
    `
    const enrolled = Number(enrolledResult[0].total)
    const effectiveCapacity = Math.floor((session.capacity * onlinePercent) / 100)

    if (enrolled + requestedPartySize > effectiveCapacity) {
      throw new ConflictError(
        `No hay suficientes lugares disponibles. Disponibles: ${effectiveCapacity - enrolled}, solicitados: ${requestedPartySize}`,
      )
    }

    // Validate spotIds against product layout (if layout exists and spots were selected)
    if (requestedSpotIds.length > 0 && product.layoutConfig) {
      const layout = product.layoutConfig as { spots?: { id: string; enabled: boolean }[] }
      const validSpotIds = new Set((layout.spots ?? []).filter(s => s.enabled).map(s => s.id))

      for (const spotId of requestedSpotIds) {
        if (!validSpotIds.has(spotId)) {
          throw new BadRequestError(`Lugar "${spotId}" no es valido`)
        }
      }

      // Check that requested spots are not already taken
      const takenReservations = await tx.reservation.findMany({
        where: {
          classSessionId: body.classSessionId,
          status: { in: ['PENDING', 'CONFIRMED', 'CHECKED_IN'] },
          spotIds: { hasSome: requestedSpotIds },
        },
        select: { spotIds: true },
      })
      if (takenReservations.length > 0) {
        const takenIds = takenReservations.flatMap(r => r.spotIds).filter(id => requestedSpotIds.includes(id))
        throw new ConflictError(`Los lugares ${takenIds.join(', ')} ya estan reservados`)
      }
    }

    const confirmationCode = reservationService.generateConfirmationCode()

    // Ensure uniqueness
    const existing = await tx.reservation.findUnique({
      where: { venueId_confirmationCode: { venueId, confirmationCode } },
      select: { id: true },
    })
    const finalCode = existing ? reservationService.generateConfirmationCode() : confirmationCode

    // Auto-link to a registered Customer when the guest data matches one. This
    // makes the booking show up in the customer portal "Mis Reservaciones" and
    // anchors loyalty/credits to the same identity.
    // Auto-link matching: exact email OR canonical phone. Phone is matched
    // format-independently — coarse-prefilter existing customers by the trailing
    // 10 digits, then canonical-verify with phonesMatch — because guest-typed and
    // stored phone strings aren't consistently normalized across write paths.
    const phoneLast10Digits = body.guestPhone ? phoneLast10(body.guestPhone) : null
    // Fetch candidate customers: exact email OR normalized-phone last-10 match.
    // The phone side strips non-digits from the STORED "phone" column in SQL so
    // formatting differences don't hide a real returning customer (a Prisma
    // `endsWith` compares raw text and misses "55 1234 5678"). phonesMatch below
    // is the canonical verify. Column names are compile-time literals here.
    const emailCond = body.guestEmail ? Prisma.sql`"email" = ${body.guestEmail}` : Prisma.sql`FALSE`
    const phoneCond = phoneLast10Digits
      ? Prisma.sql`right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${phoneLast10Digits}`
      : Prisma.sql`FALSE`
    const matchCandidates =
      body.guestEmail || phoneLast10Digits
        ? await tx.$queryRaw<{ id: string; email: string | null; phone: string | null }[]>`
            SELECT "id", "email", "phone"
            FROM "Customer"
            WHERE "venueId" = ${venueId}
              AND (${emailCond} OR ${phoneCond})
          `
        : []
    const matchedCustomer =
      matchCandidates.find(c => (body.guestEmail && c.email === body.guestEmail) || phonesMatch(c.phone, body.guestPhone)) ?? null

    // Three states for the reservation row:
    // 1. requiresUpfrontCash (policy=required + venue has Stripe): PENDING +
    //    depositStatus=PENDING + amount set. Webhook will flip to CONFIRMED+PAID
    //    after Stripe checkout succeeds.
    // 2. owesAtVenue (policy=required + venue lacks Stripe): CONFIRMED + amount
    //    set + depositStatus stays NULL. Encodes "spot held, customer owes $X
    //    at the venue" — staff/dashboard can read this combination to know the
    //    customer needs to pay on arrival.
    // 3. else (policy=at_venue/optional, or credits paid): standard CONFIRMED.
    const effectiveStatus: ReservationStatus = requiresUpfrontCash ? 'PENDING' : initialStatus
    const upfrontAmount = requiresUpfrontCash || owesAtVenue ? cashPrice * requestedPartySize : null
    const ownerAtVenueNote = owesAtVenue
      ? `[PAY-AT-VENUE] Cliente debe $${cashPrice * requestedPartySize} al llegar (venue sin Stripe configurado)`
      : null
    const mergedSpecialRequests = [body.specialRequests ?? null, ownerAtVenueNote].filter(Boolean).join(' • ') || null

    const reservation = await tx.reservation.create({
      data: {
        venueId,
        confirmationCode: finalCode,
        classSessionId: body.classSessionId,
        productId: session.productId,
        startsAt: session.startsAt,
        endsAt: session.endsAt,
        duration: session.duration,
        status: effectiveStatus,
        channel: 'WEB',
        customerId: matchedCustomer?.id ?? null,
        guestName: body.guestName,
        guestPhone: body.guestPhone,
        guestEmail: body.guestEmail ?? null,
        partySize: requestedPartySize,
        spotIds: requestedSpotIds,
        specialRequests: mergedSpecialRequests,
        depositAmount: upfrontAmount,
        depositStatus: requiresUpfrontCash ? 'PENDING' : null,
        confirmedAt: requiresUpfrontCash ? null : autoConfirm ? new Date() : null,
        statusLog: [
          {
            status: effectiveStatus,
            at: new Date().toISOString(),
            by: null,
            ...(owesAtVenue ? { note: 'pay-at-venue', amountOwed: cashPrice * requestedPartySize } : {}),
          },
        ],
      },
    })

    // ---- Credit redemption (if creditItemBalanceId provided) ----
    // Charges N credits where N = requestedPartySize (one credit per seat).
    let creditRedeemed = false
    let creditsUsed = 0
    if (body.creditItemBalanceId) {
      // Find customer by email/phone
      const customer = await tx.customer.findFirst({
        where: {
          venueId,
          OR: [...(body.guestEmail ? [{ email: body.guestEmail }] : []), ...(body.guestPhone ? [{ phone: body.guestPhone }] : [])],
        },
      })

      if (!customer) {
        throw new BadRequestError('No se encontro el cliente para canjear creditos')
      }

      // Lock and verify balance
      const balances = await tx.$queryRaw<{ id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string }[]>`
        SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId"
        FROM "CreditItemBalance"
        WHERE id = ${body.creditItemBalanceId}
        FOR UPDATE
      `

      if (balances.length === 0) {
        throw new BadRequestError('Balance de credito no encontrado')
      }

      const balance = balances[0]

      if (balance.productId !== session.productId) {
        throw new BadRequestError('El credito no corresponde al producto de esta clase')
      }

      if (balance.remainingQuantity < requestedPartySize) {
        throw new BadRequestError(
          `No tienes suficientes creditos. Disponibles: ${balance.remainingQuantity}, necesarios: ${requestedPartySize}. Compra mas creditos para continuar.`,
        )
      }

      // Verify purchase is active and not expired
      const purchase = await tx.creditPackPurchase.findUnique({
        where: { id: balance.creditPackPurchaseId },
        select: { status: true, expiresAt: true, customerId: true },
      })

      if (!purchase || purchase.customerId !== customer.id) {
        throw new BadRequestError('Credito no valido para este cliente')
      }

      if (purchase.status !== CreditPurchaseStatus.ACTIVE) {
        throw new BadRequestError('Los creditos ya no estan activos')
      }

      if (purchase.expiresAt && purchase.expiresAt < new Date()) {
        throw new BadRequestError('Los creditos han expirado')
      }

      // Decrement balance by partySize (one credit per seat)
      await tx.creditItemBalance.update({
        where: { id: body.creditItemBalanceId },
        data: { remainingQuantity: { decrement: requestedPartySize } },
      })

      // Create single credit transaction with negative quantity = seats
      await tx.creditTransaction.create({
        data: {
          venueId,
          customerId: customer.id,
          creditPackPurchaseId: balance.creditPackPurchaseId,
          creditItemBalanceId: body.creditItemBalanceId,
          type: 'REDEEM',
          quantity: -requestedPartySize,
          reservationId: reservation.id,
          reason: requestedPartySize > 1 ? `Reserva de ${requestedPartySize} lugares` : null,
        },
      })

      // Check if purchase is exhausted
      const remainingBalances = await tx.creditItemBalance.findMany({
        where: {
          creditPackPurchaseId: balance.creditPackPurchaseId,
          remainingQuantity: { gt: 0 },
        },
      })

      if (remainingBalances.length === 0) {
        await tx.creditPackPurchase.update({
          where: { id: balance.creditPackPurchaseId },
          data: { status: CreditPurchaseStatus.EXHAUSTED },
        })
      }

      creditRedeemed = true
      creditsUsed = requestedPartySize
      logger.info(
        `✅ [CREDIT REDEEM] ${requestedPartySize} credit(s) redeemed for reservation ${reservation.confirmationCode} | balance=${body.creditItemBalanceId}`,
      )
    }

    logger.info(
      `✅ [CLASS BOOKING] Created ${reservation.confirmationCode} | venue=${venueId} session=${body.classSessionId} party=${requestedPartySize} enrolled=${enrolled}→${enrolled + requestedPartySize}/${effectiveCapacity}${creditRedeemed ? ` (${creditsUsed} credit${creditsUsed > 1 ? 's' : ''})` : ''}`,
    )

    // ---- Google Calendar push outbox (Phase 2 — spec §14.2) ----
    // One event per class, not per attendee. Enqueue UPDATE_ROSTER (debounced
    // 30s) so the worker coalesces multiple attendee mutations into a single
    // events.patch on the class's pushed event. No per-reservation CREATE.
    const classSession = await tx.classSession.findUnique({
      where: { id: body.classSessionId },
      select: { assignedStaffId: true },
    })
    if (classSession) {
      const classTargets = await resolveClassSessionPushTargets(tx, {
        venueId,
        assignedStaffId: classSession.assignedStaffId ?? null,
      })
      if (classTargets.length > 0) {
        await enqueuePush(tx, {
          source: { kind: 'class', classSessionId: body.classSessionId },
          venueId,
          operation: 'UPDATE_ROSTER',
          targetConnectionIds: classTargets.map(t => t.id),
          debounceUntil: new Date(Date.now() + 30_000),
        })
        // Debounced — sweeper publishes after window. No immediate RMQ push.
      }
    }

    return { ...reservation, creditRedeemed, creditsUsed, requiresUpfrontCash, owesAtVenue, upfrontAmount }
  })
}

// ==========================================
// SLOT HOLD ENDPOINTS (Square countdown UX)
// ==========================================

/** TTL for a fresh slot hold. Square uses 10 minutes; we mirror that so the
 *  customer has enough time to fill the form without holding inventory hostage
 *  if they abandon. The widget reads expiresAt from the response and renders
 *  "Cita reservada durante 9:56" against it. */
/** Lazy cleanup threshold — sweep holds older than this past their expiry.
 *  Cheap, runs from the same path as availability so we don't need a cron. */
const SLOT_HOLD_GC_BUFFER_MS = 60 * 60 * 1000

/** Best-effort sweep of long-expired holds. Called from any path that scans
 *  holds anyway (createHold, getAvailability) so the table can't grow without
 *  bound. We swallow errors — the actual hold-validation queries already
 *  filter by expiresAt > NOW() so a backlog of dead rows just costs a bit
 *  of disk, never breaks correctness. */
async function pruneExpiredHolds(): Promise<void> {
  try {
    await prisma.slotHold.deleteMany({
      where: { expiresAt: { lt: new Date(Date.now() - SLOT_HOLD_GC_BUFFER_MS) } },
    })
  } catch (error) {
    logger.warn(`[slot-hold] cleanup failed (non-fatal): ${(error as Error).message}`)
  }
}

/**
 * Transitional pre-Task-7C reschedule hold helper. Normal booking holds use the
 * neutral atomic protocol in appointmentSlotHold.service.ts; reschedule keeps
 * this legacy shape until its tagged dual-write lands in the following commit.
 * `excludeReservationId` lets reschedule skip counting the reservation being
 * moved against its own target slot.
 */
async function holdAppointmentSlot(args: {
  venueId: string
  startsAt: Date
  endsAt: Date
  productIds: string[]
  partySize: number
  fingerprint: string | null
  pacingMax: number
  excludeReservationId?: string
}): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + SLOT_HOLD_TTL_MS)
  return prisma.$transaction(async tx => {
    const lockKey = `apt-hold:${args.venueId}`
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey})::bigint)`

    // External calendar busy-block check — reject so the customer never sees a
    // countdown for a slot the venue already blocked via Google Calendar.
    const externalBlock = await checkExternalBusyBlock(tx, {
      venueId: args.venueId,
      staffId: null,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
    })
    if (externalBlock) {
      throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
    }

    const { reservations, holds } = await countAppointmentOccupancy(tx, {
      venueId: args.venueId,
      startsAt: args.startsAt,
      endsAt: args.endsAt,
      excludeReservationId: args.excludeReservationId,
    })
    if (reservations + holds >= args.pacingMax) {
      throw new ConflictError('Este horario ya no está disponible. Por favor elige otro horario.')
    }
    return tx.slotHold.create({
      data: {
        venueId: args.venueId,
        startsAt: args.startsAt,
        endsAt: args.endsAt,
        productIds: args.productIds,
        classSessionId: null,
        partySize: Math.max(1, args.partySize),
        expiresAt,
        fingerprint: args.fingerprint,
      },
      select: { id: true, expiresAt: true },
    })
  })
}

/**
 * POST /public/venues/:venueSlug/reservations/hold
 *
 * Body: { startsAt, endsAt, productId?, productIds?, classSessionId?, partySize? }
 *
 * Creates a SlotHold row with TTL=10min and returns its id+expiresAt so the
 * widget can pass both into createReservation. Normal appointment holds use the
 * atomic Release A mint/consume protocol; legacy class and generic holds retain
 * their existing validation and post-commit cleanup until client coordination.
 *
 * Validations:
 *   - venue exists + has public booking enabled
 *   - startsAt < endsAt + endsAt within ~24h of startsAt (sanity)
 *   - productIds (if present) all belong to venue + non-CLASS
 *   - classSessionId (if present) belongs to venue
 */
export async function createHold(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    const settings = await getReservationSettings(venue.id)
    if (!settings.publicBooking.enabled) {
      throw new BadRequestError('Las reservaciones en linea no estan habilitadas')
    }

    const body = req.body as {
      startsAt: string
      endsAt: string
      productId?: string
      productIds?: string | string[]
      classSessionId?: string
      partySize?: number
      fingerprint?: string
      staffId?: string
      modifierSelections?: { productId: string; modifierId: string; quantity?: number }[]
      windowSemantics?: 'base'
    }

    const startsAt = new Date(body.startsAt)
    const endsAt = new Date(body.endsAt)
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new BadRequestError('Fechas invalidas')
    }
    if (endsAt <= startsAt) {
      throw new BadRequestError('endsAt debe ser posterior a startsAt')
    }
    if (endsAt.getTime() - startsAt.getTime() > 24 * 60 * 60 * 1000) {
      throw new BadRequestError('Ventana de reserva excede 24 horas')
    }
    if (startsAt.getTime() < Date.now() - 5 * 60 * 1000) {
      throw new BadRequestError('No se puede reservar un horario en el pasado')
    }

    // Before productId was accepted by this schema, class holds could carry a
    // shared-client scalar that validation stripped. Preserve that behavior:
    // only an explicit productIds field opts a class hold into list validation.
    const scalarProductId = body.classSessionId && body.productIds === undefined ? undefined : body.productId
    const { productIds } = normalizeBookedProductIds({ productId: scalarProductId, productIds: body.productIds })
    const isAppointmentHold = !body.classSessionId && productIds.length > 0
    if (!isAppointmentHold && productIds.length > 0) {
      const products = await prisma.product.findMany({
        where: { id: { in: productIds }, venueId: venue.id },
        select: { id: true, type: true },
      })
      if (products.length !== productIds.length) {
        throw new BadRequestError('Uno o mas productos no pertenecen a este venue')
      }
      if (products.some(p => p.type === 'CLASS')) {
        throw new BadRequestError('Los productos de tipo clase requieren classSessionId, no productIds')
      }
    }

    if (body.classSessionId) {
      const session = await prisma.classSession.findFirst({
        where: { id: body.classSessionId, venueId: venue.id },
        select: { id: true },
      })
      if (!session) {
        throw new NotFoundError('La sesion de clase no existe en este venue')
      }
    }

    // Lazy GC — cheap, runs once per hold creation.
    void pruneExpiredHolds()

    // For APPOINTMENTS_SERVICE holds we MUST serialize concurrent creates
    // for the same venue — otherwise two tabs both pass an unguarded count
    // and both succeed, leaving two phantom holds that block every later
    // reservation until they expire (~10 min). pg_advisory_xact_lock is
    // a cheap session-scoped lock released at transaction commit; collisions
    // wait microseconds. The lock key is venue-wide rather than per-slot
    // because Mindform-scale concurrency is low and per-slot keys complicate
    // overlap reasoning (two distinct slots can still overlap). Bumping
    // contention later is a one-line change.
    let hold: { id: string; expiresAt: Date; staffId?: string | null }
    if (isAppointmentHold) {
      hold = await mintNormalAppointmentHold({
        venueId: venue.id,
        startsAt,
        endsAt,
        productIds,
        partySize: body.partySize ?? 1,
        fingerprint: body.fingerprint ?? null,
        staffId: body.staffId,
        modifierSelections: body.modifierSelections,
        windowSemantics: body.windowSemantics,
      })
    } else {
      // Non-appointment holds (classes, generic) — wrap in a transaction so the
      // external busy-block check runs against the same snapshot the create
      // commits with.
      const expiresAt = new Date(Date.now() + SLOT_HOLD_TTL_MS)
      hold = await prisma.$transaction(async tx => {
        const externalBlock = await checkExternalBusyBlock(tx, {
          venueId: venue.id,
          staffId: null,
          startsAt,
          endsAt,
        })
        if (externalBlock) {
          throw new ConflictError('Este horario fue bloqueado por un evento de calendario externo')
        }
        return tx.slotHold.create({
          data: {
            venueId: venue.id,
            startsAt,
            endsAt,
            productIds,
            classSessionId: body.classSessionId ?? null,
            partySize: Math.max(1, body.partySize ?? 1),
            expiresAt,
            fingerprint: body.fingerprint ?? null,
          },
          select: { id: true, expiresAt: true },
        })
      })
    }

    res.status(201).json({
      holdId: hold.id,
      expiresAt: hold.expiresAt,
      ttlSeconds: Math.floor(SLOT_HOLD_TTL_MS / 1000),
      ...('staffId' in hold && hold.staffId ? { staffId: hold.staffId } : {}),
    })
  } catch (error) {
    next(error)
  }
}

/**
 * DELETE /public/venues/:venueSlug/reservations/hold/:holdId
 *
 * Releases a hold the customer no longer needs (e.g. they navigated back from
 * the form to pick a different slot). Idempotent — missing hold returns 204
 * so the widget can call this on every back-nav without worrying about state.
 */
export async function cancelHold(req: Request, res: Response, next: NextFunction) {
  try {
    const { venueSlug, holdId } = req.params
    const venue = await resolveVenueBySlug(venueSlug)

    await prisma.slotHold.deleteMany({
      where: { id: holdId, venueId: venue.id },
    })
    res.status(204).end()
  } catch (error) {
    next(error)
  }
}

/**
 * Validate a hold passed on createReservation. Returns the hold row if it is
 * valid and matches the booking, otherwise throws. The current caller deletes
 * it best-effort after the reservation has been written (so a failed create
 * doesn't strand the customer with no fallback); validation and deletion are
 * not atomic until the Release A protocol.
 *
 * Returns null when no holdId was passed — bookings without holds keep
 * working exactly as they did pre-hold-mechanism.
 */
export async function validateHoldForReservation(args: {
  venueId: string
  holdId: string | undefined | null
  startsAt: Date
  endsAt: Date
}): Promise<{ id: string } | null> {
  if (!args.holdId) return null
  const hold = await prisma.slotHold.findFirst({
    where: {
      id: args.holdId,
      venueId: args.venueId,
      expiresAt: { gt: new Date() },
    },
    select: { id: true, startsAt: true, endsAt: true },
  })
  if (!hold) {
    throw new ConflictError('Tu reserva temporal expiro. Selecciona el horario de nuevo.')
  }
  // Sanity: the hold must cover the same slot the customer is now booking.
  if (hold.startsAt.getTime() !== args.startsAt.getTime() || hold.endsAt.getTime() !== args.endsAt.getTime()) {
    throw new BadRequestError('La reserva temporal no corresponde al horario seleccionado')
  }
  return { id: hold.id }
}

// ==========================================
// CREDIT REDEMPTION (shared helper)
// ==========================================

/**
 * Redeems credits from one or more CreditItemBalance rows against a reservation.
 * Mirrors the inline class-path logic but works for any reservation type and
 * accepts an array of balance IDs so multi-service appointments can redeem
 * across products in a single transaction.
 *
 * Each balance is:
 *   1. Locked with FOR UPDATE
 *   2. Validated: belongs to customer, expected productId (when provided),
 *      sufficient quantity, parent purchase ACTIVE + not expired
 *   3. Decremented by `creditsPerBalance`
 *   4. Stamped with a REDEEM CreditTransaction
 *   5. Parent purchase flipped to EXHAUSTED if all balances drained
 *
 * Caller MUST pass a Prisma transaction client. We don't open one ourselves
 * because the class path already wraps everything in a tx and we want
 * everything-or-nothing semantics with the reservation insert.
 */
export async function redeemCreditsForReservation(
  tx: Prisma.TransactionClient,
  args: {
    venueId: string
    reservationId: string
    confirmationCode: string
    /** One balance ID per redemption (length 1 = legacy single-product). */
    balanceIds: string[]
    creditsPerBalance: number
    customerEmail?: string
    customerPhone?: string
    /** When provided, every balance.productId MUST match one of these (no
     *  random balance ID swapping for a different product). For multi-service
     *  redemption pass every selected service's productId. */
    expectedProductIds?: string[]
  },
): Promise<{ creditsUsed: number; redeemed: boolean }> {
  if (args.balanceIds.length === 0) {
    return { creditsUsed: 0, redeemed: false }
  }

  // Find customer by email/phone (same logic as class path).
  const customer = await tx.customer.findFirst({
    where: {
      venueId: args.venueId,
      OR: [...(args.customerEmail ? [{ email: args.customerEmail }] : []), ...(args.customerPhone ? [{ phone: args.customerPhone }] : [])],
    },
  })
  if (!customer) {
    throw new BadRequestError('No se encontro el cliente para canjear creditos')
  }

  let totalCreditsUsed = 0
  for (const balanceId of args.balanceIds) {
    const balances = await tx.$queryRaw<{ id: string; remainingQuantity: number; creditPackPurchaseId: string; productId: string }[]>`
      SELECT id, "remainingQuantity", "creditPackPurchaseId", "productId"
      FROM "CreditItemBalance"
      WHERE id = ${balanceId}
      FOR UPDATE
    `

    if (balances.length === 0) {
      throw new BadRequestError(`Balance de credito no encontrado: ${balanceId}`)
    }
    const balance = balances[0]

    if (args.expectedProductIds && !args.expectedProductIds.includes(balance.productId)) {
      throw new BadRequestError('El credito no corresponde a los servicios reservados')
    }

    if (balance.remainingQuantity < args.creditsPerBalance) {
      throw new BadRequestError(
        `No tienes suficientes creditos. Disponibles: ${balance.remainingQuantity}, necesarios: ${args.creditsPerBalance}.`,
      )
    }

    const purchase = await tx.creditPackPurchase.findUnique({
      where: { id: balance.creditPackPurchaseId },
      select: { status: true, expiresAt: true, customerId: true },
    })
    if (!purchase || purchase.customerId !== customer.id) {
      throw new BadRequestError('Credito no valido para este cliente')
    }
    if (purchase.status !== CreditPurchaseStatus.ACTIVE) {
      throw new BadRequestError('Los creditos ya no estan activos')
    }
    if (purchase.expiresAt && purchase.expiresAt < new Date()) {
      throw new BadRequestError('Los creditos han expirado')
    }

    await tx.creditItemBalance.update({
      where: { id: balanceId },
      data: { remainingQuantity: { decrement: args.creditsPerBalance } },
    })

    await tx.creditTransaction.create({
      data: {
        venueId: args.venueId,
        customerId: customer.id,
        creditPackPurchaseId: balance.creditPackPurchaseId,
        creditItemBalanceId: balanceId,
        type: 'REDEEM',
        quantity: -args.creditsPerBalance,
        reservationId: args.reservationId,
        reason: args.creditsPerBalance > 1 ? `Reserva de ${args.creditsPerBalance} creditos` : null,
      },
    })

    totalCreditsUsed += args.creditsPerBalance

    // Check if purchase is fully drained
    const remaining = await tx.creditItemBalance.findFirst({
      where: { creditPackPurchaseId: balance.creditPackPurchaseId, remainingQuantity: { gt: 0 } },
      select: { id: true },
    })
    if (!remaining) {
      await tx.creditPackPurchase.update({
        where: { id: balance.creditPackPurchaseId },
        data: { status: CreditPurchaseStatus.EXHAUSTED },
      })
    }
  }

  logger.info(
    `[CREDIT REDEEM] ${totalCreditsUsed} credit(s) redeemed across ${args.balanceIds.length} balance(s) for reservation ${args.confirmationCode}`,
  )

  return { creditsUsed: totalCreditsUsed, redeemed: true }
}
