/**
 * PATCH /mobile/venues/:venueId/terminals/:terminalId/settings — el POS configura SU PROPIA ficha.
 *
 * Por qué existe esta ruta (founder, 2026-09-18): el ajuste «mostrar la pantalla de calificación»
 * ya existía y la app Android ya lo obedecía, pero sólo se podía cambiar desde la pestaña de
 * Configuración del dashboard, que está reservada a las terminales de cobro (`TPV_ANDROID`). Para
 * una tablet `POS_ANDROID` no había NINGUNA forma de apagarlo: la app de iOS incluso decía
 * «configúralo en el dashboard», donde no existía el botón.
 *
 * Lo que se prueba aquí es la mitad que cuesta dinero si sale mal — quién puede escribir qué, en
 * qué aparato:
 *   1. La autorización es la REAL (`checkPermission` NO está simulado): sólo se simula la capa de
 *      datos de membresías. Un 200 exige que el rol de verdad tenga `tpv-settings:update`.
 *   2. Un aparato sólo escribe su PROPIA ficha: el binding es (terminalId + venueId + deviceUid).
 *   3. Un POS no puede escribir un ajuste que no obedece (los de la PAX), ni con permiso de dueño.
 *   4. Toda escritura deja `ActivityLog`.
 */

import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { updateTpvSettings } from '@/services/dashboard/tpv.dashboard.service'

jest.mock('@/services/dashboard/tpv.dashboard.service', () => ({
  ...jest.requireActual('@/services/dashboard/tpv.dashboard.service'),
  updateTpvSettings: jest.fn(),
  getTpvSettings: jest.fn(),
}))

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-test-auth-context']
    const value = Array.isArray(raw) ? raw[0] : raw
    if (!value) {
      res.status(401).json({ message: 'No autorizado' })
      return
    }
    ;(req as any).authContext = JSON.parse(value)
    next()
  },
}))

jest.mock('@/middlewares/validateVenueAccess.middleware', () => ({
  validateVenueAccess: (_req: Request, _res: Response, next: NextFunction) => next(),
  requireVenueMembership: (req: Request, res: Response, next: NextFunction) => {
    const allowed: string[] = (req as any).authContext?.allowedVenueIds ?? []
    if (!allowed.includes(req.params.venueId)) {
      res.status(403).json({ message: 'No tienes acceso a este establecimiento' })
      return
    }
    next()
  },
}))

import mobileRoutes from '@/routes/mobile.routes'

const VENUE_A = 'venue-a'
const VENUE_B = 'venue-b'
const TABLET_UID = 'device-tablet-1'
const OTRA_TABLET_UID = 'device-tablet-2'

const TERMINALS = [
  { id: 'pos-a', venueId: VENUE_A, deviceUid: TABLET_UID, type: 'POS_ANDROID' },
  { id: 'pos-a2', venueId: VENUE_A, deviceUid: OTRA_TABLET_UID, type: 'POS_ANDROID' },
  { id: 'pax-a', venueId: VENUE_A, deviceUid: null, type: 'TPV_ANDROID' },
  { id: 'pos-b', venueId: VENUE_B, deviceUid: TABLET_UID, type: 'POS_ANDROID' },
  // El «etc» que pidió cuidar el founder: un aparato que no es terminal de cobro ni POS.
  { id: 'kds-a', venueId: VENUE_A, deviceUid: 'device-kds-1', type: 'KDS' },
  { id: 'win-a', venueId: VENUE_A, deviceUid: 'device-win-1', type: 'POS_DESKTOP' },
]

const MEMBERSHIPS: Record<string, { role: string; active: boolean }> = {
  [`owner-a:${VENUE_A}`]: { role: 'OWNER', active: true },
  [`cashier-a:${VENUE_A}`]: { role: 'CASHIER', active: true },
  [`owner-a:${VENUE_B}`]: { role: 'OWNER', active: true },
}

const mockedUpdate = updateTpvSettings as jest.MockedFunction<typeof updateTpvSettings>

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/mobile', mobileRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message, code: error.code })
  })
  return app
}

function as(userId: string, role: string, venues: string[] = [VENUE_A]) {
  return {
    'x-test-auth-context': JSON.stringify({ userId, venueId: venues[0], orgId: 'org-a', role, allowedVenueIds: venues }),
  }
}

function patch(venueId: string, terminalId: string, headers: Record<string, string>, body: unknown, deviceUid?: string) {
  const req = request(makeApp()).patch(`/api/v1/mobile/venues/${venueId}/terminals/${terminalId}/settings`).set(headers)
  if (deviceUid) req.set('x-device-id', deviceUid)
  return req.send(body as any)
}

function auditCalls() {
  return (logAction as jest.Mock).mock.calls.filter(([params]) => String(params?.action).startsWith('TPV_SETTINGS_'))
}

beforeEach(() => {
  jest.clearAllMocks()
  mockedUpdate.mockResolvedValue({ showReviewScreen: false, showTipScreen: true } as any)

  // Honra el `where`: si el controlador no acota por venue o por aparato, no encuentra nada.
  prismaMock.terminal.findFirst.mockImplementation((({ where }: any) => {
    const found = TERMINALS.find(
      t =>
        t.id === where?.id &&
        (where?.venueId === undefined || t.venueId === where.venueId) &&
        (where?.deviceUid === undefined || t.deviceUid === where.deviceUid),
    )
    return Promise.resolve(found ?? null)
  }) as any)

  // Capa de datos de la autorización REAL.
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockImplementation((({ where }: any) => {
    const m = MEMBERSHIPS[`${where?.staffId_venueId?.staffId}:${where?.staffId_venueId?.venueId}`]
    return Promise.resolve(m ? { role: m.role, active: m.active, permissionSetId: null, permissionSet: null } : null)
  }) as any)
  prismaMock.venue.findUnique.mockImplementation((({ where }: any) => Promise.resolve({ id: where?.id, organizationId: 'org-a' })) as any)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
})

describe('el dueño apaga la pantalla de calificación desde su propia tablet', () => {
  it('guarda el ajuste en la ficha de ESE aparato y lo devuelve', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { showReviewScreen: false }, TABLET_UID)

    expect(response.status).toBe(200)
    expect(response.body.data.settings).toMatchObject({ showReviewScreen: false })
  })

  /**
   * 🔴 La auditoría la escribe `updateTpvSettings`, NO este controlador — escribir aquí otro
   * renglón dejaba DOS filas por un toque, una de ellas anónima (medido en el QA del 18-sep sobre
   * una Sunmi OrderPAD 3 real; los unitarios no lo veían porque mockean el servicio). Así que lo
   * que hay que garantizar es que el servicio reciba QUIÉN, DESDE DÓNDE y QUÉ APARATO: sin eso su
   * renglón sale sin actor y la bitácora del dueño no sirve para «¿quién apagó la propina?».
   */
  it('le pasa al servicio el actor, el origen y el aparato — de ahí sale la bitácora', async () => {
    await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { showReviewScreen: false }, TABLET_UID)

    expect(mockedUpdate).toHaveBeenCalledWith(
      'pos-a',
      { showReviewScreen: false },
      { venueId: VENUE_A, staffId: 'owner-a', source: 'pos', deviceUid: TABLET_UID },
    )
  })

  it('no escribe un segundo renglón de auditoría por su cuenta', async () => {
    await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { showReviewScreen: false }, TABLET_UID)

    expect(auditCalls()).toHaveLength(0)
  })
})

describe('🔴 quién NO puede', () => {
  it('un cajero recibe 403: configurar no es operar', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('cashier-a', 'CASHIER'), { showReviewScreen: false }, TABLET_UID)

    expect(response.status).toBe(403)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('sin X-Device-ID no se escribe nada: la ficha se identifica por el aparato', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { showReviewScreen: false })

    expect(response.status).toBe(400)
    expect(response.body.code).toBe('DEVICE_ID_REQUIRED')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('una tablet NO puede configurar OTRA tablet del mismo negocio', async () => {
    const response = await patch(VENUE_A, 'pos-a2', as('owner-a', 'OWNER'), { showReviewScreen: false }, TABLET_UID)

    expect(response.status).toBe(404)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('una tablet NO puede configurar la PAX, ni siendo del mismo negocio', async () => {
    const response = await patch(VENUE_A, 'pax-a', as('owner-a', 'OWNER'), { showReviewScreen: false }, TABLET_UID)

    expect(response.status).toBe(404)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('no alcanza a una terminal de OTRO negocio, aunque el aparato tenga el mismo id físico', async () => {
    const response = await patch(VENUE_A, 'pos-b', as('owner-a', 'OWNER', [VENUE_A, VENUE_B]), { showReviewScreen: false }, TABLET_UID)

    expect(response.status).toBe(404)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  // 🔴 Este caso lo rechaza el SCHEMA (`.strict()`), no el guard de aparatos: la llave ni siquiera
  // llega al controlador. Se prueba igual porque es la primera barrera y es la que ve el cliente,
  // pero el guard por tipo de aparato se ejercita en el caso de abajo y en los unitarios del
  // servicio de capacidades. (Descubierto rompiendo el guard a propósito: este test seguía verde.)
  it('una llave que el POS no obedece no pasa ni el schema', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { kioskModeEnabled: true }, TABLET_UID)

    expect(response.status).toBe(400)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it.each([
    ['una pantalla de cocina', 'kds-a', 'device-kds-1'],
    ['un POS de Windows', 'win-a', 'device-win-1'],
  ])('%s no configura NADA, ni un ajuste que una tablet sí puede', async (_label, terminalId, deviceUid) => {
    const response = await patch(VENUE_A, terminalId, as('owner-a', 'OWNER'), { showReviewScreen: false }, deviceUid)

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('SETTING_NOT_SUPPORTED_BY_DEVICE')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('un cuerpo vacío no pasa como éxito silencioso', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), {}, TABLET_UID)

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('NO_SETTINGS_PROVIDED')
    expect(mockedUpdate).not.toHaveBeenCalled()
  })
})

/**
 * Porcentajes de propina sugeridos desde el propio aparato (founder, 2026-09-18: «que en propinas
 * puedas definir qué propinas mostrar»). Mismas reglas que el editor del dashboard —1 a 100, sin
 * repetidos, ordenados, máximo 6— para que un negocio no acabe con dos listas distintas según
 * dónde las editó.
 */
describe('los porcentajes de propina se eligen desde el aparato', () => {
  it('guarda la lista que mandó el POS', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { tipSuggestions: [5, 10, 15] }, TABLET_UID)

    expect(response.status).toBe(200)
    expect(mockedUpdate).toHaveBeenCalledWith('pos-a', { tipSuggestions: [5, 10, 15] }, expect.objectContaining({ source: 'pos' }))
  })

  it.each([
    ['vacía — el cliente se quedaría sin ningún botón de propina', []],
    ['con un 0', [0, 10, 15]],
    ['por encima de 100', [10, 150]],
    ['con decimales', [10.5, 15]],
    ['con repetidos', [10, 10, 15]],
    ['de más de seis', [5, 10, 15, 20, 25, 30, 35]],
  ])('rechaza una lista %s', async (_caso, lista) => {
    const response = await patch(VENUE_A, 'pos-a', as('owner-a', 'OWNER'), { tipSuggestions: lista }, TABLET_UID)

    expect(response.status).toBe(400)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('un cajero tampoco puede cambiarlos', async () => {
    const response = await patch(VENUE_A, 'pos-a', as('cashier-a', 'CASHIER'), { tipSuggestions: [5, 10] }, TABLET_UID)

    expect(response.status).toBe(403)
    expect(mockedUpdate).not.toHaveBeenCalled()
  })

  it('una pantalla de cocina no configura porcentajes de propina', async () => {
    const response = await patch(VENUE_A, 'kds-a', as('owner-a', 'OWNER'), { tipSuggestions: [5, 10] }, 'device-kds-1')

    expect(response.status).toBe(422)
    expect(response.body.code).toBe('SETTING_NOT_SUPPORTED_BY_DEVICE')
  })
})
