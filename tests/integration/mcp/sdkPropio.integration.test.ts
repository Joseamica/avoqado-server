/**
 * `set_terminal_in_house_sdk` del MCP (fase 3, bloque 2a) POR EL CATÁLOGO REAL (`configureToolCatalog`, token de dos pasos) contra
 * Postgres real: al prender, la vista previa trae la serie GUARDADA arriba, el catálogo la ata a la confirmación y el escritor la
 * compara bajo el candado. Si la ficha cambió de serie entre los dos pasos, no prende. Apagar no pide serie. Repetir dice «ya
 * estaba así». Series ficticias AVQD-99000003xx (otros archivos usan otros rangos).
 *
 * Correr (va a la nube con su base propia; nunca contra av-db-25):
 *   npx jest --selectProjects=integration --runTestsByPath tests/integration/mcp/sdkPropio.integration.test.ts --ci
 */
import { randomUUID } from 'crypto'
import { TerminalType } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import type { McpScope } from '@/mcp/scope'
import { registerSdkPropioTools } from '@/mcp/tools/sdkPropio'
import { conectarPorElCatalogo, pasoUnoYDos } from '../../__helpers__/mcp-por-el-catalogo'

const NOMBRE = 'set_terminal_in_house_sdk'
const sufijo = randomUUID().slice(0, 8)
let orgId: string | undefined
let venueId: string | undefined
let staffId: string | undefined
let blumonId: string
let proveedorPropio: string | undefined
const terminalIds: string[] = []
const merchantIds: string[] = []
let consecutivo = 300
const nuevaSerie = () => `AVQD-99000${String(consecutivo++).padStart(5, '0')}` // AVQD-9900000300 … 399
let mcp: Awaited<ReturnType<typeof conectarPorElCatalogo>>

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Negocio de prueba ${sufijo}`, email: `sdk-mcp-${sufijo}@example.test`, phone: '5500000000' },
    })
  ).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: 'Negocio de prueba', slug: `sdk-mcp-${sufijo}` } })).id
  const existente = await prisma.paymentProvider.findUnique({ where: { code: 'BLUMON' } })
  blumonId =
    existente?.id ??
    (proveedorPropio = (
      await prisma.paymentProvider.create({ data: { code: 'BLUMON', name: 'Blumon', type: 'PAYMENT_PROCESSOR', countryCode: ['MX'] } })
    ).id)
  staffId = (await prisma.staff.create({ data: { email: `sdk-mcp-sa-${sufijo}@example.test`, firstName: 'Prueba', lastName: 'Soporte' } }))
    .id
  const scope = {
    staffId,
    activeOrg: orgId,
    allowedVenueIds: [venueId],
    perVenueAccess: new Map(),
    isSuperAdmin: true,
    scopes: ['mcp:read', 'mcp:write'],
  } as unknown as McpScope
  mcp = await conectarPorElCatalogo(server => registerSdkPropioTools(server, scope), scope)
})

afterEach(async () => {
  await prisma.activityLog.deleteMany({ where: { entity: 'Terminal', entityId: { in: terminalIds } } })
  await prisma.terminal.deleteMany({ where: { id: { in: terminalIds } } })
  await prisma.merchantAccount.deleteMany({ where: { id: { in: merchantIds } } })
  terminalIds.length = 0
  merchantIds.length = 0
})

afterAll(async () => {
  await mcp?.close()
  if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  if (venueId) await prisma.venue.deleteMany({ where: { id: venueId } })
  if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
  if (proveedorPropio) await prisma.paymentProvider.deleteMany({ where: { id: proveedorPropio } })
})

/** Una PAX elegible: serie física y una afiliación de Blumon activa asignada. */
async function pax() {
  const m = await prisma.merchantAccount.create({
    data: { providerId: blumonId, externalMerchantId: `sdk-mcp-${sufijo}-${merchantIds.length}`, credentialsEncrypted: {}, active: true },
  })
  merchantIds.push(m.id)
  const t = await prisma.terminal.create({
    data: {
      venueId: venueId!,
      name: 'Caja 1',
      type: TerminalType.TPV_ANDROID,
      brand: 'PAX',
      serialNumber: nuevaSerie(),
      assignedMerchantIds: [m.id],
    },
  })
  terminalIds.push(t.id)
  return t
}

const columna = async (id: string) =>
  (await prisma.terminal.findUniqueOrThrow({ where: { id }, select: { inHouseSdkEnabled: true } })).inHouseSdkEnabled
const asientos = (id: string) => prisma.activityLog.findMany({ where: { entity: 'Terminal', entityId: id }, take: 5 })

describe('set_terminal_in_house_sdk por el catálogo real', () => {
  it('prender sin expectedSerialNumber en el paso 1 ⇒ la vista previa trae expectedSerialNumber arriba y el paso 2 con los confirmationArguments prende', async () => {
    const t = await pax()

    const { vista, resultado } = await pasoUnoYDos(mcp, NOMBRE, { terminalId: t.id, enabled: true, reason: 'Piloto del motor propio' })

    expect(vista).toMatchObject({
      requiresConfirmation: true,
      expectedSerialNumber: t.serialNumber,
      terminal: { id: t.id, serialNumber: t.serialNumber, venue: { id: venueId, name: 'Negocio de prueba' } },
      elegibilidad: { elegible: true },
    })
    expect(vista.confirmationArguments.expectedSerialNumber).toBe(t.serialNumber)
    expect(resultado).toMatchObject({ ok: true, changed: true, enabled: true })
    expect(await columna(t.id)).toBe(true)
    // Quien firma es la conexión, y la procedencia la pone el servidor.
    const filas = await asientos(t.id)
    expect(filas).toHaveLength(1)
    expect(filas[0]).toMatchObject({ action: 'TERMINAL_IN_HOUSE_SDK_ENABLED', staffId, venueId })
    expect(filas[0].data).toMatchObject({
      procedencia: 'mcp',
      source: 'customer-mcp',
      reason: 'Piloto del motor propio',
      serialNumber: t.serialNumber,
    })
  })

  it('paso 1 con una serie VIEJA ⇒ la vista previa trae la guardada y el paso 2 confirma ésa, no la vieja', async () => {
    const t = await pax()

    const { vista, resultado } = await pasoUnoYDos(mcp, NOMBRE, {
      terminalId: t.id,
      enabled: true,
      expectedSerialNumber: 'AVQD-9900000399',
    })

    expect(vista.expectedSerialNumber).toBe(t.serialNumber)
    expect(vista.confirmationArguments.expectedSerialNumber).toBe(t.serialNumber)
    expect(resultado).toMatchObject({ ok: true, changed: true, enabled: true })
    expect(await columna(t.id)).toBe(true)
  })

  it('la ficha cambia de serie entre el paso 1 y el 2 ⇒ el paso 2 da el texto del 409 TERMINAL_SERIAL_MISMATCH y no prende', async () => {
    const t = await pax()
    const vista = await mcp.call(NOMBRE, { terminalId: t.id, enabled: true })
    expect(vista.expectedSerialNumber).toBe(t.serialNumber)

    await prisma.terminal.update({ where: { id: t.id }, data: { serialNumber: nuevaSerie() } })
    const resultado = await mcp.call(NOMBRE, { ...vista.confirmationArgs, confirmationToken: vista.confirmationToken })

    expect(resultado).toEqual({
      ok: false,
      code: 'TERMINAL_SERIAL_MISMATCH',
      error: 'La serie de la terminal cambió desde que la viste. Vuelve a consultarla.',
    })
    expect(await columna(t.id)).toBe(false)
    expect(await asientos(t.id)).toHaveLength(0)
  })

  it('apagar por el catálogo ⇒ la vista previa no trae expectedSerialNumber y el paso 2 apaga; repetir dice «ya estaba así»', async () => {
    const t = await pax()
    await prisma.terminal.update({ where: { id: t.id }, data: { inHouseSdkEnabled: true } })

    const { vista, resultado } = await pasoUnoYDos(mcp, NOMBRE, { terminalId: t.id, enabled: false })

    expect(vista.requiresConfirmation).toBe(true)
    expect('expectedSerialNumber' in vista).toBe(false)
    expect('expectedSerialNumber' in vista.confirmationArguments).toBe(false)
    expect(resultado).toMatchObject({ ok: true, changed: true, enabled: false })
    expect(await columna(t.id)).toBe(false)

    const otraVez = await pasoUnoYDos(mcp, NOMBRE, { terminalId: t.id, enabled: false })
    expect(otraVez.resultado).toMatchObject({ ok: true, changed: false, enabled: false })
    expect(otraVez.resultado.message).toMatch(/^Ya estaba así/)
    expect(await asientos(t.id)).toHaveLength(1)
  })
})
