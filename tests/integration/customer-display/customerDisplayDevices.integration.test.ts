// tests/integration/customer-display/customerDisplayDevices.integration.test.ts
import prisma from '@/utils/prismaClient'
import { listCustomerDisplayDevices } from '@/services/customer-display/customerDisplayDesign.service'

/**
 * La lista de dispositivos contra Postgres de verdad: el ORDEN y la paginación por cursor sólo se pueden probar con la
 * base, porque dependen de cómo Postgres desempata filas con el mismo nombre.
 *
 * Andamiaje: una organización con dos negocios. En A, cinco POS_ANDROID que se llaman TODAS «Caja» (una con la
 * pantalla vista hace 30 días) y una TPV_ANDROID, que no tiene pantalla del cliente y no debe salir; en B, una
 * POS_ANDROID cuyo id se usa como cursor ajeno.
 */

const suffix = `cdl-${Date.now()}`
const HACE_30_DIAS = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)

let orgId: string
let venueA: string
let venueB: string
let cajasDeA: string[]
let cajaVieja: string
let cajaDeB: string

const crearVenue = async (n: string) =>
  (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `${n} ${suffix}`, slug: `${n.toLowerCase()}-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id

const crearTerminal = async (data: { venueId: string; type: 'POS_ANDROID' | 'TPV_ANDROID'; extra?: Record<string, unknown> }) =>
  (
    await prisma.terminal.create({
      data: { venueId: data.venueId, name: 'Caja', type: data.type, ...(data.extra ?? {}) },
      select: { id: true },
    })
  ).id

beforeAll(async () => {
  const org = await prisma.organization.create({
    data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
    select: { id: true },
  })
  orgId = org.id
  venueA = await crearVenue('A')
  venueB = await crearVenue('B')

  cajaVieja = await crearTerminal({
    venueId: venueA,
    type: 'POS_ANDROID',
    extra: { customerDisplayPresent: true, capabilitiesObservedAt: HACE_30_DIAS },
  })
  cajasDeA = [cajaVieja]
  for (let i = 0; i < 4; i++) cajasDeA.push(await crearTerminal({ venueId: venueA, type: 'POS_ANDROID' }))
  await crearTerminal({ venueId: venueA, type: 'TPV_ANDROID' }) // no tiene pantalla del cliente: no sale en la lista
  cajaDeB = await crearTerminal({ venueId: venueB, type: 'POS_ANDROID' })
})

afterAll(async () => {
  if (!venueA || !venueB) return
  await prisma.terminal.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

/**
 * 🔴 Con nombres empatados, Postgres devuelve las filas en el orden en que las tiene guardadas, y ese orden CAMBIA cuando
 * una fila se reescribe. En la vida real eso pasa todo el tiempo: mientras el dueño pasa las páginas, los aparatos
 * reportan su salud. Aquí se reproduce: después de cada página, las filas que se acaban de ver cambian una columna
 * indexada (`latestHealthScore`), así que Postgres las reubica al final. Sin el desempate por id, la página siguiente
 * encuentra el cursor en otro lugar y se salta o repite dispositivos. (Sin estas escrituras, quitar el desempate NO
 * tumbaba la prueba: medido, 3 de 3 corridas en verde — el orden físico coincidía por casualidad con el de inserción.)
 */
it('recorre las cinco «Caja» de 2 en 2 sin repetir ni perder ninguna, con el total correcto, aunque las filas se reescriban entre página y página', async () => {
  const vistos: string[] = []
  let cursor: string | undefined
  let paginas = 0
  do {
    const pagina = await listCustomerDisplayDevices({ venueId: venueA, cursor, take: 2 })
    expect(pagina.total).toBe(5)
    vistos.push(...pagina.devices.map(d => d.id))
    cursor = pagina.nextCursor ?? undefined
    paginas += 1
    await prisma.terminal.updateMany({ where: { id: { in: pagina.devices.map(d => d.id) } }, data: { latestHealthScore: 90 + paginas } })
  } while (cursor && paginas < 10) // el tope sólo evita un ciclo infinito si el cursor se rompe
  expect(paginas).toBe(3)
  expect(vistos).toHaveLength(5) // ninguno repetido…
  expect([...vistos].sort()).toEqual([...cajasDeA].sort()) // …y ninguno perdido
})

it('una presencia de hace 30 días sale «desconocida» y marcada vieja, igual que en el detalle', async () => {
  const { devices } = await listCustomerDisplayDevices({ venueId: venueA, take: 50 })
  expect(devices.find(d => d.id === cajaVieja)).toMatchObject({ presence: 'UNKNOWN', stale: true, editToken: 'factory' })
})

it('un cursor de OTRO negocio es 400, no una página de otro venue', async () => {
  await expect(listCustomerDisplayDevices({ venueId: venueA, cursor: cajaDeB, take: 2 })).rejects.toMatchObject({
    statusCode: 400,
    code: 'INVALID_CURSOR',
  })
})

// Codex r8, N8: con cinco terminales, «como mucho 50» pasaba aunque se quitara el tope. Hacen falta MÁS de 50.
it('el servicio topa por su cuenta: con 51 terminales, take 500 da exactamente 50, el total real y el cursor al resto', async () => {
  // Un venue C propio para no tocar el total de A que miden las otras pruebas.
  const venueC = await crearVenue('C')
  try {
    await prisma.terminal.createMany({
      data: Array.from({ length: 51 }, (_, i) => ({
        venueId: venueC,
        name: `Caja ${String(i).padStart(2, '0')}`,
        type: 'POS_ANDROID' as const,
        serialNumber: `CAP-${suffix}-${i}`,
      })),
    })
    const todas = (await prisma.terminal.findMany({ where: { venueId: venueC }, select: { id: true }, take: 51 })).map(t => t.id)
    const consulta = jest.spyOn(prisma.terminal, 'findMany')

    const primera = await listCustomerDisplayDevices({ venueId: venueC, take: 500 })
    expect(primera.devices).toHaveLength(50)
    expect(primera.total).toBe(51)
    expect(primera.nextCursor).not.toBeNull()
    // Y la consulta que llegó a Prisma ya iba acotada (50 + 1 para saber si hay más), no 500.
    expect(consulta.mock.calls.at(-1)?.[0]).toMatchObject({ take: 51 })
    consulta.mockRestore()

    const segunda = await listCustomerDisplayDevices({ venueId: venueC, cursor: primera.nextCursor!, take: 500 })
    expect(segunda.devices).toHaveLength(1)
    expect(segunda.nextCursor).toBeNull()
    expect([...primera.devices, ...segunda.devices].map(d => d.id).sort()).toEqual([...todas].sort())
  } finally {
    // La guarda de limpieza, sin `return`: dentro de un `finally` taparía el error de la prueba (`no-unsafe-finally`).
    if (venueC) {
      await prisma.terminal.deleteMany({ where: { venueId: venueC } })
      await prisma.venue.delete({ where: { id: venueC } })
    }
  }
})
