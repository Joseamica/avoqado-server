/**
 * Cancelar o descartar una mudanza de terminal y la configuración de pagos que esa mudanza creó en el destino, contra
 * PostgreSQL REAL (encargo b771c2, tarjeta hz:87f4b879:D9; Codex p12 r1 #2 y r4 A1/A2, 12-nov-2026).
 *
 * 🔴 Antes se borraba por id la configuración que creó la mudanza, aunque después otra persona la hubiera editado (cuentas
 * o posiciones nuevas): las otras terminales del destino perdían esas cuentas. Ahora se borra sólo si sigue como la dejó
 * la mudanza (`updatedAt` anotado en la orden; en una orden vieja, `updatedAt == createdAt`).
 *
 * Y el orden de candados: el alta AngelPay toma la configuración y luego las terminales; cancelar tomaba la terminal y luego
 * la configuración (interbloqueo). Descartar tomaba la terminal y luego la orden; cancelar, la orden y luego la terminal
 * (interbloqueo). Ahora los dos deshaceres van orden → configuración → terminal.
 *
 * Run with (base desechable, nunca av-db-25):
 *   TEST_DATABASE_URL='postgresql://…/avoqado_<tarea>_test_<fecha>' \
 *     npx jest --selectProjects=integration --runInBand --runTestsByPath tests/integration/dashboard/terminalMigrationPaymentConfig.integration.test.ts
 */
import { Prisma, TpvCommandStatus } from '@prisma/client'

import { logAction } from '@/services/dashboard/activity-log.service'
import { migrateCancel, migrateDiscard } from '@/services/dashboard/terminal-migration.service'
import { deleteTerminal } from '@/services/dashboard/terminals.superadmin.service'
import prisma from '@/utils/prismaClient'

import { esperarBloqueado, retener } from '../customer-display/barrera'

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
const suffix = `mpc-${ts}`
const HORA = 60 * 60 * 1000

let orgId: string
let venueA: string
let venueB: string
let providerId: string
let mA: string
let mB: string
let mOtra: string
let terminalId: string
let configId: string
let configUpdatedAt: Date

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  const crearVenue = async (n: string) =>
    (
      await prisma.venue.create({
        data: { organizationId: orgId, name: `Venue ${n} ${suffix}`, slug: `venue-${n}-${suffix}`, timezone: 'America/Mexico_City' },
        select: { id: true },
      })
    ).id
  venueA = await crearVenue('a')
  venueB = await crearVenue('b')
  providerId = (
    await prisma.paymentProvider.create({
      data: { code: `MPC_TEST_${ts}`, name: `Proveedor ${suffix}`, type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] },
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
  mA = await crearComercio('m-a')
  mB = await crearComercio('m-b')
  mOtra = await crearComercio('m-otra')
})

async function borrarTerminales(ids: string[]) {
  if (!ids.length) return
  await prisma.tpvCommandHistory.deleteMany({ where: { terminalId: { in: ids } } })
  await prisma.tpvCommandQueue.deleteMany({ where: { terminalId: { in: ids } } })
  await prisma.activityLog.deleteMany({ where: { entityId: { in: ids } } })
  await prisma.terminal.deleteMany({ where: { id: { in: ids } } })
}

beforeEach(async () => {
  ;(logAction as jest.Mock).mockClear()
  if (!venueA || !venueB) return
  if (terminalId) await borrarTerminales([terminalId])
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: venueB } })
  // TPV del protocolo viejo: la mudanza A→B ya la dejó en B, con el comercio de B.
  terminalId = (
    await prisma.terminal.create({
      data: { venueId: venueB, name: `TPV ${suffix}`, type: 'TPV_ANDROID', brand: 'PAX', assignedMerchantIds: [mB] },
      select: { id: true },
    })
  ).id
  // La configuración que creó la mudanza en B (copiada de A), igual que `updateTerminal`.
  const creada = await prisma.venuePaymentConfig.create({
    data: { venueId: venueB, primaryAccountId: mB },
    select: { id: true, updatedAt: true },
  })
  configId = creada.id
  configUpdatedAt = creada.updatedAt
})

afterAll(async () => {
  if (!venueA || !venueB) return
  const terminales = await prisma.terminal.findMany({ where: { venueId: { in: [venueA, venueB] } }, select: { id: true }, take: 50 })
  await borrarTerminales(terminales.map(t => t.id))
  await prisma.activityLog.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  await prisma.venuePaymentConfig.deleteMany({ where: { venueId: { in: [venueA, venueB] } } })
  if (providerId) {
    await prisma.merchantAccount.deleteMany({ where: { providerId } })
    await prisma.paymentProvider.deleteMany({ where: { id: providerId } })
  }
  await prisma.venue.deleteMany({ where: { id: { in: [venueA, venueB] } } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const crearOrden = async (data: { status: TpvCommandStatus; createdAt?: Date; payload: Prisma.InputJsonValue }) =>
  (
    await prisma.tpvCommandQueue.create({
      data: {
        terminalId,
        venueId: venueB,
        commandType: 'FACTORY_RESET',
        priority: 'CRITICAL',
        requestedBy: 'system',
        expiresAt: new Date(Date.now() + HORA),
        ...data,
      },
      select: { id: true },
    })
  ).id

/** El payload que deja `updateTerminal`; `conMarca: false` = una orden creada antes de este arreglo. */
const migracion = (conMarca = true) => ({
  migration: {
    fromVenueId: venueA,
    toVenueId: venueB,
    previousMerchantIds: [mA],
    createdVenuePaymentConfigId: configId,
    ...(conMarca && { createdVenuePaymentConfigUpdatedAt: configUpdatedAt.toISOString() }),
  },
})

const ordenParaCancelar = (conMarca = true) => crearOrden({ status: 'QUEUED', payload: migracion(conMarca) })
const ordenParaDescartar = (conMarca = true) =>
  crearOrden({ status: 'SENT', createdAt: new Date(Date.now() - 25 * HORA), payload: migracion(conMarca) })

/** Otra persona edita la configuración de B después de la mudanza (cambia su cuenta principal). */
const editarConfig = (db: Prisma.TransactionClient | typeof prisma = prisma) =>
  db.venuePaymentConfig.update({ where: { id: configId }, data: { primaryAccountId: mOtra } })

const laConfig = () => prisma.venuePaymentConfig.findUnique({ where: { id: configId }, select: { primaryAccountId: true } })
const laTerminal = () =>
  prisma.terminal.findUniqueOrThrow({ where: { id: terminalId }, select: { venueId: true, assignedMerchantIds: true } })
/** `logAction` está simulado en la integración (`integration-setup.ts`): se leen sus llamadas. */
const asientosDeConfig = async (action: string) =>
  (logAction as jest.Mock).mock.calls
    .map(([p]) => p as { action: string; entityId?: string; venueId?: string | null; data?: unknown })
    .filter(p => p.action === action && p.entityId === configId)

describe('cancelar una mudanza y la configuración que creó (Postgres real)', () => {
  it('1. control: nadie la tocó ⇒ se borra, como antes', async () => {
    await ordenParaCancelar()
    await expect(migrateCancel(terminalId, {})).resolves.toEqual({ cancelled: true, restoredVenueId: venueA })
    expect(await laConfig()).toBeNull()
    expect(await laTerminal()).toEqual({ venueId: venueA, assignedMerchantIds: [mA] })
    expect(await asientosDeConfig('VENUE_PAYMENT_CONFIG_DELETED')).toHaveLength(1)
  })

  it('2. 🔴 otra persona la editó después de la mudanza ⇒ se conserva con su cambio, y queda anotado', async () => {
    await ordenParaCancelar()
    await editarConfig()
    await expect(migrateCancel(terminalId, {})).resolves.toEqual({ cancelled: true, restoredVenueId: venueA })
    expect(await laConfig()).toEqual({ primaryAccountId: mOtra })
    expect(await laTerminal()).toEqual({ venueId: venueA, assignedMerchantIds: [mA] }) // la terminal sí regresa
    expect(await asientosDeConfig('VENUE_PAYMENT_CONFIG_DELETED')).toHaveLength(0)
    const conservada = await asientosDeConfig('VENUE_PAYMENT_CONFIG_KEPT')
    expect(conservada).toHaveLength(1)
    expect(conservada[0].venueId).toBe(venueB)
  })

  it('3. orden vieja (sin la marca): nunca editada ⇒ se borra; editada ⇒ se conserva', async () => {
    await ordenParaCancelar(false)
    await expect(migrateCancel(terminalId, {})).resolves.toMatchObject({ cancelled: true })
    expect(await laConfig()).toBeNull()

    // Segunda vuelta con la config editada (otra terminal, misma regla).
    await prisma.terminal.update({ where: { id: terminalId }, data: { venueId: venueB, assignedMerchantIds: [mB] } })
    configId = (await prisma.venuePaymentConfig.create({ data: { venueId: venueB, primaryAccountId: mB }, select: { id: true } })).id
    await editarConfig()
    await ordenParaCancelar(false)
    await expect(migrateCancel(terminalId, {})).resolves.toMatchObject({ cancelled: true })
    expect(await laConfig()).toEqual({ primaryAccountId: mOtra })
  })

  it('4. 🔴 A1: un alta que tiene la configuración y luego toma la terminal ya no se tranca con cancelar', async () => {
    await ordenParaCancelar()
    // El alta AngelPay: candado de la configuración de B (como `tomarCandado`) …
    const alta = await retener(tx => tx.$queryRaw`SELECT id FROM "VenuePaymentConfig" WHERE id = ${configId} FOR UPDATE`)
    const cancelacion = migrateCancel(terminalId, {})
    expect(await esperarBloqueado(alta.pid, cancelacion)).toBe('bloqueada')
    // … luego edita la configuración y toma la terminal. Antes, cancelar ya tenía la terminal: `deadlock detected`.
    alta.soltar(async tx => {
      await editarConfig(tx)
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE`
    })
    await alta.transaccion
    await expect(cancelacion).resolves.toMatchObject({ cancelled: true, restoredVenueId: venueA })
    // La cancelación esperó al alta y vio su cambio: no le borró la configuración.
    expect(await laConfig()).toEqual({ primaryAccountId: mOtra })
  })
})

describe('descartar una mudanza y la configuración que creó (Postgres real)', () => {
  it('5. control: nadie la tocó ⇒ se borra, como antes', async () => {
    const M = await ordenParaDescartar()
    await expect(migrateDiscard(terminalId, {})).resolves.toMatchObject({ discarded: 1, commandIds: [M], restoredVenueId: venueA })
    expect(await laConfig()).toBeNull()
    expect(await laTerminal()).toEqual({ venueId: venueA, assignedMerchantIds: [mA] })
  })

  it('6. 🔴 otra persona la editó ⇒ se conserva con su cambio, y queda anotado', async () => {
    await ordenParaDescartar()
    await editarConfig()
    await expect(migrateDiscard(terminalId, {})).resolves.toMatchObject({ discarded: 1, restoredVenueId: venueA })
    expect(await laConfig()).toEqual({ primaryAccountId: mOtra })
    expect(await laTerminal()).toEqual({ venueId: venueA, assignedMerchantIds: [mA] })
    expect(await asientosDeConfig('VENUE_PAYMENT_CONFIG_KEPT')).toHaveLength(1)
  })

  it('7. orden vieja (sin la marca) editada ⇒ se conserva', async () => {
    await ordenParaDescartar(false)
    await editarConfig()
    await expect(migrateDiscard(terminalId, {})).resolves.toMatchObject({ discarded: 1 })
    expect(await laConfig()).toEqual({ primaryAccountId: mOtra })
  })

  it('8. 🔴 A2: quien tiene la orden y luego toma la terminal (cancelar) ya no se tranca con descartar', async () => {
    const M = await ordenParaDescartar()
    // Cancelar: el CAS de la orden primero …
    const cancelar = await retener(tx => tx.$queryRaw`SELECT id FROM "TpvCommandQueue" WHERE id = ${M} FOR UPDATE`)
    const descarte = migrateDiscard(terminalId, {})
    expect(await esperarBloqueado(cancelar.pid, descarte)).toBe('bloqueada')
    // … luego la terminal. Antes, descartar ya tenía la terminal y esperaba la orden: `deadlock detected`.
    cancelar.soltar(async tx => {
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE`
      await tx.tpvCommandQueue.update({ where: { id: M }, data: { status: 'CANCELLED' } })
    })
    await cancelar.transaccion
    // Ganó la cancelación: el descarte ve la orden ya cancelada y responde 409, sin tocar nada.
    await expect(descarte).rejects.toMatchObject({ statusCode: 409, code: 'MIGRATION_NOT_CURRENT' })
    expect(await laTerminal()).toEqual({ venueId: venueB, assignedMerchantIds: [mB] })
    expect(await laConfig()).toEqual({ primaryAccountId: mB })
  })

  it('9. 🔴 A1 en descartar: un alta que tiene la configuración y luego toma la terminal ya no se tranca', async () => {
    await ordenParaDescartar()
    const alta = await retener(tx => tx.$queryRaw`SELECT id FROM "VenuePaymentConfig" WHERE id = ${configId} FOR UPDATE`)
    const descarte = migrateDiscard(terminalId, {})
    expect(await esperarBloqueado(alta.pid, descarte)).toBe('bloqueada')
    alta.soltar(async tx => {
      await editarConfig(tx)
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE`
    })
    await alta.transaccion
    await expect(descarte).resolves.toMatchObject({ discarded: 1, restoredVenueId: venueA })
    expect(await laConfig()).toEqual({ primaryAccountId: mOtra })
  })

  it('10. 🔴 Codex r1: eliminar la terminal ya no se tranca con un descarte que ya tiene sus órdenes', async () => {
    const M = await ordenParaDescartar()
    // Descartar: las órdenes primero …
    const descarte = await retener(tx => tx.$queryRaw`SELECT id FROM "TpvCommandQueue" WHERE id = ${M} FOR UPDATE`)
    const borrado = deleteTerminal(terminalId)
    expect(await esperarBloqueado(descarte.pid, borrado)).toBe('bloqueada')
    // … luego la terminal. Si el borrado tomara la terminal antes que las órdenes que borra en cascada: `deadlock detected`.
    descarte.soltar(async tx => {
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE`
    })
    await descarte.transaccion
    await expect(borrado).resolves.toEqual({ success: true })
    expect(await prisma.terminal.findUnique({ where: { id: terminalId }, select: { id: true } })).toBeNull()
  })
})
