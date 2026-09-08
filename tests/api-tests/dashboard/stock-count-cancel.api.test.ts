/*
  tests/api-tests/dashboard/stock-count-cancel.api.test.ts

  La capa HTTP de «cancelar un conteo», de punta a punta: Express real + supertest.
  Existe porque un test estático del permiso demuestra que alguien escribió
  `inventory:update` en la ruta, NO que un cajero reciba un 403 de verdad.

  Middleware real: authenticateTokenMiddleware → checkFeatureAccess('INVENTORY_TRACKING')
  → checkPermission('inventory:update') → controlador.

  🔴 El candado de PLAN va ANTES que el de permiso: TODO el router de inventario cuelga de
  `router.use(checkFeatureAccess('INVENTORY_TRACKING'))` (inventory.routes.ts:111), y sin
  satisfacerlo cada caso de esta suite recibiría el 403 de «Feature not available» — que se
  parece al 403 de permiso pero no prueba NADA sobre el permiso. Se satisface por el camino
  de la CONCESIÓN EXPLÍCITA (`venueFeature.findFirst`), igual que loyalty.api.test.ts.

  Hechos de permisos (src/lib/permissions.ts), verificados contra el mapa de roles:
  - `inventory:update` lo traen MANAGER, ADMIN y OWNER. Aquí se prueban ADMIN y OWNER.
  - CASHIER y WAITER NO lo traen: heredan `inventory:read` por la dependencia de
    `orders:create` (necesitan ver existencias para tomar una comanda), y ahí se quedan.
  - HOST no tiene NINGÚN permiso de inventario — ni siquiera la lectura, porque no toma
    comandas. Es el control de que un rol sin nada tampoco pasa.
*/
process.env.NODE_ENV = process.env.NODE_ENV || 'test'
process.env.ACCESS_TOKEN_SECRET = process.env.ACCESS_TOKEN_SECRET || 'test-access-secret'
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret'
process.env.COOKIE_SECRET = process.env.COOKIE_SECRET || 'test-cookie-secret'
process.env.DATABASE_URL = process.env.DATABASE_URL || 'postgresql://user:pass@localhost:5432/testdb?schema=public'

jest.mock('../../../src/config/session', () => {
  const noop = (req: any, _res: any, next: any) => next()
  return { __esModule: true, default: noop }
})
jest.mock('../../../src/config/swagger', () => ({ __esModule: true, setupSwaggerUI: jest.fn() }))

import jwt from 'jsonwebtoken'
import request from 'supertest'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

const app = require('../../../src/app').default

const venueId = 'clvenuestockcount0000001'
const otherVenueId = 'clvenuestockcount0000002'
const countId = 'clstockcount000000000001'
const RUTA = `/api/v1/dashboard/venues/${venueId}/inventory/stock-counts/${countId}/cancel`

/**
 * Concesión explícita de INVENTORY_TRACKING, en la forma que el MIDDLEWARE consulta:
 * `findFirst` con `include: { feature: true }`. ⚠️ No basta con los campos que selecciona
 * `venueHasFeatureAccess` — el middleware lee `venueFeature.feature.name` al conceder, y sin
 * la relación revienta con un 500 «Failed to verify feature access» que NO se parece en nada
 * a la causa. Mismo fixture que loyalty.api.test.ts.
 *
 * `venue.findUnique` se deja en null a propósito: un venue ausente NO es exento
 * (`venueIsExemptFromPlanGating`), así que el gate depende de esta concesión y no de un
 * atajo — y `checkPermission` sigue sin su respaldo por organización.
 */
const CONCESION_INVENTARIO = {
  id: 'vf-inv-1',
  active: true,
  endDate: null,
  suspendedAt: null,
  stripeSubscriptionId: null,
  feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
}

/** Revisión que trae la fila bloqueada en el estado base de cada caso. */
const REVISION_ACTUAL = 4

/**
 * 🔴 El servicio ya NO decide con un `findFirst`: abre transacción y BLOQUEA la fila
 * (`SELECT … FOR UPDATE` vía `$queryRaw`, inventory.mobile.service.ts → `lockStockCount`).
 * Sin simular ese bloqueo, `rows[0]` se evalúa sobre `undefined` y TODO caso contesta 500 —
 * que es exactamente como se puso rojo el CI el 2026-09-08. El reclamo `updateMany` se
 * condiciona a la revisión LEÍDA, así que la fila que devuelve esta función es la que manda.
 */
function bloqueoDe(status: 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED' | 'APPLYING', revision = REVISION_ACTUAL) {
  return [{ id: countId, status, revision, applyingAt: null }]
}

function makeToken(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

beforeEach(() => {
  jest.clearAllMocks()
  // checkPermission determinista: sin bypass de SUPERADMIN ni overrides personalizados.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venueFeature.findFirst.mockResolvedValue(CONCESION_INVENTARIO as never)
  prismaMock.stockCount.updateMany.mockResolvedValue({ count: 1 })
  // Sin esta línea, el caso del 409 deja sembrado un conteo COMPLETED y los tests que
  // corran DESPUÉS lo heredan — `jest.clearAllMocks()` borra las LLAMADAS, no las
  // implementaciones: pasarían o fallarían según el orden, no según el código.
  prismaMock.$queryRaw.mockResolvedValue(bloqueoDe('IN_PROGRESS') as never)
  prismaMock.activityLog.create.mockResolvedValue({} as never)
})

describe('POST …/stock-counts/:countId/cancel', () => {
  it('401 sin credencial', async () => {
    const res = await request(app).post(RUTA)
    expect(res.status).toBe(401)
    expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
  })

  it.each([['CASHIER'], ['WAITER'], ['HOST']])('🔴 %s recibe 403 de verdad y no escribe nada', async role => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${makeToken(role)}`)
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:update')
    expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
  })

  it('🔴 403 entre negocios: un token de otro venue no cancela aquí', async () => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${makeToken('OWNER', otherVenueId)}`)
    expect(res.status).toBe(403)
    expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
  })

  it.each([['ADMIN'], ['OWNER']])('%s cancela y recibe 200 con el conteo cancelado', async role => {
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${makeToken(role)}`)
    expect(res.status).toBe(200)
    // La revisión que sale es la de la fila BLOQUEADA + 1: prueba que el conteo cancelado
    // se construyó sobre lo que el lock leyó, y no sobre un valor inventado por el servicio.
    expect(res.body).toMatchObject({ success: true, data: { id: countId, status: 'CANCELLED', revision: REVISION_ACTUAL + 1 } })
    expect(prismaMock.stockCount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: countId, venueId, status: 'IN_PROGRESS', revision: REVISION_ACTUAL } }),
    )
  })

  it('409 con motivo cuando el conteo ya se completó', async () => {
    prismaMock.$queryRaw.mockResolvedValue(bloqueoDe('COMPLETED') as never)
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${makeToken('OWNER')}`)
    expect(res.status).toBe(409)
    expect(res.body.message ?? res.body.error).toMatch(/completado/i)
    // Un conteo completado YA ajustó el inventario: el servicio lo decide sobre la fila
    // bloqueada y ni siquiera intenta el reclamo. Sin esta línea, un reclamo que escribiera
    // y luego explicara el 409 pasaría igual de verde.
    expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
  })

  it('404 cuando no existe en este negocio', async () => {
    prismaMock.$queryRaw.mockResolvedValue([] as never)
    const res = await request(app)
      .post(RUTA)
      .set('Authorization', `Bearer ${makeToken('OWNER')}`)
    expect(res.status).toBe(404)
    // 🔴 Una ruta AUSENTE también contesta 404: sin esto, borrar el `router.post` dejaría esta
    // prueba en verde (pasó exactamente así en la corrida roja). Lo que distingue «el servicio
    // no lo encontró» de «nadie atendió la petición» es que el BLOQUEO se haya intentado; el
    // testigo era `updateMany`, y con el reclamo bajo lock ya no se llega a él en este caso.
    expect(prismaMock.$queryRaw).toHaveBeenCalled()
    expect(prismaMock.stockCount.updateMany).not.toHaveBeenCalled()
  })
})
