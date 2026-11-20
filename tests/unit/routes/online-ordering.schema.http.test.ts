// tests/unit/routes/online-ordering.schema.http.test.ts
/**
 * D661 (r2 #7): el esquema ESTRICTO de ajustes lo comparten el DASHBOARD (`PUT /settings`) y la tool MCP. Un campo que el servicio sí
 * entiende pero el esquema no conoce sale 400 al guardar. Aquí corre el camino real: ruta → validación → controlador → servicio, con
 * la base de pruebas; sólo se sueltan los candados de permiso y de plan (sus propias pruebas viven en `onlineOrdering.restaurant`).
 */
import express from 'express'
import request from 'supertest'
import { Prisma } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'
import type { McpScope } from '@/mcp/scope'

jest.mock('@/middlewares/checkPermission.middleware', () => ({
  __esModule: true,
  checkPermission: () => (_req: any, _res: any, next: any) => next(),
}))
jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  __esModule: true,
  checkFeatureAccess: () => (_req: any, _res: any, next: any) => next(),
}))
// El router del panel también monta la bandeja; aquí sólo importan los ajustes.
jest.mock('@/controllers/mobile/onlineOrders.mobile.controller', () => {
  const nada = (_req: any, res: any) => res.status(501).end()
  return {
    __esModule: true,
    pause: nada,
    inbox: nada,
    toPayPanel: nada,
    accept: nada,
    acceptPanel: nada,
    reject: nada,
    ready: nada,
    delivered: nada,
    cancel: nada,
  }
})
const mockAudit = jest.fn()
jest.mock('@/mcp/guard', () => ({
  __esModule: true,
  createGuard: () => ({ venueFilter: (v: string) => ({ venueId: { in: [v] } }), requirePermission: () => undefined }),
}))
jest.mock('@/mcp/requireWriteScopeAlways', () => ({ requireWriteScopeAlways: () => undefined }))
jest.mock('@/mcp/planGate', () => ({ planGateMessage: async () => null }))
jest.mock('@/mcp/audit', () => ({ auditMcpWrite: (...a: unknown[]) => mockAudit(...a) }))

import dashboardRouter from '@/routes/dashboard/onlineOrdering.dashboard.routes'
import { registerOnlineOrderingTools } from '@/mcp/tools/onlineOrdering'

const app = express()
app.use(express.json())
app.use((req: any, _res, next) => {
  req.authContext = { userId: 'staff1', venueId: 'v1' }
  next()
})
app.use('/d/venues/:venueId/online-ordering', dashboardRouter)
app.use((err: any, _req: any, res: any, _next: any) => res.status(err.statusCode ?? 500).json({ code: err.code, error: err.message }))

type Handler = (a: Record<string, unknown>, e: unknown) => Promise<{ content: Array<{ text: string }> }>
const handlers = new Map<string, Handler>()
const shapes = new Map<string, Record<string, any>>()
const parse = (r: { content: Array<{ text: string }> }) => JSON.parse(r.content[0].text)
beforeAll(() => {
  registerOnlineOrderingTools(
    {
      tool: (...a: unknown[]) => {
        handlers.set(a[0] as string, a[a.length - 1] as Handler)
        shapes.set(a[0] as string, a[2] as Record<string, any>)
      },
    } as never,
    { staffId: 'staff1', activeOrg: 'o1', allowedVenueIds: ['v1'], perVenueAccess: new Map() } as unknown as McpScope,
  )
})

const dia = { enabled: true, ranges: [{ open: '09:00', close: '21:00' }] }
const HORARIO = { monday: dia, tuesday: dia, wednesday: dia, thursday: dia, friday: dia, saturday: dia, sunday: dia }
/** La fila guardada; cada escritura la actualiza, como la base. */
let fila: Record<string, unknown>
const conFila = (o: Record<string, unknown>) => {
  fila = {
    id: 'set1',
    venueId: 'v1',
    enabled: true,
    minOrderAmount: new Prisma.Decimal('0'),
    defaultPrepMinutes: 15,
    acceptsPayAtPickup: true,
    acceptsCardOnline: true,
    manualPause: false,
    pausedUntil: null,
    hours: HORARIO,
    lastInboxPollAt: null,
    requiresAcceptance: true,
    lastToPayPollAt: new Date(Date.now() - 60_000),
    cardOnlineNadie: false,
    // Una caja actualizada avisó hace 1 min: prender el interruptor no choca con NO_CARD_ALERT_DEVICE.
    lastCardAlertPollAt: new Date(Date.now() - 60_000),
    ...o,
  }
}

beforeEach(() => {
  prismaMock.onlineOrderingSettings.findUnique.mockImplementation(async () => fila)
  prismaMock.onlineOrderingSettings.upsert.mockImplementation(async (a: any) => (fila = { ...fila, ...a.update }))
  prismaMock.venue.findUnique.mockResolvedValue({
    timezone: 'America/Mexico_City',
    type: 'RESTAURANT',
    address: 'Av. 1',
    phone: '5512345678',
  })
  prismaMock.privacyNoticeVersion.findFirst.mockResolvedValue({ id: 'pnv1' })
  prismaMock.ecommerceMerchant.findMany.mockResolvedValue([])
  prismaMock.onlineOrder.count.mockResolvedValue(0)
  prismaMock.onlineOrderCharge.count.mockResolvedValue(0)
})

const PUT = (body: Record<string, unknown>) => request(app).put('/d/venues/v1/online-ordering/settings').send(body)

describe('el esquema estricto de ajustes, por HTTP y por la tool MCP (D661)', () => {
  it('HTTP: el DASHBOARD guarda cardOnlineNadie en los dos modos sin 400; la tool MCP lo lee y lo guarda', async () => {
    // DASHBOARD, «Mi equipo» y «Nadie»: prender y apagar se guardan y la respuesta (la vista del GET) lo trae.
    for (const requiresAcceptance of [true, false]) {
      conFila({ requiresAcceptance })
      const prender = await PUT({ cardOnlineNadie: true })
      expect(prender.status).toBe(200)
      expect(prender.body.data).toMatchObject({ requiresAcceptance, cardOnlineNadie: true })
      expect(fila.cardOnlineNadie).toBe(true)
      const apagar = await PUT({ cardOnlineNadie: false })
      expect(apagar.status).toBe(200)
      expect(apagar.body.data.cardOnlineNadie).toBe(false)
    }
    // El GET del panel lo lee.
    conFila({ requiresAcceptance: false, cardOnlineNadie: true })
    const get = await request(app).get('/d/venues/v1/online-ordering/settings')
    expect(get.status).toBe(200)
    expect(get.body.data.cardOnlineNadie).toBe(true)

    // MCP: el mismo esquema acepta el campo, la lectura lo trae y configurar lo guarda (vista previa → confirmar).
    expect(shapes.get('online_ordering_configure')!.changes.safeParse({ cardOnlineNadie: true }).success).toBe(true)
    conFila({ requiresAcceptance: false })
    const leido = parse(await handlers.get('online_ordering_settings')!({ venueId: 'v1' }, {}))
    expect(leido.ajustes.cardOnlineNadie).toBe(false)
    const vista = parse(await handlers.get('online_ordering_configure')!({ venueId: 'v1', changes: { cardOnlineNadie: true } }, {}))
    expect(vista).toMatchObject({ ok: false, requiresConfirmation: true })
    expect(vista.preview.cambios).toEqual([
      { campo: 'cardOnlineNadie', de: false, a: true, resumen: 'Pagar con tarjeta al pedir con «No, entran solos»: no → sí' },
    ])
    expect(fila.cardOnlineNadie).toBe(false)
    const hecho = parse(
      await handlers.get('online_ordering_configure')!({ venueId: 'v1', changes: { cardOnlineNadie: true }, confirm: true }, {}),
    )
    expect(hecho.ok).toBe(true)
    expect(hecho.ajustes.cardOnlineNadie).toBe(true)
    expect(fila.cardOnlineNadie).toBe(true)
    expect(mockAudit).toHaveBeenCalledTimes(1)
  })

  it('sin caja capaz en 7 días: el panel recibe 409 NO_CARD_ALERT_DEVICE y la tool MCP lo dice sin error ni auditar; nada se guarda', async () => {
    conFila({ requiresAcceptance: false, lastCardAlertPollAt: null })
    const r = await PUT({ cardOnlineNadie: true })
    expect(r.status).toBe(409)
    expect(r.body.code).toBe('NO_CARD_ALERT_DEVICE')
    const mcp = parse(
      await handlers.get('online_ordering_configure')!({ venueId: 'v1', changes: { cardOnlineNadie: true }, confirm: true }, {}),
    )
    expect(mcp).toMatchObject({ ok: false, code: 'NO_CARD_ALERT_DEVICE' })
    expect(mockAudit).not.toHaveBeenCalled()
    expect(fila.cardOnlineNadie).toBe(false)
  })

  it('el esquema sigue estricto: un campo que no existe es 400 y no escribe', async () => {
    conFila({})
    const r = await PUT({ cardOnlineNadi: true })
    expect(r.status).toBe(400)
    expect(prismaMock.onlineOrderingSettings.upsert).not.toHaveBeenCalled()
  })
})
