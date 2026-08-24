import {
  classifyUndeliverable,
  filterDeliverableRecipients,
  isDeliverableRecipient,
  isUndeliverableEmail,
  partitionRecipients,
  SEED_ROLE_NAMES,
} from '@/utils/undeliverableEmail'
import logger from '@/config/logger'

/**
 * Fixtures are REAL production recipients, taken from a read-only survey of the
 * prod `Staff` table on 2026-08-23 while chasing a daily hard-bounce flow out of
 * `nightly-low-stock`. Keeping the real strings here is deliberate: the point of
 * this guard is that these exact addresses stop reaching Resend.
 */
describe('classifyUndeliverable', () => {
  describe('RESERVED_TLD — RFC 2606 / 6761 / 6762, never routable on the public internet', () => {
    it.each([
      'emilio-morayta@testarudo-cafe.pos.local',
      'mesero-01@testarudo-cafe.pos.local',
      'someone@build.test',
      'someone@nowhere.invalid',
      'someone@my.localhost',
      'someone@shop.example',
    ])('blocks %s', email => {
      expect(classifyUndeliverable(email)).toBe('RESERVED_TLD')
    })
  })

  describe('RESERVED_DOMAIN — RFC 2606 example domains', () => {
    it.each(['test@example.com', 'a@example.net', 'b@example.org', 'c@sub.example.com'])('blocks %s', email => {
      expect(classifyUndeliverable(email)).toBe('RESERVED_DOMAIN')
    })
  })

  describe('PLACEHOLDER_DOMAIN — subdomains of avoqado.io that Avoqado generates itself', () => {
    it.each([
      'tpv-keppler-1776271462836-3w4w0u@internal.avoqado.io',
      'tpv-doña-simona-1777398669306-ppf9v0@internal.avoqado.io',
      'luis.castro@avoqado-full.avoqado.io',
      'sofia.herrera@avoqado-full.avoqado.io',
      'deleted-cmhvejhd800al2gtxjlbmm4kn@deleted.avoqado.io',
    ])('blocks %s', email => {
      expect(classifyUndeliverable(email)).toBe('PLACEHOLDER_DOMAIN')
    })

    it('does NOT block the real corporate mail domain', () => {
      expect(classifyUndeliverable('owner@avoqado.io')).toBeNull()
      expect(classifyUndeliverable('admin@avoqado.io')).toBeNull()
      expect(classifyUndeliverable('onboarding@avoqado.io')).toBeNull()
    })
  })

  describe('SEED_ACCOUNT — role name repeated as its own domain, planted by demo/seed scripts', () => {
    it.each([
      'owner@owner.com',
      'admin@admin.com',
      'manager@manager.com',
      'admin2@admin2.com',
      'manager2@manager2.com',
      'superadmin@superadmin.com',
      'cashier@cashier.com',
      'cashier2@cashier2.com',
      'waiter2@waiter2.com',
      'host@host.com',
      'host2@host2.com',
      'kitchen@kitchen.com',
      'kitchen2@kitchen2.com',
      'viewer@viewer.com',
      'viewer2@viewer2.com',
    ])('blocks %s', email => {
      expect(classifyUndeliverable(email)).toBe('SEED_ACCOUNT')
    })

    it('blocks a seed variant that does not exist yet (admin3@admin3.com)', () => {
      expect(classifyUndeliverable('admin3@admin3.com')).toBe('SEED_ACCOUNT')
    })

    it('does NOT block a real business whose mailbox happens to repeat its own name', () => {
      // Real Avoqado client. The rule must key on Avoqado ROLE names, never on
      // "local part equals domain label", which would silence this one.
      expect(classifyUndeliverable('mindform@mindform.com.mx')).toBeNull()
      expect(classifyUndeliverable('info@info.com')).toBeNull()
      expect(classifyUndeliverable('news@news.com')).toBeNull()
    })

    it('does NOT block a role name on an unrelated real domain', () => {
      expect(classifyUndeliverable('admin@mindform.com.mx')).toBeNull()
      expect(classifyUndeliverable('owner@gmail.com')).toBeNull()
    })
  })

  describe('MALFORMED', () => {
    it.each(['', '   ', 'no-arroba', 'two@@at.com', '@nolocal.com', 'nodomain@', 'spaced out@mail.com'])('blocks %p', email => {
      expect(classifyUndeliverable(email)).toBe('MALFORMED')
    })

    it('treats null/undefined as malformed', () => {
      expect(classifyUndeliverable(null as unknown as string)).toBe('MALFORMED')
      expect(classifyUndeliverable(undefined as unknown as string)).toBe('MALFORMED')
    })
  })

  describe('real recipients that MUST keep receiving mail', () => {
    it.each([
      'mindformhouse@gmail.com',
      'fatimaflores6689@gmail.com',
      'anasoglzt3@gmail.com',
      'joseamica@gmail.com',
      'jo_amieva7@hotmail.com',
      'daguirrec.91@gmail.com',
      'contacto@testarudocafe.com',
      'ventas@makadi.mx',
      'soporte@playtelecom.com',
      'onboarding@avoqado.io',
    ])('lets %s through', email => {
      expect(classifyUndeliverable(email)).toBeNull()
      expect(isUndeliverableEmail(email)).toBe(false)
    })
  })

  describe('normalisation', () => {
    it('is case-insensitive', () => {
      expect(classifyUndeliverable('ADMIN@ADMIN.COM')).toBe('SEED_ACCOUNT')
      expect(classifyUndeliverable('Luis.Castro@Avoqado-Full.Avoqado.IO')).toBe('PLACEHOLDER_DOMAIN')
    })

    it('ignores surrounding whitespace', () => {
      expect(classifyUndeliverable('  admin@admin.com  ')).toBe('SEED_ACCOUNT')
      expect(classifyUndeliverable('  mindformhouse@gmail.com  ')).toBeNull()
    })

    it('accepts the "Name <addr>" form and classifies the address inside', () => {
      expect(classifyUndeliverable('Luis Castro <luis.castro@avoqado-full.avoqado.io>')).toBe('PLACEHOLDER_DOMAIN')
      expect(classifyUndeliverable('Mindform <mindformhouse@gmail.com>')).toBeNull()
    })
  })
})

describe('isUndeliverableEmail', () => {
  it('is true for every blocked class', () => {
    expect(isUndeliverableEmail('admin@admin.com')).toBe(true)
    expect(isUndeliverableEmail('tpv-iq-1778001255931-gxishc@internal.avoqado.io')).toBe(true)
    expect(isUndeliverableEmail('mesero-01@testarudo-cafe.pos.local')).toBe(true)
    expect(isUndeliverableEmail('test@example.com')).toBe(true)
    expect(isUndeliverableEmail('garbage')).toBe(true)
  })

  it('is false for deliverable addresses', () => {
    expect(isUndeliverableEmail('mindformhouse@gmail.com')).toBe(false)
  })
})

describe('SEED_ROLE_NAMES stays mirrored to the StaffRole enum', () => {
  // The module under test must NOT import @prisma/client: doing so runs dotenv
  // as a side effect and revives process.env (it broke three resend.service
  // tests that assert "no API key → do not send"). So the list is a literal,
  // and this test is what keeps it honest. A test file may import Prisma freely.
  it('covers every StaffRole, lowercased', () => {
    const { StaffRole } = require('@prisma/client')
    const fromPrisma = Object.values(StaffRole as Record<string, string>)
      .map(r => r.toLowerCase())
      .sort()

    expect([...SEED_ROLE_NAMES].sort()).toEqual(fromPrisma)
  })
})

describe('isDeliverableRecipient', () => {
  beforeEach(() => (logger.warn as jest.Mock).mockClear())

  it('lets a real address through without logging', () => {
    expect(isDeliverableRecipient('mindformhouse@gmail.com', 'someSender')).toBe(true)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('blocks and logs the reason plus the call site', () => {
    expect(isDeliverableRecipient('admin@admin.com', 'sendOnboardingWelcomeEmail')).toBe(false)

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringMatching(/undeliverable/i),
      expect.objectContaining({ to: 'admin@admin.com', reason: 'SEED_ACCOUNT', source: 'sendOnboardingWelcomeEmail' }),
    )
  })

  it('carries the extra meta so the log says which venue or subject it was', () => {
    isDeliverableRecipient('luis.castro@avoqado-full.avoqado.io', 'emailService.sendEmail', { subject: 'Inventario bajo' })

    expect((logger.warn as jest.Mock).mock.calls[0][1]).toMatchObject({ subject: 'Inventario bajo' })
  })
})

describe('partitionRecipients / filterDeliverableRecipients', () => {
  const mixed = ['mindformhouse@gmail.com', 'admin@admin.com', 'isaac.mayoral@playtelecom.com', 'tpv-iq-1@internal.avoqado.io']

  beforeEach(() => (logger.warn as jest.Mock).mockClear())

  it('splits the list without reordering the survivors', () => {
    const { deliverable, blocked } = partitionRecipients(mixed)

    expect(deliverable).toEqual(['mindformhouse@gmail.com', 'isaac.mayoral@playtelecom.com'])
    expect(blocked).toEqual([
      { email: 'admin@admin.com', reason: 'SEED_ACCOUNT' },
      { email: 'tpv-iq-1@internal.avoqado.io', reason: 'PLACEHOLDER_DOMAIN' },
    ])
  })

  it('returns only the deliverable ones and logs what it dropped', () => {
    expect(filterDeliverableRecipients(mixed, 'sendBadReviewEmail')).toEqual(['mindformhouse@gmail.com', 'isaac.mayoral@playtelecom.com'])

    expect((logger.warn as jest.Mock).mock.calls[0][1]).toMatchObject({ source: 'sendBadReviewEmail', kept: 2 })
  })

  it('stays quiet when every recipient is fine', () => {
    expect(filterDeliverableRecipients(['a@gmail.com', 'b@hotmail.com'], 'sendBadReviewEmail')).toHaveLength(2)
    expect(logger.warn).not.toHaveBeenCalled()
  })

  it('returns an empty list when every recipient is blocked — callers must handle it', () => {
    expect(filterDeliverableRecipients(['admin@admin.com', 'owner@owner.com'], 'sendBadReviewEmail')).toEqual([])
  })

  it('handles an empty input list', () => {
    expect(filterDeliverableRecipients([], 'sendBadReviewEmail')).toEqual([])
    expect(logger.warn).not.toHaveBeenCalled()
  })
})
