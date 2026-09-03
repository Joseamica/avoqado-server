// tests/unit/services/marketing/campaignPublish.service.test.ts
/**
 * Vista previa + publicación (Fase 1C-A, Task 5). El token de confirmación
 * (`campaignConfirmToken.ts`, T4) es la razón de ser de esta capa: sin él, publicar
 * mandaría lo que sea que esté guardado AHORA, no lo que el dueño vio y confirmó. Por eso
 * `firmarTokenDeEnvio`/`verificarTokenDeEnvio`/`huellaDeCampana` se usan REALES (crypto puro,
 * sin DB) — un mock que simplemente devolviera `{ok:true}` no probaría nada del round-trip.
 */
import { previsualizarEnvio, publicarCampana } from '@/services/marketing/campaignPublish.service'
import { firmarTokenDeEnvio, huellaDeCampana } from '@/services/marketing/campaignConfirmToken'
import { enqueueCampaign, resolverAudiencia } from '@/services/marketing/campaignEnqueue.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { BadRequestError, ConflictError, NotFoundError } from '@/errors/AppError'
import prisma from '@/utils/prismaClient'

// 🔴 Mock COMPLETO del módulo — incluye `resolverAudiencia`, aunque hoy vive en el mismo
// archivo que `enqueueCampaign`. Las pruebas de campaignEnqueue.service.test.ts YA cubren su
// lógica de negocio (GROUP/TAGS/supresión) exhaustivamente; aquí sólo importa que
// `previsualizarEnvio` y `publicarCampana` la LLAMEN con los datos correctos y usen su
// resultado — no volver a probar la audiencia en sí.
jest.mock('@/services/marketing/campaignEnqueue.service', () => ({
  enqueueCampaign: jest.fn(),
  resolverAudiencia: jest.fn(),
}))

jest.mock('@/services/dashboard/activity-log.service', () => ({
  logAction: jest.fn(),
}))

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: { customerCampaign: { findFirst: jest.fn() } },
}))

const enqueueCampaignMock = enqueueCampaign as jest.Mock
const resolverAudienciaMock = resolverAudiencia as jest.Mock
const logActionMock = logAction as jest.Mock
const findFirstMock = prisma.customerCampaign.findFirst as jest.Mock

const VENUE_ID = 'venue-1'
const CAMPAIGN_ID = 'camp-1'
const AHORA = new Date('2026-09-02T12:00:00.000Z')

function campañaBase(overrides: Record<string, any> = {}) {
  return {
    id: CAMPAIGN_ID,
    venueId: VENUE_ID,
    subject: 'Promoción de septiembre',
    contentBlocks: [{ type: 'heading', text: 'Hola' }],
    audience: 'ALL_CONSENTED',
    customerGroupId: null,
    tags: [] as string[],
    ...overrides,
  }
}

function elegibles(n: number) {
  return Array.from({ length: n }, (_, i) => ({ id: `cust-${i}`, email: `c${i}@ejemplo.mx`, tags: [] }))
}

beforeEach(() => {
  jest.clearAllMocks()
  logActionMock.mockResolvedValue(undefined)
})

describe('previsualizarEnvio', () => {
  it('devuelve el conteo REAL de la audiencia (resolverAudiencia) y un token firmado', async () => {
    findFirstMock.mockResolvedValue(campañaBase())
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 1 })

    const resultado = await previsualizarEnvio({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })

    expect(resultado.totalDestinatarios).toBe(3)
    expect(typeof resultado.token).toBe('string')
    expect(resultado.token).toContain('.')
    // 15 minutos exactos — el mismo plazo que campaignConfirmToken.VIGENCIA_MS.
    expect(resultado.expiraEn).toEqual(new Date(AHORA.getTime() + 15 * 60 * 1000))
  })

  it('resuelve la audiencia con los datos de LA campaña cargada (forma de la llamada)', async () => {
    const campaign = campañaBase({ audience: 'GROUP', customerGroupId: 'group-1', tags: ['VIP'] })
    findFirstMock.mockResolvedValue(campaign)
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(0), omitidas: 0 })

    await previsualizarEnvio({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })

    expect(findFirstMock).toHaveBeenCalledWith({ where: { id: CAMPAIGN_ID, venueId: VENUE_ID } })
    expect(resolverAudienciaMock).toHaveBeenCalledWith(
      expect.objectContaining({
        venueId: VENUE_ID,
        audience: 'GROUP',
        customerGroupId: 'group-1',
        tags: ['VIP'],
      }),
    )
  })

  it('campaña inexistente en el venue ⇒ NotFoundError', async () => {
    findFirstMock.mockResolvedValue(null)

    await expect(previsualizarEnvio({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })).rejects.toThrow(NotFoundError)
    expect(resolverAudienciaMock).not.toHaveBeenCalled()
  })

  it('el mismo contenido produce la MISMA huella que verá publicarCampana (round-trip real)', async () => {
    const campaign = campañaBase()
    findFirstMock.mockResolvedValue(campaign)
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(2), omitidas: 0 })

    const { token } = await previsualizarEnvio({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, ahora: AHORA })

    // Firma manual con la MISMA huella/conteo que debería producir la campaña sin cambios —
    // si el token real coincidiera con éste, es que huellaDeCampana se llamó con subject +
    // contentBlocks (no con algún otro campo) y con el conteo real de elegibles.
    const huellaEsperada = huellaDeCampana({ subject: campaign.subject, bloques: campaign.contentBlocks })
    const tokenEsperado = firmarTokenDeEnvio({
      campaignId: CAMPAIGN_ID,
      venueId: VENUE_ID,
      huellaContenido: huellaEsperada,
      totalDestinatarios: 2,
      ahora: AHORA,
    })
    expect(token).toBe(tokenEsperado)
  })
})

describe('publicarCampana', () => {
  function tokenValido(campaign: ReturnType<typeof campañaBase>, n: number, emitidoEn: Date) {
    const huella = huellaDeCampana({ subject: campaign.subject, bloques: campaign.contentBlocks })
    return firmarTokenDeEnvio({
      campaignId: CAMPAIGN_ID,
      venueId: VENUE_ID,
      huellaContenido: huella,
      totalDestinatarios: n,
      ahora: emitidoEn,
    })
  }

  it('con token VÁLIDO llama a enqueueCampaign y devuelve su resultado', async () => {
    const campaign = campañaBase()
    findFirstMock.mockResolvedValue(campaign)
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })
    const token = tokenValido(campaign, 3, AHORA)
    enqueueCampaignMock.mockResolvedValue({ encoladas: 3, omitidas: 0 })

    const resultado = await publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token, actorStaffId: 'staff-1', ahora: AHORA })

    expect(resultado).toEqual({ encoladas: 3, omitidas: 0 })
    expect(enqueueCampaignMock).toHaveBeenCalledWith({
      venueId: VENUE_ID,
      campaignId: CAMPAIGN_ID,
      actorStaffId: 'staff-1',
      ahora: AHORA,
    })
  })

  it('🔴 SIN token ⇒ BadRequestError, y enqueueCampaign NUNCA se llama', async () => {
    const campaign = campañaBase()
    findFirstMock.mockResolvedValue(campaign)
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })

    await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token: '', ahora: AHORA })).rejects.toThrow(BadRequestError)
    expect(enqueueCampaignMock).not.toHaveBeenCalled()
  })

  it('🔴 con token VENCIDO ⇒ BadRequestError, y enqueueCampaign NUNCA se llama', async () => {
    const campaign = campañaBase()
    findFirstMock.mockResolvedValue(campaign)
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })
    const emitidoHaceRato = new Date(AHORA.getTime() - 16 * 60 * 1000)
    const token = tokenValido(campaign, 3, emitidoHaceRato)

    await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token, ahora: AHORA })).rejects.toThrow(BadRequestError)
    expect(enqueueCampaignMock).not.toHaveBeenCalled()
  })

  it('🔴 con token de OTRO contenido (la campaña se editó desde la vista previa) ⇒ BadRequestError, y enqueueCampaign NUNCA se llama', async () => {
    // El token se firmó cuando el asunto era "Versión vieja"; para cuando se publica, la
    // campaña YA tiene otro asunto — la huella recalculada no coincide.
    const huellaVieja = huellaDeCampana({ subject: 'Versión vieja', bloques: campañaBase().contentBlocks })
    const token = firmarTokenDeEnvio({
      campaignId: CAMPAIGN_ID,
      venueId: VENUE_ID,
      huellaContenido: huellaVieja,
      totalDestinatarios: 3,
      ahora: AHORA,
    })
    findFirstMock.mockResolvedValue(campañaBase({ subject: 'Versión nueva' }))
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })

    await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token, ahora: AHORA })).rejects.toThrow(BadRequestError)
    expect(enqueueCampaignMock).not.toHaveBeenCalled()
  })

  it('publicar una campaña que YA está ENQUEUED ⇒ ConflictError (propagado desde enqueueCampaign)', async () => {
    // El token en sí es válido (nada cambió desde la vista previa) — el rechazo lo da el CAS
    // de `enqueueCampaign`, no la verificación del token.
    const campaign = campañaBase()
    findFirstMock.mockResolvedValue(campaign)
    resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })
    const token = tokenValido(campaign, 3, AHORA)
    enqueueCampaignMock.mockRejectedValue(new ConflictError('La campaña ya fue encolada o no está en un estado publicable.'))

    await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token, ahora: AHORA })).rejects.toThrow(ConflictError)
  })

  it('campaña inexistente en el venue ⇒ NotFoundError, y enqueueCampaign NUNCA se llama', async () => {
    findFirstMock.mockResolvedValue(null)

    await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token: 'lo-que-sea.firma', ahora: AHORA })).rejects.toThrow(
      NotFoundError,
    )
    expect(enqueueCampaignMock).not.toHaveBeenCalled()
  })

  describe('bitácora', () => {
    it('escribe CUSTOMER_CAMPAIGN_PUBLISHED DESPUÉS del commit, con encoladas/omitidas/totalDestinatarios', async () => {
      const campaign = campañaBase()
      findFirstMock.mockResolvedValue(campaign)
      resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 1 })
      const token = tokenValido(campaign, 3, AHORA)
      enqueueCampaignMock.mockResolvedValue({ encoladas: 3, omitidas: 0 })

      await publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token, actorStaffId: 'staff-1', ahora: AHORA })

      expect(logActionMock).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CUSTOMER_CAMPAIGN_PUBLISHED',
          entity: 'CustomerCampaign',
          entityId: CAMPAIGN_ID,
          staffId: 'staff-1',
          venueId: VENUE_ID,
          data: expect.objectContaining({ encoladas: 3, omitidas: 0, totalDestinatarios: 3 }),
        }),
      )
    })

    it('si logAction rechaza, publicarCampana NO falla (best-effort, sin await encadenado)', async () => {
      const campaign = campañaBase()
      findFirstMock.mockResolvedValue(campaign)
      resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })
      const token = tokenValido(campaign, 3, AHORA)
      enqueueCampaignMock.mockResolvedValue({ encoladas: 3, omitidas: 0 })
      logActionMock.mockRejectedValue(new Error('la bitácora truena'))

      await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token, ahora: AHORA })).resolves.toEqual({
        encoladas: 3,
        omitidas: 0,
      })
    })

    it('sin token válido, NO se escribe bitácora de publicación', async () => {
      const campaign = campañaBase()
      findFirstMock.mockResolvedValue(campaign)
      resolverAudienciaMock.mockResolvedValue({ elegibles: elegibles(3), omitidas: 0 })

      await expect(publicarCampana({ venueId: VENUE_ID, campaignId: CAMPAIGN_ID, token: 'invalido.firma', ahora: AHORA })).rejects.toThrow(
        BadRequestError,
      )
      expect(logActionMock).not.toHaveBeenCalled()
    })
  })
})
