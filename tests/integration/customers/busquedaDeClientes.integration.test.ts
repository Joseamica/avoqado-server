/**
 * Búsqueda de clientes contra Postgres REAL (spec 2026-10-14 §3.2). Lo que un mock no prueba: el plegado de acentos con
 * `translate` bajo lc_ctype C, los dígitos de teléfonos guardados con formato, que otro negocio JAMÁS aparece, y (auditoría
 * A #7) que con más coincidencias que el tope la búsqueda NO cambia de significado: las más nuevas y searchCapped.
 * Ruling B3: topada, `meta.totalCount` = lo ALCANZABLE (lo que Prisma pagina) y `meta.totalMatches` = el total EXACTO.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'
import { getCustomers } from '@/services/dashboard/customer.dashboard.service'

describe('búsqueda de clientes (integración)', () => {
  let orgId: string | undefined
  let venueA: string | undefined
  let venueB: string | undefined
  const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Busqueda', email: `itest-busq-${sello}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    const venue = (slug: string) =>
      prisma.venue.create({
        data: {
          name: slug,
          slug,
          organizationId: org.id,
          address: 'X',
          city: 'X',
          state: 'X',
          country: 'MX',
          zipCode: '00000',
          timezone: 'America/Mexico_City',
        },
      })
    venueA = (await venue(`itest-busq-a-${sello}`)).id
    venueB = (await venue(`itest-busq-b-${sello}`)).id
    // `createdAt` explícito: el orden «más nuevos primero» de las pruebas del tope no puede depender del reloj.
    const dia = (d: number) => new Date(Date.UTC(2026, 9, d, 18, 0, 0))
    await prisma.customer.createMany({
      data: [
        { venueId: venueA, firstName: 'José', lastName: 'Pérez', phone: '+525543453965', createdAt: dia(1) },
        {
          venueId: venueA,
          firstName: 'Ana',
          lastName: 'López',
          phone: '55 1234 5678',
          email: 'ana@correo.com',
          tags: ['vip'],
          createdAt: dia(2),
        },
        { venueId: venueA, firstName: 'Dany', phone: '+5598765432', createdAt: dia(3) },
        { venueId: venueA, firstName: 'Mariana', tags: ['vip'], createdAt: dia(4) },
        { venueId: venueA, firstName: 'Sara', createdAt: dia(5) },
        { venueId: venueB, firstName: 'José', lastName: 'Pérez', phone: '+525543453965', createdAt: dia(1) },
      ],
    })
    // Saldo pendiente (para el filtro del dashboard dentro del SQL): Ana y Dany deben; la cuenta CANCELADA de Sara no cuenta.
    const deudores = await prisma.customer.findMany({
      where: { venueId: venueA, firstName: { in: ['Ana', 'Dany', 'Sara'] } },
      select: { id: true, firstName: true },
      take: 3,
    })
    for (const c of deudores) {
      await prisma.order.create({
        data: {
          venueId: venueA,
          orderNumber: `ITEST-BUSQ-${sello}-${c.firstName}`,
          subtotal: 50,
          taxAmount: 0,
          total: 50,
          remainingBalance: 50,
          paymentStatus: 'PENDING',
          status: c.firstName === 'Sara' ? 'CANCELLED' : 'PENDING',
          orderCustomers: { create: { customerId: c.id, isPrimary: true } },
        },
      })
    }
  })

  afterAll(async () => {
    // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
    if (!venueA || !venueB || !orgId) return
    await prisma.order.deleteMany({ where: { venueId: { in: [venueA, venueB] } } }) // sus OrderCustomer caen en cascada
    await prisma.customer.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
    await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
    await prisma.organization.deleteMany({ where: { id: orgId } })
    await prisma.$disconnect()
  })

  const nombres = async (search: string) => (await getCustomers(venueA!, 1, 50, search)).data.map(c => c.firstName).sort()

  it.each([['55 4345 3965'], ['5543453965'], ['525543453965'], ['5215543453965'], ['+52 1 55 4345 3965'], ['4345']])(
    'teléfono %p encuentra a José (sólo el de ESTE negocio)',
    async texto => {
      const r = await getCustomers(venueA!, 1, 50, texto)
      expect(r.data.map(c => c.firstName)).toEqual(['José'])
      expect(r.meta.totalCount).toBe(1)
    },
  )

  it('teléfono guardado con espacios («55 1234 5678») se encuentra escribiendo dígitos', async () => {
    expect(await nombres('5512345678')).toEqual(['Ana'])
  })

  it('🔴 Dany guardado sin lada (+5598765432) se encuentra con el 52 delante', async () => {
    expect(await nombres('52 55 9876 5432')).toEqual(['Dany'])
  })

  it.each([['jose'], ['JOSÉ'], ['José'], ['perez']])('nombre sin importar acentos ni mayúsculas: %p', async texto => {
    expect(await nombres(texto)).toEqual(['José'])
  })

  it('dos palabras: «ana lopez»', async () => {
    expect(await nombres('ana lopez')).toEqual(['Ana'])
  })

  it('por correo', async () => {
    expect(await nombres('ana@correo')).toEqual(['Ana'])
  })

  it('🔴 el cliente de OTRO negocio jamás aparece', async () => {
    const r = await getCustomers(venueA!, 1, 100, 'jose')
    expect(r.data.every(c => c.id)).toBe(true)
    expect(r.meta.totalCount).toBe(1)
    const enB = await getCustomers(venueB!, 1, 100, 'a')
    expect(enB.data).toHaveLength(0) // «José Pérez» de B no tiene «a»; Ana, Dany, Mariana y Sara son de A
  })

  it('pageSize hostil se topa en 100', async () => {
    expect((await getCustomers(venueA!, 1, 100000)).meta.pageSize).toBe(100)
  })

  it('un comodín del texto no se lee como comodín («%» no encuentra a todos)', async () => {
    expect(await nombres('%')).toEqual([])
    expect(await nombres('_')).toEqual([])
  })

  // ── Auditoría A #7 + ruling B3: más coincidencias que el tope (tope inyectado; «a» casa con Ana, Dany, Mariana y Sara) ──
  const buscarA = (pagina: number, tope: number, extra: { tags?: string; pendiente?: boolean } = {}) =>
    getCustomers(venueA!, pagina, 1, 'a', undefined, undefined, extra.tags, 'createdAt', 'desc', extra.pendiente, { topeDeBusqueda: tope })

  it('🔴 sin pasar el tope: total exacto y se recorren TODAS las páginas', async () => {
    const r = await buscarA(2, 10)
    expect(r.data.map(c => c.firstName)).toEqual(['Mariana'])
    expect(r.meta).toMatchObject({ totalCount: 4, totalPages: 4, hasNextPage: true })
    expect(r.meta).not.toHaveProperty('searchCapped')
    expect(r.meta).not.toHaveProperty('totalMatches')
  })

  it('🔴 pasando el tope: las MÁS NUEVAS, totalCount ALCANZABLE, totalMatches EXACTO y searchCapped; la página 2 es la última', async () => {
    const p1 = await buscarA(1, 2)
    const p2 = await buscarA(2, 2)
    const p3 = await buscarA(3, 2)
    expect(p1.data.map(c => c.firstName)).toEqual(['Sara'])
    expect(p1.meta).toMatchObject({ totalCount: 2, totalMatches: 4, totalPages: 2, hasNextPage: true, searchCapped: true })
    expect(p2.data.map(c => c.firstName)).toEqual(['Mariana'])
    expect(p2.meta).toMatchObject({ totalCount: 2, totalMatches: 4, totalPages: 2, hasNextPage: false, searchCapped: true })
    // Ninguna página que el dashboard ofrezca (1..totalPages) sale vacía; la de más allá no se ofrece.
    expect(p3.data).toHaveLength(0)
    expect(p3.meta.hasNextPage).toBe(false)
  })

  it('🔴 la regla NO cambia al pasar el tope: el total de «JOSÉ» se cuenta con el MISMO plegado de acentos (tope 0)', async () => {
    // Antes la búsqueda era un `contains` de Prisma sin plegar acentos: «jose» no encontraba «José».
    const r = await getCustomers(venueA!, 1, 50, 'JOSÉ', undefined, undefined, undefined, 'createdAt', 'desc', undefined, {
      topeDeBusqueda: 0,
    })
    expect(r.meta).toMatchObject({ totalCount: 0, totalMatches: 1, totalPages: 0, searchCapped: true })
  })

  it('🔴 el filtro de etiquetas va ANTES del tope y el total lo respeta (SQL real de `tags && …`)', async () => {
    const r = await buscarA(1, 1, { tags: 'vip' })
    expect(r.data.map(c => c.firstName)).toEqual(['Mariana'])
    expect(r.meta).toMatchObject({ totalCount: 1, totalMatches: 2, searchCapped: true })
  })

  it('🔴 el filtro de saldo pendiente en SQL no cuenta la cuenta CANCELADA (EXISTS real contra Order)', async () => {
    const r = await buscarA(1, 1, { pendiente: true })
    expect(r.data.map(c => c.firstName)).toEqual(['Dany'])
    expect(r.meta).toMatchObject({ totalCount: 1, totalMatches: 2, searchCapped: true })
    const todos = await getCustomers(venueA!, 1, 50, 'a', undefined, undefined, undefined, 'createdAt', 'desc', true)
    expect(todos.data.map(c => c.firstName).sort()).toEqual(['Ana', 'Dany'])
    expect(todos.meta.totalCount).toBe(2)
  })
})
