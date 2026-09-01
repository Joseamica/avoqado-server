// tests/unit/services/marketing/campaignEnqueue.service.test.ts
/**
 * 🔴 DINERO/CUOTA + AUDIENCIA. Esta es la transacción de PUBLICACIÓN de una campaña: si se
 * equivoca, o manda correo a quien se dio de baja / está en supresión global (daña la
 * reputación del subdominio de marketing entero), o dos publicaciones simultáneas reservan
 * cuota dos veces. Por eso la mitad de estas pruebas fija la FORMA de las llamadas a Prisma
 * (el `where` de la audiencia, el `createMany` con `skipDuplicates`), no sólo el resultado
 * que decide el mock.
 */
import { enqueueCampaign } from '@/services/marketing/campaignEnqueue.service'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from '@/errors/AppError'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { reservarCuota } from '@/services/marketing/emailQuota.service'
import { filtrarSuprimidos } from '@/services/marketing/emailSuppression.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/access/basePlan.service', () => ({
  venueHasFeatureAccess: jest.fn(),
}))

jest.mock('@/services/marketing/emailQuota.service', () => {
  // 🔴 `periodoDeEnvio` se usa REAL — es la única forma de que la prueba del período con
  // `scheduledFor` de madrugada sea una prueba de verdad y no un mock diciéndose a sí mismo
  // que sí funciona.
  const actual = jest.requireActual('@/services/marketing/emailQuota.service')
  return { ...actual, reservarCuota: jest.fn() }
})

jest.mock('@/services/marketing/emailSuppression.service', () => {
  const actual = jest.requireActual('@/services/marketing/emailSuppression.service')
  return { ...actual, filtrarSuprimidos: jest.fn() }
})

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/config/env', () => ({ env: { MARKETING_MONTHLY_QUOTA: 2000 } }))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}))

const venueHasFeatureAccessMock = venueHasFeatureAccess as jest.Mock
const reservarCuotaMock = reservarCuota as jest.Mock
const filtrarSuprimidosMock = filtrarSuprimidos as jest.Mock
const logActionMock = logAction as jest.Mock

const VENUE_ID = 'venue-1'
const CAMPAIGN_ID = 'camp-1'
const AHORA = new Date('2026-09-01T12:00:00.000Z') // mediodía UTC = ya es septiembre en México

function campañaBase(overrides: Record<string, any> = {}) {
  return {
    id: CAMPAIGN_ID,
    venueId: VENUE_ID,
    status: 'DRAFT',
    audience: 'ALL_CONSENTED',
    customerGroupId: null,
    tags: [] as string[],
    scheduledFor: null as Date | null,
    sendNoLaterThan: null as Date | null,
    ...overrides,
  }
}

function crearTxMock(
  overrides: {
    campaign?: any
    venue?: any
    customers?: Array<{ id: string; email: string; tags: string[] }>
    claimCount?: number
    createManyCount?: number
    totalRecipients?: number
    group?: any
  } = {},
) {
  const campaign = overrides.campaign ?? campañaBase()
  const venue = overrides.venue ?? { timezone: 'America/Mexico_City' }
  const customers = overrides.customers ?? [{ id: 'cust-1', email: 'ana@ejemplo.mx', tags: [] }]
  const claimCount = overrides.claimCount ?? 1
  // 🔴 totalRecipients y createMany son cosas DISTINTAS: createMany devuelve por default el
  // largo REAL de `data` que el servicio le mandó (así una prueba que sólo cambia la
  // audiencia/supresión no tiene que recalcular a mano cuántos sobrevivieron el filtrado);
  // sólo se fija con un número FIJO cuando `overrides.createManyCount` lo pide a propósito
  // (simular que `skipDuplicates` descartó de más).
  const totalRecipients = overrides.totalRecipients ?? overrides.createManyCount ?? customers.length
  const grupoPorDefecto = { id: campaign.customerGroupId, venueId: VENUE_ID }

  return {
    customerCampaign: {
      findFirst: jest.fn().mockResolvedValue(campaign),
      updateMany: jest.fn().mockResolvedValue({ count: claimCount }),
      update: jest.fn().mockResolvedValue({ ...campaign, totalRecipients }),
    },
    venue: {
      findFirst: jest.fn().mockResolvedValue(venue),
    },
    customerGroup: {
      // 🔴 `'group' in overrides` y no `overrides.group ?? …`: un override explícito a
      // `null` (grupo ajeno/borrado) debe QUEDARSE en null, no caer al default por `??`.
      findFirst: jest.fn().mockResolvedValue('group' in overrides ? overrides.group : grupoPorDefecto),
    },
    customer: {
      findMany: jest.fn().mockResolvedValue(customers),
    },
    customerCampaignDelivery: {
      createMany: jest
        .fn()
        .mockImplementation((args: { data: unknown[] }) => Promise.resolve({ count: overrides.createManyCount ?? args.data.length })),
      count: jest.fn().mockResolvedValue(totalRecipients),
    },
  } as any
}

function mockTransaccion(tx: any) {
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
}

beforeEach(() => {
  jest.clearAllMocks()
  venueHasFeatureAccessMock.mockResolvedValue(true)
  filtrarSuprimidosMock.mockResolvedValue(new Set())
  reservarCuotaMock.mockResolvedValue(undefined)
  logActionMock.mockResolvedValue(undefined)
})

describe('enqueueCampaign — tier', () => {
  it('sin acceso al plan, rebota ANTES de abrir la transacción: createMany nunca se llama', async () => {
    venueHasFeatureAccessMock.mockResolvedValue(false)
    const tx = crearTxMock()
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(ForbiddenError)
    expect(tx.customerCampaignDelivery.createMany).not.toHaveBeenCalled()
    expect(tx.customerCampaign.findFirst).not.toHaveBeenCalled()
  })
})

describe('enqueueCampaign — carga de la campaña', () => {
  it('campaña inexistente en el venue ⇒ NotFoundError', async () => {
    const tx = crearTxMock()
    tx.customerCampaign.findFirst.mockResolvedValue(null)
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(NotFoundError)
  })

  it('carga la campaña filtrando por venueId (tenant en el WHERE, nunca findUnique por id pelón)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customerCampaign.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: CAMPAIGN_ID, venueId: VENUE_ID } }))
  })
})

describe('enqueueCampaign — vencimiento', () => {
  it('pasado sendNoLaterThan ⇒ EXPIRED, BadRequestError y CERO deliveries', async () => {
    const campaign = campañaBase({ sendNoLaterThan: new Date('2026-09-01T00:00:00.000Z') })
    const tx = crearTxMock({ campaign })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
    expect(tx.customerCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CAMPAIGN_ID, venueId: VENUE_ID, status: { in: ['DRAFT', 'SCHEDULED'] } },
        data: { status: 'EXPIRED' },
      }),
    )
    expect(tx.customerCampaignDelivery.createMany).not.toHaveBeenCalled()
  })

  it('sin sendNoLaterThan, el límite es scheduledFor + 24h', async () => {
    // scheduledFor hace 25h de AHORA ⇒ vencida
    const scheduledFor = new Date(AHORA.getTime() - 25 * 60 * 60 * 1000)
    const campaign = campañaBase({ status: 'SCHEDULED', scheduledFor })
    const tx = crearTxMock({ campaign })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
  })

  it('dentro de las 24h de scheduledFor, NO vence', async () => {
    const scheduledFor = new Date(AHORA.getTime() - 1 * 60 * 60 * 1000)
    const campaign = campañaBase({ status: 'SCHEDULED', scheduledFor })
    const tx = crearTxMock({ campaign })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).resolves.toEqual({
      encoladas: 1,
      omitidas: 0,
    })
  })
})

describe('enqueueCampaign — reclamo CAS', () => {
  it('count 0 (ya encolada o en otro estado) ⇒ ConflictError, y la audiencia NUNCA se consulta', async () => {
    const tx = crearTxMock({ claimCount: 0 })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(ConflictError)
    expect(tx.customer.findMany).not.toHaveBeenCalled()
  })

  it('el reclamo transiciona DRAFT/SCHEDULED → ENQUEUED (forma del where/data)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customerCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CAMPAIGN_ID, venueId: VENUE_ID, status: { in: ['DRAFT', 'SCHEDULED'] } },
        data: { status: 'ENQUEUED' },
      }),
    )
  })
})

describe('enqueueCampaign — audiencia', () => {
  it('ALL_CONSENTED toma a todos los elegibles que devuelve la consulta', async () => {
    const customers = [
      { id: 'cust-1', email: 'ana@ejemplo.mx', tags: [] },
      { id: 'cust-2', email: 'beto@ejemplo.mx', tags: [] },
    ]
    const tx = crearTxMock({ customers })
    mockTransaccion(tx)

    const resultado = await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(resultado).toEqual({ encoladas: 2, omitidas: 0 })
  })

  it('🔴 prueba de FORMA: el where exige venueId, active, marketingConsent, email y un ConsentEvent GRANTED', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          venueId: VENUE_ID,
          active: true,
          marketingConsent: true,
          email: { not: null },
          consentEvents: { some: { action: 'GRANTED' } },
        }),
      }),
    )
  })

  it('GROUP filtra por customerGroupId DEL MISMO VENUE (prueba de FORMA del where)', async () => {
    const campaign = campañaBase({ audience: 'GROUP', customerGroupId: 'group-1' })
    const tx = crearTxMock({ campaign, group: { id: 'group-1', venueId: VENUE_ID } })
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customerGroup.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'group-1', venueId: VENUE_ID } }))
    expect(tx.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ customerGroupId: 'group-1' }) }),
    )
  })

  it('GROUP sin customerGroupId asignado ⇒ BadRequestError', async () => {
    const campaign = campañaBase({ audience: 'GROUP', customerGroupId: null })
    const tx = crearTxMock({ campaign })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
  })

  it('GROUP con un grupo que no existe en ESTE venue ⇒ BadRequestError', async () => {
    const campaign = campañaBase({ audience: 'GROUP', customerGroupId: 'group-ajeno' })
    const tx = crearTxMock({ campaign, group: null })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
  })

  it('TAGS con semántica ANY sobre tags normalizados (mayúsculas/espacios no importan)', async () => {
    const campaign = campañaBase({ audience: 'TAGS', tags: ['VIP'] })
    const customers = [
      { id: 'cust-1', email: 'ana@ejemplo.mx', tags: ['vip', 'frecuente'] }, // matchea normalizando
      { id: 'cust-2', email: 'beto@ejemplo.mx', tags: ['otro'] }, // no matchea
      { id: 'cust-3', email: 'carla@ejemplo.mx', tags: [] },
    ]
    const tx = crearTxMock({ campaign, customers })
    mockTransaccion(tx)

    const resultado = await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(resultado.encoladas).toBe(1)
    expect(tx.customerCampaignDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ customerId: 'cust-1' })] }),
    )
  })

  it('TAGS filtra en SQL por isEmpty:false antes de aplicar la semántica ANY en JS (forma del where)', async () => {
    const campaign = campañaBase({ audience: 'TAGS', tags: ['VIP'] })
    // Necesita AL MENOS un candidato que sobreviva el filtro ANY en JS — si no, la
    // transacción revierte con "sin destinatarios elegibles" antes de que valga la pena
    // comprobar la forma del `where` (el mock ya registró la llamada de todos modos, pero
    // afirmar sobre una promesa que se sabe rechazada es una prueba mal escrita).
    const tx = crearTxMock({ campaign, customers: [{ id: 'cust-1', email: 'ana@ejemplo.mx', tags: ['VIP'] }] })
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tags: { isEmpty: false } }) }),
    )
  })

  it('TAGS sin ninguna etiqueta configurada ⇒ BadRequestError', async () => {
    const campaign = campañaBase({ audience: 'TAGS', tags: [] })
    const tx = crearTxMock({ campaign })
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
  })
})

describe('enqueueCampaign — supresión global', () => {
  it('un customer suprimido NO se encola y cuenta como omitido', async () => {
    const customers = [
      { id: 'cust-1', email: 'ana@ejemplo.mx', tags: [] },
      { id: 'cust-2', email: 'suprimido@ejemplo.mx', tags: [] },
    ]
    const tx = crearTxMock({ customers, createManyCount: 1, totalRecipients: 1 })
    filtrarSuprimidosMock.mockResolvedValue(new Set(['suprimido@ejemplo.mx']))
    mockTransaccion(tx)

    const resultado = await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(resultado).toEqual({ encoladas: 1, omitidas: 1 })
    expect(tx.customerCampaignDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: [expect.objectContaining({ customerId: 'cust-1' })] }),
    )
  })

  it('todos suprimidos ⇒ BadRequestError (sin destinatarios elegibles) y sin createMany', async () => {
    const customers = [{ id: 'cust-1', email: 'suprimido@ejemplo.mx', tags: [] }]
    const tx = crearTxMock({ customers })
    filtrarSuprimidosMock.mockResolvedValue(new Set(['suprimido@ejemplo.mx']))
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
    expect(tx.customerCampaignDelivery.createMany).not.toHaveBeenCalled()
  })
})

describe('enqueueCampaign — dedupeKey y skipDuplicates', () => {
  it('dedupeKey es campaignId + ":" + customerId, y createMany usa skipDuplicates:true', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customerCampaignDelivery.createMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: [expect.objectContaining({ dedupeKey: `${CAMPAIGN_ID}:cust-1`, venueId: VENUE_ID, status: 'PENDING' })],
        skipDuplicates: true,
      }),
    )
  })
})

describe('enqueueCampaign — cuota', () => {
  it('reserva la cuota con la cantidad REAL encolada y el período del ENVÍO (scheduledFor)', async () => {
    // 04:00 UTC del 1-oct es 22:00 del 30-sep en México (UTC-6): todavía es septiembre.
    const scheduledFor = new Date('2026-10-01T04:00:00.000Z')
    const campaign = campañaBase({ status: 'SCHEDULED', scheduledFor, sendNoLaterThan: new Date('2026-12-31T00:00:00.000Z') })
    const tx = crearTxMock({ campaign })
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(reservarCuotaMock).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({ venueId: VENUE_ID, period: '2026-09', cantidad: 1, topeMensual: 2000 }),
    )
  })

  it('sin scheduledFor, el período se calcula sobre "ahora"', async () => {
    const tx = crearTxMock() // AHORA = 2026-09-01T12:00:00Z ⇒ ya es septiembre en México
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(reservarCuotaMock).toHaveBeenCalledWith(tx, expect.objectContaining({ period: '2026-09' }))
  })

  it('si createMany encola 0 (todos ya existían por skipDuplicates), reservarCuota NO se llama', async () => {
    const tx = crearTxMock({ createManyCount: 0, totalRecipients: 3 })
    mockTransaccion(tx)

    const resultado = await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(resultado.encoladas).toBe(0)
    expect(reservarCuotaMock).not.toHaveBeenCalled()
  })

  it('si reservarCuota lanza (tope alcanzado), el error se propaga (la transacción entera revierte)', async () => {
    const tx = crearTxMock()
    reservarCuotaMock.mockRejectedValue(new BadRequestError('Se alcanzó el tope de correos de campaña para este período.'))
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(BadRequestError)
  })
})

describe('enqueueCampaign — totalRecipients y resultado', () => {
  it('al terminar, totalRecipients se fija con un COUNT real de las deliveries (no aritmética)', async () => {
    const customers = [
      { id: 'cust-1', email: 'ana@ejemplo.mx', tags: [] },
      { id: 'cust-2', email: 'beto@ejemplo.mx', tags: [] },
    ]
    const tx = crearTxMock({ customers, totalRecipients: 2 })
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })
    expect(tx.customerCampaignDelivery.count).toHaveBeenCalledWith({ where: { campaignId: CAMPAIGN_ID } })
    expect(tx.customerCampaign.update).toHaveBeenCalledWith({ where: { id: CAMPAIGN_ID }, data: { totalRecipients: 2 } })
  })
})

describe('enqueueCampaign — bitácora', () => {
  it('escribe CUSTOMER_CAMPAIGN_ENQUEUED DESPUÉS del commit, con encoladas/omitidas/period', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, actorStaffId: 'staff-1', ahora: AHORA })
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_CAMPAIGN_ENQUEUED',
        entity: 'CustomerCampaign',
        entityId: CAMPAIGN_ID,
        staffId: 'staff-1',
        venueId: VENUE_ID,
        data: expect.objectContaining({ encoladas: 1, omitidas: 0, period: '2026-09' }),
      }),
    )
  })

  it('si logAction rechaza, enqueueCampaign NO falla', async () => {
    const tx = crearTxMock()
    logActionMock.mockRejectedValue(new Error('la bitácora truena'))
    mockTransaccion(tx)

    await expect(enqueueCampaign({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).resolves.toEqual({
      encoladas: 1,
      omitidas: 0,
    })
  })
})
