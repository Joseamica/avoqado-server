/*
  API tests for the "cobro externo" (settlementRoute EXTERNAL) endpoints — Task 11
  "Endpoints, rutas y validación" del plan 2026-08-10-caja-externa-fase-1-nucleo:

    POST /api/v1/mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/handoff
    POST /api/v1/mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/confirm
    POST /api/v1/mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/not-charged
    GET  /api/v1/mobile/venues/:venueId/area-tickets/pending-confirmation

  Alcance: esta tarea es la puerta HTTP (routing, permiso, validación Zod, envelope) —
  NO vuelve a probar las reglas de negocio del servicio (idempotencia, cuantización,
  discrepancias…), que ya cubren las Tasks 6-9 en
  tests/unit/services/mobile/areaTicketExternal.{handoff,confirm,notCharged}.test.ts y
  tests/integration/area-tickets/area-ticket-external-*.test.ts. Por eso
  `areaTicketExternal.mobile.service` se mockea aquí — mismo arnés que
  tests/api-tests/dashboard/venueActivityLog.api.test.ts (supertest + JWT firmado a mano +
  prismaMock para el permiso), sólo que ahí mockean `activity-log.service` y aquí este.

  Auth: JWT con `venueId` == el de la URL, así `checkPermission` resuelve el rol desde el
  propio token (`source: 'token'`, ver `resolveUserRoleForVenue` en
  `checkPermission.middleware.ts`) sin pegarle a `staffVenue.findUnique`. SÍ pega, siempre,
  a `staffVenue.findFirst` (probe de bypass SUPERADMIN) y a `venueRolePermission.findUnique`
  (overrides custom por rol) — ambos se mockean a `null` en `beforeEach`, igual que el sibling,
  para que la decisión de acceso salga limpiamente de `DEFAULT_PERMISSIONS`.

  Roles usados a propósito (permissions.ts, verificado antes de escribir esto):
    - CASHIER   no tiene NI 'area-tickets:issue' NI 'area-tickets:confirm-external' → 403 base.
    - WAITER    SÍ tiene 'area-tickets:issue' pero NO 'area-tickets:confirm-external' → separa
                de verdad los dos permisos (no basta "algún" permiso).
    - MANAGER   tiene los dos → 200 en las cuatro rutas.
*/

import request from 'supertest'
import jwt from 'jsonwebtoken'
import type { Express } from 'express'
import { prismaMock } from '@tests/__helpers__/setup'
import { mirrorTokenRoleOnStaffVenue } from '@tests/__helpers__/venueRoleMock'

const mockMarkExternalHandoff = jest.fn()
const mockConfirmExternalSettlement = jest.fn()
const mockMarkExternalNotCharged = jest.fn()
const mockListPendingExternalConfirmation = jest.fn()

// Se mockea el servicio COMPLETO: este archivo prueba la puerta HTTP que construye la
// Task 11, no reimplementa las Tasks 6-9. `__esModule: true` porque el service exporta con
// `export async function ...` (ESM interop de ts-jest).
jest.mock('@/services/mobile/areaTicketExternal.mobile.service', () => ({
  __esModule: true,
  markExternalHandoff: (...args: unknown[]) => mockMarkExternalHandoff(...args),
  confirmExternalSettlement: (...args: unknown[]) => mockConfirmExternalSettlement(...args),
  markExternalNotCharged: (...args: unknown[]) => mockMarkExternalNotCharged(...args),
  listPendingExternalConfirmation: (...args: unknown[]) => mockListPendingExternalConfirmation(...args),
}))

let app: Express
const TEST_SECRET = 'test-secret'

const VENUE_ID = 'cltestvenueextsettle00001'
const STAFF_ID = 'cltestuseridextsettle0002'
const ORG_ID = 'cltestorgidextsettle00003'
const TICKET_ID = 'cltestareaticketextset004'

const BASE = `/api/v1/mobile/venues/${VENUE_ID}/area-tickets`
const SETTLEMENT_BASE = `${BASE}/${TICKET_ID}/external-settlement`

beforeAll(async () => {
  const mod = await import('@/app')
  app = mod.default
})

/** Mismo helper que `venueActivityLog.api.test.ts`: JWT shape de AvoqadoJwtPayload. */
const makeToken = (role: string) => {
  // El rol se AUTORIZA contra StaffVenue, no contra el JWT (7bdbac01).
  mirrorTokenRoleOnStaffVenue(role, VENUE_ID)
  return jwt.sign(
    {
      sub: STAFF_ID,
      orgId: ORG_ID,
      venueId: VENUE_ID,
      role,
    },
    process.env.ACCESS_TOKEN_SECRET || TEST_SECRET,
  )
}

const authHeader = (role: string) => ({ Authorization: `Bearer ${makeToken(role)}` })

beforeEach(() => {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

// ---------------------------------------------------------------------------
// POST .../external-settlement/handoff  (permiso: area-tickets:issue)
// ---------------------------------------------------------------------------
describe('POST /mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/handoff', () => {
  const url = `${SETTLEMENT_BASE}/handoff`

  it('403 sin el permiso area-tickets:issue', async () => {
    const res = await request(app).post(url).set(authHeader('CASHIER')).send({ idempotencyKey: 'k' })
    expect(res.status).toBe(403)
    expect(mockMarkExternalHandoff).not.toHaveBeenCalled()
  })

  it('200 con MANAGER, y el envelope es { success, data, error }', async () => {
    mockMarkExternalHandoff.mockResolvedValue({ areaTicketId: TICKET_ID, handoffState: 'HANDED_OFF', alreadyHandedOff: false })

    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, error: null })
    expect(res.body.data.handoffState).toBe('HANDED_OFF')
    expect(mockMarkExternalHandoff).toHaveBeenCalledWith(
      VENUE_ID,
      TICKET_ID,
      expect.objectContaining({ idempotencyKey: 'k', deviceUid: expect.any(String) }),
    )
  })

  it('400 en español sin idempotencyKey', async () => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({})
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/llave de idempotencia/i)
    expect(mockMarkExternalHandoff).not.toHaveBeenCalled()
  })

  it('un rechazo de dominio del servicio (AppError) se traduce al envelope { success:false, data:null, error }', async () => {
    const { default: AppError } = await import('@/errors/AppError')
    mockMarkExternalHandoff.mockRejectedValue(
      new AppError('Este vale todavía no se imprimió; no hay papel que entregar en la caja externa.', 409, true, 'AREA_TICKET_NOT_PRINTED'),
    )

    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k' })

    expect(res.status).toBe(409)
    expect(res.body.success).toBe(false)
    expect(res.body.data).toBeNull()
    expect(res.body.error).toMatchObject({ code: 'AREA_TICKET_NOT_PRINTED', message: expect.stringMatching(/imprimió/i) })
  })
})

// ---------------------------------------------------------------------------
// POST .../external-settlement/confirm  (permiso: area-tickets:confirm-external)
// ---------------------------------------------------------------------------
describe('POST /mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/confirm', () => {
  const url = `${SETTLEMENT_BASE}/confirm`

  it('403 sin el permiso area-tickets:confirm-external', async () => {
    const res = await request(app).post(url).set(authHeader('CASHIER')).send({ idempotencyKey: 'k' })
    expect(res.status).toBe(403)
    expect(mockConfirmExternalSettlement).not.toHaveBeenCalled()
  })

  it('200 con MANAGER, y el envelope es { success, data, error }', async () => {
    mockConfirmExternalSettlement.mockResolvedValue({
      areaTicketId: TICKET_ID,
      status: 'CONFIRMED',
      referenceAmount: '168.00',
      externalAmount: '168.00',
      variance: '0.00',
      alreadyConfirmed: false,
    })

    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k', externalAmount: '168.00' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, error: null })
    expect(res.body.data.status).toBe('CONFIRMED')
    expect(mockConfirmExternalSettlement).toHaveBeenCalledWith(
      VENUE_ID,
      TICKET_ID,
      expect.objectContaining({ idempotencyKey: 'k', externalAmount: '168.00' }),
    )
  })

  it('200 con MANAGER sin externalAmount (asumido, sin verificar importe)', async () => {
    mockConfirmExternalSettlement.mockResolvedValue({
      areaTicketId: TICKET_ID,
      status: 'CONFIRMED',
      referenceAmount: '168.00',
      externalAmount: null,
      variance: null,
      alreadyConfirmed: false,
    })

    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k' })

    expect(res.status).toBe(200)
    expect(res.body.data.externalAmount).toBeNull()
  })

  it('400 en español si externalAmount no es un decimal de dos posiciones ("168.000")', async () => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k', externalAmount: '168.000' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/importe/i)
    expect(mockConfirmExternalSettlement).not.toHaveBeenCalled()
  })

  // Hueco que dejó la revisión de la Task 7: sin este regex, cualquiera de estos tres
  // llega hasta `new Prisma.Decimal(...)` dentro del servicio y revienta con un
  // [DecimalError] crudo → 500 en inglés, en vez de un 400 en español aquí en la puerta.
  it.each(['abc', 'Infinity', '-50.00'])('400 en español si externalAmount es "%s"', async garbage => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k', externalAmount: garbage })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/importe/i)
    expect(mockConfirmExternalSettlement).not.toHaveBeenCalled()
  })

  it('400 en español sin idempotencyKey', async () => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ externalAmount: '168.00' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/llave de idempotencia/i)
    expect(mockConfirmExternalSettlement).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST .../external-settlement/not-charged  (permiso: area-tickets:confirm-external)
// ---------------------------------------------------------------------------
describe('POST /mobile/venues/:venueId/area-tickets/:ticketId/external-settlement/not-charged', () => {
  const url = `${SETTLEMENT_BASE}/not-charged`

  it('403 sin el permiso area-tickets:confirm-external', async () => {
    const res = await request(app).post(url).set(authHeader('CASHIER')).send({ idempotencyKey: 'k', reason: 'Cliente se fue sin pagar' })
    expect(res.status).toBe(403)
    expect(mockMarkExternalNotCharged).not.toHaveBeenCalled()
  })

  it('200 con MANAGER, y el envelope es { success, data, error }', async () => {
    mockMarkExternalNotCharged.mockResolvedValue({ areaTicketId: TICKET_ID, status: 'NOT_CHARGED' })

    const res = await request(app)
      .post(url)
      .set(authHeader('MANAGER'))
      .send({ idempotencyKey: 'k', reason: 'Cliente se fue sin pagar en la otra caja' })

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, error: null })
    expect(res.body.data.status).toBe('NOT_CHARGED')
    expect(mockMarkExternalNotCharged).toHaveBeenCalledWith(
      VENUE_ID,
      TICKET_ID,
      expect.objectContaining({ idempotencyKey: 'k', reason: 'Cliente se fue sin pagar en la otra caja' }),
    )
  })

  it('400 en español sin reason', async () => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/motivo|por qué/i)
    expect(mockMarkExternalNotCharged).not.toHaveBeenCalled()
  })

  it('400 en español con reason vacío', async () => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ idempotencyKey: 'k', reason: '' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/motivo|por qué/i)
    expect(mockMarkExternalNotCharged).not.toHaveBeenCalled()
  })

  it('400 en español sin idempotencyKey', async () => {
    const res = await request(app).post(url).set(authHeader('MANAGER')).send({ reason: 'Cliente se fue sin pagar' })
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/llave de idempotencia/i)
    expect(mockMarkExternalNotCharged).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET .../area-tickets/pending-confirmation  (permiso: area-tickets:issue)
// ---------------------------------------------------------------------------
describe('GET /mobile/venues/:venueId/area-tickets/pending-confirmation', () => {
  const url = `${BASE}/pending-confirmation`

  it('403 sin el permiso area-tickets:issue', async () => {
    const res = await request(app).get(url).set(authHeader('CASHIER'))
    expect(res.status).toBe(403)
    expect(mockListPendingExternalConfirmation).not.toHaveBeenCalled()
  })

  it('200 con MANAGER, y el envelope es { success, data, error }', async () => {
    mockListPendingExternalConfirmation.mockResolvedValue({
      items: [
        {
          id: TICKET_ID,
          code: 'A-001',
          fulfillmentAreaId: 'area1',
          issuedAt: new Date().toISOString(),
          referenceAmount: '168.00',
          handoffState: 'PENDING',
        },
      ],
      nextCursor: null,
    })

    const res = await request(app).get(url).set(authHeader('MANAGER'))

    expect(res.status).toBe(200)
    expect(res.body).toMatchObject({ success: true, error: null })
    expect(Array.isArray(res.body.data.items)).toBe(true)
    expect(res.body.data.nextCursor).toBeNull()
  })

  it('reenvía cursor y limit de la query string al servicio', async () => {
    mockListPendingExternalConfirmation.mockResolvedValue({ items: [], nextCursor: null })

    await request(app).get(`${url}?cursor=abc123&limit=5`).set(authHeader('MANAGER'))

    expect(mockListPendingExternalConfirmation).toHaveBeenCalledWith(VENUE_ID, expect.objectContaining({ cursor: 'abc123', limit: 5 }))
  })

  it('NUNCA lee el área de la query string — el servicio la resuelve de la terminal autenticada', async () => {
    mockListPendingExternalConfirmation.mockResolvedValue({ items: [], nextCursor: null })

    await request(app).get(`${url}?fulfillmentAreaId=otra-area-cualquiera`).set(authHeader('MANAGER'))

    const callArgs = mockListPendingExternalConfirmation.mock.calls[0][1]
    expect(callArgs).not.toHaveProperty('fulfillmentAreaId')
  })
})

// ---------------------------------------------------------------------------
// Separación real de permisos: 'area-tickets:issue' != 'area-tickets:confirm-external'
// WAITER tiene el primero (es trabajo de piso) pero NUNCA el segundo (es una
// afirmación sobre dinero que exige autoridad de gerencia — comentario explícito
// en permissions.ts junto a la entrada de MANAGER).
// ---------------------------------------------------------------------------
describe('separación de permisos entre issue y confirm-external', () => {
  it('WAITER: 200 en handoff (tiene area-tickets:issue)', async () => {
    mockMarkExternalHandoff.mockResolvedValue({ areaTicketId: TICKET_ID, handoffState: 'HANDED_OFF', alreadyHandedOff: false })

    const res = await request(app).post(`${SETTLEMENT_BASE}/handoff`).set(authHeader('WAITER')).send({ idempotencyKey: 'k' })
    expect(res.status).toBe(200)
  })

  it('WAITER: 403 en confirm (NO tiene area-tickets:confirm-external)', async () => {
    const res = await request(app).post(`${SETTLEMENT_BASE}/confirm`).set(authHeader('WAITER')).send({ idempotencyKey: 'k' })
    expect(res.status).toBe(403)
    expect(mockConfirmExternalSettlement).not.toHaveBeenCalled()
  })

  it('WAITER: 403 en not-charged (NO tiene area-tickets:confirm-external)', async () => {
    const res = await request(app)
      .post(`${SETTLEMENT_BASE}/not-charged`)
      .set(authHeader('WAITER'))
      .send({ idempotencyKey: 'k', reason: 'x' })
    expect(res.status).toBe(403)
    expect(mockMarkExternalNotCharged).not.toHaveBeenCalled()
  })

  it('WAITER: 200 en pending-confirmation (tiene area-tickets:issue)', async () => {
    mockListPendingExternalConfirmation.mockResolvedValue({ items: [], nextCursor: null })

    const res = await request(app).get(`${BASE}/pending-confirmation`).set(authHeader('WAITER'))
    expect(res.status).toBe(200)
  })
})
