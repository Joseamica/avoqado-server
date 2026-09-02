export const DASHBOARD_E2E_SEED_IDENTITY = Object.freeze({
  email: 'commercial-dashboard-e2e@avoqado.test',
  password: 'synthetic-dashboard-e2e-only',
  organizationSlug: 'avoqado-commercial-e2e',
  venueSlug: 'avoqado-commercial-e2e',
  staffVenueRole: 'SUPERADMIN',
  staffOrganizationRole: 'OWNER',
  emailVerified: true,
  venueStatus: 'ACTIVE',
  seatCapExempt: true,
  remindersEnabled: true,
} as const)

const DATABASE_NAME = /^avoqado_commercial_dashboard_e2e_[0-9]+_[0-9]+_[a-f0-9]{8}_test$/u

export function assertDashboardE2eSeedTarget(raw: string | undefined): URL {
  try {
    if (!raw) throw new Error('missing')
    const url = new URL(raw)
    const databaseName = url.pathname.replace(/^\//u, '')
    if (
      !['postgres:', 'postgresql:'].includes(url.protocol) ||
      !['127.0.0.1', 'localhost'].includes(url.hostname) ||
      !url.username ||
      !url.password ||
      !DATABASE_NAME.test(databaseName)
    ) {
      throw new Error('unsafe')
    }
    return url
  } catch {
    throw new Error('COMMERCIAL_DASHBOARD_E2E_SEED_TARGET_REJECTED')
  }
}
