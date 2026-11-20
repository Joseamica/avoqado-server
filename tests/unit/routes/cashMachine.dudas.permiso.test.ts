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
jest.mock('@/services/cashMachine/dudasDeLaMaquina', () => ({
  ...jest.requireActual('@/services/cashMachine/dudasDeLaMaquina'),
  subirDudaDeLaMaquina: (...a: unknown[]) => mockSubir(...a),
  consultarDudaDeLaMaquina: (...a: unknown[]) => mockConsultar(...a),
  listarDudasDeLaMaquina: (...a: unknown[]) => mockListar(...a),
  resolverDudaDeLaMaquina: (...a: unknown[]) => mockResolver(...a),
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
async function correr(router: any, ruta: string, metodo: Metodo, role: StaffRole, extra: { body?: object; query?: object } = {}) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: metodo.toUpperCase(),
    originalUrl: `/api/v1${ruta.replace(':venueId', VENUE).replace(':referenceCC', REF)}`,
    params: { venueId: VENUE, referenceCC: REF },
    headers: { 'x-device-id': 'uid-pc-1', 'x-device-platform': 'DESKTOP', 'x-cash-machine-credential': 'secreta' },
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
const RESOLVER_BODY = { outcome: 'PAGADO', creditCents: 20000, changeDispensedCents: 1250, evidence: 'Pago Completado $187.50' }

beforeEach(() => {
  jest.clearAllMocks()
  mockSubir.mockResolvedValue({ status: 'ABIERTO', referenceCC: REF })
  mockConsultar.mockResolvedValue({ status: 'ABIERTO', referenceCC: REF })
  mockListar.mockResolvedValue({ data: [], total: 0, nextCursor: null })
  mockResolver.mockResolvedValue({ status: 200, body: { referenceCC: REF, outcome: 'PAGADO', resolvedBy: 'GERENTE' } })
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
    )
  })

  it('un carrito vacío es 400 (la misma lectura que la venta) y no sube nada', async () => {
    const out = await correr(mobileRouter, DUDAS, 'post', StaffRole.CASHIER, { body: { ...DUDA_BODY, pedido: { items: [] } } })
    expect(out.error).toMatchObject({ statusCode: 400 })
    expect(mockSubir).not.toHaveBeenCalled()
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
      { outcome: 'PAGADO', creditCents: 20000, changeDispensedCents: 1250, occurredAt: undefined, evidence: 'Pago Completado $187.50' },
      expect.any(Function),
    )
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
