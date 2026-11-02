/**
 * H0 (28-oct-2026): el alta con el plan ya confirmado se termina sola, sin esperar a que el navegador toque «Entrar».
 * Medido en prod: una alta pagada que no tocó «Entrar» quedó con el negocio en ONBOARDING y el POS le contestó 403
 * ALTA_SIN_TERMINAR. Promesa y mapa: docs/audit/2026-10-28-alta-pagada-se-termina-sola/promesa.md (Avoqado/).
 *
 * 🔴 El cierre es todo-o-nada (Codex r1 #1): progreso, negocio y organización se escriben en LA MISMA transacción. Por eso
 * la transacción recibe aquí su propio `tx`: si una escritura va por el cliente global, la prueba lo ve.
 */
jest.mock('@/services/onboarding/onboardingProgress.service', () => ({
  __esModule: true,
  getV2SetupDataForCompletion: jest.fn(),
  parseV2Plan: jest.fn(),
}))
jest.mock('@/services/onboarding/venueCreation.service', () => ({
  __esModule: true,
  applyBusinessInfoToVenue: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/launchCampaigns/hybridPurchase.service', () => ({
  __esModule: true,
  assertHybridOnboardingPurchase: jest.fn().mockResolvedValue(undefined),
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({ logAction: jest.fn().mockResolvedValue(undefined) }))

import { terminarAltaCobrada } from '@/services/onboarding/terminarAltaCobrada'
import * as onboardingProgressService from '@/services/onboarding/onboardingProgress.service'
import * as venueCreationService from '@/services/onboarding/venueCreation.service'
import { assertHybridOnboardingPurchase } from '@/services/launchCampaigns/hybridPurchase.service'
import { logAction } from '@/services/dashboard/activity-log.service'
import { prismaMock } from '@tests/__helpers__/setup'

const ORG = 'org-1'
const VENUE = { id: 'venue-1', slug: 'tacos-lupita', name: 'Tacos Lupita', status: 'ONBOARDING' }
const NEGOCIO = { name: 'Tacos Lupita', venueType: 'RESTAURANT', address: 'Calle 1', city: 'CDMX' }

function txFalso() {
  return {
    $queryRaw: jest.fn().mockResolvedValue([]),
    onboardingProgress: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    venue: { updateMany: jest.fn().mockResolvedValue({ count: 1 }), update: jest.fn().mockResolvedValue(VENUE) },
    organization: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  }
}

let tx: ReturnType<typeof txFalso>

function conAlta(progreso: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock).mockResolvedValue({
    progress: {
      id: 'op-1',
      organizationId: ORG,
      completedAt: null,
      termsAcceptedAt: new Date('2026-10-28T15:00:00Z'),
      planActivationStatus: 'ACTIVE',
      v2SetupData: {},
      ...progreso,
    },
    businessInfo: NEGOCIO,
    bankInfo: null,
    identityInfo: null,
    entityInfo: null,
    ...extra,
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  tx = txFalso()
  prismaMock.$transaction.mockImplementation((cb: (t: unknown) => unknown) => cb(tx))
  prismaMock.venue.findFirst.mockResolvedValue(VENUE)
  prismaMock.organization.findUnique.mockResolvedValue({ onboardingCompletedAt: null })
  ;(onboardingProgressService.parseV2Plan as jest.Mock).mockReturnValue({ tier: 'PRO', interval: 'monthly', payNow: true })
  conAlta()
})

describe('terminarAltaCobrada — el alta con plan confirmado se termina sola', () => {
  it('termina el alta en UNA transacción: candado de la organización, progreso, negocio y organización', async () => {
    const r = await terminarAltaCobrada(ORG, { via: 'cobro', staffId: 'staff-1' })

    expect(r).toEqual(expect.objectContaining({ estado: 'TERMINADA', venue: expect.objectContaining({ id: VENUE.id }) }))
    expect(tx.$queryRaw).toHaveBeenCalled()
    expect(assertHybridOnboardingPurchase).toHaveBeenCalledWith(ORG, undefined, tx)
    expect(tx.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, completedAt: null, planActivationStatus: 'ACTIVE' },
      data: expect.objectContaining({ completedAt: expect.any(Date), currentStep: 7 }),
    })
    expect(tx.venue.updateMany).toHaveBeenCalledWith({ where: { id: VENUE.id, status: 'ONBOARDING' }, data: { status: 'ACTIVE' } })
    expect(tx.organization.updateMany).toHaveBeenCalledWith({
      where: { id: ORG, onboardingCompletedAt: null },
      data: { onboardingCompletedAt: expect.any(Date) },
    })
    // 🔴 Nada de las escrituras obligatorias por el cliente global (quedarían fuera de la transacción).
    expect(prismaMock.onboardingProgress.updateMany).not.toHaveBeenCalled()
    expect(prismaMock.venue.update).not.toHaveBeenCalled()
    expect(prismaMock.organization.update).not.toHaveBeenCalled()
  })

  it('deja rastro en la bitácora con el camino que lo cerró', async () => {
    await terminarAltaCobrada(ORG, { via: 'barrido' })
    expect(logAction).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'ONBOARDING_COMPLETED',
        entity: 'OnboardingProgress',
        entityId: 'op-1',
        organizationId: ORG,
        venueId: VENUE.id,
        data: expect.objectContaining({ via: 'barrido' }),
      }),
    )
  })

  it('rehidrata los datos del negocio antes de cerrar, y un fallo ahí no impide el cierre', async () => {
    ;(venueCreationService.applyBusinessInfoToVenue as jest.Mock).mockRejectedValueOnce(new Error('geocoder caído'))
    const r = await terminarAltaCobrada(ORG, { via: 'cobro', staffId: 'staff-1' })
    expect(venueCreationService.applyBusinessInfoToVenue).toHaveBeenCalledWith(
      VENUE.id,
      expect.objectContaining({ name: 'Tacos Lupita' }),
      'staff-1',
    )
    expect(r.estado).toBe('TERMINADA')
  })

  it('guarda RFC, razón social e idioma en el negocio dentro de la transacción', async () => {
    conAlta({}, { identityInfo: { rfc: 'XAXX010101000' }, entityInfo: { commercialName: 'Lupita SA' } })
    await terminarAltaCobrada(ORG, { via: 'navegador', language: 'en' })
    expect(tx.venue.update).toHaveBeenCalledWith({
      where: { id: VENUE.id },
      data: { rfc: 'XAXX010101000', legalName: 'Lupita SA', language: 'en' },
    })
  })

  it('sin idioma ni datos fiscales no toca el negocio de más', async () => {
    await terminarAltaCobrada(ORG, { via: 'cobro' })
    expect(tx.venue.update).not.toHaveBeenCalled()
  })

  it.each(['NONE', 'IN_PROGRESS', 'DECLINED', null])('🔴 con el plan en %p NO termina nada', async estado => {
    conAlta({ planActivationStatus: estado })
    const r = await terminarAltaCobrada(ORG, { via: 'barrido' })
    expect(r).toEqual({ estado: 'NADA', motivo: 'PLAN_NO_CONFIRMADO' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('🔴 sin términos aceptados NO termina nada', async () => {
    conAlta({ termsAcceptedAt: null })
    const r = await terminarAltaCobrada(ORG, { via: 'cobro' })
    expect(r).toEqual({ estado: 'NADA', motivo: 'SIN_TERMINOS' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('sin negocio no inventa uno', async () => {
    prismaMock.venue.findFirst.mockResolvedValue(null)
    const r = await terminarAltaCobrada(ORG, { via: 'cobro' })
    expect(r).toEqual({ estado: 'NADA', motivo: 'SIN_NEGOCIO' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('un alta realmente terminada (las tres marcas) contesta YA_TERMINADA sin escribir', async () => {
    conAlta({ completedAt: new Date('2026-10-28T15:10:00Z') })
    prismaMock.organization.findUnique.mockResolvedValue({ onboardingCompletedAt: new Date('2026-10-28T15:10:00Z') })
    prismaMock.venue.findFirst.mockResolvedValue({ ...VENUE, status: 'ACTIVE' })
    const r = await terminarAltaCobrada(ORG, { via: 'aviso-stripe' })
    expect(r).toEqual(expect.objectContaining({ estado: 'YA_TERMINADA' }))
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 una marca temprana (completedAt sin la organización) NO cuenta como terminada ni se repara sin permiso', async () => {
    conAlta({ completedAt: new Date('2026-10-28T15:10:00Z') })
    const r = await terminarAltaCobrada(ORG, { via: 'cobro' })
    expect(r).toEqual({ estado: 'NADA', motivo: 'CIERRE_EN_CURSO' })
    expect(prismaMock.$transaction).not.toHaveBeenCalled()
  })

  it('el barrido repara un cierre a medias: negocio y organización, sin volver a marcar el progreso', async () => {
    conAlta({ completedAt: new Date('2026-10-28T15:10:00Z') })
    const r = await terminarAltaCobrada(ORG, { via: 'barrido', repararParcial: true })
    expect(r.estado).toBe('TERMINADA')
    expect(tx.onboardingProgress.updateMany).toHaveBeenCalledWith({
      where: { organizationId: ORG, completedAt: { not: null }, planActivationStatus: 'ACTIVE' },
      data: { currentStep: 7 },
    })
    expect(tx.venue.updateMany).toHaveBeenCalled()
    expect(tx.organization.updateMany).toHaveBeenCalled()
  })

  it('perder la carrera contra otro cierre no escribe nada más y contesta lo que encontró', async () => {
    tx.onboardingProgress.updateMany.mockResolvedValue({ count: 0 })
    // Al releer, el otro cierre ya terminó todo.
    ;(onboardingProgressService.getV2SetupDataForCompletion as jest.Mock)
      .mockResolvedValueOnce({
        progress: { id: 'op-1', completedAt: null, termsAcceptedAt: new Date(), planActivationStatus: 'ACTIVE', v2SetupData: {} },
        businessInfo: NEGOCIO,
      })
      .mockResolvedValueOnce({
        progress: { id: 'op-1', completedAt: new Date(), termsAcceptedAt: new Date(), planActivationStatus: 'ACTIVE', v2SetupData: {} },
        businessInfo: NEGOCIO,
      })
    prismaMock.organization.findUnique
      .mockResolvedValueOnce({ onboardingCompletedAt: null })
      .mockResolvedValueOnce({ onboardingCompletedAt: new Date() })
    prismaMock.venue.findFirst.mockResolvedValueOnce(VENUE).mockResolvedValueOnce({ ...VENUE, status: 'ACTIVE' })

    const r = await terminarAltaCobrada(ORG, { via: 'aviso-stripe' })

    expect(r.estado).toBe('YA_TERMINADA')
    expect(tx.venue.updateMany).not.toHaveBeenCalled()
    expect(tx.organization.updateMany).not.toHaveBeenCalled()
    expect(logAction).not.toHaveBeenCalled()
  })

  it('🔴 si una escritura obligatoria falla, el error sale (la transacción se deshace) y no se anuncia éxito', async () => {
    tx.organization.updateMany.mockRejectedValue(new Error('conexión perdida'))
    await expect(terminarAltaCobrada(ORG, { via: 'cobro' })).rejects.toThrow('conexión perdida')
    expect(logAction).not.toHaveBeenCalled()
  })

  it('un negocio que no está en ONBOARDING (p. ej. suspendido) no se reactiva', async () => {
    prismaMock.venue.findFirst.mockResolvedValue({ ...VENUE, status: 'SUSPENDED' })
    await terminarAltaCobrada(ORG, { via: 'cobro' })
    // El CAS sólo mueve ONBOARDING → ACTIVE.
    expect(tx.venue.updateMany).toHaveBeenCalledWith({ where: { id: VENUE.id, status: 'ONBOARDING' }, data: { status: 'ACTIVE' } })
  })

  it('con compra híbrida, la guarda corre dentro del candado con su id', async () => {
    ;(onboardingProgressService.parseV2Plan as jest.Mock).mockReturnValue({ tier: 'PRO', hybridPurchaseId: 'hp-1' })
    await terminarAltaCobrada(ORG, { via: 'cobro' })
    expect(assertHybridOnboardingPurchase).toHaveBeenCalledWith(ORG, 'hp-1', tx)
  })
})
