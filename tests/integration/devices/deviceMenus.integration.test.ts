/**
 * Menú del aparato (Task A8) — contra Postgres REAL y la app REAL por supertest: la página del DASHBOARD («Qué muestra cada
 * aparato») guarda y lista, el candado Pro del PUT, y que las filas de `TerminalMenu` se van solas (cascada) al borrar el menú
 * o el aparato y al reemplazar el menú con una importación. Además, el CHECK de la base: un menú no puede quedar sin uso; nada
 * del otro negocio se cuela (guardar, listar); y `set_device_menus` del MCP deja UNA fila de bitácora con su procedencia.
 *
 * Corre en la nube (base desechable): ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration
 *   --testPathPattern "devices/deviceMenus" --ci
 */
// La bitácora REAL (integration-setup la mockea): se comprueba la fila de ActivityLog con su antes y después.
jest.unmock('@/services/dashboard/activity-log.service')
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { getVenueTpvSettings } from '@/controllers/mobile/tpvSettings.mobile.controller'
import { registerDeviceMenuTools } from '@/mcp/tools/deviceMenus'
import type { McpScope } from '@/mcp/scope'
import { conectarPorElCatalogo } from '@tests/__helpers__/mcp-por-el-catalogo'
import { importMenu } from '@/services/dashboard/menu.dashboard.service'
import { resolveDeviceMenuFilter, TODO } from '@/services/devices/deviceMenus.service'

jest.setTimeout(120_000)

const suffix = `dm-${Date.now()}`
const DEVICE = `dev-${suffix}`
let server: Server
let orgId: string
let venueId: string
let staffId: string
let token: string
let caja: string // POS_ANDROID con deviceUid
let pax: string // TPV_ANDROID
let catComida: string
let catBebidas: string
let menuComida: string
let menuBebidas: string
let menuWeb: string // sólo tienda en línea
let menuApagado: string
// El otro negocio: su aparato y su menú nunca se cuelan.
let otraOrgId: string
let otroVenueId: string
let otraCaja: string
let menuAjeno: string

const api = (path: string) => `/api/v1/dashboard/venues/${venueId}${path}`
const put = (terminalId: string, menuIds: string[]) =>
  request(server)
    .put(api(`/tpv/${terminalId}/menus`))
    .set('Authorization', `Bearer ${token}`)
    .send({ menuIds })
const get = (path: string) => request(server).get(api(path)).set('Authorization', `Bearer ${token}`)

/** El cuerpo REAL de `/settings` para un aparato (el controlador, sin HTTP), como en pollAndSettingsAgree. */
async function settingsDeLaCaja(deviceUid = DEVICE) {
  let body: any
  const res: any = { status: () => res, json: (b: unknown) => ((body = b), res) }
  await getVenueTpvSettings({ params: { venueId }, headers: { 'x-device-id': deviceUid } } as any, res, (e: unknown) => {
    throw e
  })
  return body.data.deviceTerminal
}

async function darPro() {
  const feature = await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: {},
    create: { code: 'PLAN_PRO', name: 'Pro', category: 'OPERATIONS', monthlyPrice: 0 },
  })
  const ya = await prisma.venueFeature.findFirst({ where: { venueId, featureId: feature.id }, select: { id: true } })
  if (!ya) await prisma.venueFeature.create({ data: { venueId, featureId: feature.id, monthlyPrice: 0 } })
}

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))

  orgId = (await prisma.organization.create({ data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '5500000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, slug: `v-${suffix}`, status: 'ACTIVE', timezone: 'America/Mexico_City' },
    })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `${suffix}-owner@example.test`, firstName: 'Dueña', lastName: 'Menús' } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
  token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })

  caja = (await prisma.terminal.create({ data: { venueId, name: 'Caja', type: 'POS_ANDROID', deviceUid: DEVICE, status: 'ACTIVE' } })).id
  pax = (await prisma.terminal.create({ data: { venueId, name: 'PAX', type: 'TPV_ANDROID', status: 'ACTIVE' } })).id

  catComida = (await prisma.menuCategory.create({ data: { venueId, name: 'Comida', slug: `comida-${suffix}` } })).id
  catBebidas = (await prisma.menuCategory.create({ data: { venueId, name: 'Bebidas', slug: `bebidas-${suffix}` } })).id
  for (const [categoryId, n] of [
    [catComida, 2],
    [catBebidas, 1],
  ] as const) {
    for (let i = 0; i < n; i++) {
      await prisma.product.create({ data: { venueId, categoryId, name: `P ${categoryId} ${i}`, sku: `SKU-${categoryId}-${i}`, price: 50 } })
    }
  }
  const menu = async (name: string, categoryId: string, appliesToDevices = true) =>
    (
      await prisma.menu.create({
        data: { venueId, name, appliesToDevices, appliesToOnline: true, categories: { create: { categoryId } } },
      })
    ).id
  menuComida = await menu('Comida', catComida)
  menuBebidas = await menu('Bebidas', catBebidas)
  menuWeb = await menu('Web', catComida, false)
  menuApagado = (
    await prisma.menu.create({ data: { venueId, name: 'Apagado', active: false, categories: { create: { categoryId: catComida } } } })
  ).id

  otraOrgId = (
    await prisma.organization.create({ data: { name: `Otra ${suffix}`, email: `otra-${suffix}@example.test`, phone: '5500000001' } })
  ).id
  otroVenueId = (
    await prisma.venue.create({
      data: {
        organizationId: otraOrgId,
        name: `Otro ${suffix}`,
        slug: `otro-${suffix}`,
        status: 'ACTIVE',
        timezone: 'America/Mexico_City',
      },
    })
  ).id
  otraCaja = (await prisma.terminal.create({ data: { venueId: otroVenueId, name: 'Caja ajena', type: 'POS_ANDROID', status: 'ACTIVE' } }))
    .id
  const catAjena = (await prisma.menuCategory.create({ data: { venueId: otroVenueId, name: 'Ajena', slug: `ajena-${suffix}` } })).id
  menuAjeno = (
    await prisma.menu.create({ data: { venueId: otroVenueId, name: 'Ajeno', categories: { create: { categoryId: catAjena } } } })
  ).id
})

afterAll(async () => {
  try {
    if (venueId) {
      // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.terminal.deleteMany({ where: { venueId } }) // TerminalMenu se va en cascada
      await prisma.menu.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venueFeature.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
    }
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
    if (otroVenueId) {
      await prisma.terminal.deleteMany({ where: { venueId: otroVenueId } })
      await prisma.menu.deleteMany({ where: { venueId: otroVenueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId: otroVenueId } })
      await prisma.venue.deleteMany({ where: { id: otroVenueId } })
    }
    if (otraOrgId) await prisma.organization.deleteMany({ where: { id: otraOrgId } })
  } finally {
    await new Promise<void>(listo => server.close(() => listo()))
  }
})

it('PUT sin Pro da 403 y no guarda nada', async () => {
  const res = await put(caja, [menuComida])
  expect(res.status).toBe(403)
  expect(res.body.featureCode).toBe('DEVICE_MENUS')
  expect(await prisma.terminalMenu.count({ where: { terminalId: caja } })).toBe(0)
})

it('PUT con Pro guarda y GET lo enseña', async () => {
  await darPro()

  const res = await put(caja, [menuComida])
  expect(res.status).toBe(200)
  // Un aparato que no reporta versión no aplica la elección: `sees` es lo que muestra hoy (todo) y lo filtrado va en `seesAfterUpdate`.
  expect(res.body).toMatchObject({
    id: caja,
    name: 'Caja',
    type: 'POS_ANDROID',
    needsAppUpdate: true,
    menus: [{ id: menuComida, name: 'Comida' }],
    sees: { categories: 2, products: 3 },
    seesAfterUpdate: { categories: 1, products: 2 },
  })

  const lista = await get('/tpvs/menus')
  expect(lista.status).toBe(200)
  expect(lista.body).toMatchObject({ everything: { categories: 2, products: 3 }, total: 1, page: 1, pageSize: 50 })
  // Sólo los POS: la PAX no sale
  expect(lista.body.terminals.map((t: any) => t.id)).toEqual([caja])
  expect(lista.body.terminals[0]).toMatchObject({
    menus: [{ id: menuComida, name: 'Comida' }],
    sees: { categories: 2, products: 3 },
    seesAfterUpdate: { categories: 1, products: 2 },
  })

  // logAction va sin esperar (fuera de la transacción): se le da hasta 5 s de margen.
  const buscarLog = () => prisma.activityLog.findFirst({ where: { venueId, action: 'TERMINAL_MENUS_UPDATED', entityId: caja } })
  let log = await buscarLog()
  for (let i = 0; i < 50 && !log; i++) {
    await new Promise(r => setTimeout(r, 100))
    log = await buscarLog()
  }
  expect(log?.data).toEqual({ terminalName: 'Caja', antes: [], despues: [{ id: menuComida, name: 'Comida' }] })
  expect(log?.staffId).toBe(staffId)

  // Opciones del selector: sin el menú sólo en línea; pedir 500 se topa en 100
  const opciones = await get('/tpvs/menus/options?pageSize=500')
  expect(opciones.status).toBe(200)
  expect(opciones.body.pageSize).toBe(100)
  expect(opciones.body.menus.map((m: any) => m.id).sort()).toEqual([menuBebidas, menuComida].sort())
  expect(opciones.body.menus.find((m: any) => m.id === menuComida)).toEqual({
    id: menuComida,
    name: 'Comida',
    appliesToOnline: true,
    categoryCount: 1,
  })
  const busqueda = await get('/tpvs/menus/options?search=BEBI')
  expect(busqueda.body).toMatchObject({ total: 1, menus: [{ id: menuBebidas }] })

  // Las salidas de error del contrato
  const aTpv = await put(pax, [])
  expect(aTpv.status).toBe(404)
  expect(aTpv.body.code).toBe('TERMINAL_NOT_FOUND')
  const soloEnLinea = await put(caja, [menuWeb])
  expect(soloEnLinea.status).toBe(400)
  expect(soloEnLinea.body.code).toBe('MENU_NO_DISPONIBLE')
  const repetidos = await put(caja, [menuComida, menuComida])
  expect(repetidos.status).toBe(400)
  expect(await prisma.terminalMenu.count({ where: { terminalId: caja } })).toBe(1) // nada cambió
})

it('borrar el menú borra la fila por cascada y el aparato vuelve a null en /settings', async () => {
  await darPro()
  expect((await put(caja, [menuBebidas])).status).toBe(200)
  expect(await settingsDeLaCaja()).toMatchObject({ visibleCategoryIds: [catBebidas], visibleMenuIds: [menuBebidas] })

  await prisma.menu.delete({ where: { id: menuBebidas } })

  expect(await prisma.terminalMenu.count({ where: { menuId: menuBebidas } })).toBe(0)
  expect(await settingsDeLaCaja()).toMatchObject({ visibleCategoryIds: null, visibleMenuIds: null })
})

it('borrar el aparato borra sus filas', async () => {
  await darPro()
  const otra = (await prisma.terminal.create({ data: { venueId, name: 'Caja 2', type: 'POS_IOS' } })).id
  expect((await put(otra, [menuComida])).status).toBe(200)
  expect(await prisma.terminalMenu.count({ where: { terminalId: otra } })).toBe(1)

  await prisma.terminal.delete({ where: { id: otra } })

  expect(await prisma.terminalMenu.count({ where: { terminalId: otra } })).toBe(0)
})

it('nada del otro negocio: su menú no se guarda, su aparato no se toca y la lista no lo enseña', async () => {
  await darPro()

  const menuDelOtro = await put(caja, [menuAjeno])
  expect(menuDelOtro.status).toBe(400)
  expect(menuDelOtro.body.code).toBe('MENU_NO_DISPONIBLE')

  const aparatoDelOtro = await put(otraCaja, [])
  expect(aparatoDelOtro.status).toBe(404)
  expect(aparatoDelOtro.body.code).toBe('TERMINAL_NOT_FOUND')
  expect(await prisma.terminal.findUnique({ where: { id: otraCaja }, select: { venueId: true } })).toEqual({ venueId: otroVenueId })

  // Una fila vieja hacia el menú del otro negocio (un aparato que cambió de sucursal) no se enseña ni cuenta.
  expect((await put(caja, [menuComida])).status).toBe(200)
  await prisma.terminalMenu.create({ data: { terminalId: caja, menuId: menuAjeno } })
  const lista = await get('/tpvs/menus')
  expect(lista.body.terminals.map((t: any) => t.id)).toEqual([caja])
  expect(lista.body.terminals[0].menus).toEqual([{ id: menuComida, name: 'Comida' }])
  const opciones = await get('/tpvs/menus/options')
  expect(opciones.body.menus.map((m: any) => m.id)).not.toContain(menuAjeno)
  const todo = JSON.stringify([lista.body, opciones.body])
  for (const delOtro of [otraCaja, menuAjeno, 'Ajeno', 'Caja ajena']) expect(todo).not.toContain(delOtro)
})

it('set_device_menus del MCP: la vista previa sólo enseña lo del negocio y cada cambio deja UNA fila con la procedencia del MCP', async () => {
  await darPro()
  // Hoy: Comida, más dos filas que la regla no usa (un menú del otro negocio y uno apagado).
  await prisma.terminalMenu.deleteMany({ where: { terminalId: caja } })
  await prisma.terminalMenu.createMany({
    data: [menuComida, menuAjeno, menuApagado].map(menuId => ({ terminalId: caja, menuId })),
  })

  const scope = {
    staffId,
    activeOrg: orgId,
    allowedVenueIds: [venueId],
    scopes: ['mcp:read', 'mcp:write'],
    perVenueAccess: new Map([[venueId, { role: 'OWNER', corePermissions: ['*:*'], isSuperAdmin: false }]]),
  } as unknown as McpScope
  const mcp = await conectarPorElCatalogo(server => registerDeviceMenuTools(server, scope), scope)
  const args = { venueId, terminalIds: [caja], menuIds: [] }
  const confirmar = async () => {
    const vista = await mcp.call('set_device_menus', args)
    return {
      vista,
      resultado: await mcp.call('set_device_menus', {
        ...vista.confirmationArguments,
        confirm: true,
        confirmationToken: vista.confirmationToken,
      }),
    }
  }
  const filasDelMcp = () =>
    prisma.activityLog.findMany({
      where: { venueId, action: 'TERMINAL_MENUS_UPDATED', entityId: caja, data: { path: ['source'], equals: 'customer-mcp' } },
      select: { staffId: true, data: true },
      take: 10,
    })

  try {
    const primero = await confirmar()
    expect(primero.vista.preview).toEqual([{ id: caja, device: 'Caja', current: 'Comida', new: 'Todos los menús' }])
    expect(primero.resultado).toMatchObject({ ok: true, updated: [{ id: caja, name: 'Caja' }] })

    // logAction va sin esperar: hasta 5 s de margen.
    let filas = await filasDelMcp()
    for (let i = 0; i < 50 && filas.length === 0; i++) {
      await new Promise(r => setTimeout(r, 100))
      filas = await filasDelMcp()
    }
    await new Promise(r => setTimeout(r, 500)) // por si llegara una segunda
    filas = await filasDelMcp()
    expect(filas).toEqual([
      {
        staffId,
        data: { terminalName: 'Caja', antes: [{ id: menuComida, name: 'Comida' }], despues: [], source: 'customer-mcp' },
      },
    ])

    // Guardar otra vez lo mismo no deja ninguna fila nueva.
    const segundo = await confirmar()
    expect(segundo.resultado).toMatchObject({ ok: true })
    await new Promise(r => setTimeout(r, 1000))
    expect(await filasDelMcp()).toHaveLength(1)
  } finally {
    await mcp.close()
  }
})

it('la importación en modo replace deja a los aparatos en Todos', async () => {
  await darPro()
  expect((await put(caja, [menuComida])).status).toBe(200)
  expect(await resolveDeviceMenuFilter(venueId, caja)).not.toEqual(TODO)

  await importMenu(
    venueId,
    {
      mode: 'replace',
      categories: [{ name: 'Nueva', slug: `nueva-${suffix}`, products: [{ name: 'Nuevo', sku: `NEW-${suffix}`, price: 10 }] }],
    },
    { type: 'SERVICE', servicePrincipalId: 'MENU_DEL_APARATO_PRUEBA' },
  )

  expect(await prisma.terminalMenu.count({ where: { terminalId: caja } })).toBe(0)
  expect(await resolveDeviceMenuFilter(venueId, caja)).toEqual(TODO)
  const lista = await get('/tpvs/menus')
  expect(lista.body.terminals[0]).toMatchObject({ id: caja, menus: [] })
  expect(lista.body.terminals[0].sees).toEqual(lista.body.everything)
})

it('la base no deja un menú sin uso: las dos casillas apagadas violan el CHECK (23514)', async () => {
  const error = await prisma.menu
    .create({ data: { venueId, name: 'Ningún lado', appliesToDevices: false, appliesToOnline: false } })
    .then(() => null)
    .catch((e: Error) => e)
  expect(error?.message).toMatch(/23514/)
  expect(error?.message).toMatch(/Menu_appliesTo_alguno_check/)
})

it('Ruling 15 (Codex r3 #1 y #2): una categoría apagada que el menú trae directo sale igual en Cobrar y en Mesas, y «Todos» la cuenta', async () => {
  await darPro()
  const antes = (await get('/tpvs/menus')).body.everything

  const categoria = async (name: string, active: boolean, productos: number) => {
    const id = (await prisma.menuCategory.create({ data: { venueId, name, slug: `${name}-${suffix}`.toLowerCase(), active } })).id
    for (let i = 0; i < productos; i++) {
      await prisma.product.create({
        data: { venueId, categoryId: id, name: `P ${name} ${i}`, sku: `SKU-${name}-${suffix}-${i}`, price: 10 },
      })
    }
    return id
  }
  const encendida = await categoria('Encendida', true, 2)
  const apagada = await categoria('Apagada', false, 3)
  const menuMixto = (
    await prisma.menu.create({
      data: { venueId, name: 'Barra', categories: { create: [{ categoryId: encendida }, { categoryId: apagada, displayOrder: 1 }] } },
    })
  ).id

  const guardado = await put(caja, [menuMixto])
  expect(guardado.status).toBe(200)
  expect(guardado.body.seesAfterUpdate).toEqual({ categories: 2, products: 5 })

  // Cobrar (/settings) y Mesas (/menus) dan las MISMAS categorías para este aparato.
  const cobrar = await settingsDeLaCaja()
  const mesas = await request(server).get(`/api/v1/mobile/venues/${venueId}/menus`).set('Authorization', `Bearer ${token}`)
  expect(mesas.status).toBe(200)
  const delMenu = mesas.body.data.menus.find((m: any) => m.id === menuMixto).categoryIds
  expect(cobrar.visibleCategoryIds).toEqual([...delMenu].sort())
  expect(cobrar.visibleCategoryIds).toEqual([encendida, apagada].sort())

  // «Todos» cuenta la apagada con sus productos: la API de productos de las apps la entrega.
  const lista = await get('/tpvs/menus')
  expect(lista.body.everything).toEqual({ categories: antes.categories + 2, products: antes.products + 5 })
  const opciones = await get('/tpvs/menus/options?search=Barra')
  expect(opciones.body.menus).toEqual([expect.objectContaining({ id: menuMixto, categoryCount: 2 })])
})

it('Codex r3 #3: el conteo de un aparato no depende de sus vecinos de página (la unión pasa el tope de 5000 asignaciones)', async () => {
  await darPro()
  const uidA = `dev-a-${suffix}`
  const aparatoA = (await prisma.terminal.create({ data: { venueId, name: 'A sola', type: 'POS_ANDROID', deviceUid: uidA } })).id
  const aparatoB = (await prisma.terminal.create({ data: { venueId, name: 'B muchas', type: 'POS_ANDROID' } })).id

  const sola = (await prisma.menuCategory.create({ data: { venueId, name: 'Sola', slug: `sola-${suffix}` } })).id
  await prisma.product.create({ data: { venueId, categoryId: sola, name: 'P Sola', sku: `SKU-sola-${suffix}`, price: 10 } })
  const menuA = (await prisma.menu.create({ data: { venueId, name: 'Menú de A', categories: { create: { categoryId: sola } } } })).id

  // B: 50 menús × 101 categorías = 5050 asignaciones (pasa las 5000 del tope por sí solo).
  await prisma.menuCategory.createMany({
    data: Array.from({ length: 101 }, (_, j) => ({ venueId, name: `Muchas ${j}`, slug: `muchas-${j}-${suffix}` })),
  })
  const muchas = await prisma.menuCategory.findMany({
    where: { venueId, slug: { startsWith: 'muchas-' } },
    select: { id: true },
    take: 101,
  })
  const menusDeB: string[] = []
  for (let i = 0; i < 50; i++) menusDeB.push((await prisma.menu.create({ data: { venueId, name: `Menú B ${i}` } })).id)
  await prisma.menuCategoryAssignment.createMany({
    data: menusDeB.flatMap(menuId => muchas.map(c => ({ menuId, categoryId: c.id }))),
  })

  const deA = await put(aparatoA, [menuA])
  expect(deA.status).toBe(200)
  expect((await put(aparatoB, menusDeB)).status).toBe(200)
  // Ruling 11: con la versión mínima en null, lo filtrado viaja en seesAfterUpdate.
  expect(deA.body.seesAfterUpdate).toEqual({ categories: 1, products: 1 })

  const lista = await get('/tpvs/menus')
  const fila = (id: string) => lista.body.terminals.find((t: any) => t.id === id)
  expect(fila(aparatoA).seesAfterUpdate).toEqual(deA.body.seesAfterUpdate)
  expect(fila(aparatoB).seesAfterUpdate).toBeNull() // B solo pasa el tope: muestra todo
  expect(await settingsDeLaCaja(uidA)).toMatchObject({ visibleCategoryIds: [sola], visibleMenuIds: [menuA] })
})
