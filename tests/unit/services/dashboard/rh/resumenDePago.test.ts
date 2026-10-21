// «Cómo se le paga hoy» (spec RH §3.5): sólo lee los motores de hoy, con su permiso por bloque.
import { prismaMock } from '@tests/__helpers__/setup'
import { resumenDePago } from '@/services/dashboard/rh/resumenDePago.service'
import { NotFoundError } from '@/errors/AppError'

const SEDE = 'venue-1'
const ORG = 'org-1'
const PERSONA = 'staff-1'
const TODO = { comisiones: true, pagoPorClase: true }

const esquema = (over: Record<string, unknown>) => ({
  id: 'cfg',
  name: 'General',
  venueId: SEDE,
  filterByStaff: false,
  staffIds: [],
  tiers: [],
  ...over,
})

beforeEach(() => {
  prismaMock.venue.findUnique.mockResolvedValue({ organizationId: ORG, timezone: 'America/Mexico_City' })
  prismaMock.staffVenue.findUnique.mockResolvedValue({ id: 'sv-1' })
  // validateStaffForCommission (el motor): StaffVenue activo de la sede, con su Staff.
  prismaMock.staffVenue.findFirst.mockResolvedValue({ staffId: PERSONA, role: 'WAITER', staff: { id: PERSONA, active: true } })
  prismaMock.commissionConfig.findMany.mockResolvedValue([])
  prismaMock.commissionOverride.findFirst.mockResolvedValue(null)
  prismaMock.staffPayLevelAssignment.findFirst.mockResolvedValue(null)
})

function nadaSeEscribio() {
  for (const modelo of Object.values(prismaMock)) {
    if (!modelo || typeof modelo !== 'object') continue
    for (const m of ['create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany'] as const) {
      if ((modelo as any)[m]) expect((modelo as any)[m]).not.toHaveBeenCalled()
    }
  }
}

describe('resumenDePago (spec RH §3.5)', () => {
  it('excepción con excludeFromCommissions ⇒ la comisión sale excluida; tasa personal en número', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([
      esquema({ id: 'cfg-a', name: 'Meseros' }),
      esquema({ id: 'cfg-b', name: 'Barra', filterByCategories: true, categoryIds: ['cat-bebidas'] }),
    ])
    prismaMock.commissionOverride.findFirst.mockImplementation(async ({ where }: any) =>
      where.configId === 'cfg-a'
        ? { excludeFromCommissions: true, customRate: null }
        : { excludeFromCommissions: false, customRate: '0.05' },
    )
    const r = await resumenDePago(SEDE, PERSONA, TODO)
    expect(r.comisiones).toEqual([
      { configId: 'cfg-a', nombre: 'Meseros', alcance: 'SEDE', excluida: true, tasaPersonal: null },
      { configId: 'cfg-b', nombre: 'Barra', alcance: 'SEDE', excluida: false, tasaPersonal: 0.05 },
    ])
    expect(prismaMock.commissionOverride.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ staffId: PERSONA }) }),
    )
    nadaSeEscribio()
  })

  it('un esquema «sólo elegidos» que no incluye a la persona NO aparece; uno de organización sale con su alcance', async () => {
    prismaMock.commissionConfig.findMany
      .mockResolvedValueOnce([]) // la sede no tiene esquemas propios ⇒ el motor cae a los de la organización
      .mockResolvedValueOnce([
        esquema({ id: 'cfg-otros', venueId: null, filterByStaff: true, staffIds: ['staff-9'] }),
        esquema({
          id: 'cfg-yo',
          venueId: null,
          name: 'Org',
          filterByStaff: true,
          staffIds: [PERSONA],
          filterByCategories: true,
          categoryIds: ['cat-1'],
        }),
      ])
    const r = await resumenDePago(SEDE, PERSONA, TODO)
    expect(r.comisiones).toEqual([{ configId: 'cfg-yo', nombre: 'Org', alcance: 'ORGANIZACION', excluida: false, tasaPersonal: null }])
  })

  // Lo que el motor USA (createCommissionForPayment ~:306-345), no todo lo activo. findMany llega ya en ORDEN_DE_ESQUEMAS.
  it('dos esquemas generales ⇒ sólo el de mayor prioridad (el motor paga catchAll[0])', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([
      esquema({ id: 'cfg-alta', name: 'Alta' }),
      esquema({ id: 'cfg-baja', name: 'Baja' }),
    ])
    const r = await resumenDePago(SEDE, PERSONA, TODO)
    expect(r.comisiones?.map(c => c.configId)).toEqual(['cfg-alta'])
  })

  it('un esquema por categorías cuyas categorías ya son todas de otro de mayor prioridad NO aparece; con una propia, sí', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([
      esquema({ id: 'cfg-dueno', filterByCategories: true, categoryIds: ['cat-1', 'cat-2'] }),
      esquema({ id: 'cfg-tapado', filterByCategories: true, categoryIds: ['cat-2', 'cat-1'] }),
      esquema({ id: 'cfg-parcial', filterByCategories: true, categoryIds: ['cat-2', 'cat-3'] }),
    ])
    const r = await resumenDePago(SEDE, PERSONA, TODO)
    expect(r.comisiones?.map(c => c.configId)).toEqual(['cfg-dueno', 'cfg-parcial'])
  })

  it('personas elegidas se miran DESPUÉS de repartir, como el motor: el general ganador sin la persona no cede su lugar', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([
      esquema({ id: 'cfg-general-otros', filterByStaff: true, staffIds: ['staff-9'] }),
      esquema({ id: 'cfg-general-yo', filterByStaff: true, staffIds: [PERSONA] }),
      // Es dueño de cat-1 aunque no incluya a la persona: el de abajo NO hereda esa categoría.
      esquema({ id: 'cfg-cat-otros', filterByCategories: true, categoryIds: ['cat-1'], filterByStaff: true, staffIds: ['staff-9'] }),
      esquema({ id: 'cfg-cat-yo', filterByCategories: true, categoryIds: ['cat-1'], filterByStaff: true, staffIds: [PERSONA] }),
    ])
    expect((await resumenDePago(SEDE, PERSONA, TODO)).comisiones).toEqual([])
  })

  it('monto fijo (FIXED) ⇒ sin tasa personal, aunque la excepción la tenga; la exclusión sí se conserva', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([
      esquema({ id: 'cfg-fijo', calcType: 'FIXED' }),
      esquema({ id: 'cfg-pct', calcType: 'PERCENTAGE', filterByCategories: true, categoryIds: ['cat-1'] }),
    ])
    prismaMock.commissionOverride.findFirst.mockResolvedValue({ excludeFromCommissions: true, customRate: '0.05' })
    const r = await resumenDePago(SEDE, PERSONA, TODO)
    expect(r.comisiones).toEqual([
      expect.objectContaining({ configId: 'cfg-fijo', excluida: true, tasaPersonal: null }),
      expect.objectContaining({ configId: 'cfg-pct', excluida: true, tasaPersonal: 0.05 }),
    ])
  })

  it('sin commissions:read ⇒ comisiones: null y no se consulta el motor; sin staffpay:read ⇒ nivelDeClase: SIN_PERMISO', async () => {
    const r = await resumenDePago(SEDE, PERSONA, { comisiones: false, pagoPorClase: false })
    expect(r).toEqual({ comisiones: null, nivelDeClase: 'SIN_PERMISO', propinas: { regla: 'ATIENDE_LUEGO_COBRA' } })
    expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
    expect(prismaMock.staffPayLevelAssignment.findFirst).not.toHaveBeenCalled()
  })

  it('StaffVenue inactivo ⇒ comisiones: [] (el motor no le calcula), sin leer esquemas', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([esquema({ id: 'cfg-a' })])
    prismaMock.staffVenue.findFirst.mockResolvedValue(null) // el motor busca con active: true
    const r = await resumenDePago(SEDE, PERSONA, TODO)
    expect(r.comisiones).toEqual([])
    expect(prismaMock.staffVenue.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId: PERSONA, venueId: SEDE, active: true } }),
    )
    expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
  })

  it('Staff inactivo ⇒ comisiones: []', async () => {
    prismaMock.commissionConfig.findMany.mockResolvedValue([esquema({ id: 'cfg-a' })])
    prismaMock.staffVenue.findFirst.mockResolvedValue({ staffId: PERSONA, role: 'WAITER', staff: { id: PERSONA, active: false } })
    expect((await resumenDePago(SEDE, PERSONA, TODO)).comisiones).toEqual([])
    expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
  })

  it('persona de otra sede ⇒ 404 y no lee nada más', async () => {
    prismaMock.staffVenue.findUnique.mockResolvedValue(null)
    await expect(resumenDePago(SEDE, PERSONA, TODO)).rejects.toBeInstanceOf(NotFoundError)
    expect(prismaMock.staffVenue.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { staffId_venueId: { staffId: PERSONA, venueId: SEDE } } }),
    )
    expect(prismaMock.commissionConfig.findMany).not.toHaveBeenCalled()
  })

  it('sin nivel ⇒ nivelDeClase: null; con nivel ⇒ nombre y desde (día civil), buscado en la organización hasta hoy', async () => {
    expect((await resumenDePago(SEDE, PERSONA, TODO)).nivelDeClase).toBeNull()
    prismaMock.staffPayLevelAssignment.findFirst.mockResolvedValue({
      effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
      payLevel: { name: 'Senior' },
    })
    expect((await resumenDePago(SEDE, PERSONA, TODO)).nivelDeClase).toEqual({ nombre: 'Senior', desde: '2026-09-01' })
    const args = prismaMock.staffPayLevelAssignment.findFirst.mock.calls[0][0]
    expect(args.where).toMatchObject({ staffId: PERSONA, organizationId: ORG, effectiveFrom: { lte: expect.any(Date) } })
    expect(args.orderBy).toEqual([{ effectiveFrom: 'desc' }, { revision: 'desc' }])
    nadaSeEscribio()
  })
})
