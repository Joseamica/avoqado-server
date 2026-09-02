import {
  buildInventoryByResponsible,
  type InventoryItemInput,
  type StaffInput,
} from '@/services/organization-dashboard/orgInventoryByResponsible.service'

const VIRTUAL = 'venue-virtual'
const TIENDA_QRO = 'venue-qro'
const TIENDA_SLP = 'venue-slp'

function item(overrides: Partial<InventoryItemInput> = {}): InventoryItemInput {
  return {
    assignedPromoterId: 'prom-1',
    assignedSupervisorId: 'sup-1',
    custodyState: 'PROMOTER_HELD',
    promoterAcceptedAt: new Date('2026-08-01T10:00:00.000Z'),
    registeredFromVenueId: VIRTUAL,
    saleVerificationStatus: null,
    ...overrides,
  }
}

function staff(overrides: Partial<StaffInput> = {}): StaffInput {
  return {
    id: 'prom-1',
    name: 'Promotor Uno',
    active: true,
    venues: [{ venueId: TIENDA_QRO, city: 'Querétaro', startDate: new Date('2026-01-01') }],
    ...overrides,
  }
}

const SUP_1 = staff({ id: 'sup-1', name: 'Supervisor Uno', venues: [] })

describe('buildInventoryByResponsible', () => {
  describe('jerarquía ciudad › supervisor › promotor', () => {
    it('agrupa al promotor bajo la ciudad de su sucursal y su supervisor', () => {
      const result = buildInventoryByResponsible({
        items: [item(), item()],
        staff: [staff(), SUP_1],
      })

      expect(result.cities).toHaveLength(1)
      expect(result.cities[0].city).toBe('Querétaro')
      expect(result.cities[0].supervisors).toHaveLength(1)
      expect(result.cities[0].supervisors[0].supervisorName).toBe('Supervisor Uno')
      expect(result.cities[0].supervisors[0].promoters[0]).toMatchObject({
        promoterName: 'Promotor Uno',
        assigned: 2,
      })
    })

    it('separa dos ciudades distintas', () => {
      const result = buildInventoryByResponsible({
        items: [item(), item({ assignedPromoterId: 'prom-2' })],
        staff: [
          staff(),
          staff({
            id: 'prom-2',
            name: 'Promotor Dos',
            venues: [{ venueId: TIENDA_SLP, city: 'San Luis Potosí', startDate: new Date('2026-01-01') }],
          }),
          SUP_1,
        ],
      })

      expect(result.cities.map(c => c.city)).toEqual(['Querétaro', 'San Luis Potosí'])
    })
  })

  describe('las 7 columnas', () => {
    it('acepta filas agregadas con peso sin cambiar ningún total', () => {
      const result = buildInventoryByResponsible({
        items: [
          item({ custodyState: 'PROMOTER_HELD', promoterAcceptedAt: new Date('2026-08-01T10:00:00.000Z'), weight: 120 } as any),
          item({ custodyState: 'SOLD', saleVerificationStatus: 'COMPLETED', weight: 75 } as any),
        ],
        staff: [staff(), SUP_1],
      })

      expect(result.total).toMatchObject({
        assigned: 195,
        receptionApproved: 195,
        inHandToday: 120,
        saleApproved: 75,
      })
    })

    it('cuenta cada columna contra su estado', () => {
      const result = buildInventoryByResponsible({
        items: [
          item({ custodyState: 'PROMOTER_PENDING', promoterAcceptedAt: null }),
          item({ custodyState: 'PROMOTER_HELD' }),
          item({ custodyState: 'PROMOTER_HELD' }),
          item({ custodyState: 'SOLD', saleVerificationStatus: 'COMPLETED' }),
          item({ custodyState: 'SOLD', saleVerificationStatus: 'PENDING' }),
          item({ custodyState: 'SOLD', saleVerificationStatus: 'PROCESSING' }),
          item({ custodyState: 'SOLD', saleVerificationStatus: 'FAILED' }),
          item({ custodyState: 'SOLD', saleVerificationStatus: 'REJECTED' }),
        ],
        staff: [staff(), SUP_1],
      })

      expect(result.total).toMatchObject({
        assigned: 8,
        receptionApproved: 7, // el PROMOTER_PENDING no lo aceptó
        inHandToday: 2,
        saleApproved: 1,
        saleInAdminReview: 2, // PENDING + PROCESSING
        saleInPromoterReview: 1, // FAILED = "Revisar" del promotor
        saleRejected: 1,
      })
    })

    it('🔴 una venta RECHAZADA no regresa el SIM a "en mano" (decisión Isaac, 25-ago)', () => {
      const result = buildInventoryByResponsible({
        items: [item({ custodyState: 'SOLD', saleVerificationStatus: 'REJECTED' })],
        staff: [staff(), SUP_1],
      })

      expect(result.total.saleRejected).toBe(1)
      expect(result.total.inHandToday).toBe(0)
    })

    it('"en mano HOY" ignora los rechazados por el promotor y los del supervisor', () => {
      const result = buildInventoryByResponsible({
        items: [item({ custodyState: 'PROMOTER_REJECTED' }), item({ custodyState: 'PROMOTER_HELD' })],
        staff: [staff(), SUP_1],
      })

      expect(result.total.inHandToday).toBe(1)
    })
  })

  describe('deducción del supervisor (47% de los SIMs no lo traen)', () => {
    it('deduce el supervisor del promotor a partir de los SIMs que sí lo traen', () => {
      const result = buildInventoryByResponsible({
        items: [item({ assignedSupervisorId: 'sup-1' }), item({ assignedSupervisorId: null }), item({ assignedSupervisorId: null })],
        staff: [staff(), SUP_1],
      })

      const sup = result.cities[0].supervisors
      expect(sup).toHaveLength(1)
      expect(sup[0].supervisorName).toBe('Supervisor Uno')
      expect(sup[0].promoters[0].assigned).toBe(3) // los 3 caen bajo él, no 1
    })

    it('con supervisores distintos gana el mayoritario, para que el promotor no se parta', () => {
      const result = buildInventoryByResponsible({
        items: [
          item({ assignedSupervisorId: 'sup-1' }),
          item({ assignedSupervisorId: 'sup-1' }),
          item({ assignedSupervisorId: 'sup-2' }),
          item({ assignedSupervisorId: null }),
        ],
        staff: [staff(), SUP_1, staff({ id: 'sup-2', name: 'Supervisor Dos', venues: [] })],
      })

      const sup = result.cities[0].supervisors
      expect(sup).toHaveLength(1)
      expect(sup[0].supervisorName).toBe('Supervisor Uno')
      expect(sup[0].promoters[0].assigned).toBe(4)
    })

    it('sin ningún supervisor en sus SIMs, cae en un grupo visible y no se pierde', () => {
      const result = buildInventoryByResponsible({
        items: [item({ assignedSupervisorId: null })],
        staff: [staff()],
      })

      expect(result.cities[0].supervisors[0].supervisorId).toBeNull()
      expect(result.cities[0].supervisors[0].promoters[0].assigned).toBe(1)
      expect(result.total.assigned).toBe(1)
    })
  })

  /**
   * 🔴 El caso que reportó Isaac por WhatsApp el 31-ago-2026, con captura:
   * "Juan Nájera aparece que tiene 2 vendedores" cuando su archivo le da 11.
   *
   * Causa: la tabla colocaba a cada promotor bajo el supervisor MAYORITARIO de sus
   * SIMs. Yolanda cambió de equipo —hoy trabaja en una tienda de Juan— pero las 61
   * SIMs que ya traía encima siguen grabadas a nombre de Hugo, que es quien se las
   * entregó. La estructura del equipo dice una cosa y el inventario viejo dice otra,
   * y ganaba el inventario viejo.
   *
   * El propio comentario de `resolveSupervisorId` ya decía que el supervisor "se
   * deduce del promotor, no del campo de cada SIM" — el código hacía lo contrario.
   */
  describe('🔴 el supervisor sale de la ESTRUCTURA, no del inventario viejo', () => {
    const HUGO = staff({ id: 'hugo', name: 'Hugo González', venues: [] })
    const JUAN = staff({ id: 'juan', name: 'Juan Nájera', venues: [] })
    const YOLANDA = staff({
      id: 'yolanda',
      name: 'Yolanda González',
      venues: [{ venueId: TIENDA_SLP, city: 'San Luis Potosí', startDate: new Date('2026-06-01') }],
    })

    it('cuelga al promotor de su tienda actual aunque TODAS sus SIMs digan otro supervisor', () => {
      const result = buildInventoryByResponsible({
        items: [
          item({ assignedPromoterId: 'yolanda', assignedSupervisorId: 'hugo' }),
          item({ assignedPromoterId: 'yolanda', assignedSupervisorId: 'hugo' }),
          item({ assignedPromoterId: 'yolanda', assignedSupervisorId: 'hugo' }),
        ],
        staff: [YOLANDA, HUGO, JUAN],
        venueSupervisors: { [TIENDA_SLP]: 'juan' },
      })

      const sup = result.cities[0].supervisors
      expect(sup).toHaveLength(1)
      expect(sup[0].supervisorName).toBe('Juan Nájera')
      expect(sup[0].promoters[0].promoterName).toBe('Yolanda González')
      // Sus SIMs viajan CON ella: el conteo del supervisor nuevo tiene que cuadrar.
      expect(sup[0].promoters[0].assigned).toBe(3)
      expect(sup[0].assigned).toBe(3)
    })

    it('sin estructura para esa tienda, cae al supervisor de sus SIMs y no se pierde', () => {
      // Es el respaldo para una tienda sin supervisor asignado: peor sería dejar
      // al promotor colgando de nadie.
      const result = buildInventoryByResponsible({
        items: [item({ assignedPromoterId: 'yolanda', assignedSupervisorId: 'hugo' })],
        staff: [YOLANDA, HUGO, JUAN],
        venueSupervisors: {},
      })

      expect(result.cities[0].supervisors[0].supervisorName).toBe('Hugo González')
    })

    it('sin estructura Y sin supervisor en las SIMs, sigue visible en su propio grupo', () => {
      const result = buildInventoryByResponsible({
        items: [item({ assignedPromoterId: 'yolanda', assignedSupervisorId: null })],
        staff: [YOLANDA, HUGO, JUAN],
      })

      expect(result.cities[0].supervisors[0].supervisorId).toBeNull()
      expect(result.total.assigned).toBe(1)
    })

    it('dos promotores de la MISMA tienda caen bajo el mismo supervisor, aunque sus SIMs difieran', () => {
      // Esto es lo que hacía que Juan apareciera con 2 de sus 11: cada promotor
      // se iba con el supervisor que dijeran SUS SIMs, partiendo al equipo.
      const otra = staff({
        id: 'kasandra',
        name: 'Kasandra Aguilera',
        venues: [{ venueId: TIENDA_SLP, city: 'San Luis Potosí', startDate: new Date('2026-06-01') }],
      })

      const result = buildInventoryByResponsible({
        items: [
          item({ assignedPromoterId: 'yolanda', assignedSupervisorId: 'hugo' }),
          item({ assignedPromoterId: 'kasandra', assignedSupervisorId: null }),
        ],
        staff: [YOLANDA, otra, HUGO, JUAN],
        venueSupervisors: { [TIENDA_SLP]: 'juan' },
      })

      const sup = result.cities[0].supervisors
      expect(sup).toHaveLength(1)
      expect(sup[0].supervisorName).toBe('Juan Nájera')
      expect(sup[0].promoters.map(p => p.promoterName).sort()).toEqual(['Kasandra Aguilera', 'Yolanda González'])
    })
  })

  describe('promotor con dos sucursales', () => {
    it('usa la asignación MÁS RECIENTE (caso Tirza Juárez → Querétaro)', () => {
      const tirza = staff({
        id: 'prom-1',
        name: 'Tirza Juárez',
        venues: [
          { venueId: TIENDA_SLP, city: 'San Luis Potosí', startDate: new Date('2026-03-25') },
          { venueId: TIENDA_QRO, city: 'Querétaro', startDate: new Date('2026-07-17') },
        ],
      })

      const result = buildInventoryByResponsible({ items: [item()], staff: [tirza, SUP_1] })

      expect(result.cities).toHaveLength(1)
      expect(result.cities[0].city).toBe('Querétaro')
    })
  })

  describe('promotores dados de baja (los 338 SIMs)', () => {
    it('los saca a un renglón aparte, visible, nunca escondido', () => {
      const result = buildInventoryByResponsible({
        items: [item(), item({ assignedPromoterId: 'baja-1' })],
        staff: [staff(), SUP_1, staff({ id: 'baja-1', name: 'Ignacio Mitre', active: false, venues: [] })],
      })

      expect(result.cities).toHaveLength(1)
      expect(result.cities[0].supervisors[0].promoters[0].promoterName).toBe('Promotor Uno')

      expect(result.unassigned.promoters).toHaveLength(1)
      expect(result.unassigned.promoters[0]).toMatchObject({ promoterName: 'Ignacio Mitre', assigned: 1 })
    })

    it('un promotor activo sin sucursal también cae ahí, no desaparece', () => {
      const result = buildInventoryByResponsible({
        items: [item({ assignedPromoterId: 'sin-suc' })],
        staff: [staff({ id: 'sin-suc', name: 'Sin Sucursal', active: true, venues: [] }), SUP_1],
      })

      expect(result.cities).toHaveLength(0)
      expect(result.unassigned.promoters[0].promoterName).toBe('Sin Sucursal')
      expect(result.unassigned.assigned).toBe(1)
    })
  })

  describe('Total País', () => {
    it('suma las ciudades MÁS el renglón de bajas, para que nada se pierda', () => {
      const result = buildInventoryByResponsible({
        items: [item(), item({ assignedPromoterId: 'prom-2' }), item({ assignedPromoterId: 'baja-1' })],
        staff: [
          staff(),
          staff({
            id: 'prom-2',
            name: 'Promotor Dos',
            venues: [{ venueId: TIENDA_SLP, city: 'San Luis Potosí', startDate: new Date('2026-01-01') }],
          }),
          staff({ id: 'baja-1', name: 'Baja Uno', active: false, venues: [] }),
          SUP_1,
        ],
      })

      const sumaCiudades = result.cities.reduce((n, c) => n + c.assigned, 0)
      expect(sumaCiudades).toBe(2)
      expect(result.unassigned.assigned).toBe(1)
      expect(result.total.assigned).toBe(3)
    })

    it('cada nivel suma a su padre', () => {
      const result = buildInventoryByResponsible({
        items: [item(), item(), item({ assignedPromoterId: 'prom-2' })],
        staff: [staff(), staff({ id: 'prom-2', name: 'Promotor Dos' }), SUP_1],
      })

      const city = result.cities[0]
      const sup = city.supervisors[0]
      expect(sup.promoters.reduce((n, p) => n + p.assigned, 0)).toBe(sup.assigned)
      expect(city.supervisors.reduce((n, s) => n + s.assigned, 0)).toBe(city.assigned)
    })
  })

  describe('filtro de sucursal receptora', () => {
    it('filtra por la sucursal receptora indicada', () => {
      const result = buildInventoryByResponsible({
        items: [item({ registeredFromVenueId: VIRTUAL }), item({ registeredFromVenueId: TIENDA_SLP })],
        staff: [staff(), SUP_1],
        receivingVenueId: VIRTUAL,
      })

      expect(result.total.assigned).toBe(1)
    })

    it('sin filtro muestra TODO — el supervisor tiene que poder cuadrar el conteo físico', () => {
      const result = buildInventoryByResponsible({
        items: [item({ registeredFromVenueId: VIRTUAL }), item({ registeredFromVenueId: TIENDA_SLP })],
        staff: [staff(), SUP_1],
      })

      expect(result.total.assigned).toBe(2)
    })

    it('el filtro aplica PAREJO a las 7 columnas, para que la resta siga cuadrando', () => {
      const result = buildInventoryByResponsible({
        items: [
          item({ registeredFromVenueId: VIRTUAL, custodyState: 'PROMOTER_HELD' }),
          item({ registeredFromVenueId: TIENDA_SLP, custodyState: 'PROMOTER_HELD' }),
          item({ registeredFromVenueId: TIENDA_SLP, custodyState: 'SOLD', saleVerificationStatus: 'COMPLETED' }),
        ],
        staff: [staff(), SUP_1],
      })

      const conFiltro = buildInventoryByResponsible({
        items: [
          item({ registeredFromVenueId: VIRTUAL, custodyState: 'PROMOTER_HELD' }),
          item({ registeredFromVenueId: TIENDA_SLP, custodyState: 'PROMOTER_HELD' }),
          item({ registeredFromVenueId: TIENDA_SLP, custodyState: 'SOLD', saleVerificationStatus: 'COMPLETED' }),
        ],
        staff: [staff(), SUP_1],
        receivingVenueId: VIRTUAL,
      })

      expect(result.total).toMatchObject({ assigned: 3, inHandToday: 2, saleApproved: 1 })
      expect(conFiltro.total).toMatchObject({ assigned: 1, inHandToday: 1, saleApproved: 0 })
    })
  })

  describe('regresión: casos que no deben romperse', () => {
    it('sin ítems devuelve una estructura vacía pero válida, no explota', () => {
      const result = buildInventoryByResponsible({ items: [], staff: [] })

      expect(result.cities).toEqual([])
      expect(result.unassigned.promoters).toEqual([])
      expect(result.total.assigned).toBe(0)
      expect(result.total.inHandToday).toBe(0)
    })

    it('ignora ítems que todavía no tienen promotor (están con admin o supervisor)', () => {
      const result = buildInventoryByResponsible({
        items: [
          item({ assignedPromoterId: null, custodyState: 'ADMIN_HELD' }),
          item({ assignedPromoterId: null, custodyState: 'SUPERVISOR_HELD' }),
          item(),
        ],
        staff: [staff(), SUP_1],
      })

      expect(result.total.assigned).toBe(1)
    })

    it('un promotor que no está en el catálogo de staff no tumba el reporte', () => {
      const result = buildInventoryByResponsible({
        items: [item({ assignedPromoterId: 'fantasma' })],
        staff: [],
      })

      expect(result.total.assigned).toBe(1)
      expect(result.unassigned.promoters).toHaveLength(1)
    })

    it('las ciudades salen ordenadas alfabéticamente, estable entre corridas', () => {
      const mk = (id: string, city: string) =>
        staff({ id, name: id, venues: [{ venueId: `v-${id}`, city, startDate: new Date('2026-01-01') }] })

      const result = buildInventoryByResponsible({
        items: [item({ assignedPromoterId: 'c' }), item({ assignedPromoterId: 'a' }), item({ assignedPromoterId: 'b' })],
        staff: [mk('c', 'Zacatecas'), mk('a', 'Aguascalientes'), mk('b', 'Monterrey'), SUP_1],
      })

      expect(result.cities.map(c => c.city)).toEqual(['Aguascalientes', 'Monterrey', 'Zacatecas'])
    })
  })

  describe('estructura completa: promotores sin SIMs (pedido de Isaac, 27-ago)', () => {
    it('muestra al promotor activo aunque tenga CERO SIMs asignados', () => {
      const result = buildInventoryByResponsible({
        items: [item()],
        staff: [staff(), SUP_1, staff({ id: 'sin-sims', name: 'Joana Sánchez', role: 'PROMOTER' })],
      })

      const nombres = result.cities.flatMap(c => c.supervisors.flatMap(s => s.promoters.map(p => p.promoterName)))
      expect(nombres).toContain('Joana Sánchez')
      const joana = result.cities[0].supervisors.flatMap(s => s.promoters).find(p => p.promoterName === 'Joana Sánchez')!
      expect(joana.assigned).toBe(0)
      expect(joana.inHandToday).toBe(0)
    })

    it('un promotor en cero NO altera los totales', () => {
      const conCero = buildInventoryByResponsible({
        items: [item()],
        staff: [staff(), SUP_1, staff({ id: 'sin-sims', name: 'Joana Sánchez', role: 'PROMOTER' })],
      })
      expect(conCero.total.assigned).toBe(1)
      expect(conCero.total.inHandToday).toBe(1)
    })

    it('lo agrupa bajo el supervisor de SU sucursal, que es la única pista cuando no hay SIMs', () => {
      const result = buildInventoryByResponsible({
        items: [item()],
        staff: [staff(), SUP_1, staff({ id: 'sin-sims', name: 'Joana Sánchez', role: 'PROMOTER' })],
        venueSupervisors: { [TIENDA_QRO]: 'sup-1' },
      })

      const sup = result.cities[0].supervisors.find(s => s.supervisorId === 'sup-1')!
      expect(sup.promoters.map(p => p.promoterName)).toContain('Joana Sánchez')
    })

    it('un SUPERVISOR activo sin promotores con SIMs también aparece (caso Juan Nájera)', () => {
      const result = buildInventoryByResponsible({
        items: [],
        staff: [
          staff({
            id: 'sup-9',
            name: 'Juan Nájera',
            role: 'SUPERVISOR',
            venues: [{ venueId: TIENDA_SLP, city: 'San Luis Potosí', startDate: new Date('2026-01-01') }],
          }),
        ],
      })

      expect(result.cities.map(c => c.city)).toContain('San Luis Potosí')
      const sup = result.cities[0].supervisors[0]
      expect(sup.supervisorName).toBe('Juan Nájera')
      expect(sup.assigned).toBe(0)
    })

    it('un promotor DADO DE BAJA sin SIMs no ensucia la tabla', () => {
      const result = buildInventoryByResponsible({
        items: [item()],
        staff: [staff(), SUP_1, staff({ id: 'baja-sin-sims', name: 'Baja Vacía', active: false, role: 'PROMOTER', venues: [] })],
      })

      expect(result.unassigned.promoters.map(p => p.promoterName)).not.toContain('Baja Vacía')
    })

    it('regresión: sin `role` en el catálogo, el comportamiento anterior no cambia', () => {
      const result = buildInventoryByResponsible({
        items: [item()],
        staff: [staff(), SUP_1, staff({ id: 'otro', name: 'No Debe Salir' })],
      })

      const nombres = result.cities.flatMap(c => c.supervisors.flatMap(s => s.promoters.map(p => p.promoterName)))
      expect(nombres).not.toContain('No Debe Salir')
    })
  })
})
