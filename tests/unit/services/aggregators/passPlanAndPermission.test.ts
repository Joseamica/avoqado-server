import { elPlanConcede } from '@/services/access/basePlan.service'
import { PERMISSION_DEPENDENCIES, INDIVIDUAL_PERMISSIONS_BY_RESOURCE } from '@/lib/permissions'
import { PERMISSION_TO_FEATURE_MAP } from '@/services/access/access.service'

describe('pases: plan y permiso', () => {
  // nuevo
  it('AGGREGATOR_PASSES lo concede Pro (y Premium)', () => {
    expect(elPlanConcede('PRO', 'AGGREGATOR_PASSES')).toBe(true)
    expect(elPlanConcede('PREMIUM', 'AGGREGATOR_PASSES')).toBe(true)
  })
  // nuevo
  it('reservations:manage-passes implica ver reservas y está en el catálogo de reservas', () => {
    expect(PERMISSION_DEPENDENCIES['reservations:manage-passes']).toEqual(['reservations:read', 'reservations:manage-passes'])
    expect(INDIVIDUAL_PERMISSIONS_BY_RESOURCE.reservations).toContain('reservations:manage-passes')
  })
  // nuevo
  it('en white-label el permiso exige la función de pases', () => {
    expect(PERMISSION_TO_FEATURE_MAP['reservations:manage-passes']).toBe('AGGREGATOR_PASSES')
  })
  // nuevo — P2-9
  it('el catálogo comercial lo trae en Pro (las publicaciones nuevas lo incluyen)', () => {
    const { FEATURE_CATALOG } = jest.requireActual('@/config/featureCatalog')
    expect(FEATURE_CATALOG.find((f: any) => f.featureCode === 'AGGREGATOR_PASSES')).toMatchObject({
      minimumTier: 'PRO',
      // Copy honesto: Wellhub todavía no se puede conectar; el comprador ve el requisito en previewHybridOffer.
      description: 'Recibe reservas y check-ins de socios de TotalPass sin capturar a mano. Wellhub, muy pronto.',
      requirement: 'Requiere Reservas con clases y una cuenta de TotalPass.',
    })
  })
  // regresión
  it('sigue igual: reservas en Pro', () => {
    expect(elPlanConcede('PRO', 'RESERVATIONS')).toBe(true)
  })
})
