/**
 * Customer Portal Public Service
 *
 * Handles:
 * - Customer registration (email + password)
 * - Customer login
 * - Portal data (credits + reservations)
 *
 * Uses existing Customer.password field — no new tables.
 */

import bcrypt from 'bcryptjs'
import { CreditPurchaseStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { BadRequestError, UnauthorizedError } from '@/errors/AppError'
import { generateCustomerToken } from '@/jwt.service'

const SALT_ROUNDS = 10

/**
 * Register a new customer account (or set password on existing customer)
 */
export async function registerCustomer(
  venueId: string,
  data: { email: string; password: string; phone?: string; firstName?: string; lastName?: string },
) {
  const { email, password, phone, firstName, lastName } = data

  // Check if customer with this email already exists
  const existing = await prisma.customer.findUnique({
    where: { venueId_email: { venueId, email } },
  })

  if (existing?.password) {
    throw new BadRequestError('Ya existe una cuenta con este correo. Inicia sesión.')
  }

  const hashedPassword = await bcrypt.hash(password, SALT_ROUNDS)

  let customer
  if (existing) {
    // Customer exists (created from booking/credit purchase) — set password
    customer = await prisma.customer.update({
      where: { id: existing.id },
      data: {
        password: hashedPassword,
        provider: 'EMAIL',
        ...(phone && !existing.phone ? { phone } : {}),
        ...(firstName && !existing.firstName ? { firstName } : {}),
        ...(lastName && !existing.lastName ? { lastName } : {}),
      },
    })
  } else {
    // Check if phone is already taken
    if (phone) {
      const phoneExists = await prisma.customer.findUnique({
        where: { venueId_phone: { venueId, phone } },
      })
      if (phoneExists?.password) {
        throw new BadRequestError('Ya existe una cuenta con este teléfono.')
      }
      if (phoneExists) {
        // Phone customer exists without password — merge by setting email + password
        customer = await prisma.customer.update({
          where: { id: phoneExists.id },
          data: {
            email,
            password: hashedPassword,
            provider: 'EMAIL',
            ...(firstName ? { firstName } : {}),
            ...(lastName ? { lastName } : {}),
          },
        })
      }
    }

    if (!customer) {
      customer = await prisma.customer.create({
        data: {
          venueId,
          email,
          phone: phone || null,
          password: hashedPassword,
          provider: 'EMAIL',
          firstName: firstName || null,
          lastName: lastName || null,
        },
      })
    }
  }

  const token = generateCustomerToken(customer.id, venueId)

  return {
    token,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
  }
}

/**
 * Login with email + password
 */
export async function loginCustomer(venueId: string, email: string, password: string) {
  const customer = await prisma.customer.findUnique({
    where: { venueId_email: { venueId, email } },
  })

  if (!customer || !customer.password) {
    throw new UnauthorizedError('Correo o contraseña incorrectos')
  }

  const valid = await bcrypt.compare(password, customer.password)
  if (!valid) {
    throw new UnauthorizedError('Correo o contraseña incorrectos')
  }

  const token = generateCustomerToken(customer.id, venueId)

  return {
    token,
    customer: {
      id: customer.id,
      firstName: customer.firstName,
      lastName: customer.lastName,
      email: customer.email,
      phone: customer.phone,
    },
  }
}

/**
 * Update customer profile (authenticated)
 */
export async function updateProfile(venueId: string, customerId: string, data: { firstName?: string; lastName?: string; phone?: string }) {
  // If phone is being updated, check uniqueness
  if (data.phone) {
    const phoneExists = await prisma.customer.findUnique({
      where: { venueId_phone: { venueId, phone: data.phone } },
    })
    if (phoneExists && phoneExists.id !== customerId) {
      throw new BadRequestError('Este teléfono ya está registrado con otra cuenta')
    }
  }

  const customer = await prisma.customer.update({
    where: { id: customerId },
    data: {
      ...(data.firstName !== undefined ? { firstName: data.firstName } : {}),
      ...(data.lastName !== undefined ? { lastName: data.lastName } : {}),
      ...(data.phone !== undefined ? { phone: data.phone } : {}),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
    },
  })

  return { customer }
}

/**
 * Get all customer portal data (requires authenticated customer)
 */
export async function getCustomerPortal(venueId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, venueId },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      loyaltyPoints: true,
      totalVisits: true,
    },
  })

  if (!customer) {
    return { customer: null, credits: { purchases: [] }, reservations: { upcoming: [], past: [] } }
  }

  const now = new Date()
  const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)

  // Build contact filter for reservations (customer may have booked with phone/email before account)
  const contactFilter = [
    { customerId: customer.id },
    ...(customer.phone ? [{ guestPhone: customer.phone }] : []),
    ...(customer.email ? [{ guestEmail: customer.email }] : []),
  ]

  const [purchases, upcomingReservations, pastReservations] = await Promise.all([
    prisma.creditPackPurchase.findMany({
      where: {
        venueId,
        customerId: customer.id,
        status: CreditPurchaseStatus.ACTIVE,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      include: {
        creditPack: { select: { name: true } },
        itemBalances: {
          where: {
            remainingQuantity: { gt: 0 },
            product: { allowCreditRedemption: true },
          },
          include: {
            product: { select: { id: true, name: true, type: true, imageUrl: true } },
          },
        },
      },
      orderBy: { expiresAt: 'asc' },
    }),

    prisma.reservation.findMany({
      where: {
        venueId,
        startsAt: { gte: now },
        status: { in: ['PENDING', 'CONFIRMED'] },
        OR: contactFilter,
      },
      select: {
        confirmationCode: true,
        cancelSecret: true,
        status: true,
        startsAt: true,
        endsAt: true,
        duration: true,
        partySize: true,
        guestName: true,
        spotIds: true,
        product: { select: { id: true, name: true, price: true } },
      },
      orderBy: { startsAt: 'asc' },
      take: 20,
    }),

    prisma.reservation.findMany({
      where: {
        venueId,
        startsAt: { lt: now, gte: thirtyDaysAgo },
        OR: contactFilter,
      },
      select: {
        confirmationCode: true,
        status: true,
        startsAt: true,
        endsAt: true,
        duration: true,
        partySize: true,
        guestName: true,
        product: { select: { id: true, name: true, price: true } },
      },
      orderBy: { startsAt: 'desc' },
      take: 20,
    }),
  ])

  return {
    customer,
    credits: { purchases },
    reservations: {
      upcoming: upcomingReservations,
      past: pastReservations,
    },
  }
}
