import { Prisma, ProductType, VenueStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { NotFoundError } from '@/errors/AppError'
import { getReservationSettings } from '@/services/dashboard/reservationSettings.service'

const bookableProductTypes = [ProductType.APPOINTMENTS_SERVICE, ProductType.EVENT, ProductType.CLASS]

const bookableVenueWhere: Prisma.VenueWhereInput = {
  active: true,
  status: { notIn: [VenueStatus.SUSPENDED, VenueStatus.ADMIN_SUSPENDED, VenueStatus.CLOSED] },
  reservationSettings: { publicBookingEnabled: true },
  products: {
    some: {
      active: true,
      type: { in: bookableProductTypes },
    },
  },
}

function toNumber(value: unknown): number | null {
  if (value == null) return null
  return Number(value)
}

export async function searchVenues(input: { q?: string; city?: string; limit: number }) {
  const q = input.q?.trim()
  const city = input.city?.trim()

  const venues = await prisma.venue.findMany({
    where: {
      ...bookableVenueWhere,
      ...(city ? { city: { contains: city, mode: 'insensitive' } } : {}),
      ...(q
        ? {
            OR: [
              { name: { contains: q, mode: 'insensitive' } },
              { address: { contains: q, mode: 'insensitive' } },
              { city: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      type: true,
      address: true,
      city: true,
      state: true,
      latitude: true,
      longitude: true,
      timezone: true,
      primaryColor: true,
      products: {
        where: { active: true, type: { in: bookableProductTypes } },
        select: { id: true, name: true, type: true, price: true, duration: true },
        orderBy: { name: 'asc' },
        take: 3,
      },
    },
    orderBy: [{ name: 'asc' }],
    take: input.limit,
  })

  return {
    venues: venues.map(venue => ({
      ...venue,
      latitude: toNumber(venue.latitude),
      longitude: toNumber(venue.longitude),
      products: venue.products.map(product => ({
        ...product,
        price: product.price == null ? null : Number(product.price),
      })),
    })),
  }
}

export async function getVenueDetail(venueSlug: string) {
  const venue = await prisma.venue.findFirst({
    where: {
      slug: venueSlug,
      ...bookableVenueWhere,
    },
    select: {
      id: true,
      name: true,
      slug: true,
      logo: true,
      type: true,
      address: true,
      city: true,
      state: true,
      phone: true,
      email: true,
      website: true,
      latitude: true,
      longitude: true,
      timezone: true,
      primaryColor: true,
      products: {
        where: { active: true, type: { in: bookableProductTypes } },
        select: {
          id: true,
          name: true,
          price: true,
          duration: true,
          eventCapacity: true,
          type: true,
          maxParticipants: true,
          layoutConfig: true,
          requireCreditForBooking: true,
        },
        orderBy: { name: 'asc' },
      },
    },
  })

  if (!venue) throw new NotFoundError('Negocio no encontrado')

  const settings = await getReservationSettings(venue.id)

  return {
    ...venue,
    latitude: toNumber(venue.latitude),
    longitude: toNumber(venue.longitude),
    products: venue.products.map(product => ({
      ...product,
      price: product.price == null ? null : Number(product.price),
    })),
    publicBooking: settings.publicBooking,
    operatingHours: settings.operatingHours,
  }
}
