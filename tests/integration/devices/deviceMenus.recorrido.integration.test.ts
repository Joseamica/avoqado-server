/**
 * Menú del aparato (Task A10, paso 2) — el RECORRIDO REAL del SERVIDOR como prueba repetible: app real por supertest y Postgres
 * REAL. Un negocio Pro con tres menús y tres aparatos POS; se eligen menús por el DASHBOARD y se lee lo que recibe cada
 * aparato en `/settings` y en `/menus` (Mesas); luego se borra un menú y se quita Pro. Es un recorrido: el estado pasa de un
 * paso al siguiente a propósito.
 *
 * Corre en la nube (base desechable): ./scripts/avq-verify.sh avoqado-server npx jest --selectProjects integration
 *   --testPathPattern "devices/deviceMenus.recorrido" --ci
 */
jest.unmock('@/services/dashboard/activity-log.service')
import type { Server } from 'http'
import { StaffRole } from '@prisma/client'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'

jest.setTimeout(120_000)

const suffix = `rec-${Date.now()}`
let server: Server
let orgId: string
let venueId: string
let staffId: string
let token: string
const aparato: Record<'android' | 'ios' | 'windows', { id: string; uid: string }> = {
  android: { id: '', uid: `dev-and-${suffix}` },
  ios: { id: '', uid: `dev-ios-${suffix}` },
  windows: { id: '', uid: `dev-win-${suffix}` },
}
let menuA: string
let menuB: string
let menuWeb: string
let catsA: string[] = []
let catsB: string[] = []

const dash = (path: string) => `/api/v1/dashboard/venues/${venueId}${path}`
const put = (terminalId: string, menuIds: string[]) =>
  request(server)
    .put(dash(`/tpv/${terminalId}/menus`))
    .set('Authorization', `Bearer ${token}`)
    .send({ menuIds })
const settings = (uid: string) =>
  request(server)
    .get(`/api/v1/mobile/venues/${venueId}/settings`)
    .set('Authorization', `Bearer ${token}`)
    .set('X-Device-ID', uid)
    .then(r => {
      expect(r.status).toBe(200)
      return r.body.data.deviceTerminal
    })

beforeAll(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))

  orgId = (await prisma.organization.create({ data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '5500000000' } })).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, slug: `v-${suffix}`, status: 'ACTIVE', timezone: 'America/Mexico_City' },
    })
  ).id
  staffId = (await prisma.staff.create({ data: { email: `${suffix}-owner@example.test`, firstName: 'Dueña', lastName: 'Recorrido' } })).id
  await prisma.staffVenue.create({ data: { staffId, venueId, role: StaffRole.OWNER, active: true } })
  token = jwt.sign({ sub: staffId, orgId, venueId, role: StaffRole.OWNER }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })

  for (const [k, type] of [
    ['android', 'POS_ANDROID'],
    ['ios', 'POS_IOS'],
    ['windows', 'POS_DESKTOP'],
  ] as const) {
    aparato[k].id = (
      await prisma.terminal.create({ data: { venueId, name: `Caja ${k}`, type, deviceUid: aparato[k].uid, status: 'ACTIVE' } })
    ).id
  }

  const categoria = async (name: string) => {
    const id = (await prisma.menuCategory.create({ data: { venueId, name, slug: `${name}-${suffix}`.toLowerCase() } })).id
    await prisma.product.create({ data: { venueId, categoryId: id, name: `P ${name}`, sku: `SKU-${name}-${suffix}`, price: 50 } })
    return id
  }
  catsA = [await categoria('A1'), await categoria('A2')]
  catsB = [await categoria('B1'), await categoria('B2'), await categoria('B3')]
  const catWeb = await categoria('W1')
  const menu = async (name: string, cats: string[], appliesToDevices = true) =>
    (
      await prisma.menu.create({
        data: { venueId, name, appliesToDevices, appliesToOnline: true, categories: { create: cats.map(categoryId => ({ categoryId })) } },
      })
    ).id
  menuA = await menu('Menú A', catsA)
  menuB = await menu('Menú B', catsB)
  menuWeb = await menu('Menú Web', [catWeb], false)

  const feature = await prisma.feature.upsert({
    where: { code: 'PLAN_PRO' },
    update: {},
    create: { code: 'PLAN_PRO', name: 'Pro', category: 'OPERATIONS', monthlyPrice: 0 },
  })
  await prisma.venueFeature.create({ data: { venueId, featureId: feature.id, monthlyPrice: 0 } })
})

afterAll(async () => {
  try {
    if (venueId) {
      // sin esta guarda, un id undefined vaciaría tablas enteras (8-oct)
      await prisma.activityLog.deleteMany({ where: { venueId } })
      await prisma.terminal.deleteMany({ where: { venueId } })
      await prisma.menu.deleteMany({ where: { venueId } })
      await prisma.product.deleteMany({ where: { venueId } })
      await prisma.menuCategory.deleteMany({ where: { venueId } })
      await prisma.venueFeature.deleteMany({ where: { venueId } })
      await prisma.staffVenue.deleteMany({ where: { venueId } })
      await prisma.venue.deleteMany({ where: { id: venueId } })
    }
    if (orgId) await prisma.organization.deleteMany({ where: { id: orgId } })
    if (staffId) await prisma.staff.deleteMany({ where: { id: staffId } })
  } finally {
    await new Promise<void>(listo => server.close(() => listo()))
  }
})

describe('Menú del aparato: el recorrido del SERVIDOR', () => {
  it('paso 1 · el negocio Pro arma sus tres menús y tres aparatos POS; todos arrancan en «Todos»', async () => {
    for (const k of ['android', 'ios', 'windows'] as const) {
      expect(await settings(aparato[k].uid)).toMatchObject({ id: aparato[k].id, visibleCategoryIds: null, visibleMenuIds: null })
    }
    const lista = await request(server).get(dash('/tpvs/menus')).set('Authorization', `Bearer ${token}`)
    expect(lista.status).toBe(200)
    expect(lista.body.total).toBe(3)
    expect(lista.body.terminals.map((t: any) => t.type).sort()).toEqual(['POS_ANDROID', 'POS_DESKTOP', 'POS_IOS'])
  })

  it('paso 2 · el DASHBOARD le pone A a uno y B a otro; el tercero se queda en «Todos»', async () => {
    expect((await put(aparato.android.id, [menuA])).status).toBe(200)
    expect((await put(aparato.ios.id, [menuB])).status).toBe(200)

    const lista = await request(server).get(dash('/tpvs/menus')).set('Authorization', `Bearer ${token}`)
    expect(lista.status).toBe(200)
    // «Todos» = 6 categorías con producto (A1 A2 B1 B2 B3 W1) y 6 productos.
    const todo = lista.body.everything
    expect(todo).toEqual({ categories: 6, products: 6 })
    const fila = (id: string) => lista.body.terminals.find((t: any) => t.id === id)
    // Ruling 11: sin versión mínima publicada la app ignora el filtro → `sees` es todo y lo filtrado va en `seesAfterUpdate`.
    expect(fila(aparato.android.id)).toMatchObject({
      menus: [{ id: menuA, name: 'Menú A' }],
      needsAppUpdate: true,
      sees: todo,
      seesAfterUpdate: { categories: 2, products: 2 },
    })
    expect(fila(aparato.ios.id)).toMatchObject({
      menus: [{ id: menuB, name: 'Menú B' }],
      needsAppUpdate: true,
      sees: todo,
      seesAfterUpdate: { categories: 3, products: 3 },
    })
    expect(fila(aparato.windows.id)).toMatchObject({ menus: [], needsAppUpdate: true, sees: todo, seesAfterUpdate: null })
  })

  it('paso 3 · /settings entrega a cada aparato lo suyo y al tercero null/null', async () => {
    expect(await settings(aparato.android.uid)).toMatchObject({ visibleCategoryIds: [...catsA].sort(), visibleMenuIds: [menuA] })
    expect(await settings(aparato.ios.uid)).toMatchObject({ visibleCategoryIds: [...catsB].sort(), visibleMenuIds: [menuB] })
    expect(await settings(aparato.windows.uid)).toMatchObject({ visibleCategoryIds: null, visibleMenuIds: null })
  })

  it('paso 4 · /menus (Mesas) no trae «Menú Web»', async () => {
    const res = await request(server).get(`/api/v1/mobile/venues/${venueId}/menus`).set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    const ids = res.body.data.menus.map((m: any) => m.id)
    expect(ids.sort()).toEqual([menuA, menuB].sort())
    expect(ids).not.toContain(menuWeb)
  })

  it('paso 5 · se borra «Menú B» por el DASHBOARD y el segundo aparato vuelve a null en /settings', async () => {
    const del = await request(server)
      .delete(dash(`/menus/${menuB}`))
      .set('Authorization', `Bearer ${token}`)
    expect(del.status).toBeLessThan(300)
    expect(await settings(aparato.ios.uid)).toMatchObject({ visibleCategoryIds: null, visibleMenuIds: null })
    // el primero no se movió
    expect(await settings(aparato.android.uid)).toMatchObject({ visibleMenuIds: [menuA] })
  })

  it('paso 6 · se le quita Pro al negocio y los tres reciben null', async () => {
    await prisma.venueFeature.deleteMany({ where: { venueId } })
    for (const k of ['android', 'ios', 'windows'] as const) {
      expect(await settings(aparato[k].uid)).toMatchObject({ visibleCategoryIds: null, visibleMenuIds: null })
    }
  })
})
