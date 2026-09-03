// tests/unit/services/marketing/campaignDraft.service.test.ts
/**
 * Guardar/editar el BORRADOR de una campaña. `bloquesCampanaSchema` (T1) y `renderizarBloques`/
 * `dominiosDeLosBloques` (T2) se usan REALES (no mockeados) — son puros y es la única forma de
 * comprobar de verdad que el servidor genera htmlBody/textBody/linkDomains, en vez de un mock
 * diciéndose a sí mismo que sí funciona. Sólo se mockean Prisma y la bitácora.
 *
 * 🔴 Mitad de estas pruebas son de FORMA (el `where` de la carga/edición, el `data` del
 * `create`): es lo único que demuestra que el cliente NUNCA manda HTML y que el tenant nunca
 * falta en una consulta.
 */
import { guardarBorrador } from '@/services/marketing/campaignDraft.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { $transaction: jest.fn() },
}))

const logActionMock = logAction as jest.Mock

const VENUE_ID = 'venue-1'
const CAMPAIGN_ID = 'camp-1'

const BLOQUES_VALIDOS = [
  { type: 'paragraph', text: 'hola' },
  { type: 'button', label: 'Ver', url: 'https://mi-negocio.mx/p' },
]

function crearTxMock(
  overrides: {
    existente?: any
    claimCount?: number
    createdId?: string
  } = {},
) {
  const createdId = overrides.createdId ?? 'camp-nuevo'
  return {
    customerCampaign: {
      create: jest.fn().mockImplementation(({ data }: { data: any }) => Promise.resolve({ id: createdId, ...data })),
      findFirst: jest
        .fn()
        .mockResolvedValue('existente' in overrides ? overrides.existente : { id: CAMPAIGN_ID, venueId: VENUE_ID, status: 'DRAFT' }),
      updateMany: jest.fn().mockResolvedValue({ count: overrides.claimCount ?? 1 }),
    },
  } as any
}

function mockTransaccion(tx: any) {
  ;(prisma.$transaction as jest.Mock).mockImplementation(async (cb: any) => cb(tx))
}

beforeEach(() => {
  jest.clearAllMocks()
  logActionMock.mockResolvedValue(undefined)
})

describe('guardarBorrador — validación de bloques', () => {
  it('bloques inválidos (type inventado) ⇒ BadRequestError, y nada se escribe', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await expect(
      guardarBorrador({ venueId: VENUE_ID, name: 'Promo', subject: 'S', audience: 'ALL_CONSENTED' as any, bloques: [{ type: 'script' }] }),
    ).rejects.toThrow(BadRequestError)
    expect(tx.customerCampaign.create).not.toHaveBeenCalled()
    expect(prisma.$transaction).not.toHaveBeenCalled()
  })

  it('lista de bloques vacía ⇒ BadRequestError (una campaña sin contenido no se guarda)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await expect(
      guardarBorrador({ venueId: VENUE_ID, name: 'Promo', subject: 'S', audience: 'ALL_CONSENTED' as any, bloques: [] }),
    ).rejects.toThrow(BadRequestError)
  })
})

describe('guardarBorrador — audiencia GROUP', () => {
  it('GROUP sin customerGroupId ⇒ BadRequestError, y nada se escribe', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await expect(
      guardarBorrador({ venueId: VENUE_ID, name: 'Promo', subject: 'S', audience: 'GROUP' as any, bloques: BLOQUES_VALIDOS }),
    ).rejects.toThrow(BadRequestError)
    expect(tx.customerCampaign.create).not.toHaveBeenCalled()
  })

  it('GROUP con customerGroupId ⇒ se guarda con ese grupo (forma del data)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'GROUP' as any,
      customerGroupId: 'group-1',
      bloques: BLOQUES_VALIDOS,
    })
    expect(tx.customerCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ audience: 'GROUP', customerGroupId: 'group-1' }) }),
    )
  })

  it('editar de GROUP a ALL_CONSENTED limpia el customerGroupId viejo', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
    })
    expect(tx.customerCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ audience: 'ALL_CONSENTED', customerGroupId: null }) }),
    )
  })
})

describe('guardarBorrador — crear (sin campaignId)', () => {
  it('crea una campaña nueva en DRAFT con los bloques ORIGINALES en contentBlocks', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    const resultado = await guardarBorrador({
      venueId: VENUE_ID,
      name: 'Promo de septiembre',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
    })

    expect(resultado).toEqual({ id: 'camp-nuevo' })
    expect(tx.customerCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          venueId: VENUE_ID,
          name: 'Promo de septiembre',
          status: 'DRAFT',
          contentBlocks: BLOQUES_VALIDOS,
        }),
      }),
    )
  })

  // 🔴 Es la prueba que sostiene la decisión de no sanitizar (campaignBlocks.ts): si el HTML
  // viniera del cliente en vez de generarse aquí, cualquiera podría mandar el marcado que
  // quisiera firmado con el dominio de marketing.
  it('el servidor genera htmlBody, textBody y linkDomains — no los recibe del cliente', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: [
        { type: 'paragraph', text: 'hola' },
        { type: 'button', label: 'Ver', url: 'https://mi-negocio.mx/p' },
      ],
    })

    expect(tx.customerCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          htmlBody: expect.stringContaining('hola'),
          textBody: expect.stringContaining('hola'),
          linkDomains: ['mi-negocio.mx'],
          status: 'DRAFT',
        }),
      }),
    )
  })

  it('sin tags, se guarda con arreglo vacío', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({ venueId: VENUE_ID, name: 'Promo', subject: 'S', audience: 'ALL_CONSENTED' as any, bloques: BLOQUES_VALIDOS })
    expect(tx.customerCampaign.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ tags: [] }) }))
  })

  it('con campaignId ausente, NO se consulta ni se actualiza nada — sólo create', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({ venueId: VENUE_ID, name: 'Promo', subject: 'S', audience: 'ALL_CONSENTED' as any, bloques: BLOQUES_VALIDOS })
    expect(tx.customerCampaign.findFirst).not.toHaveBeenCalled()
    expect(tx.customerCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('bitácora CUSTOMER_CAMPAIGN_DRAFT_CREATED después del commit, con el id creado', async () => {
    const tx = crearTxMock({ createdId: 'camp-xyz' })
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
      actorStaffId: 'staff-1',
    })
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_CAMPAIGN_DRAFT_CREATED',
        entity: 'CustomerCampaign',
        entityId: 'camp-xyz',
        staffId: 'staff-1',
        venueId: VENUE_ID,
      }),
    )
  })
})

describe('guardarBorrador — editar (con campaignId)', () => {
  it('campaña inexistente en el venue ⇒ NotFoundError, y updateMany NUNCA se llama', async () => {
    const tx = crearTxMock({ existente: null })
    mockTransaccion(tx)

    await expect(
      guardarBorrador({
        venueId: VENUE_ID,
        campaignId: CAMPAIGN_ID,
        name: 'Promo',
        subject: 'S',
        audience: 'ALL_CONSENTED' as any,
        bloques: BLOQUES_VALIDOS,
      }),
    ).rejects.toThrow(NotFoundError)
    expect(tx.customerCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 prueba de FORMA: la carga SIEMPRE filtra por venueId (nunca findUnique por id pelón)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
    })
    expect(tx.customerCampaign.findFirst).toHaveBeenCalledWith({ where: { id: CAMPAIGN_ID, venueId: VENUE_ID } })
  })

  it('el CAS de la edición exige venueId y status en [DRAFT, SCHEDULED] (forma del where)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
    })
    expect(tx.customerCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: CAMPAIGN_ID, venueId: VENUE_ID, status: { in: ['DRAFT', 'SCHEDULED'] } },
      }),
    )
  })

  it('editar una SCHEDULED la regresa a DRAFT', async () => {
    const tx = crearTxMock({ existente: { id: CAMPAIGN_ID, venueId: VENUE_ID, status: 'SCHEDULED' } })
    mockTransaccion(tx)

    const resultado = await guardarBorrador({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      name: 'Promo editada',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
    })
    expect(resultado).toEqual({ id: CAMPAIGN_ID })
    expect(tx.customerCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT' }) }),
    )
  })

  it.each(['SENT', 'SENDING', 'ENQUEUED', 'CANCELLED', 'BLOCKED', 'EXPIRED'])(
    'una campaña %s no se puede editar ⇒ ConflictError (claimCount 0)',
    async status => {
      const tx = crearTxMock({ existente: { id: CAMPAIGN_ID, venueId: VENUE_ID, status }, claimCount: 0 })
      mockTransaccion(tx)

      await expect(
        guardarBorrador({
          venueId: VENUE_ID,
          campaignId: CAMPAIGN_ID,
          name: 'Promo',
          subject: 'S',
          audience: 'ALL_CONSENTED' as any,
          bloques: BLOQUES_VALIDOS,
        }),
      ).rejects.toThrow(ConflictError)
    },
  )

  it('actualiza el contenido (htmlBody/textBody/contentBlocks) al editar (forma del data)', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      name: 'Promo editada',
      subject: 'Nuevo asunto',
      audience: 'ALL_CONSENTED' as any,
      bloques: [{ type: 'heading', text: 'Nuevo encabezado' }],
    })
    expect(tx.customerCampaign.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          name: 'Promo editada',
          subject: 'Nuevo asunto',
          contentBlocks: [{ type: 'heading', text: 'Nuevo encabezado' }],
          htmlBody: expect.stringContaining('Nuevo encabezado'),
        }),
      }),
    )
  })

  it('bitácora CUSTOMER_CAMPAIGN_DRAFT_UPDATED después del commit, con el campaignId', async () => {
    const tx = crearTxMock()
    mockTransaccion(tx)

    await guardarBorrador({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      name: 'Promo',
      subject: 'S',
      audience: 'ALL_CONSENTED' as any,
      bloques: BLOQUES_VALIDOS,
      actorStaffId: 'staff-2',
    })
    expect(logActionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'CUSTOMER_CAMPAIGN_DRAFT_UPDATED',
        entity: 'CustomerCampaign',
        entityId: CAMPAIGN_ID,
        staffId: 'staff-2',
        venueId: VENUE_ID,
      }),
    )
  })

  it('si logAction rechaza, guardarBorrador NO falla', async () => {
    const tx = crearTxMock()
    logActionMock.mockRejectedValue(new Error('la bitácora truena'))
    mockTransaccion(tx)

    await expect(
      guardarBorrador({
        venueId: VENUE_ID,
        campaignId: CAMPAIGN_ID,
        name: 'Promo',
        subject: 'S',
        audience: 'ALL_CONSENTED' as any,
        bloques: BLOQUES_VALIDOS,
      }),
    ).resolves.toEqual({ id: CAMPAIGN_ID })
  })
})
