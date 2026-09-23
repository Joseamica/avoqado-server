/**
 * S4 — la ficha: editar, bloquear campos y cambiar de estado (spec 2026-09-17 § 2.1, § 3.4).
 *
 * 🔴 La prueba que de verdad importa aquí es la del CUPO: bajarlo por debajo del conteo NO puede
 * dar un 500. La condición viaja DENTRO del `updateMany`, así que una reserva que entre entre la
 * lectura y la escritura no hace reventar el CHECK de la base.
 */
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { Prisma } from '@prisma/client'
import {
  camposBloqueados,
  createLaunchCampaign,
  endLaunchCampaign,
  findClaimableByCode,
  findClaimableByCodeOrSlug,
  listLaunchCampaigns,
  pauseLaunchCampaign,
  updateLaunchCampaign,
} from '@/services/launchCampaigns/launchCampaign.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

const VISTA = new Date('2026-09-17T10:00:00Z')

function ficha(overrides: Record<string, unknown> = {}) {
  return {
    id: 'lc-1',
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: 2200,
    discountMonths: 3,
    currency: 'MXN',
    offerVersion: 1,
    listPriceCentsSnapshot: null,
    discountAmountCents: null,
    stripePriceId: null,
    stripeCouponId: null,
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2026-12-01T00:00:00Z'),
    redemptionCap: 100,
    redemptionCount: 0,
    headline: null,
    subheadline: null,
    bullets: [],
    status: 'DRAFT',
    statusReason: null,
    activatedAt: null,
    createdAt: VISTA,
    updatedAt: VISTA,
    ...overrides,
  }
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 1 } as never)
})

describe('updateLaunchCampaign — el cupo', () => {
  it('🔴 bajar el cupo por debajo del conteo responde 400 CAP_BELOW_COUNT, NUNCA un 500', async () => {
    // La ficha que el superadmin tenía en pantalla decía 3 tomados…
    prismaMock.launchCampaign.findUnique
      .mockResolvedValueOnce(ficha({ status: 'ACTIVE', activatedAt: VISTA, redemptionCount: 3 }) as never)
      // …y para cuando escribe, una reserva más ya entró: 4. Es la carrera exacta que el
      // `updateMany` condicional existe para no convertir en un 500 contra el CHECK.
      .mockResolvedValueOnce({ updatedAt: VISTA, redemptionCount: 4 } as never)
    prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(updateLaunchCampaign('lc-1', { expectedUpdatedAt: VISTA, redemptionCap: 2 } as never)).rejects.toMatchObject({
      statusCode: 400,
      code: 'LAUNCH_CAMPAIGN_CAP_BELOW_COUNT',
      details: { redemptionCount: 4 },
    })
  })

  it('🔴 la condición del cupo viaja DENTRO del WHERE, no en un `if` previo', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ACTIVE', activatedAt: VISTA, redemptionCount: 3 }) as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha({ redemptionCap: 50 }) as never)

    await updateLaunchCampaign('lc-1', { expectedUpdatedAt: VISTA, redemptionCap: 50 } as never)

    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', updatedAt: VISTA, redemptionCount: { lte: 50 } },
      data: expect.objectContaining({ redemptionCap: 50 }),
    })
  })

  it('una edición que no toca el cupo no le mete una condición de conteo al WHERE', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ACTIVE', activatedAt: VISTA }) as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha() as never)

    await updateLaunchCampaign('lc-1', { expectedUpdatedAt: VISTA, name: 'Otro nombre' } as never)

    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', updatedAt: VISTA },
      data: expect.objectContaining({ name: 'Otro nombre' }),
    })
  })
})

describe('updateLaunchCampaign — revisión optimista y campos congelados', () => {
  it('un `updatedAt` viejo responde 409 STALE (dos pestañas no se pisan en silencio)', async () => {
    prismaMock.launchCampaign.findUnique
      .mockResolvedValueOnce(ficha() as never)
      .mockResolvedValueOnce({ updatedAt: new Date('2026-09-18T00:00:00Z'), redemptionCount: 0 } as never)
    prismaMock.launchCampaign.updateMany.mockResolvedValue({ count: 0 } as never)

    await expect(updateLaunchCampaign('lc-1', { expectedUpdatedAt: VISTA, name: 'X' } as never)).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAUNCH_CAMPAIGN_STALE',
    })
  })

  it('🔴 sobre una ficha ACTIVA el precio y los meses están congelados → FIELD_LOCKED', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ACTIVE', activatedAt: VISTA }) as never)

    await expect(
      updateLaunchCampaign('lc-1', { expectedUpdatedAt: VISTA, advertisedPriceCents: 3300, discountMonths: 6 } as never),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'LAUNCH_CAMPAIGN_FIELD_LOCKED',
      details: { fields: expect.arrayContaining(['advertisedPriceCents', 'discountMonths']) },
    })
    expect(prismaMock.launchCampaign.updateMany).not.toHaveBeenCalled()
  })

  it('sobre una ficha ACTIVA los textos y las etiquetas SÍ se pueden editar', () => {
    expect(
      camposBloqueados(ficha({ status: 'ACTIVE', activatedAt: VISTA }) as never, { headline: 'Hola', vertical: 'RETAIL' } as never),
    ).toEqual([])
  })

  it('en DRAFT no hay nada congelado', () => {
    expect(camposBloqueados(ficha() as never, { advertisedPriceCents: 3300, landingSlug: 'otro', discountMonths: 6 } as never)).toEqual([])
  })

  it('🔴 `validFrom` se congela en cuanto alguien tomó un lugar', () => {
    expect(
      camposBloqueados(ficha({ status: 'ACTIVE', activatedAt: VISTA, redemptionCount: 1 }) as never, { validFrom: new Date() } as never),
    ).toEqual(['validFrom'])
    expect(
      camposBloqueados(ficha({ status: 'ACTIVE', activatedAt: VISTA, redemptionCount: 0 }) as never, { validFrom: new Date() } as never),
    ).toEqual([])
  })

  it('una ficha TERMINADA es historia: no se edita nada', () => {
    expect(camposBloqueados(ficha({ status: 'ENDED' }) as never, { name: 'X' } as never)).toEqual(['name'])
  })

  it('una vigencia invertida se rechaza aunque los campos estén libres', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha() as never)
    await expect(
      updateLaunchCampaign('lc-1', { expectedUpdatedAt: VISTA, validUntil: new Date('2020-01-01T00:00:00Z') } as never),
    ).rejects.toMatchObject({ statusCode: 400, code: 'LAUNCH_CAMPAIGN_INVALID_WINDOW' })
  })
})

describe('createLaunchCampaign', () => {
  const cuerpo = {
    code: 'POS22',
    name: 'POS $22',
    landingSlug: 'pos-22',
    vertical: 'ALL',
    channel: null,
    planTier: 'PRO',
    billingInterval: 'MONTHLY',
    advertisedPriceCents: 2200,
    discountMonths: 3,
    validFrom: new Date('2026-09-01T00:00:00Z'),
    validUntil: new Date('2026-12-01T00:00:00Z'),
    redemptionCap: 100,
    headline: null,
    subheadline: null,
    bullets: [],
  }

  it('🔴 nace SIEMPRE en DRAFT: crear no habla con Stripe ni activa nada', async () => {
    prismaMock.launchCampaign.create.mockResolvedValue(ficha() as never)
    await createLaunchCampaign(cuerpo as never, 'staff-1')
    expect(prismaMock.launchCampaign.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'DRAFT', createdById: 'staff-1' }) }),
    )
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAUNCH_CAMPAIGN_CREATED' }))
  })

  it.each([
    [['code'], 'LAUNCH_CAMPAIGN_CODE_TAKEN'],
    [['landingSlug'], 'LAUNCH_CAMPAIGN_SLUG_TAKEN'],
  ])('un P2002 sobre %s se traduce a %s', async (target, code) => {
    prismaMock.launchCampaign.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('dup', { code: 'P2002', clientVersion: '6', meta: { target } }),
    )
    await expect(createLaunchCampaign(cuerpo as never, 'staff-1')).rejects.toMatchObject({ statusCode: 409, code })
  })
})

describe('transiciones de estado', () => {
  it('pausar una ficha ACTIVA la deja en PAUSED con su motivo', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ACTIVE', activatedAt: VISTA }) as never)
    prismaMock.launchCampaign.findUniqueOrThrow.mockResolvedValue(ficha({ status: 'PAUSED' }) as never)

    await pauseLaunchCampaign('lc-1', 'se acabó el presupuesto', 'staff-1')
    expect(prismaMock.launchCampaign.updateMany).toHaveBeenCalledWith({
      where: { id: 'lc-1', status: { in: ['ACTIVE'] }, updatedAt: VISTA },
      data: expect.objectContaining({ status: 'PAUSED', statusReason: 'se acabó el presupuesto' }),
    })
    expect(logAction).toHaveBeenCalledWith(expect.objectContaining({ action: 'LAUNCH_CAMPAIGN_PAUSED' }))
  })

  it('pausar una ficha que no está activa → BAD_STATE', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'DRAFT' }) as never)
    await expect(pauseLaunchCampaign('lc-1', 'motivo')).rejects.toMatchObject({ code: 'LAUNCH_CAMPAIGN_BAD_STATE' })
  })

  it('terminar una ficha ya terminada → BAD_STATE (es irreversible)', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ENDED' }) as never)
    await expect(endLaunchCampaign('lc-1', 'motivo')).rejects.toMatchObject({ code: 'LAUNCH_CAMPAIGN_BAD_STATE' })
  })
})

describe('listLaunchCampaigns', () => {
  it('🔴 acota la página y desempata el orden con el id (paginación estable)', async () => {
    prismaMock.launchCampaign.count.mockResolvedValue(3 as never)
    prismaMock.launchCampaign.findMany.mockResolvedValue([ficha()] as never)

    const r = await listLaunchCampaigns({ page: 2, pageSize: 25 } as never)

    expect(prismaMock.launchCampaign.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], skip: 25, take: 25 }),
    )
    expect(r.meta).toEqual({ total: 3, page: 2, pageSize: 25 })
    expect(r.data[0].availability).toEqual({ available: false, reason: 'NOT_PUBLISHED' })
  })
})

describe('findClaimableByCode', () => {
  it('🔴 NO mira el cupo: una ficha llena se sigue pudiendo reclamar (atribución ≠ lugar)', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ACTIVE', redemptionCap: 5, redemptionCount: 5 }) as never)
    await expect(findClaimableByCode('POS22', new Date('2026-09-17T00:00:00Z'))).resolves.toMatchObject({ code: 'POS22' })
  })

  it.each([
    ['DRAFT', new Date('2026-09-17T00:00:00Z')],
    ['PAUSED', new Date('2026-09-17T00:00:00Z')],
    ['ENDED', new Date('2026-09-17T00:00:00Z')],
  ])('una ficha %s no es reclamable', async (status, ahora) => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status }) as never)
    await expect(findClaimableByCode('POS22', ahora)).resolves.toBeNull()
  })

  it('fuera de la ventana tampoco es reclamable', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(ficha({ status: 'ACTIVE' }) as never)
    await expect(findClaimableByCode('POS22', new Date('2027-01-01T00:00:00Z'))).resolves.toBeNull()
    await expect(findClaimableByCode('POS22', new Date('2026-08-01T00:00:00Z'))).resolves.toBeNull()
  })

  it('un código que no existe devuelve null, no un error', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(null as never)
    await expect(findClaimableByCode('NOPE')).resolves.toBeNull()
  })
})

/**
 * 🔴 El anuncio manda el SLUG, no el código — y son formatos que NUNCA pueden coincidir:
 * `code` va en MAYÚSCULAS (`/^[A-Z0-9][A-Z0-9_-]{2,31}$/`) y `landingSlug` en minúsculas
 * (`/^[a-z0-9]+(?:-[a-z0-9]+)*$/`). El CTA de `/oferta/pos-22` manda `?oferta=pos-22`, el alta lo
 * pone en mayúsculas (`POS-22`) y busca por código: NUNCA encuentra `POS22`. Y se pierde en
 * silencio, porque el llamador hace `.catch(() => null)`. O sea: cuenta creada sin la oferta y sin
 * atribución, con el clic ya pagado.
 */
describe('findClaimableByCodeOrSlug — el anuncio puede traer cualquiera de los dos', () => {
  const DENTRO = new Date('2026-09-17T00:00:00Z')

  it('🔴 EL CASO QUE COSTABA DINERO: el slug de la página de oferta resuelve la ficha', async () => {
    // el alta ya lo subió a mayúsculas, así que por código no existe; por slug sí
    prismaMock.launchCampaign.findUnique.mockResolvedValueOnce(null as never).mockResolvedValueOnce(ficha({ status: 'ACTIVE' }) as never)
    await expect(findClaimableByCodeOrSlug('POS-22', DENTRO)).resolves.toMatchObject({ code: 'POS22' })
  })

  it('el código de siempre sigue resolviendo, y sin preguntar por el slug', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValueOnce(ficha({ status: 'ACTIVE' }) as never)
    await expect(findClaimableByCodeOrSlug('POS22', DENTRO)).resolves.toMatchObject({ code: 'POS22' })
    expect(prismaMock.launchCampaign.findUnique).toHaveBeenCalledTimes(1)
  })

  it('acepta el slug tal como se ve en la barra del navegador, en minúsculas', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValueOnce(null as never).mockResolvedValueOnce(ficha({ status: 'ACTIVE' }) as never)
    await expect(findClaimableByCodeOrSlug('pos-22', DENTRO)).resolves.toMatchObject({ code: 'POS22' })
    // la segunda consulta va por landingSlug y en minúsculas, no por código
    expect(prismaMock.launchCampaign.findUnique).toHaveBeenLastCalledWith(expect.objectContaining({ where: { landingSlug: 'pos-22' } }))
  })

  it('🔴 la reclamabilidad NO se relaja por entrar por slug: una ficha PAUSADA sigue sin serlo', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValueOnce(null as never).mockResolvedValueOnce(ficha({ status: 'PAUSED' }) as never)
    await expect(findClaimableByCodeOrSlug('pos-22', DENTRO)).resolves.toBeNull()
  })

  it('lo que no es ni código ni slug devuelve null, no un error', async () => {
    prismaMock.launchCampaign.findUnique.mockResolvedValue(null as never)
    await expect(findClaimableByCodeOrSlug('NOPE', DENTRO)).resolves.toBeNull()
  })

  it('una cadena vacía o de puro espacio no consulta nada', async () => {
    await expect(findClaimableByCodeOrSlug('   ', DENTRO)).resolves.toBeNull()
    expect(prismaMock.launchCampaign.findUnique).not.toHaveBeenCalled()
  })
})
