// tests/unit/services/dashboard/createEnhancedVenue.creador.test.ts
// hz:nube0000:na5adb84 · decisión «A» del founder (17-nov): el alta avanzada (`POST /dashboard/venues/enhanced`) es SÓLO de
// superadmin (el guardia lo prueba `tests/unit/routes/enhancedVenue.soloSuperadmin.routes.test.ts`). Antes el negocio nacía sin
// ningún `StaffVenue` (la fila estaba comentada) y su dueño recibía 403 al activar cobros o el KYC. Ahora el superadmin no queda
// como personal y el dueño lo dice la petición (`ownerStaffId`): tiene que ser dueño activo de la organización y queda OWNER,
// DENTRO de la transacción del alta. Nunca otro: una fila OWNER a un miembro lo volvería dueño de toda la organización.
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
const SUPERADMIN = 'cm00000000000000000000sa01'
const DUENO = 'cm00000000000000000000due1'
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
    ownerStaffId: DUENO,
    ...extra,
  }) as any

const quien = { userId: SUPERADMIN, venueDelPermisoId: DEL_PERMISO }

const consultas: Array<{ sql: string; valores: unknown[] }> = []
const conSql = (r: { negocio: unknown[]; dueno: unknown[] }) => {
  consultas.length = 0
  prismaMock.$queryRaw.mockImplementation(async (strings: TemplateStringsArray, ...valores: unknown[]) => {
    const sql = strings.join('?')
    consultas.push({ sql, valores })
    return sql.includes('FROM "Venue"') ? r.negocio : sql.includes('FROM "StaffOrganization"') ? r.dueno : []
  })
}

describe('createEnhancedVenue · sólo superadmin, con el dueño que dice la petición (na5adb84, «A»)', () => {
  beforeEach(() => {
    // `FOR SHARE` del negocio del permiso (un traslado espera) y de la membresía del dueño (una baja espera).
    conSql({ negocio: [{ organizationId: ORG }], dueno: [{ staffId: DUENO }] })
    prismaMock.venue.findFirst.mockResolvedValue(null)
    prismaMock.venue.create.mockResolvedValue({ id: NUEVO, name: 'Cafetería Nueva', slug: 'cafeteria-nueva' })
    prismaMock.staffVenue.create.mockResolvedValue({ id: 'sv-1' })
  })

  it('🔴 el dueño indicado queda OWNER activo del negocio nuevo, dentro de la transacción; el superadmin no queda como personal', async () => {
    await createEnhancedVenue(quien, alta())

    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(prismaMock.staffVenue.create).toHaveBeenCalledTimes(1)
    expect(prismaMock.staffVenue.create).toHaveBeenCalledWith({ data: { staffId: DUENO, venueId: NUEVO, role: 'OWNER', active: true } })
  })

  it('🔴 se revisa que sea dueño ACTIVO de la organización del negocio del permiso (persona activa incluida)', async () => {
    await createEnhancedVenue(quien, alta())

    const negocio = consultas.find(c => c.sql.includes('FROM "Venue"'))!
    expect(negocio.sql).toMatch(/FROM "Venue" WHERE id = \? FOR SHARE/)
    expect(negocio.valores).toEqual([DEL_PERMISO])
    const dueno = consultas.find(c => c.sql.includes('FROM "StaffOrganization"'))!
    expect(dueno.sql).toMatch(/so\.role = 'OWNER'[\s\S]*so\."isActive" AND s\.active[\s\S]*FOR SHARE OF so/)
    expect(dueno.valores).toEqual([DUENO, ORG])
    // Codex r9 #4: primero la persona y luego su membresía (el orden del borrado de personal: sin trabas).
    const persona = consultas.findIndex(c => /FROM "Staff" WHERE id = \? FOR SHARE/.test(c.sql))
    expect(persona).toBeGreaterThan(-1)
    expect(persona).toBeLessThan(consultas.findIndex(c => c.sql.includes('FROM "StaffOrganization"')))
    expect(prismaMock.venue.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ organizationId: ORG }) }),
    )
  })

  it('🔴 un dueño que no es dueño activo de esa organización (un miembro, otra organización) ⇒ 400 en español, sin crear nada', async () => {
    conSql({ negocio: [{ organizationId: ORG }], dueno: [] })

    await expect(createEnhancedVenue(quien, alta())).rejects.toMatchObject({ statusCode: 400, code: 'DUENO_NO_ES_DE_LA_ORGANIZACION' })
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
    expect(prismaMock.staffVenue.create).not.toHaveBeenCalled()
  })

  it('🔴 Codex r8 #2: el superadmin no puede ponerse a sí mismo como dueño (aunque sea dueño de la organización) ⇒ 400', async () => {
    await expect(createEnhancedVenue(quien, alta({ ownerStaffId: SUPERADMIN }))).rejects.toMatchObject({
      statusCode: 400,
      code: 'DUENO_ES_QUIEN_CREA',
    })
    expect(prismaMock.venue.create).not.toHaveBeenCalled()
  })

  it('si la fila del dueño truena, el alta entera falla (no queda un negocio sin dueño)', async () => {
    prismaMock.staffVenue.create.mockRejectedValue(new Error('boom'))
    await expect(createEnhancedVenue(quien, alta())).rejects.toThrow('boom')
  })

  it('el superadmin liga la cuenta de cobro que elija (sólo se revisa que exista, D25)', async () => {
    prismaMock.merchantAccount.findMany.mockResolvedValue([{ id: CUENTA }])
    prismaMock.venuePaymentConfig.create.mockResolvedValue({ id: 'vpc-1' })

    await expect(createEnhancedVenue(quien, alta({ enablePaymentProcessing: true, primaryAccountId: CUENTA }))).resolves.toMatchObject({
      venueId: NUEVO,
    })
    expect(prismaMock.merchantAccount.findMany).toHaveBeenCalledTimes(1)
    expect(prismaMock.venuePaymentConfig.create).toHaveBeenCalled()
  })
})
