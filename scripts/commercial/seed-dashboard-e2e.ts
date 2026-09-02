import bcrypt from 'bcryptjs'
import {
  OrgRole,
  PlanTier,
  PrismaClient,
  StaffRole,
  VenueStatus,
  VerificationStatus,
} from '@prisma/client'

import {
  assertDashboardE2eSeedTarget,
  DASHBOARD_E2E_SEED_IDENTITY,
} from './dashboard-e2e-seed-plan'

assertDashboardE2eSeedTarget(process.env.DATABASE_URL)
if (process.env.NODE_ENV !== 'test') throw new Error('COMMERCIAL_DASHBOARD_E2E_SEED_NODE_ENV_REJECTED')

const prisma = new PrismaClient()

async function seed(): Promise<void> {
  const identity = DASHBOARD_E2E_SEED_IDENTITY
  const password = await bcrypt.hash(identity.password, 4)
  const completedAt = new Date('2026-09-02T06:00:00.000Z')

  await prisma.$transaction(async tx => {
    const organization = await tx.organization.upsert({
      where: { slug: identity.organizationSlug },
      update: {
        seatCapExempt: identity.seatCapExempt,
        onboardingCompletedAt: completedAt,
      },
      create: {
        name: 'Avoqado Commercial E2E',
        slug: identity.organizationSlug,
        email: identity.email,
        phone: '+525500000000',
        seatCapExempt: identity.seatCapExempt,
        onboardingCompletedAt: completedAt,
      },
    })

    const venue = await tx.venue.upsert({
      where: { slug: identity.venueSlug },
      update: {
        organizationId: organization.id,
        active: true,
        status: VenueStatus.ACTIVE,
        kycStatus: VerificationStatus.NOT_SUBMITTED,
        planTier: PlanTier.PRO,
        seatCapExempt: identity.seatCapExempt,
        onboardingCompletedAt: completedAt,
      },
      create: {
        organizationId: organization.id,
        name: 'Avoqado Commercial E2E',
        slug: identity.venueSlug,
        active: true,
        status: VenueStatus.ACTIVE,
        kycStatus: VerificationStatus.NOT_SUBMITTED,
        planTier: PlanTier.PRO,
        seatCapExempt: identity.seatCapExempt,
        onboardingCompletedAt: completedAt,
        timezone: 'America/Mexico_City',
        currency: 'MXN',
        language: 'es',
        city: 'Ciudad de México',
        country: 'MX',
        primaryColor: '#65A30D',
      },
    })

    await tx.venueSettings.upsert({
      where: { venueId: venue.id },
      update: {},
      create: { venueId: venue.id },
    })
    await tx.reservationSettings.upsert({
      where: { venueId: venue.id },
      update: {
        publicBookingEnabled: true,
        remindersEnabled: identity.remindersEnabled,
        reminderChannels: ['EMAIL', 'SMS', 'WHATSAPP'],
      },
      create: {
        venueId: venue.id,
        publicBookingEnabled: true,
        remindersEnabled: identity.remindersEnabled,
        reminderChannels: ['EMAIL', 'SMS', 'WHATSAPP'],
      },
    })

    const staff = await tx.staff.upsert({
      where: { email: identity.email },
      update: {
        password,
        active: true,
        emailVerified: identity.emailVerified,
      },
      create: {
        email: identity.email,
        password,
        firstName: 'Commercial',
        lastName: 'E2E',
        active: true,
        emailVerified: identity.emailVerified,
      },
    })

    await tx.staffOrganization.upsert({
      where: { staffId_organizationId: { staffId: staff.id, organizationId: organization.id } },
      update: { role: OrgRole.OWNER, isPrimary: true, isActive: true },
      create: {
        staffId: staff.id,
        organizationId: organization.id,
        role: OrgRole.OWNER,
        isPrimary: true,
        isActive: true,
      },
    })
    await tx.staffVenue.upsert({
      where: { staffId_venueId: { staffId: staff.id, venueId: venue.id } },
      update: { role: StaffRole.SUPERADMIN, active: true, permissions: null },
      create: {
        staffId: staff.id,
        venueId: venue.id,
        role: StaffRole.SUPERADMIN,
        active: true,
      },
    })
  })
}

seed()
  .then(() => {
    console.log(`DASHBOARD_E2E_SEED_READY venue=${DASHBOARD_E2E_SEED_IDENTITY.venueSlug}`)
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : 'COMMERCIAL_DASHBOARD_E2E_SEED_FAILED')
    process.exitCode = 1
  })
