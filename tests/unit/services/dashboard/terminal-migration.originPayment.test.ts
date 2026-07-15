import prisma from '@/utils/prismaClient'
import { resolveOriginPayment } from '@/services/dashboard/terminal-migration.service'

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    venuePaymentConfig: { findUnique: jest.fn() },
    organizationPaymentConfig: { findUnique: jest.fn() },
  },
}))

const m = prisma as unknown as {
  venuePaymentConfig: { findUnique: jest.Mock }
  organizationPaymentConfig: { findUnique: jest.Mock }
}

const VENUE_CFG = {
  primaryAccountId: 'merch-p',
  secondaryAccountId: 'merch-s',
  tertiaryAccountId: null,
  preferredProcessor: 'AUTO',
  routingRules: null,
}

describe('resolveOriginPayment', () => {
  beforeEach(() => {
    jest.clearAllMocks()
    m.venuePaymentConfig.findUnique.mockResolvedValue(null)
    m.organizationPaymentConfig.findUnique.mockResolvedValue(null)
  })

  it('copia la VenuePaymentConfig propia del origen', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue(VENUE_CFG)
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.merchantIds).toEqual(['merch-p', 'merch-s'])
    expect(r.copyable?.primaryAccountId).toBe('merch-p')
  })

  it('cae a la OrganizationPaymentConfig heredada cuando el origen no tiene propia', async () => {
    m.organizationPaymentConfig.findUnique.mockResolvedValue({ ...VENUE_CFG, primaryAccountId: 'merch-org' })
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.merchantIds).toContain('merch-org')
    expect(r.copyable?.primaryAccountId).toBe('merch-org')
  })

  it('los assignedMerchantIds de la terminal ganan sobre la config del venue', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue(VENUE_CFG)
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: ['merch-term'] }, 'org-1')
    expect(r.merchantIds).toEqual(['merch-term'])
  })

  it('sin config alguna, construye copyable desde los assignedMerchantIds', async () => {
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: ['merch-term'] }, 'org-1')
    expect(r.copyable).toEqual({
      primaryAccountId: 'merch-term',
      secondaryAccountId: null,
      tertiaryAccountId: null,
      preferredProcessor: 'AUTO',
      routingRules: null,
    })
  })

  it('sin config y sin merchants → nada que llevar', async () => {
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.merchantIds).toEqual([])
    expect(r.copyable).toBeNull()
  })

  it('no consulta la org cuando originOrgId es null', async () => {
    await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, null)
    expect(m.organizationPaymentConfig.findUnique).not.toHaveBeenCalled()
  })

  // El caso de los 18 de 78: la terminal cobra con un merchant distinto al default
  // de su sucursal. copyable DEBE seguir a la terminal, no al default viejo.
  // ('MENTA' en vez de 'BLUMON': el enum PaymentProcessor real es
  //  LEGACY | MENTA | CLIP | BANK_DIRECT | AUTO. Lo que importa es que sea != AUTO.)
  it('copyable sigue a la terminal cuando difiere del default del venue', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue({ ...VENUE_CFG, preferredProcessor: 'MENTA', routingRules: { r: 1 } })
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: ['merch-term'] }, 'org-1')
    expect(r.copyable).toEqual({
      primaryAccountId: 'merch-term', // NO 'merch-p'
      secondaryAccountId: null,
      tertiaryAccountId: null,
      preferredProcessor: 'MENTA', // la política sí se hereda del venue origen
      routingRules: null, // se anula: nombra slots de una jerarquía que acabamos de redefinir
    })
  })

  it('sin override de la terminal, copyable equivale a copiar la fila del venue', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue(VENUE_CFG)
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.copyable).toEqual({
      primaryAccountId: 'merch-p',
      secondaryAccountId: 'merch-s',
      tertiaryAccountId: null,
      preferredProcessor: 'AUTO',
      routingRules: null,
    })
  })

  // Sin override copiamos la fila VERBATIM: los slots primary/secondary/tertiary son
  // una jerarquía, y `routingRules` los nombra por nombre ({"factura":"secondary"}).
  // Compactar el hueco ascendería el tertiary al slot secondary y la regla pasaría a
  // apuntar a otro merchant.
  it('sin override, un cfg con hueco conserva los slots exactos (no se compacta)', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue({
      primaryAccountId: 'a',
      secondaryAccountId: null,
      tertiaryAccountId: 'c',
      preferredProcessor: 'AUTO',
      routingRules: { factura: 'tertiary' },
    })
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: [] }, 'org-1')
    expect(r.copyable).toEqual({
      primaryAccountId: 'a',
      secondaryAccountId: null, // NO 'c' — el hueco se preserva
      tertiaryAccountId: 'c',
      preferredProcessor: 'AUTO',
      routingRules: { factura: 'tertiary' },
    })
  })

  it('con override, las routingRules del venue se anulan (no sobreviven a la nueva jerarquía)', async () => {
    m.venuePaymentConfig.findUnique.mockResolvedValue({
      ...VENUE_CFG,
      preferredProcessor: 'CLIP',
      routingRules: { factura: 'secondary', amount_over: 1000 },
    })
    const r = await resolveOriginPayment({ venueId: 'v-old', assignedMerchantIds: ['merch-term', 'merch-term-2'] }, 'org-1')
    expect(r.copyable?.routingRules).toBeNull()
    expect(r.copyable?.primaryAccountId).toBe('merch-term')
    expect(r.copyable?.secondaryAccountId).toBe('merch-term-2')
    expect(r.copyable?.preferredProcessor).toBe('CLIP') // la política sí sobrevive: no nombra slots
  })
})
