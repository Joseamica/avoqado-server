// tests/integration/mcp/setProductIva.test.ts
//
// IVA por producto, plan 6b, Tarea 9 (spec §5.6, §11 «MCP», D20): el estado del IVA por producto se consulta SIN Facturación (el selector
// es de todos los planes). `set_product_iva` con sólo el negocio es el diagnóstico; con producto y valor cambia el IVA por el MISMO
// servicio que el dashboard (`updateProduct`, origen MCP). Contra Postgres real: el diagnóstico lee aparatos, facturas y candados.
import { randomUUID } from 'crypto'
import { StaffRole } from '@prisma/client'
import type { McpScope } from '@/mcp/scope'
import { registerAccountingTools } from '@/mcp/tools/accounting'
import { registerMenuTools } from '@/mcp/tools/menu'
import prisma from '@/utils/prismaClient'
import { limpiarNegocios, nuevoNegocio, type Negocio } from '../fiscal/exclusionContable.fixtures'

// La observación de 30 días se da por cumplida (su valor real lo prueba la Tarea 3).
jest.mock('@/services/mobile/deviceRegistry.service', () => ({
  ...jest.requireActual('@/services/mobile/deviceRegistry.service'),
  OBSERVADOR_POS_DESDE: new Date('2026-08-01T00:00:00Z'),
}))
// Las herramientas del MCP se llaman directo: el guardia y el plan no son lo que se prueba aquí (tienen sus suites).
jest.mock('@/mcp/planGate', () => ({ planGateMessage: jest.fn().mockResolvedValue(null) }))
jest.mock('@/mcp/guard', () => ({
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: jest.fn() }),
}))

// Antes de registrar cualquier siembra o limpieza: nunca aceptar la base compartida.
const { isDisposableH1Url } = require('../../../scripts/h1-test-database.cjs')
const testDatabase = new URL(process.env.TEST_DATABASE_URL ?? '')
if (!isDisposableH1Url(testDatabase)) throw new Error('Esta suite exige una base H1 desechable validada.')

jest.setTimeout(120_000)

const DIA = 24 * 60 * 60 * 1000
const MENSAJE_BLOQUEADO = 'Para vender productos con un IVA distinto de 16 % falta resolver esto:'
const MENSAJE_SOLO_DUENO =
  'Es el primer producto con un IVA distinto de 16 %: encenderlo pausa la contabilidad automática de toda la organización, así que sólo lo puede hacer el dueño o un administrador.'

type Herramienta = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>

describe('MCP · set_product_iva, el IVA en menu_item_detail y fiscal_readiness (integración)', () => {
  const venueIds: string[] = []
  const staffs: string[] = []

  afterAll(async () => {
    await prisma.terminal.deleteMany({ where: { venueId: { in: venueIds } } })
    await prisma.staffVenue.deleteMany({ where: { staffId: { in: staffs } } })
    await prisma.staff.deleteMany({ where: { id: { in: staffs } } })
    await limpiarNegocios()
    await prisma.$disconnect()
  })

  /** Un negocio apagado y limpio, SIN emisor fiscal, con un producto al 16 %. */
  const armar = async (role: StaffRole = StaffRole.OWNER) => {
    const x: Negocio = await nuevoNegocio({ contabilidad: false })
    venueIds.push(x.venueId)
    const staffId = (await prisma.staff.create({ data: { email: `mcp9-${randomUUID()}@t.mx`, firstName: 'IVA', lastName: 'Tarea9' } })).id
    staffs.push(staffId)
    await prisma.staffVenue.create({ data: { staffId, venueId: x.venueId, role, active: true } })
    const categoryId = (
      await prisma.menuCategory.create({ data: { venueId: x.venueId, name: 'IVA', slug: `iva-${randomUUID().slice(0, 8)}` } })
    ).id
    const p = await prisma.product.create({
      data: { venueId: x.venueId, categoryId, sku: `M9-${randomUUID().slice(0, 8)}`, name: 'Café en grano', price: 100 },
    })
    // Las herramientas del MCP de ESE negocio y de ESA persona (quien confirma es el autor del cambio).
    const mapa = new Map<string, Herramienta>()
    const scope = { staffId, activeOrg: x.organizationId, allowedVenueIds: [x.venueId], perVenueAccess: new Map() } as McpScope
    const reg = { tool: (...a: unknown[]) => mapa.set(a[0] as string, a[a.length - 1] as never) } as never
    registerMenuTools(reg, scope)
    registerAccountingTools(reg, scope)
    const mcp = async (nombre: string, args: Record<string, unknown>) =>
      JSON.parse((await mapa.get(nombre)!({ venueId: x.venueId, ...args }, {})).content[0].text)
    return { x, staffId, p, mcp }
  }
  const iPadViejo = (venueId: string) =>
    prisma.terminal.create({
      data: {
        venueId,
        name: 'iPad de la barra',
        type: 'POS_IOS',
        version: '1.14.0',
        status: 'ACTIVE',
        lastHeartbeat: new Date(Date.now() - DIA),
      },
    })

  it('spec §11 · sin Facturación ni emisor: el diagnóstico da el estado y el bloqueo; menu_item_detail muestra el IVA', async () => {
    const { x, p, mcp } = await armar()
    expect(await prisma.fiscalEmisor.count({ where: { venueId: x.venueId } })).toBe(0)
    await iPadViejo(x.venueId)

    const d = await mcp('set_product_iva', {})
    expect(d).toMatchObject({
      ok: true,
      diagnostico: true,
      encendido: false,
      revisado: true,
      dondeSeCambia: 'dashboard → producto, junto al precio',
      bloqueos: [expect.objectContaining({ codigo: 'APARATO_VIEJO', comoArreglar: expect.any(String) })],
    })

    const detalle = await mcp('menu_item_detail', { name: p.name })
    expect(detalle.item).toMatchObject({ iva: '16 %', ivaSeCambiaEn: 'dashboard → producto, junto al precio' })
    const lista = await mcp('list_menu', {})
    expect(lista.items).toEqual([expect.objectContaining({ name: 'Café en grano', iva: '16 %' })])
  })

  it('Codex r1 P3-11 · fiscal_readiness de un negocio SIN emisor también trae el estado del IVA por producto', async () => {
    const { x, mcp } = await armar()
    await iPadViejo(x.venueId)
    const ivaPorProducto = {
      encendido: false,
      bloqueos: [expect.objectContaining({ codigo: 'APARATO_VIEJO' })],
      avisos: [],
      facturasSinSello: [],
    }
    // Con el RFC del local pero sin emisor: la respuesta completa, y sin un único emisor no hay ventas fuera de la global que contar.
    expect(await mcp('fiscal_readiness', {})).toMatchObject({ ok: true, ivaPorProducto, ventasFueraDeLaGlobal: null })
    // Sin RFC ni emisor: el retorno temprano también lo trae.
    await prisma.venue.update({ where: { id: x.venueId }, data: { rfc: null } })
    expect(await mcp('fiscal_readiness', {})).toMatchObject({ ok: true, needsFiscalSetup: true, ivaPorProducto })
  })

  it('con UN emisor: fiscal_readiness cuenta de verdad las ventas fuera de la global (el listado real, no un null por una falla tragada)', async () => {
    const { x, mcp } = await armar()
    await prisma.fiscalEmisor.create({
      data: {
        venueId: x.venueId,
        rfc: x.rfc,
        legalName: 'Negocio de prueba',
        regimenFiscal: '601',
        lugarExpedicion: '01000',
        csdStatus: 'ACTIVE',
      },
    })
    const r = await mcp('fiscal_readiness', {})
    expect(r.ok).toBe(true)
    expect(r.ivaPorProducto).toMatchObject({ encendido: false, bloqueos: [], avisos: [], facturasSinSello: [] })
    expect(r.ventasFueraDeLaGlobal).toMatchObject({
      periodo: expect.objectContaining({ anio: expect.any(Number) }),
      totales: expect.objectContaining({ total: 0, completo: true }),
      globalApagada: expect.any(Boolean),
    })
  })

  it('con un aparato viejo, confirmar se detiene: bloqueos con cómo arreglarlos y nada escrito', async () => {
    const { x, p, mcp } = await armar()
    await iPadViejo(x.venueId)
    const previa = await mcp('set_product_iva', { name: 'café', iva: 'IVA_0' })
    expect(previa).toMatchObject({
      requiresConfirmation: true,
      change: { item: 'Café en grano', label: 'IVA', from: '16 %', to: '0 %' },
      encenderaElNegocio: true,
      bloqueos: [expect.objectContaining({ codigo: 'APARATO_VIEJO' })],
    })
    const r = await mcp('set_product_iva', {
      name: 'café',
      iva: 'IVA_0',
      confirm: true,
      resolvedProductId: p.id,
      expectedSourceFingerprint: previa.expectedSourceFingerprint,
    })
    expect(r).toMatchObject({
      ok: false,
      error: MENSAJE_BLOQUEADO,
      code: 'IVA_ENCENDIDO_BLOQUEADO',
      bloqueos: [expect.objectContaining({ codigo: 'APARATO_VIEJO' })],
    })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).ivaTratamiento).toBe('IVA_16')
    expect(await prisma.venueIvaPorProducto.findUnique({ where: { venueId: x.venueId } })).toBeNull()
  })

  it('D20 · el dueño confirma: enciende y cambia por el MISMO servicio (origen MCP en la auditoría)', async () => {
    const { x, staffId, p, mcp } = await armar(StaffRole.OWNER)
    const previa = await mcp('set_product_iva', { name: 'café', iva: 'IVA_0' })
    expect(previa).toMatchObject({ requiresConfirmation: true, encenderaElNegocio: true, soloDuenoOAdministrador: true, bloqueos: [] })
    const r = await mcp('set_product_iva', {
      name: 'café',
      iva: 'IVA_0',
      confirm: true,
      resolvedProductId: p.id,
      expectedSourceFingerprint: previa.expectedSourceFingerprint,
    })
    expect(r).toEqual({ ok: true, item: { name: 'Café en grano', iva: '0 %' } })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).ivaTratamiento).toBe('IVA_0')
    expect(await prisma.venueIvaPorProducto.findUnique({ where: { venueId: x.venueId } })).toMatchObject({ habilitadoPorStaffId: staffId })
    const log = await prisma.activityLog.findMany({ where: { venueId: x.venueId } })
    expect(log.find(l => l.action === 'IVA_POR_PRODUCTO_ACTIVADO')).toMatchObject({ data: expect.objectContaining({ origen: 'MCP' }) })
    expect(log.find(l => l.action === 'PRODUCT_IVA_CHANGED')).toMatchObject({ data: expect.objectContaining({ origen: 'MCP' }) })
    // Ya encendido: el diagnóstico lo dice y el producto aparece con su IVA.
    expect(await mcp('set_product_iva', {})).toMatchObject({ ok: true, diagnostico: true, encendido: true })
    expect((await mcp('menu_item_detail', { name: 'café' })).item.iva).toBe('0 %')
  })

  it('el primer encendido sólo lo confirma el dueño o un administrador: un mesero recibe el motivo en español', async () => {
    const { x, p, mcp } = await armar(StaffRole.WAITER)
    const previa = await mcp('set_product_iva', { name: 'café', iva: 'EXENTO' })
    const r = await mcp('set_product_iva', {
      name: 'café',
      iva: 'EXENTO',
      confirm: true,
      resolvedProductId: p.id,
      expectedSourceFingerprint: previa.expectedSourceFingerprint,
    })
    expect(r).toEqual({ ok: false, error: MENSAJE_SOLO_DUENO, code: 'IVA_ENCENDIDO_SOLO_DUENO' })
    expect((await prisma.product.findUniqueOrThrow({ where: { id: p.id } })).ivaTratamiento).toBe('IVA_16')
    expect(await prisma.venueIvaPorProducto.findUnique({ where: { venueId: x.venueId } })).toBeNull()
  })
})
