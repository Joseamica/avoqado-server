/**
 * Fix A1 (audit, spec §10.4) — confused-deputy en el link de canal de delivery.
 *
 * Antes, POST /venues/:venueId/channels (crear) y PATCH .../channels/:linkId (actualizar, que
 * puede cambiar `externalLocationId`) estaban gated `delivery-channels:manage` (OWNER/ADMIN). Un
 * manager de un tenant podía bindear un `externalLocationId` de Deliverect ARBITRARIO a su venue
 * y luego dispararlo (pause/menu-sync) con las credenciales OAuth PLATFORM-WIDE de Deliverect —
 * el scoping por `venueId` solo prueba dueño del link LOCAL de Avoqado, no del recurso EXTERNO.
 *
 * Decisión de producto (spec §2): "ops/superadmin conecta el canal; el dueño solo solicita y
 * opera". Fix: crear y cualquier update que toque `externalLocationId`/`externalAccountId`
 * (las dos identidades del recurso externo) ahora exigen `delivery-channels:connect` — un
 * permiso que NINGÚN rol no-SUPERADMIN tiene en DEFAULT_PERMISSIONS (solo pasa vía el atajo
 * `*:*` de SUPERADMIN en checkPermission — ver SUPERADMIN_ONLY_ALLOWLIST en
 * scripts/audit-permissions.ts). `pause` y el toggle `orderAcceptanceMode` (operativos sobre un
 * canal YA conectado) se quedan en OWNER/ADMIN vía `delivery-channels:manage`.
 *
 * Patrón de test: mini Express app montando el router REAL (mirrors
 * tests/unit/routes/simCustody.admin.routes.test.ts) — auth y checkPermission mockeados vía
 * headers de prueba, checkFeatureAccess passthrough (no es lo que se prueba aquí), controllers
 * proxied (200 + marcador).
 */

import express from 'express'
import request from 'supertest'

// 1. Auth: inyecta authContext desde un header de prueba.
jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: any, _res: any, next: any) => {
    const ctx = req.headers['x-test-auth-context']
    if (ctx) req.authContext = JSON.parse(ctx as string)
    next()
  },
}))

// 2. checkPermission: el mock lee 'x-test-allow-permission'. Si coincide con el permiso
//    chequeado (o es '*') → next(); si no → 403. Captura CADA permiso chequeado para poder
//    afirmar CUÁL string gatea cada ruta/rama.
const mockCheckPermission = jest.fn()
jest.mock('@/middlewares/checkPermission.middleware', () => ({
  checkPermission: (perm: string) => (req: any, res: any, next: any) => {
    mockCheckPermission(perm)
    const allowed = req.headers['x-test-allow-permission']
    if (allowed === perm || allowed === '*') return next()
    return res.status(403).json({ error: 'Forbidden', message: `Permission '${perm}' required`, required: perm })
  },
}))

// 3. Feature gate: no es lo que se prueba en este archivo — passthrough.
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))

// 4. Controllers: no es lo que se prueba — cada handler responde 200 con un marcador.
const controllerProxy = () =>
  new Proxy({}, { get: (_t, prop) => (prop === '__esModule' ? true : (_req: any, res: any) => res.json({ handler: String(prop) })) })
jest.mock('@/controllers/delivery-channels/deliveryChannels.controller', () => controllerProxy())

// ─── Import router DESPUÉS de los mocks ────────────────────────────────────────
import deliveryChannelsRouter from '@/routes/delivery-channels.routes'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use('/delivery-channels', deliveryChannelsRouter)
  // Red de seguridad: si algún body de prueba no pasara el Zod real, evita un 500 HTML crudo.
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err?.statusCode || 500).json({ error: err?.message || 'error' })
  })
  return app
}

const VENUE_ID = 'venue-test-1'
const LINK_ID = 'link-test-1'
const USER_ID = 'user-test-1'
const adminCtx = { userId: USER_ID, orgId: 'org1', venueId: VENUE_ID, role: 'ADMIN' }

function authHeader(ctx: object): Record<string, string> {
  return { 'x-test-auth-context': JSON.stringify(ctx) }
}

describe('delivery-channels.routes — Fix A1 (confused-deputy: create/link = SUPERADMIN only)', () => {
  let app: express.Express

  beforeEach(() => {
    jest.clearAllMocks()
    app = createApp()
  })

  describe('POST /venues/:venueId/channels (crear)', () => {
    const body = { provider: 'DELIVERECT', externalLocationId: 'loc-123' }

    it('403 para un no-superadmin (ADMIN) aunque tenga delivery-channels:manage', async () => {
      const res = await request(app)
        .post(`/delivery-channels/venues/${VENUE_ID}/channels`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:manage' })
        .send(body)

      expect(res.status).toBe(403)
    })

    it('gatea con delivery-channels:connect (NO con delivery-channels:manage)', async () => {
      await request(app)
        .post(`/delivery-channels/venues/${VENUE_ID}/channels`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': '*' })
        .send(body)

      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:connect')
      expect(mockCheckPermission).not.toHaveBeenCalledWith('delivery-channels:manage')
    })

    it('200 para un superadmin (delivery-channels:connect permitido)', async () => {
      const res = await request(app)
        .post(`/delivery-channels/venues/${VENUE_ID}/channels`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:connect' })
        .send(body)

      expect(res.status).toBe(200)
    })
  })

  describe('PATCH /venues/:venueId/channels/:linkId (actualizar)', () => {
    it('tocar externalLocationId → gatea con delivery-channels:connect, 403 sin él', async () => {
      const res = await request(app)
        .patch(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:manage' })
        .send({ externalLocationId: 'loc-arbitrario-999' })

      expect(res.status).toBe(403)
      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:connect')
    })

    it('tocar externalAccountId → también gatea con delivery-channels:connect', async () => {
      await request(app)
        .patch(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': '*' })
        .send({ externalAccountId: 'acct-arbitrario-999' })

      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:connect')
    })

    it('un superadmin SÍ puede cambiar externalLocationId', async () => {
      const res = await request(app)
        .patch(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:connect' })
        .send({ externalLocationId: 'loc-arbitrario-999' })

      expect(res.status).toBe(200)
    })

    it('un ADMIN con SOLO delivery-channels:manage recibe 403 si el body TAMBIÉN incluye externalLocationId', async () => {
      const res = await request(app)
        .patch(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:manage' })
        .send({ orderAcceptanceMode: 'MANUAL', externalLocationId: 'loc-999' })

      expect(res.status).toBe(403)
    })

    // ── Regresión: el toggle de modo se queda en OWNER/ADMIN ──────────────────
    it('REGRESIÓN: tocar SOLO orderAcceptanceMode → gatea con delivery-channels:manage (ADMIN sigue pudiendo togglear modo)', async () => {
      const res = await request(app)
        .patch(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:manage' })
        .send({ orderAcceptanceMode: 'MANUAL' })

      expect(res.status).toBe(200)
      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:manage')
      expect(mockCheckPermission).not.toHaveBeenCalledWith('delivery-channels:connect')
    })

    it('REGRESIÓN: tocar SOLO autoSyncMenu/config → sigue en delivery-channels:manage', async () => {
      const res = await request(app)
        .patch(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:manage' })
        .send({ autoSyncMenu: false })

      expect(res.status).toBe(200)
      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:manage')
    })
  })

  // ── Regresión: rutas hermanas sin cambios ─────────────────────────────────
  describe('Regresión: rutas hermanas no afectadas', () => {
    it('POST .../pause sigue en delivery-channels:manage (OWNER/ADMIN)', async () => {
      const res = await request(app)
        .post(`/delivery-channels/venues/${VENUE_ID}/channels/${LINK_ID}/pause`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:manage' })
        .send({ paused: true })

      expect(res.status).toBe(200)
      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:manage')
    })

    it('GET .../channels sigue en delivery-channels:read', async () => {
      const res = await request(app)
        .get(`/delivery-channels/venues/${VENUE_ID}/channels`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:read' })

      expect(res.status).toBe(200)
      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:read')
    })

    it('POST .../activation-request sigue en delivery-channels:request', async () => {
      const res = await request(app)
        .post(`/delivery-channels/venues/${VENUE_ID}/activation-request`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:request' })
        .send({ requestedChannels: ['RAPPI'] })

      expect(res.status).toBe(200)
      expect(mockCheckPermission).toHaveBeenCalledWith('delivery-channels:request')
    })

    it('GET .../delivery/summary sigue en delivery-channels:read', async () => {
      const res = await request(app)
        .get(`/delivery-channels/venues/${VENUE_ID}/delivery/summary`)
        .set({ ...authHeader(adminCtx), 'x-test-allow-permission': 'delivery-channels:read' })

      expect(res.status).toBe(200)
    })
  })
})
