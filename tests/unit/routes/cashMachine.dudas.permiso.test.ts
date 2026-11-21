/**
 * Máquina de efectivo 1a · «Cobros en duda» (R4-4): la cadena REAL de cada ruta con los permisos de fábrica (sólo la base va simulada).
 *  · subir la duda → `payments:create` (la PC; la puerta del emparejamiento la prueba el servicio).
 *  · consultarla → `payments:read` (la PC pregunta cada 60 s).
 *  · listar y resolver → `cash-machine:resolve`, en /mobile (POS del mostrador) y en /dashboard. El cajero no; el gerente sí, y el
 *    gerente sale de la SESIÓN aunque el cuerpo traiga otro.
 * Molde: `mobile.cashMachine.permiso.test.ts`.
 */
const mockStaffVenueFindUnique = jest.fn()
const mockSubir = jest.fn()
const mockConsultar = jest.fn()
const mockListar = jest.fn()
const mockResolver = jest.fn()
const mockRevisar = jest.fn()
const mockConsumeOverride = jest.fn()

jest.mock('@/utils/prismaClient', () => ({
  __esModule: true,
  default: {
    staff: { findUnique: async () => ({ active: true }) },
    staffVenue: { findFirst: async () => null, findUnique: (...a: unknown[]) => mockStaffVenueFindUnique(...a) },
    venue: { findUnique: async () => null },
    staffOrganization: { findUnique: async () => null, findFirst: async () => null },
    venueRolePermission: { findUnique: async () => null },
  },
}))
jest.mock('@/services/dashboard/activity-log.service', () => ({
  ...jest.requireActual('@/services/dashboard/activity-log.service'),
  logAction: jest.fn(),
}))
jest.mock('@/services/mobile/permission-override.mobile.service', () => ({
  ...jest.requireActual('@/services/mobile/permission-override.mobile.service'),
  isManagerPinOverrideEnabled: async () => true,
  consumePermissionOverride: (...a: unknown[]) => mockConsumeOverride(...a),
}))
jest.mock('@/services/cashMachine/dudasDeLaMaquina', () => ({
  ...jest.requireActual('@/services/cashMachine/dudasDeLaMaquina'),
  subirDudaDeLaMaquina: (...a: unknown[]) => mockSubir(...a),
  consultarDudaDeLaMaquina: (...a: unknown[]) => mockConsultar(...a),
  listarDudasDeLaMaquina: (...a: unknown[]) => mockListar(...a),
  resolverDudaDeLaMaquina: (...a: unknown[]) => mockResolver(...a),
  revisarIncidenciaDeLaMaquina: (...a: unknown[]) => mockRevisar(...a),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'
import dashboardRouter from '@/routes/dashboard.routes'

const VENUE = 'cjld2cjxh0000qzrmn831i7rn'
const REF = 'AQ0123456789AB'
type Metodo = 'get' | 'post'

const cadena = (router: any, ruta: string, metodo: Metodo) => {
  const capa = router.stack.find((l: any) => l.route?.path === ruta && l.route.methods[metodo])
  return capa.route.stack.map((rl: any) => rl.handle) as any[]
}
const permisosDe = (router: any, ruta: string, metodo: Metodo) =>
  cadena(router, ruta, metodo)
    .filter(x => typeof x.requiredPermission === 'string')
    .map(x => x.requiredPermission)

/** Corre la cadena después de `authenticateTokenMiddleware` (el JWT ya está en authContext), controlador incluido. */
async function correr(
  router: any,
  ruta: string,
  metodo: Metodo,
  role: StaffRole,
  extra: { body?: object; query?: object; headers?: Record<string, string> } = {},
) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: metodo.toUpperCase(),
    originalUrl: `/api/v1${ruta.replace(':venueId', VENUE).replace(':referenceCC', REF)}`,
    params: { venueId: VENUE, referenceCC: REF, incidentId: INCIDENCIA },
    headers: { 'x-device-id': 'uid-pc-1', 'x-device-platform': 'DESKTOP', 'x-cash-machine-credential': 'secreta', ...extra.headers },
    body: extra.body ?? {},
    query: extra.query ?? {},
    authContext: { userId: 'u-sesion', venueId: VENUE, role },
  }
  const out: { status?: number; json?: any; error?: any } = {}
  const res: any = {
    set: () => res,
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  for (const h of cadena(router, ruta, metodo).slice(1)) {
    let avanzo = false
    await h(req, res, (err?: unknown) => {
      if (err) out.error = err
      else avanzo = true
    })
    if (!avanzo) break
  }
  return out
}

const DUDAS = '/venues/:venueId/cash-machine/doubts'
const DUDA = '/venues/:venueId/cash-machine/doubts/:referenceCC'
const RESOLVER = '/venues/:venueId/cash-machine/doubts/:referenceCC/resolve'
const REVISAR = '/venues/:venueId/cash-machine/incidents/:incidentId/review'
const INCIDENCIA = 'cjld2cjxh0000qzrmn831i7rx'
const CARRITO = { items: [{ name: 'Pastel', quantity: 1, unitPrice: 187.5 }], orderType: 'TAKEOUT', source: 'AVOQADO_ANDROID' }
const DUDA_BODY = {
  referenceCC: REF,
  dueCents: 18750,
  saleCents: 18750,
  tipCents: 0,
  pedido: CARRITO,
  startedAt: '2026-11-20T17:58:00.000Z',
  lastSeen: [{ event: 'updateCredit' }],
}
const RESOLVER_BODY = { outcome: 'PAGADO', creditCents: 20000, changeDispensedCents: 1250, evidence: 'Pago Completado $187.50', version: 3 }

beforeEach(() => {
  jest.clearAllMocks()
  mockSubir.mockResolvedValue({ status: 'ABIERTO', referenceCC: REF })
  mockConsultar.mockResolvedValue({ status: 'ABIERTO', referenceCC: REF })
  mockListar.mockResolvedValue({ data: [], total: 0, nextCursor: null })
  mockResolver.mockResolvedValue({ status: 200, body: { referenceCC: REF, outcome: 'PAGADO', resolvedBy: 'GERENTE' } })
  mockRevisar.mockResolvedValue({ id: INCIDENCIA, referenceCC: REF, kind: 'IMPOSIBLE', status: 'RESUELTO' })
  mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
})

describe('permisos de cada ruta', () => {
  it('subir → payments:create; consultar → payments:read; listar y resolver → cash-machine:resolve (también en el panel)', () => {
    expect(permisosDe(mobileRouter, DUDAS, 'post')).toEqual(['payments:create'])
    expect(permisosDe(mobileRouter, DUDA, 'get')).toEqual(['payments:read'])
    expect(permisosDe(mobileRouter, DUDAS, 'get')).toEqual(['cash-machine:resolve'])
    expect(permisosDe(mobileRouter, RESOLVER, 'post')).toEqual(['cash-machine:resolve'])
    expect(permisosDe(dashboardRouter, DUDAS, 'get')).toEqual(['cash-machine:resolve'])
    expect(permisosDe(dashboardRouter, RESOLVER, 'post')).toEqual(['cash-machine:resolve'])
  })
})

describe('subir y consultar la duda (la PC)', () => {
  it('la cajera de la PC sube la duda con su sesión, su aparato y su credencial', async () => {
    const out = await correr(mobileRouter, DUDAS, 'post', StaffRole.CASHIER, { body: DUDA_BODY })
    expect(out).toMatchObject({ status: 200, json: { success: true, status: 'ABIERTO', referenceCC: REF } })
    expect(mockSubir).toHaveBeenCalledWith(
      VENUE,
      { userId: 'u-sesion', deviceUid: 'uid-pc-1', credencial: 'secreta' },
      expect.objectContaining({ referenceCC: REF, dueCents: 18750, pedido: CARRITO }),
      expect.any(Function),
    )
  })

  it('🔴 r6-2: un carrito vacío NO es 400: la duda sube igual (nunca se vuelve desenlace por eso)', async () => {
    const out = await correr(mobileRouter, DUDAS, 'post', StaffRole.CASHIER, { body: { ...DUDA_BODY, pedido: { items: [] } } })
    expect(out.status).toBe(200)
    expect(mockSubir).toHaveBeenCalledWith(
      VENUE,
      expect.anything(),
      expect.objectContaining({ pedido: { items: [] } }),
      expect.any(Function),
    )
  })

  it('centavos con decimales son 400 en español', async () => {
    const out = await correr(mobileRouter, DUDAS, 'post', StaffRole.CASHIER, { body: { ...DUDA_BODY, dueCents: 187.5 } })
    expect(out.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('entero de centavos') })
  })

  it('🔴 un rol sin payments:create (cocina) recibe 403 y no sube nada', async () => {
    const out = await correr(mobileRouter, DUDAS, 'post', StaffRole.KITCHEN, { body: DUDA_BODY })
    expect(out.status).toBe(403)
    expect(mockSubir).not.toHaveBeenCalled()
  })

  it('la PC consulta su duda', async () => {
    const out = await correr(mobileRouter, DUDA, 'get', StaffRole.CASHIER)
    expect(out).toMatchObject({ status: 200, json: { success: true, status: 'ABIERTO' } })
    expect(mockConsultar).toHaveBeenCalledWith(VENUE, REF)
  })
})

describe.each([
  ['POS del mostrador (/mobile)', mobileRouter],
  ['DASHBOARD', dashboardRouter],
])('listar y resolver · %s', (_n, router) => {
  it('🔴 el cajero recibe 403 y no lista ni resuelve', async () => {
    expect((await correr(router, DUDAS, 'get', StaffRole.CASHIER)).status).toBe(403)
    expect((await correr(router, RESOLVER, 'post', StaffRole.CASHIER, { body: RESOLVER_BODY })).status).toBe(403)
    expect(mockListar).not.toHaveBeenCalled()
    expect(mockResolver).not.toHaveBeenCalled()
  })

  it('el gerente lista con el límite que pidió (el servicio lo recorta) y el estado', async () => {
    const out = await correr(router, DUDAS, 'get', StaffRole.MANAGER, { query: { limit: '500', status: 'ABIERTO' } })
    expect(out).toMatchObject({ status: 200, json: { success: true, data: [], total: 0, nextCursor: null } })
    expect(mockListar).toHaveBeenCalledWith(VENUE, { status: 'ABIERTO', cursor: undefined, limit: 500 })
  })

  it('🔴 el gerente resuelve: el gerente es el de la SESIÓN aunque el cuerpo traiga otro', async () => {
    const out = await correr(router, RESOLVER, 'post', StaffRole.MANAGER, {
      body: { ...RESOLVER_BODY, resolvedByStaffId: 'otro-gerente', staffId: 'otro' },
    })
    expect(out).toMatchObject({ status: 200, json: { success: true, resolvedBy: 'GERENTE' } })
    expect(mockResolver).toHaveBeenCalledWith(
      VENUE,
      'u-sesion',
      REF,
      {
        outcome: 'PAGADO',
        creditCents: 20000,
        changeDispensedCents: 1250,
        occurredAt: undefined,
        evidence: 'Pago Completado $187.50',
        version: 3,
      },
      expect.any(Function),
    )
  })

  it('🔴 r6-4: sin la versión que vio, 400 en español (no se resuelve a ciegas)', async () => {
    const sinVersion: Partial<typeof RESOLVER_BODY> = { ...RESOLVER_BODY }
    delete sinVersion.version
    const out = await correr(router, RESOLVER, 'post', StaffRole.MANAGER, { body: sinVersion })
    expect(out.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('versión') })
    expect(mockResolver).not.toHaveBeenCalled()
  })

  it('el 202 de una venta que ya no se arma sale tal cual', async () => {
    mockResolver.mockResolvedValue({ status: 202, body: { referenceCC: REF, incident: 'NO_SE_PUDO_REGISTRAR' } })
    const out = await correr(router, RESOLVER, 'post', StaffRole.MANAGER, { body: RESOLVER_BODY })
    expect(out).toMatchObject({ status: 202, json: { success: true, incident: 'NO_SE_PUDO_REGISTRAR' } })
  })

  it('sin lo que vio en la máquina es 400 en español', async () => {
    const out = await correr(router, RESOLVER, 'post', StaffRole.MANAGER, { body: { ...RESOLVER_BODY, evidence: '  ' } })
    expect(out.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('Escribe lo que viste') })
    expect(mockResolver).not.toHaveBeenCalled()
  })
})

describe('Codex r1 #8 (decisión b): cash-machine:resolve sólo con la sesión del gerente', () => {
  it.each([
    ['POS', () => mobileRouter],
    ['panel', () => dashboardRouter],
  ])('🔴 %s · la cajera con un PIN de gerente válido NO resuelve: 403, el PIN no se gasta y el 403 no ofrece PIN', async (_n, router) => {
    const out = await correr(router(), RESOLVER, 'post', StaffRole.CASHIER, {
      body: RESOLVER_BODY,
      headers: { 'x-permission-override': 'pin-ok' },
    })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'cash-machine:resolve' })
    expect(out.json.overridable).toBeUndefined()
    expect(mockConsumeOverride).not.toHaveBeenCalled()
    expect(mockResolver).not.toHaveBeenCalled()
  })

  it('🔴 tampoco lista ni revisa con el PIN', async () => {
    const lista = await correr(mobileRouter, DUDAS, 'get', StaffRole.CASHIER, { headers: { 'x-permission-override': 'pin-ok' } })
    expect(lista.status).toBe(403)
    const revisa = await correr(mobileRouter, REVISAR, 'post', StaffRole.CASHIER, {
      body: { note: 'x', version: 1 },
      headers: { 'x-permission-override': 'pin-ok' },
    })
    expect(revisa.status).toBe(403)
    expect(mockConsumeOverride).not.toHaveBeenCalled()
  })
})

describe('Codex r1 #7: revisar una incidencia que no es duda', () => {
  it('pide cash-machine:resolve en el POS y en el panel', () => {
    expect(permisosDe(mobileRouter, REVISAR, 'post')).toEqual(['cash-machine:resolve'])
    expect(permisosDe(dashboardRouter, REVISAR, 'post')).toEqual(['cash-machine:resolve'])
  })

  it('🔴 el gerente la revisa con SU sesión y su nota', async () => {
    const out = await correr(dashboardRouter, REVISAR, 'post', StaffRole.MANAGER, {
      body: { note: '  La máquina devolvió todo  ', version: 2 },
    })
    expect(out).toMatchObject({ status: 200, json: { success: true, status: 'RESUELTO', kind: 'IMPOSIBLE' } })
    // Codex r2 #8: con la versión de la evidencia que vio.
    expect(mockRevisar).toHaveBeenCalledWith(VENUE, 'u-sesion', INCIDENCIA, 'La máquina devolvió todo', 2)
  })

  it('🔴 Codex r2 #8: sin la versión que vio, 400 en español (no se revisa a ciegas)', async () => {
    const out = await correr(mobileRouter, REVISAR, 'post', StaffRole.MANAGER, { body: { note: 'x' } })
    expect(out.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('versión') })
    expect(mockRevisar).not.toHaveBeenCalled()
  })

  it('sin nota es 400 en español', async () => {
    const out = await correr(mobileRouter, REVISAR, 'post', StaffRole.MANAGER, { body: {} })
    expect(out.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('Escribe qué revisaste') })
    expect(mockRevisar).not.toHaveBeenCalled()
  })

  it('la lista filtra por tipo y folio (lo valida el esquema)', async () => {
    const out = await correr(mobileRouter, DUDAS, 'get', StaffRole.MANAGER, { query: { kind: 'IMPOSIBLE', folio: 'AQ01' } })
    expect(out.status).toBe(200)
    expect(mockListar).toHaveBeenCalledWith(VENUE, expect.objectContaining({ kind: 'IMPOSIBLE', folio: 'AQ01' }))
  })
})
