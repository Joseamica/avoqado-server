/**
 * Los escritores de `Terminal.venueId` del carril de comandos de la TPV, contra PostgreSQL REAL.
 *
 * 🔴 G4 (auditoría de Codex del plan de la pantalla del cliente, 14-oct): deshacer una migración (cancelarla o descartar su
 * borrado) sólo vale si sigue siendo la VIGENTE. Una cancelación o un descarte viejos que esperaban el candado de la
 * terminal no pueden regresarla a un negocio que ya no le toca, ni escribirle encima los comercios de una migración más
 * nueva: el dinero se iría por la afiliación equivocada. Las unitarias fingen el candado; aquí la carrera es real, con la
 * barrera de `../customer-display/barrera` metiendo el cambio ENTRE la lectura inicial de la operación y su candado.
 *
 * Y el gancho de la pantalla del cliente (§4.3 del plan): cada escritor de `venueId` borra el diseño y el acuse de la
 * terminal en SU transacción. Si el escritor falla después del gancho, el borrado se deshace con todo lo demás.
 *
 * Run with (base desechable, nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/dashboard/terminalVenueWriters.integration.test.ts
 */
import { Prisma, TpvCommandStatus } from '@prisma/client'

import { ConflictError } from '@/errors/AppError'
import * as cambioDeNegocio from '@/services/customer-display/customerDisplayVenueChange'
import { migrateCancel, migrateDiscard } from '@/services/dashboard/terminal-migration.service'
import { tpvCommandQueueService } from '@/services/tpv/command-queue.service'
import prisma from '@/utils/prismaClient'

import { esperarBloqueado, retenerTerminal } from '../customer-display/barrera'

// Sólo los emisores de sockets, como en las unitarias del carril: lo demás (Prisma, el gancho, el carril) es real.
jest.mock('@/communication/sockets', () => ({
  __esModule: true,
  default: { getBroadcastingService: jest.fn(() => null), broadcastToVenue: jest.fn() },
  broadcastTpvCommand: jest.fn(),
  broadcastTpvCommandStatusChanged: jest.fn(),
  broadcastTpvCommandQueued: jest.fn(),
  broadcastTpvStatusUpdate: jest.fn(),
  broadcastSuperadminTerminalUpdate: jest.fn(),
}))

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
let orgId2: string
let venueB2: string

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

  // 9.7: otra organización con su negocio B2, para el permiso de ejecución que apunta a otra organización.
  orgId2 = (
    await prisma.organization.create({
      data: { name: `Org2 ${suffix}`, email: `org2-${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueB2 = await crearVenue('b2', orgId2)
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
    where: { venueId: { in: [venueA, venueB, venueC, ...(venueB2 ? [venueB2] : [])] } },
    select: { id: true },
    take: 50,
  })
  await borrarTerminales(terminales.map(t => t.id))
  if (providerId) {
    await prisma.merchantAccount.deleteMany({ where: { providerId } })
    await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  }
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB, venueC, ...(venueB2 ? [venueB2] : [])] } } })
  await prisma.organization.deleteMany({ where: { id: { in: [orgId, ...(orgId2 ? [orgId2] : [])] } } })
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
    // La reversión regresa la terminal a A: el gancho borra el diseño en la misma transacción y deja su asiento.
    expect(await elDiseno()).toBeNull()
    const escritos = await asientos()
    expect(escritos).toHaveLength(1)
    expect(escritos[0]).toMatchObject({ venueId: venueA, data: { reason: 'migration_reverted', fromVenueId: venueB, toVenueId: venueA } })
  })
})

// 🔴 Ruling #4: el gancho corre DENTRO de la transacción de un escritor real. Si el escritor falla después del gancho, el
// diseño, el acuse y el asiento se deshacen junto con todo lo demás; si no falla, todo queda junto.
describe('el gancho en el permiso de ejecución del protocolo 2 (updateCommandStatus, Postgres real)', () => {
  const ACUSE = { seq: 3, fingerprint: 'abc' }

  beforeEach(async () => {
    if (!venueA || !venueB || !venueC) return
    // TPV del protocolo 2 en A (organización 1), con su diseño (del `beforeEach` de arriba) y su acuse: no se muda al
    // encolar; la muda el permiso de ejecución de la app que reservó su ventana segura.
    await prisma.terminal.update({
      where: { id: terminalId },
      data: { venueId: venueA, commandProtocolVersion: 2, commandSessionId: 'sesion-1', customerDisplayAck: ACUSE },
    })
  })

  const ordenConIntencion = (intencion: { toVenueId: string; organizationId: string }) =>
    crearOrden({
      status: 'SENT',
      venueId: venueA,
      expiresAt: new Date(Date.now() + HORA),
      payload: {
        _deliveryProtocol: 2,
        _migrationIntent: { toVenueId: intencion.toVenueId, assignedMerchantIds: [m1], organizationId: intencion.organizationId },
        migration: { fromVenueId: venueA, toVenueId: intencion.toVenueId, previousMerchantIds: [] },
      },
    })

  const permiso = (id: string) =>
    tpvCommandQueueService.updateCommandStatus(id, 'EXECUTING', undefined, undefined, terminalId, { executionSessionId: 'sesion-1' })

  it('5. el escritor falla DESPUÉS del gancho ⇒ no queda nada', async () => {
    // El destino B2 y m1 pasan la validación, el gancho corre (borra el diseño y escribe el asiento), y el `updateMany`
    // condicionado a la organización 2 no encuentra la terminal, que es de la organización 1 ⇒ ConflictError.
    const id = await ordenConIntencion({ toVenueId: venueB2, organizationId: orgId2 })
    const gancho = jest.spyOn(cambioDeNegocio, 'borrarDisenoAlCambiarDeNegocio')
    try {
      await expect(permiso(id)).rejects.toBeInstanceOf(ConflictError)

      // El gancho SÍ corrió y borró dentro de la transacción…
      expect(gancho).toHaveBeenCalledTimes(1)
      await expect(gancho.mock.results[0].value).resolves.toEqual({ cambio: true, disenoBorrado: true, fromVenueId: venueA })
    } finally {
      gancho.mockRestore()
    }
    // …y todo se deshizo junto.
    expect(await elDiseno()).toEqual({ welcomeText: 'Hola' })
    expect(
      await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, select: { venueId: true, customerDisplayAck: true } }),
    ).toEqual({ venueId: venueA, customerDisplayAck: ACUSE })
    expect(await asientos()).toHaveLength(0)
    expect(await estadoDe(id)).toBe('SENT')
  })

  it('6. el mismo camino, válido ⇒ todo junto', async () => {
    const id = await ordenConIntencion({ toVenueId: venueB, organizationId: orgId })

    await expect(permiso(id)).resolves.toBe(true)

    expect(
      await prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, select: { venueId: true, customerDisplayAck: true } }),
    ).toEqual({ venueId: venueB, customerDisplayAck: null })
    expect(await elDiseno()).toBeNull()
    const escritos = await asientos()
    expect(escritos).toHaveLength(1)
    expect(escritos[0]).toMatchObject({ venueId: venueB, data: { reason: 'terminal_moved', fromVenueId: venueA, toVenueId: venueB } })
    expect(await estadoDe(id)).toBe('EXECUTING')
  })
})
