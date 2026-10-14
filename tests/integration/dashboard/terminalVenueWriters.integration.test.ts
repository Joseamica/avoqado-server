/**
 * Los escritores de `Terminal.venueId` del carril de comandos de la TPV, contra PostgreSQL REAL.
 *
 * 🔴 G4 (auditoría de Codex del plan de la pantalla del cliente, 14-oct): deshacer una migración (cancelarla o descartar su
 * borrado) sólo vale si sigue siendo la VIGENTE. Una cancelación o un descarte viejos que esperaban el candado de la
 * terminal no pueden regresarla a un negocio que ya no le toca, ni escribirle encima los comercios de una migración más
 * nueva: el dinero se iría por la afiliación equivocada. Las unitarias fingen el candado; aquí la carrera es real, con la
 * barrera de `../customer-display/barrera` metiendo el cambio ENTRE la lectura inicial de la operación y su candado.
 *
 * Run with (base desechable, nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/dashboard/terminalVenueWriters.integration.test.ts
 */
import { Prisma, TpvCommandStatus } from '@prisma/client'

import { migrateCancel, migrateDiscard } from '@/services/dashboard/terminal-migration.service'
import prisma from '@/utils/prismaClient'

import { esperarBloqueado, retenerTerminal } from '../customer-display/barrera'

const ts = Date.now()
const suffix = `tvw-${ts}`
const HORA = 60 * 60 * 1000

let orgId: string
let venueA: string
let venueB: string
let venueC: string
let providerId: string
let mViejo: string
let mNuevo: string
let m1: string
let terminalId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const crearVenue = async (n: string, organizationId: string) =>
    (
      await prisma.venue.create({
        data: { organizationId, name: `Venue ${n} ${suffix}`, slug: `venue-${n}-${suffix}`, timezone: 'America/Mexico_City' },
        select: { id: true },
      })
    ).id
  venueA = await crearVenue('a', orgId)
  venueB = await crearVenue('b', orgId)
  venueC = await crearVenue('c', orgId)

  // Un proveedor propio, fuera del catálogo de compatibilidad: no restringe marca (`isProviderCompatibleWithBrand`).
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `CD_TEST_${ts}`, name: `Proveedor ${suffix}`, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
      select: { id: true },
    })
  ).id
  const crearComercio = async (n: string) =>
    (
      await prisma.merchantAccount.create({
        data: { providerId, externalMerchantId: `${n}-${suffix}`, displayName: n, active: true, credentialsEncrypted: {} },
        select: { id: true },
      })
    ).id
  mViejo = await crearComercio('m-viejo')
  mNuevo = await crearComercio('m-nuevo')
  m1 = await crearComercio('m1')
})

/** Las terminales de la prueba (y lo que cuelga de ellas) se borran por id: nunca una limpieza amplia. */
async function borrarTerminales(ids: string[]) {
  if (!ids.length) return
  await prisma.tpvCommandHistory.deleteMany({ where: { terminalId: { in: ids } } })
  await prisma.tpvCommandQueue.deleteMany({ where: { terminalId: { in: ids } } })
  await prisma.activityLog.deleteMany({ where: { entityId: { in: ids } } })
  await prisma.terminal.deleteMany({ where: { id: { in: ids } } }) // el diseño se va en cascada
}

beforeEach(async () => {
  if (!venueA || !venueB || !venueC) return
  if (terminalId) await borrarTerminales([terminalId])
  // TPV del protocolo viejo (v1): en una migración ya se mudó al destino. Está en B, donde la dejó A→B.
  terminalId = (
    await prisma.terminal.create({
      data: { venueId: venueB, name: `TPV ${suffix}`, type: 'TPV_ANDROID', brand: 'PAX', assignedMerchantIds: [] },
      select: { id: true },
    })
  ).id
  // El gancho no mira el tipo de terminal: un diseño suelto basta para ver si una reversión lo borra.
  await prisma.customerDisplayDesign.create({ data: { terminalId, welcomeText: 'Hola' } })
})

afterAll(async () => {
  if (!venueA || !venueB || !venueC) return
  const terminales = await prisma.terminal.findMany({
    where: { venueId: { in: [venueA, venueB, venueC] } },
    select: { id: true },
    take: 50,
  })
  await borrarTerminales(terminales.map(t => t.id))
  if (providerId) {
    await prisma.merchantAccount.deleteMany({ where: { providerId } })
    await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  }
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB, venueC] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const crearOrden = async (data: {
  status: TpvCommandStatus
  venueId: string
  expiresAt: Date
  createdAt?: Date
  payload: Prisma.InputJsonValue
}) =>
  (
    await prisma.tpvCommandQueue.create({
      data: { terminalId, commandType: 'FACTORY_RESET', priority: 'CRITICAL', requestedBy: 'system', ...data },
      select: { id: true },
    })
  ).id

const laTerminal = () =>
  prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, select: { venueId: true, assignedMerchantIds: true } })
const estadoDe = async (id: string) => (await prisma.tpvCommandQueue.findUniqueOrThrow({ where: { id }, select: { status: true } })).status
const elDiseno = () => prisma.customerDisplayDesign.findUnique({ where: { terminalId }, select: { welcomeText: true } })
const asientos = () =>
  prisma.activityLog.findMany({
    where: { entityId: terminalId, action: 'CUSTOMER_DISPLAY_DESIGN_RESET' },
    select: { venueId: true, data: true },
    take: 10,
  })

/** ¿Otra sesión tiene tomada la fila de esta orden? `NOWAIT` contesta en el acto en vez de esperar. */
async function ordenBloqueada(id: string): Promise<boolean> {
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "TpvCommandQueue" WHERE id = ${id} FOR UPDATE NOWAIT`
    })
    return false
  } catch {
    return true
  }
}

const NO_VIGENTE = { statusCode: 409, code: 'MIGRATION_NOT_CURRENT' }

/** El borrado que dejó una migración A→B del protocolo viejo, recibido por la TPV hace más de 24 h y nunca ejecutado. */
const ordenDeDescarte = () =>
  crearOrden({
    status: 'SENT',
    venueId: venueB,
    createdAt: new Date(Date.now() - 25 * HORA),
    expiresAt: new Date(Date.now() + HORA),
    payload: { migration: { fromVenueId: venueA, toVenueId: venueB, previousMerchantIds: [] } },
  })

describe('G4: deshacer una migración exige que siga vigente (Postgres real)', () => {
  it('1. descarte: B→C mientras esperaba el candado ⇒ 409, y nada se escribe', async () => {
    const M1 = await ordenDeDescarte()
    const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
    const descarte = migrateDiscard(terminalId, {})
    expect(await esperarBloqueado(pid, descarte)).toBe('bloqueada') // ya leyó M1; espera el candado de la terminal

    soltar(async tx => {
      await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueC } }) // otra mudanza manda después
    })
    await transaccion

    await expect(descarte).rejects.toMatchObject(NO_VIGENTE)
    expect((await laTerminal()).venueId).toBe(venueC)
    expect(await estadoDe(M1)).toBe('SENT')
    expect(await elDiseno()).toEqual({ welcomeText: 'Hola' })
    expect(await asientos()).toHaveLength(0)
  })

  it('2. descarte: la orden venció mientras esperaba el candado ⇒ 409 (la terminal sigue donde la dejó la migración)', async () => {
    const M1 = await ordenDeDescarte()
    const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
    const descarte = migrateDiscard(terminalId, {})
    expect(await esperarBloqueado(pid, descarte)).toBe('bloqueada')

    // La terminal queda en B: la revisión del negocio (a) pasa; sólo la vigencia de la orden (b) la detiene.
    soltar(async tx => {
      await tx.tpvCommandQueue.update({ where: { id: M1 }, data: { expiresAt: new Date(Date.now() - 1_000) } })
    })
    await transaccion

    await expect(descarte).rejects.toMatchObject(NO_VIGENTE)
    expect((await laTerminal()).venueId).toBe(venueB)
    expect(await estadoDe(M1)).toBe('SENT')
    expect(await elDiseno()).toEqual({ welcomeText: 'Hola' })
    expect(await asientos()).toHaveLength(0)
  })

  it('3. cancelación: B→C mientras esperaba el candado de la terminal ⇒ 409, y el CAS de la orden se deshace', async () => {
    const M2 = await crearOrden({
      status: 'QUEUED',
      venueId: venueB,
      expiresAt: new Date(Date.now() + HORA),
      payload: { migration: { fromVenueId: venueA, toVenueId: venueB, previousMerchantIds: [] } },
    })
    const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
    const cancelacion = migrateCancel(terminalId, {})
    expect(await esperarBloqueado(pid, cancelacion)).toBe('bloqueada')
    // Bloqueada en `lockTerminalRow`, con su CAS de cola ya hecho: la fila de la orden es suya (cola → terminal).
    expect(await ordenBloqueada(M2)).toBe(true)

    soltar(async tx => {
      await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueC } })
    })
    await transaccion

    await expect(cancelacion).rejects.toMatchObject(NO_VIGENTE)
    expect((await laTerminal()).venueId).toBe(venueC)
    expect(await estadoDe(M2)).toBe('QUEUED') // el CANCELLED se deshizo con la transacción
    expect(await prisma.tpvCommandHistory.count({ where: { terminalId } })).toBe(0)
    expect(await elDiseno()).toEqual({ welcomeText: 'Hola' })
    expect(await asientos()).toHaveLength(0)
  })

  it('3b. 🔴 cancelación vieja + migración nueva B→A con comercios distintos ⇒ 409, y los comercios nuevos sobreviven', async () => {
    const mB = m1 // el comercio con el que la terminal cobra en B
    await prisma.terminal.update({ where: { id: terminalId }, data: { assignedMerchantIds: [mB] } })
    const expiresAt = new Date(Date.now() + 2_000)
    const M3 = await crearOrden({
      status: 'QUEUED',
      venueId: venueB,
      expiresAt,
      payload: { migration: { fromVenueId: venueA, toVenueId: venueB, previousMerchantIds: [mViejo] } },
    })
    const { pid, soltar, transaccion } = await retenerTerminal(terminalId)
    const cancelacion = migrateCancel(terminalId, {})
    expect(await esperarBloqueado(pid, cancelacion)).toBe('bloqueada') // su CAS sobre M3 ya pasó
    expect(await ordenBloqueada(M3)).toBe(true)

    // M3 vence mientras la cancelación espera el candado de la terminal.
    await new Promise(r => setTimeout(r, Math.max(0, expiresAt.getTime() + 200 - Date.now())))

    // La migración nueva, válida, ya regresó la terminal a A con SUS comercios. A es el origen de la vieja: la revisión del
    // negocio (a) no lo ve; sólo el reloj leído después de los dos candados lo detiene.
    soltar(async tx => {
      await tx.terminal.update({ where: { id: terminalId }, data: { venueId: venueA, assignedMerchantIds: [mNuevo] } })
    })
    await transaccion

    await expect(cancelacion).rejects.toMatchObject(NO_VIGENTE)
    // Sin la revisión con reloj nuevo, aquí quedaría [mViejo]: el dinero de A por la afiliación equivocada.
    expect(await laTerminal()).toEqual({ venueId: venueA, assignedMerchantIds: [mNuevo] })
    expect(await estadoDe(M3)).toBe('QUEUED')
    expect(await elDiseno()).toEqual({ welcomeText: 'Hola' })
    expect(await asientos()).toHaveLength(0)
  })

  it('4. control: el descarte normal, sin barrera, regresa la terminal a A y expira la orden', async () => {
    const M1 = await ordenDeDescarte()

    await expect(migrateDiscard(terminalId, {})).resolves.toMatchObject({ discarded: 1, commandIds: [M1], restoredVenueId: venueA })

    expect(await laTerminal()).toEqual({ venueId: venueA, assignedMerchantIds: [] })
    expect(await estadoDe(M1)).toBe('EXPIRED')
    // Antes del gancho (9.b) la reversión todavía no toca el diseño.
    expect(await elDiseno()).toEqual({ welcomeText: 'Hola' })
    expect(await asientos()).toHaveLength(0)
  })
})
