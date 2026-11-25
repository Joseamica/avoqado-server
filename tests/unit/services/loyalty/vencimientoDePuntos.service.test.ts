/**
 * D27 (25-nov): el vencimiento de puntos por inactividad, con la base fingida. Fija las decisiones (qué se relee bajo qué candado, qué se
 * escribe en la misma transacción, cuándo NO se toca a nadie); el comportamiento contra Postgres real va en la prueba de integración.
 */
import { LoyaltyTransactionType, VenueStatus } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import { venueHasFeatureAccess } from '../../../../src/services/access/basePlan.service'
import { vencerPuntosDelCliente, vencerPuntosDelNegocio, vencerPuntosVencidos } from '../../../../src/services/loyalty/vencimientoDePuntos'

jest.mock('../../../../src/services/access/basePlan.service', () => ({ venueHasFeatureAccess: jest.fn() }))
jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const VENUE = 'cvenue000000000000000000a'
const CLIENTE = 'ccliente00000000000000000'
const CDMX = 'America/Mexico_City'
// Hoy: 26-nov-2027, 03:00 de CDMX. Con 365 días, vence quien no tiene actividad desde antes del 27-nov-2026 (06:00 UTC).
const AHORA = new Date('2027-11-26T09:00:00.000Z')
const reloj = () => AHORA
const ANCLA = new Date('2026-11-25T20:00:00.000Z')

const sqlDe = (llamada: unknown[]) => (llamada[0] as TemplateStringsArray).join('?')

function prepararCliente(o: {
  saldo?: number
  config?: Record<string, unknown> | null
  venue?: Record<string, unknown> | null
  ultimo?: Date | null
}) {
  prismaMock.$transaction.mockImplementation(((cb: any) => cb(prismaMock)) as any)
  prismaMock.$queryRaw.mockImplementation(((strings: TemplateStringsArray) => {
    const sql = strings.join('?')
    if (sql.includes('FROM "Customer"')) return Promise.resolve(o.saldo === undefined ? [] : [{ loyaltyPoints: o.saldo }])
    return Promise.resolve([{ id: 'ccfg' }])
  }) as any)
  prismaMock.loyaltyConfig.findUnique.mockResolvedValue(
    (o.config === undefined ? { active: true, pointsExpireDays: 365, pointsExpireSince: ANCLA } : o.config) as any,
  )
  prismaMock.venue.findUnique.mockResolvedValue((o.venue === undefined ? { timezone: CDMX, status: VenueStatus.ACTIVE } : o.venue) as any)
  prismaMock.loyaltyTransaction.findFirst.mockResolvedValue((o.ultimo ? { createdAt: o.ultimo } : null) as any)
  prismaMock.loyaltyTransaction.create.mockResolvedValue({ id: 'cexpire0000000000000000000' } as any)
  prismaMock.customer.update.mockResolvedValue({} as any)
  prismaMock.activityLog.create.mockResolvedValue({} as any)
}

describe('vencerPuntosDelCliente', () => {
  it('sin actividad desde antes del límite: vence TODO el saldo, con su movimiento y su registro en la misma transacción', async () => {
    prepararCliente({ saldo: 340, ultimo: new Date('2026-11-20T18:00:00.000Z') })

    await expect(vencerPuntosDelCliente(VENUE, CLIENTE, reloj)).resolves.toEqual({ vencidos: 340 })

    expect(prismaMock.loyaltyTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ customerId: CLIENTE, type: LoyaltyTransactionType.EXPIRE, points: -340, wholeBalance: true }),
      select: { id: true },
    })
    const motivo = (prismaMock.loyaltyTransaction.create.mock.calls[0][0] as any).data.reason as string
    // Desde la mayor entre la actividad (20-nov-2026) y el ancla (25-nov-2026, 14:00 de CDMX).
    expect(motivo).toBe('Vencieron 340 puntos: 365 días sin movimientos de puntos (desde el 25/11/2026)')
    expect(prismaMock.customer.update).toHaveBeenCalledWith({ where: { id: CLIENTE }, data: { loyaltyPoints: { decrement: 340 } } })
    expect(prismaMock.activityLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        venueId: VENUE,
        staffId: null,
        action: 'LOYALTY_POINTS_EXPIRED',
        entity: 'Customer',
        entityId: CLIENTE,
      }),
    })
    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1)
  })

  it('los candados van en orden: advisory del cliente → fila Customer → LoyaltyConfig FOR SHARE, y nunca la fila del negocio', async () => {
    prepararCliente({ saldo: 10, ultimo: null })
    await vencerPuntosDelCliente(VENUE, CLIENTE, reloj)

    const advisory = prismaMock.$executeRaw.mock.invocationCallOrder[0]
    const sqls = prismaMock.$queryRaw.mock.calls.map(sqlDe)
    expect(sqlDe(prismaMock.$executeRaw.mock.calls[0])).toContain('pg_advisory_xact_lock')
    expect(sqls[0]).toMatch(/FROM "Customer".*FOR UPDATE/s)
    expect(sqls[1]).toMatch(/FROM "LoyaltyConfig".*FOR SHARE/s)
    // La limpieza demo → real y el borrado de un negocio toman la fila del negocio ANTES que la del cliente (Codex r4 #1).
    expect(sqls.some((q: string) => /FROM "Venue"/.test(q))).toBe(false)
    const [fila, config] = prismaMock.$queryRaw.mock.invocationCallOrder
    expect(advisory).toBeLessThan(fila)
    expect(fila).toBeLessThan(config)
  })

  it('una zona vieja («GMT-6») no tumba el cálculo: se normaliza como en los reportes', async () => {
    prepararCliente({ saldo: 25, ultimo: null, venue: { timezone: 'GMT-6', status: VenueStatus.ACTIVE } })
    await expect(vencerPuntosDelCliente(VENUE, CLIENTE, reloj)).resolves.toEqual({ vencidos: 25 })
  })

  it('con actividad desde el límite (un canje o una compra reciente): no vence nada', async () => {
    prepararCliente({ saldo: 340, ultimo: new Date('2026-11-27T06:00:00.000Z') })
    await expect(vencerPuntosDelCliente(VENUE, CLIENTE, reloj)).resolves.toEqual({ vencidos: 0 })
    expect(prismaMock.loyaltyTransaction.create).not.toHaveBeenCalled()
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
  })

  it('la actividad excluye vencimientos y reversas de reembolso', async () => {
    prepararCliente({ saldo: 5, ultimo: null })
    await vencerPuntosDelCliente(VENUE, CLIENTE, reloj)
    expect(prismaMock.loyaltyTransaction.findFirst).toHaveBeenCalledWith({
      where: { customerId: CLIENTE, type: { not: LoyaltyTransactionType.EXPIRE }, refundPaymentId: null },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    })
  })

  it('sin movimientos (un saldo sembrado): cuenta desde el ancla', async () => {
    prepararCliente({ saldo: 80, ultimo: null })
    await expect(vencerPuntosDelCliente(VENUE, CLIENTE, reloj)).resolves.toEqual({ vencidos: 80 })
  })

  it('el ancla reciente protege lo viejo: nada vence antes de N días desde ella', async () => {
    prepararCliente({
      saldo: 80,
      ultimo: new Date('2020-01-01T00:00:00.000Z'),
      config: { active: true, pointsExpireDays: 365, pointsExpireSince: new Date('2027-06-01T00:00:00.000Z') },
    })
    await expect(vencerPuntosDelCliente(VENUE, CLIENTE, reloj)).resolves.toEqual({ vencidos: 0 })
  })

  it.each([
    ['saldo en 0 (ya venció: la segunda vuelta no hace nada)', { saldo: 0 }],
    ['cliente de otro negocio o inexistente', { saldo: undefined }],
    ['programa apagado', { saldo: 50, config: { active: false, pointsExpireDays: 365, pointsExpireSince: ANCLA } }],
    ['expiración apagada', { saldo: 50, config: { active: true, pointsExpireDays: null, pointsExpireSince: ANCLA } }],
    ['sin ancla todavía', { saldo: 50, config: { active: true, pointsExpireDays: 365, pointsExpireSince: null } }],
    ['negocio suspendido', { saldo: 50, venue: { timezone: CDMX, status: VenueStatus.ADMIN_SUSPENDED } }],
    ['negocio cerrado', { saldo: 50, venue: { timezone: CDMX, status: VenueStatus.CLOSED } }],
  ])('no toca nada: %s', async (_caso, o) => {
    prepararCliente({ ...o, ultimo: new Date('2020-01-01T00:00:00.000Z') })
    await expect(vencerPuntosDelCliente(VENUE, CLIENTE, reloj)).resolves.toEqual({ vencidos: 0 })
    expect(prismaMock.loyaltyTransaction.create).not.toHaveBeenCalled()
    expect(prismaMock.customer.update).not.toHaveBeenCalled()
    expect(prismaMock.activityLog.create).not.toHaveBeenCalled()
  })
})

describe('vencerPuntosDelNegocio', () => {
  beforeEach(() => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: CDMX, status: VenueStatus.ACTIVE } as any)
  })

  it('la primera vez (sin ancla): sólo arranca el reloj, sin pisar un ancla que alguien ya fijó, y no vence a nadie', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, pointsExpireDays: 365, pointsExpireSince: null } as any)
    prismaMock.loyaltyConfig.updateMany.mockResolvedValue({ count: 1 } as any)

    const r = await vencerPuntosDelNegocio(VENUE, reloj)

    expect(r.anclaFijada).toBe(true)
    expect(prismaMock.loyaltyConfig.updateMany).toHaveBeenCalledWith({
      where: { venueId: VENUE, pointsExpireSince: null },
      data: { pointsExpireSince: AHORA },
    })
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled()
  })

  it('sin el plan de lealtad: no arranca el reloj ni vence a nadie', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(false)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, pointsExpireDays: 365, pointsExpireSince: null } as any)
    const r = await vencerPuntosDelNegocio(VENUE, reloj)
    expect(r.sinPlan).toBe(true)
    expect(prismaMock.loyaltyConfig.updateMany).not.toHaveBeenCalled()
  })

  it('mientras el ancla no pase el límite (los primeros N días), no busca candidatos', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({
      active: true,
      pointsExpireDays: 365,
      pointsExpireSince: new Date('2027-01-01T00:00:00.000Z'),
    } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: CDMX, status: VenueStatus.ACTIVE } as any)
    await vencerPuntosDelNegocio(VENUE, reloj)
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled()
  })

  it('un cliente que truena se salta y los demás siguen; los candidatos son los de saldo > 0 sin actividad desde el límite', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, pointsExpireDays: 365, pointsExpireSince: ANCLA } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: CDMX, status: VenueStatus.ACTIVE } as any)
    prismaMock.customer.findMany.mockResolvedValueOnce([{ id: 'ca' }, { id: 'cb' }] as any)
    // Cliente «ca»: su transacción truena. Cliente «cb»: vence 50.
    prismaMock.$transaction.mockImplementationOnce((() => Promise.reject(new Error('tiempo agotado'))) as any)
    prismaMock.$transaction.mockImplementationOnce(((cb: any) => cb(prismaMock)) as any)
    prismaMock.$queryRaw.mockImplementation(((strings: TemplateStringsArray) =>
      Promise.resolve(strings.join('?').includes('FROM "Customer"') ? [{ loyaltyPoints: 50 }] : [{ id: 'ccfg' }])) as any)
    prismaMock.loyaltyTransaction.findFirst.mockResolvedValue(null)
    prismaMock.loyaltyTransaction.create.mockResolvedValue({ id: 'cx' } as any)

    const r = await vencerPuntosDelNegocio(VENUE, reloj)

    expect(r).toEqual(expect.objectContaining({ customersAffected: 1, pointsExpired: 50, fallidos: 1 }))
    expect(prismaMock.customer.findMany).toHaveBeenCalledWith({
      where: {
        venueId: VENUE,
        loyaltyPoints: { gt: 0 },
        loyaltyTransactions: {
          none: {
            type: { not: LoyaltyTransactionType.EXPIRE },
            refundPaymentId: null,
            createdAt: { gte: new Date('2026-11-27T06:00:00.000Z') },
          },
        },
      },
      orderBy: { id: 'asc' },
      take: 100,
      select: { id: true },
    })
  })

  it('negocio suspendido: no vence a nadie', async () => {
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, pointsExpireDays: 365, pointsExpireSince: ANCLA } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: CDMX, status: VenueStatus.SUSPENDED } as any)
    await vencerPuntosDelNegocio(VENUE, reloj)
    expect(prismaMock.customer.findMany).not.toHaveBeenCalled()
  })

  it('si pierde el plan a media tanda, se detiene antes del siguiente cliente', async () => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    prismaMock.loyaltyConfig.findUnique.mockResolvedValue({ active: true, pointsExpireDays: 365, pointsExpireSince: ANCLA } as any)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: CDMX, status: VenueStatus.ACTIVE } as any)
    prismaMock.customer.findMany.mockResolvedValueOnce([{ id: 'ca' }] as any)
    const r = await vencerPuntosDelNegocio(VENUE, reloj)
    expect(r.sinPlan).toBe(true)
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })
})

describe('vencerPuntosVencidos (la vuelta del job)', () => {
  beforeEach(() => {
    ;(venueHasFeatureAccess as jest.Mock).mockResolvedValue(true)
    prismaMock.venue.findUnique.mockResolvedValue({ timezone: CDMX, status: VenueStatus.ACTIVE } as any)
  })

  it('revisa TODOS los negocios en cada vuelta, sin memoria entre vueltas; uno que truena no detiene a los demás', async () => {
    prismaMock.loyaltyConfig.findMany.mockResolvedValue([{ venueId: 'cv1' }, { venueId: 'cv2' }] as any)
    prismaMock.loyaltyConfig.findUnique.mockImplementation((async (a: any) => {
      if (a.where.venueId === 'cv1') throw new Error('se cayó la base')
      return { active: true, pointsExpireDays: 365, pointsExpireSince: null }
    }) as any)
    prismaMock.loyaltyConfig.updateMany.mockResolvedValue({ count: 1 } as any)

    const primera = await vencerPuntosVencidos(reloj)
    expect(primera).toEqual(expect.objectContaining({ negocios: 1, fallidos: 1 }))

    // La siguiente vuelta vuelve a preguntarle todo a la base: los dos negocios otra vez.
    prismaMock.loyaltyConfig.findUnique.mockClear()
    await vencerPuntosVencidos(reloj)
    expect(prismaMock.loyaltyConfig.findUnique.mock.calls.map((c: any) => c[0].where.venueId)).toEqual(['cv1', 'cv2'])
  })

  it('pagina los negocios por venueId con tope', async () => {
    prismaMock.loyaltyConfig.findMany.mockResolvedValue([] as any)
    await vencerPuntosVencidos(reloj)
    expect(prismaMock.loyaltyConfig.findMany).toHaveBeenCalledWith({
      where: { active: true, pointsExpireDays: { gt: 0 } },
      orderBy: { venueId: 'asc' },
      take: 200,
      select: { venueId: true },
    })
  })
})
