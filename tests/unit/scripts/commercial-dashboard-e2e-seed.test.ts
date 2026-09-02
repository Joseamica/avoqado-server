import {
  assertDashboardE2eSeedTarget,
  DASHBOARD_E2E_SEED_IDENTITY,
} from '../../../scripts/commercial/dashboard-e2e-seed-plan'

describe('commercial Dashboard E2E seed boundary', () => {
  it('accepts only a dedicated loopback database with credentials', () => {
    expect(() =>
      assertDashboardE2eSeedTarget(
        'postgresql://avoqado_test:synthetic@127.0.0.1:5432/avoqado_commercial_dashboard_e2e_123_1725000000000_abcdef12_test',
      ),
    ).not.toThrow()

    for (const unsafe of [
      'postgresql://avoqado_test:synthetic@127.0.0.1:5432/avoqado',
      'postgresql://avoqado_test:synthetic@db.example.com:5432/avoqado_commercial_dashboard_e2e_123_1725000000000_abcdef12_test',
      'postgresql://127.0.0.1:5432/avoqado_commercial_dashboard_e2e_123_1725000000000_abcdef12_test',
      '',
    ]) {
      expect(() => assertDashboardE2eSeedTarget(unsafe)).toThrow('COMMERCIAL_DASHBOARD_E2E_SEED_TARGET_REJECTED')
    }
  })

  it('seeds a verified superadmin membership without making KYC an auth prerequisite', () => {
    expect(DASHBOARD_E2E_SEED_IDENTITY).toMatchObject({
      email: 'commercial-dashboard-e2e@avoqado.test',
      password: 'synthetic-dashboard-e2e-only',
      venueSlug: 'avoqado-commercial-e2e',
      staffVenueRole: 'SUPERADMIN',
      staffOrganizationRole: 'OWNER',
      emailVerified: true,
      venueStatus: 'ACTIVE',
      seatCapExempt: true,
      remindersEnabled: true,
    })
  })
})
