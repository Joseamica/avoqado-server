/**
 * Integration test (REAL DB): name-backfill on first WhatsApp login must find a
 * past guest reservation even when guestPhone has embedded formatting
 * (spaces/dashes) — the bug /full-testing surfaced.
 *
 * @see src/services/public/otpAuth.public.service.ts (findGuestNameFromPastReservations)
 */
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.OTP_PEPPER = process.env.OTP_PEPPER || 'test-pepper-backfill'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.REFRESH_TOKEN_SECRET = process.env.REFRESH_TOKEN_SECRET || 'test-refresh-secret'

import '../../__helpers__/integration-setup'
import crypto from 'crypto'
import prisma from '@/utils/prismaClient'
import { verifyOtp } from '@/services/public/otpAuth.public.service'

// Mirror lib/otp.hashOtpCode so we can plant a challenge the code will accept.
function hashOtpCode(code: string): string {
  return crypto.createHash('sha256').update(`${code}:${process.env.OTP_PEPPER}`).digest('hex')
}

describe('OTP name backfill — formatted guestPhone (integration, real DB)', () => {
  let orgId: string
  let venueId: string
  const PHONE_E164 = '+525599990001'
  const RESERVATION_CODE = 'ITEST-BACKFILL-01'

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Backfill Org', email: `itest-backfill-${Date.now()}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = await prisma.venue.create({
      data: {
        name: 'ITEST Backfill Venue',
        slug: `itest-backfill-${Date.now()}`,
        organizationId: orgId,
        address: 'X',
        city: 'X',
        state: 'X',
        country: 'MX',
        zipCode: '00000',
        timezone: 'America/Mexico_City',
      },
    })
    venueId = venue.id
    // Past guest reservation with a FORMATTED phone (spaces inside the last 10 chars).
    await prisma.reservation.create({
      data: {
        venueId,
        confirmationCode: RESERVATION_CODE,
        startsAt: new Date(Date.now() - 86400000),
        endsAt: new Date(Date.now() - 86400000 + 3600000),
        duration: 60,
        guestName: 'Ana TESTNAME',
        guestPhone: '55 9999 0001',
        guestEmail: null,
      },
    })
    // Plant an unconsumed OTP challenge the verify path will accept.
    await prisma.otpChallenge.create({
      data: {
        channel: 'whatsapp',
        destination: PHONE_E164,
        codeHash: hashOtpCode('123456'),
        expiresAt: new Date(Date.now() + 600000),
      },
    })
  })

  afterAll(async () => {
    await prisma.customer.deleteMany({ where: { venueId } })
    await prisma.reservation.deleteMany({ where: { venueId } })
    await prisma.otpChallenge.deleteMany({ where: { destination: PHONE_E164 } })
    await prisma.consumer.deleteMany({ where: { phone: PHONE_E164 } })
    await prisma.venue.deleteMany({ where: { id: venueId } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  it('backfills firstName from a formatted-phone reservation', async () => {
    const result = await verifyOtp({ venueId, channel: 'whatsapp', destination: PHONE_E164, code: '123456' })
    expect(result.customer.firstName).toBe('Ana')
    expect(result.customer.lastName).toBe('TESTNAME')
  })
})
