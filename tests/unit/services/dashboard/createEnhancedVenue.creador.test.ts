// tests/unit/services/dashboard/createEnhancedVenue.creador.test.ts
// hz:nube0000:na5adb84 (1a): el alta avanzada (`POST /dashboard/venues/enhanced`) tenía comentada la fila de personal de quien
// crea el negocio. El negocio nacía sin ningún `StaffVenue` y su creador recibía 403 al abrirlo (activar cobros, KYC). Ahora
// queda con el rol que tiene donde se revisó su permiso (el dueño de la organización resuelve OWNER, como en el registro), DENTRO
// de la transacción del alta. Codex r1 #1: nunca se sube a OWNER (una fila OWNER cuenta como «dueño de la organización»).
// Codex r1 #2: el negocio nace en la organización del negocio donde se revisó el permiso, no en la del token.
import { prismaMock } from '@tests/__helpers__/setup'
import { createEnhancedVenue } from '@/services/dashboard/venue.dashboard.service'

jest.mock('@/services/stripe.service', () => ({
  __esModule: true,
  getOrCreateStripeCustomer: jest.fn(),
  createTrialSubscriptions: jest.fn(),
  cancelStripeSubscription: jest.fn(),
}))

const ORG = 'cm00000000000000000000org1'
const DEL_PERMISO = 'cm00000000000000000000vpe1'
const CREADOR = 'cm00000000000000000000stf1'
const NUEVO = 'cm00000000000000000000vnu1'
const CUENTA = 'cm00000000000000000000mac1'

const alta = (extra: Record<string, unknown> = {}) =>
  ({
    name: 'Cafetería Nueva',
    type: 'RESTAURANT',
    address: 'Calle 1',
    city: 'CDMX',
    state: 'CDMX',
    zipCode: '01000',
    phone: '5500000000',
    email: 'nuevo@example.test',
    currency: 'MXN',
    timezone: 'America/Mexico_City',
    enablePaymentProcessing: false,
    setupPricingStructure: false,
    ...extra,
  }) as any

const quien = (rol: string) => ({ userId: CREADOR, venueDelPermisoId: DEL_PERMISO, rol: rol as any })

describe('createEnhancedVenue · quien crea el negocio queda como su personal (1a)', () => {
  beforeEach(() => {
    // El negocio del permiso, leído `FOR SHARE` (un traslado espera), y el dueño sigue siéndolo.
    prismaMock.$queryRaw.mockResolvedValue([{ organizationId: ORG }])
    prismaMock.staffVenue.findFirst.mockResolvedValue({ id: 'sv-dueno' })
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null)
    prismaMock.venue.findFirst.mockResolvedValue(null)
    prismaMock.venue.create.mockResolvedValue({ id: NUEVO, name: 'Cafetería Nueva', slug: 'cafeteria-nueva' })
    prismaMock.staffVenue.create.mockResolvedValue({ id: 'sv-1' })
  })

  it('🔴 el dueño (rol OWNER donde se revisó el permiso) queda OWNER activo del negocio nuevo, dentro de la transacción', async () => {
    await createEnhancedVenue(quien('OWNER'), alta())

    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(prismaMock.staffVenue.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.staffVenue.create).toHaveBeenCalledWith({
      data: { staffId: CREADOR, venueId: NUEVO, role: 'OWNER', active: true },
    })
  })

  it('🔴 Codex r1 #1: un ADMIN queda ADMIN, nunca OWNER (una fila OWNER lo haría dueño de toda la organización)', async () => {
    await createEnhancedVenue(quien('ADMIN'), alta())

    expect(prismaMock.staffVenue.create).toHaveBeenCalledWith({
      data: { staffId: CREADOR, venueId: NUEVO, role: 'ADMIN', active: true },
    })
  })

  it('un superadmin no queda como personal del negocio de un cliente (entra a cualquiera)', async () => {
    await createEnhancedVenue(quien('SUPERADMIN'), alta())

    expect(prismaMock.staffVenue.create).not.toHaveBeenCalled()
  })

  it('🔴 Codex r1 #2: el negocio nace en la organización del negocio donde se revisó el permiso', async () => {
    await createEnhancedVenue(quien('OWNER'), alta())

    const [strings, ...valores] = prismaMock.$queryRaw.mock.calls[0]
    expect(strings.join('?')).toMatch(/FROM "Venue" WHERE id = \? FOR SHARE/)
    expect(valores).toEqual([DEL_PERMISO])
    expect(prismaMock.venue.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG }) }),
    )
  })

  it('🔴 Codex r2 #1: OWNER por ser dueño de la organización, pero el negocio se trasladó a otra ⇒ 409, sin crear nada', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null) // sin fila OWNER propia en el negocio del permiso
    prismaMock.staffOrganization.findFirst.mockResolvedValue(null) // y ya no es dueña de la organización a la que pasó

    await expect(createEnhancedVenue(quien('OWNER'), alta())).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
    expect(prismaMock.staffOrganization.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: CREADOR, organizationId: ORG, role: 'OWNER', isActive: true }) }),
    )
  })

  it('control — dueño de la organización sin fila propia en el negocio del permiso: sigue pudiendo', async () => {
    prismaMock.staffVenue.findFirst.mockResolvedValue(null)
    prismaMock.staffOrganization.findFirst.mockResolvedValue({ id: 'so-1' })

    await createEnhancedVenue(quien('OWNER'), alta())
    expect(prismaMock.staffVenue.create).toHaveBeenCalledWith({ data: { staffId: CREADOR, venueId: NUEVO, role: 'OWNER', active: true } })
  })

  it('si la fila del creador truena, el alta entera falla (no queda un negocio sin nadie)', async () => {
    prismaMock.staffVenue.create.mockRejectedValue(new Error('boom'))
    await expect(createEnhancedVenue(quien('OWNER'), alta())).rejects.toThrow('boom')
  })

  it('1b: con cobros, la cuenta se revisa contra ESA organización; la de otra ⇒ 403 y no se crea la configuración', async () => {
    prismaMock.merchantAccount.findMany.mockImplementation(async ({ where }: any) => (where.OR ? [] : [{ id: CUENTA }]))

    await expect(
      createEnhancedVenue(quien('OWNER'), alta({ enablePaymentProcessing: true, primaryAccountId: CUENTA })),
    ).rejects.toMatchObject({ statusCode: 403, code: 'CUENTA_DE_COBRO_AJENA' })
    expect(prismaMock.venuePaymentConfig.create).not.toHaveBeenCalled()
    const pertenencia = prismaMock.merchantAccount.findMany.mock.calls.find(([a]: any) => a.where.OR)![0]
    expect(pertenencia.where.OR).toContainEqual({ venueConfigsPrimary: { some: { venue: { organizationId: ORG } } } })
  })

  it('1b: el superadmin puede ligar una cuenta de cualquier organización', async () => {
    prismaMock.merchantAccount.findMany.mockImplementation(async ({ where }: any) => (where.OR ? [] : [{ id: CUENTA }]))
    prismaMock.venuePaymentConfig.create.mockResolvedValue({ id: 'vpc-1' })

    await expect(
      createEnhancedVenue(quien('SUPERADMIN'), alta({ enablePaymentProcessing: true, primaryAccountId: CUENTA })),
    ).resolves.toMatchObject({ venueId: NUEVO })
    expect(prismaMock.venuePaymentConfig.create).toHaveBeenCalled()
  })
})
