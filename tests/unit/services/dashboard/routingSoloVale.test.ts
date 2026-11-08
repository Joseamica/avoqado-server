/**
 * Aparatos claros, Paso 1: qué categorías del Ruteo son «Sólo vale · sin comanda».
 * La regla pura (`clasificarSoloVale`) y su lectura (`leerSoloVale`) con Prisma fingido.
 */
const mockPrisma: any = {
  venueAreaTicketSettings: { findUnique: jest.fn() },
  terminal: { findMany: jest.fn() },
  menuCategory: { findMany: jest.fn() },
  product: { groupBy: jest.fn() },
}
const mockFeature = jest.fn()
const mockFiltro = jest.fn()
jest.mock('../../../../src/utils/prismaClient', () => ({ __esModule: true, default: mockPrisma }))
jest.mock('../../../../src/services/access/basePlan.service', () => ({ venueHasFeatureAccess: (...a: unknown[]) => mockFeature(...a) }))
jest.mock('../../../../src/services/devices/deviceMenus.service', () => ({ resolveDeviceMenuFilters: (...a: unknown[]) => mockFiltro(...a) }))

import { clasificarSoloVale, leerSoloVale, MAX_EMISORES } from '../../../../src/services/dashboard/routingSoloVale'

const TODAS = ['c_quesos', 'c_pan', 'c_cafe', 'c_alimentos']
const cremeria = { areaId: 'a_cre', areaName: 'Cremería', sendsComanda: false }
const panaderia = { areaId: 'a_pan', areaName: 'Panadería', sendsComanda: false }
const cafeteria = { areaId: 'a_caf', areaName: 'Cafetería', sendsComanda: true }

describe('clasificarSoloVale (la regla pura)', () => {
  it('La Galeterie: lo que muestran Cremería y Panadería y no la Cafetería es «Sólo vale»', () => {
    const r = clasificarSoloVale(
      [
        { ...cremeria, visibles: ['c_quesos', 'c_pan'] },
        { ...panaderia, visibles: ['c_quesos', 'c_pan'] },
        { ...cafeteria, visibles: ['c_cafe', 'c_alimentos'] },
      ],
      TODAS,
    )
    expect([...r.categoryIds].sort()).toEqual(['c_pan', 'c_quesos'])
    expect(r.areas).toEqual([
      { id: 'a_cre', name: 'Cremería' },
      { id: 'a_pan', name: 'Panadería' },
    ])
  })

  it('una categoría que también muestra un área CON comanda NO es «Sólo vale» (esa PC sí manda comanda)', () => {
    const r = clasificarSoloVale(
      [
        { ...cremeria, visibles: ['c_quesos', 'c_cafe'] },
        { ...cafeteria, visibles: ['c_cafe'] },
      ],
      TODAS,
    )
    expect([...r.categoryIds]).toEqual(['c_quesos'])
  })

  it('«Todos los menús» (visibles null) = todas las categorías, de los dos lados', () => {
    expect([...clasificarSoloVale([{ ...cremeria, visibles: null }], TODAS).categoryIds].sort()).toEqual([...TODAS].sort())
    const r = clasificarSoloVale(
      [
        { ...cremeria, visibles: ['c_quesos'] },
        { ...cafeteria, visibles: null },
      ],
      TODAS,
    )
    expect(r.categoryIds.size).toBe(0)
    expect(r.areas).toEqual([])
  })

  it('sin áreas sin comanda no hay nada «Sólo vale»', () => {
    expect(clasificarSoloVale([{ ...cafeteria, visibles: ['c_cafe'] }], TODAS).categoryIds.size).toBe(0)
    expect(clasificarSoloVale([], TODAS).categoryIds.size).toBe(0)
  })

  it('un área sin comanda cuyas categorías ya están todas del lado con comanda no sale en la nota', () => {
    const r = clasificarSoloVale(
      [
        { ...cremeria, visibles: ['c_quesos'] },
        { ...panaderia, visibles: ['c_cafe'] },
        { ...cafeteria, visibles: ['c_cafe'] },
      ],
      TODAS,
    )
    expect(r.areas).toEqual([{ id: 'a_cre', name: 'Cremería' }])
  })
})

describe('leerSoloVale (la lectura)', () => {
  const VENUE = 'v1'
  const emisor = (id: string, area: { areaId: string; areaName: string; sendsComanda: boolean }) => ({
    id,
    fulfillmentArea: { id: area.areaId, name: area.areaName, sendsComanda: area.sendsComanda },
  })
  beforeEach(() => {
    jest.clearAllMocks()
    mockFeature.mockResolvedValue(true)
    mockPrisma.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: true })
    mockPrisma.menuCategory.findMany.mockResolvedValue(TODAS.map(id => ({ id })))
    mockPrisma.product.groupBy.mockResolvedValue(TODAS.map(categoryId => ({ categoryId, _count: 3 })))
  })

  it('con los vales apagados en el negocio no hay nada «Sólo vale» y no se leen aparatos', async () => {
    mockPrisma.venueAreaTicketSettings.findUnique.mockResolvedValue({ enabled: false })
    expect((await leerSoloVale(VENUE)).categoryIds.size).toBe(0)
    expect(mockPrisma.terminal.findMany).not.toHaveBeenCalled()
  })

  it('sin el plan de vales tampoco', async () => {
    mockFeature.mockResolvedValue(false)
    expect((await leerSoloVale(VENUE)).categoryIds.size).toBe(0)
    expect(mockPrisma.terminal.findMany).not.toHaveBeenCalled()
  })

  it('sólo cuenta PC activas (o en mantenimiento) que de verdad emiten (como ANDROID): área activa y pantalla de vales', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue([])
    await leerSoloVale(VENUE)
    const where = mockPrisma.terminal.findMany.mock.calls[0][0].where
    expect(where).toMatchObject({
      venueId: VENUE,
      canIssueAreaTickets: true,
      defaultWorkspace: 'AREA_OPERATIONS',
      status: { in: ['ACTIVE', 'MAINTENANCE'] },
      fulfillmentArea: { is: { venueId: VENUE, active: true } },
    })
  })

  it('arma la regla con el menú de cada PC; «Todos» lee las categorías del negocio', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue([emisor('t_cre', cremeria), emisor('t_caf', cafeteria)])
    mockFiltro.mockResolvedValue(
      new Map([
        ['t_cre', { visibleCategoryIds: null, visibleMenuIds: null }],
        ['t_caf', { visibleCategoryIds: ['c_cafe'], visibleMenuIds: ['m1'] }],
      ]),
    )
    const r = await leerSoloVale(VENUE)
    expect([...r.categoryIds].sort()).toEqual(['c_alimentos', 'c_pan', 'c_quesos'])
    expect(mockPrisma.menuCategory.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { venueId: VENUE } }))
    expect(mockFiltro).toHaveBeenCalledTimes(1) // un solo lote, no una lectura por PC
    expect(mockFiltro).toHaveBeenCalledWith(VENUE, ['t_cre', 't_caf'])
  })

  it('si ninguna PC emite de un área sin comanda, no lee menús', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue([emisor('t_caf', cafeteria)])
    expect((await leerSoloVale(VENUE)).categoryIds.size).toBe(0)
    expect(mockFiltro).not.toHaveBeenCalled()
  })

  it('pasado el tope de PC no adivina: nada «Sólo vale» (se ve como hoy)', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue(Array.from({ length: MAX_EMISORES + 1 }, (_, i) => emisor(`t${i}`, cremeria)))
    expect((await leerSoloVale(VENUE)).categoryIds.size).toBe(0)
    expect(mockFiltro).not.toHaveBeenCalled()
  })

  it('Codex r2 #1: una PC con comanda cuyo menú no tiene productos activos enseña TODO (como ANDROID): nada es «Sólo vale»', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue([emisor('t_cre', cremeria), emisor('t_caf', cafeteria)])
    mockFiltro.mockResolvedValue(
      new Map([
        ['t_cre', { visibleCategoryIds: ['c_quesos'], visibleMenuIds: ['m_cre'] }],
        ['t_caf', { visibleCategoryIds: ['c_vacia'], visibleMenuIds: ['m_caf'] }],
      ]),
    )
    expect((await leerSoloVale(VENUE)).categoryIds.size).toBe(0)
    expect(mockPrisma.product.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: VENUE, active: true, deletedAt: null } }),
    )
  })

  it('Codex r2 #2: si el lote de menús no sabe (pasó su tope), no adivina: nada «Sólo vale»', async () => {
    mockPrisma.terminal.findMany.mockResolvedValue([emisor('t_cre', cremeria)])
    mockFiltro.mockResolvedValue(null)
    expect((await leerSoloVale(VENUE)).categoryIds.size).toBe(0)
  })
})
