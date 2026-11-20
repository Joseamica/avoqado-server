/**
 * Máquina de efectivo 1a: la cadena REAL de cada ruta nueva con los permisos de fábrica (sólo la base va simulada).
 *  · emparejar / desemparejar la PC → `cash-machine:configure` (R5#10): el cajero no, el gerente sí.
 *  · cotizar → `payments:create` (R4-2), con los mismos guardias de cortesía y aprobación que `POST /orders`.
 * Molde: `mobile.cashDrawerPayOut.permiso.test.ts`.
 */
const mockStaffVenueFindUnique = jest.fn()
const mockEmparejar = jest.fn()
const mockDesemparejar = jest.fn()
const mockCotizar = jest.fn()
const mockConsumeOverride = jest.fn()
const mockTurnoDelNegocio = jest.fn()
let pinPrendido = false

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
  isManagerPinOverrideEnabled: async () => pinPrendido,
  consumePermissionOverride: (...a: unknown[]) => mockConsumeOverride(...a),
}))
jest.mock('@/services/shared/turnoDeCaja', () => ({
  ...jest.requireActual('@/services/shared/turnoDeCaja'),
  turnoDelNegocioAhora: (...a: unknown[]) => mockTurnoDelNegocio(...a),
}))
jest.mock('@/services/cashMachine/emparejamiento', () => ({
  ...jest.requireActual('@/services/cashMachine/emparejamiento'),
  emparejarAparato: (...a: unknown[]) => mockEmparejar(...a),
  desemparejarAparato: (...a: unknown[]) => mockDesemparejar(...a),
}))
jest.mock('@/services/cashMachine/cotizacionDeLaMaquina', () => ({
  ...jest.requireActual('@/services/cashMachine/cotizacionDeLaMaquina'),
  cotizarParaLaMaquina: (...a: unknown[]) => mockCotizar(...a),
}))
jest.mock('@/config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}))

import { StaffRole } from '@prisma/client'
import mobileRouter from '@/routes/mobile.routes'

const VENUE = 'cjld2cjxh0000qzrmn831i7rn'

const cadena = (ruta: string, metodo: 'post' | 'delete' | 'get') => {
  const capa = (mobileRouter as any).stack.find((l: any) => l.route?.path === ruta && l.route.methods[metodo])
  return capa.route.stack.map((rl: any) => rl.handle) as any[]
}

/** Corre la cadena después de `authenticateTokenMiddleware` (el JWT ya está en authContext), controlador incluido. */
async function correr(
  ruta: string,
  metodo: 'post' | 'delete' | 'get',
  role: StaffRole,
  body: object = {},
  encabezados: Record<string, string> = {},
) {
  mockStaffVenueFindUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  const req: any = {
    method: metodo.toUpperCase(),
    originalUrl: `/api/v1/mobile${ruta.replace(':venueId', VENUE)}`,
    params: { venueId: VENUE },
    headers: { 'x-device-id': 'uid-pc-1', 'x-device-platform': 'DESKTOP', 'x-cash-machine-credential': 'secreta', ...encabezados },
    body,
    query: {},
    authContext: { userId: 'u1', venueId: VENUE, role },
  }
  const out: { status?: number; json?: any; error?: any } = {}
  const res: any = {
    set: () => res,
    status: (s: number) => ((out.status = s), res),
    json: (j: unknown) => ((out.json = j), res),
  }
  for (const h of cadena(ruta, metodo).slice(1)) {
    let avanzo = false
    await h(req, res, (err?: unknown) => {
      if (err) out.error = err
      else avanzo = true
    })
    if (!avanzo) break
  }
  return out
}

const BINDING = '/venues/:venueId/cash-machine/binding'
const QUOTE = '/venues/:venueId/cash-machine/quote'
const permisosDe = (ruta: string, metodo: 'post' | 'delete' | 'get') =>
  cadena(ruta, metodo)
    .filter(x => typeof x.requiredPermission === 'string')
    .map(x => x.requiredPermission)

beforeEach(() => {
  jest.clearAllMocks()
  pinPrendido = false
  mockConsumeOverride.mockResolvedValue({ authorizedById: 'sv-gerente' })
  mockEmparejar.mockResolvedValue({ bindingId: 'b1', credential: 'c'.repeat(43) })
  mockDesemparejar.mockResolvedValue({ revoked: true })
  mockCotizar.mockResolvedValue({ quoteId: 'q', totalCents: 4100, cobrableEnMaquina: true })
})

describe('emparejar la PC (cash-machine:configure)', () => {
  it('las dos rutas piden cash-machine:configure', () => {
    expect(permisosDe(BINDING, 'post')).toEqual(['cash-machine:configure'])
    expect(permisosDe(BINDING, 'delete')).toEqual(['cash-machine:configure'])
  })

  it('🔴 el cajero recibe 403 y no empareja ni desempareja nada', async () => {
    const post = await correr(BINDING, 'post', StaffRole.CASHIER, { machineIp: '192.168.1.50' })
    expect(post.status).toBe(403)
    expect(post.json).toMatchObject({ required: 'cash-machine:configure' })
    const del = await correr(BINDING, 'delete', StaffRole.CASHIER)
    expect(del.status).toBe(403)
    expect(mockEmparejar).not.toHaveBeenCalled()
    expect(mockDesemparejar).not.toHaveBeenCalled()
  })

  it('el gerente empareja ESTA PC (la del encabezado) y recibe la credencial con 201', async () => {
    const out = await correr(BINDING, 'post', StaffRole.MANAGER, { machineIp: ' 192.168.1.50 ' })
    expect(out.status).toBe(201)
    expect(out.json).toEqual({ success: true, bindingId: 'b1', credential: 'c'.repeat(43) })
    expect(mockEmparejar).toHaveBeenCalledWith(VENUE, { userId: 'u1', deviceUid: 'uid-pc-1' }, '192.168.1.50')
  })

  it('una IP que no es IPv4 es 400 en español antes de pedir permiso', async () => {
    const out = await correr(BINDING, 'post', StaffRole.MANAGER, { machineIp: 'maquina.local' })
    expect(out.error).toMatchObject({ statusCode: 400, message: expect.stringContaining('IPv4') })
    expect(mockEmparejar).not.toHaveBeenCalled()
  })

  it('el gerente desempareja la PC', async () => {
    const out = await correr(BINDING, 'delete', StaffRole.MANAGER)
    expect(out).toMatchObject({ status: 200, json: { success: true, revoked: true } })
  })
})

describe('cotizar (payments:create)', () => {
  it('pide payments:create', () => {
    expect(permisosDe(QUOTE, 'post')).toEqual(['payments:create'])
  })

  it('🔴 un rol sin payments:create (cocina) recibe 403 y no cotiza', async () => {
    const out = await correr(QUOTE, 'post', StaffRole.KITCHEN, { items: [{ productId: 'p1', quantity: 1 }] })
    expect(out.status).toBe(403)
    expect(mockCotizar).not.toHaveBeenCalled()
  })

  it('el cajero cotiza EN LÍNEA aunque el cuerpo diga que es de la cola; un premio pendiente se avisa', async () => {
    // Codex r2 #11: también sin `stampRewardAware` (una caja vieja): el lector del carrito de la máquina conserva el premio.
    for (const cuerpo of [
      { items: [{ productId: 'p1', quantity: 1 }], isOfflineReplay: true, stampRewardId: 'premio-1', stampRewardAware: true },
      { items: [{ productId: 'p1', quantity: 1 }], isOfflineReplay: true, stampRewardId: 'premio-1' },
    ]) {
      mockCotizar.mockClear()
      const out = await correr(QUOTE, 'post', StaffRole.CASHIER, cuerpo)
      expect(out).toMatchObject({ status: 200, json: { success: true, quoteId: 'q', totalCents: 4100 } })
      expect(mockCotizar).toHaveBeenCalledWith(
        VENUE,
        expect.objectContaining({ isOfflineReplay: false, staffId: 'u1', stampRewardId: 'premio-1' }),
        { carrito: cuerpo },
      )
    }
  })

  it('un carrito vacío es 400 (la misma lectura que POST /orders)', async () => {
    const out = await correr(QUOTE, 'post', StaffRole.CASHIER, { items: [] })
    expect(out.error).toMatchObject({ statusCode: 400 })
    expect(mockCotizar).not.toHaveBeenCalled()
  })
})

describe('Codex r1 #8 (decisión b): cash-machine:configure sólo con la sesión, nunca con el PIN del gerente', () => {
  it('🔴 la cajera con un PIN de gerente válido NO empareja: 403, el PIN no se gasta y el 403 no ofrece PIN', async () => {
    pinPrendido = true
    const out = await correr(BINDING, 'post', StaffRole.CASHIER, { machineIp: '192.168.1.50' }, { 'x-permission-override': 'pin-ok' })
    expect(out.status).toBe(403)
    expect(out.json).toMatchObject({ required: 'cash-machine:configure' })
    expect(out.json.overridable).toBeUndefined()
    expect(mockConsumeOverride).not.toHaveBeenCalled()
    expect(mockEmparejar).not.toHaveBeenCalled()
    const del = await correr(BINDING, 'delete', StaffRole.CASHIER, {}, { 'x-permission-override': 'pin-ok' })
    expect(del.status).toBe(403)
    expect(mockDesemparejar).not.toHaveBeenCalled()
  })

  it('el PIN de gerente sigue sirviendo en las demás rutas (cobrar): no se tocó el override general', async () => {
    pinPrendido = true
    const out = await correr(
      QUOTE,
      'post',
      StaffRole.KITCHEN,
      { items: [{ productId: 'p1', quantity: 1 }] },
      { 'x-permission-override': 'pin-ok' },
    )
    expect(mockConsumeOverride).toHaveBeenCalledWith(expect.objectContaining({ permission: 'payments:create' }))
    expect(out.status).toBe(200)
  })
})

describe('Codex r1 #9 (decisión a): cotizar un carrito con descuento contesta DESCUENTO sin pedir permisos', () => {
  it('🔴 la cajera sin permiso de cortesía cotiza una cortesía: 200 (DESCUENTO lo decide el servicio), sin 403 ni PIN', async () => {
    const out = await correr(QUOTE, 'post', StaffRole.CASHIER, {
      items: [{ productId: 'p1', quantity: 1, isCortesia: true, cortesiaReason: 'cliente frecuente' }],
    })
    expect(out.status).toBe(200)
    expect(mockCotizar).toHaveBeenCalled()
  })
})

describe('Codex r1 #13: GET shifts/business-current (el turno del negocio para la PC sin gaveta)', () => {
  const TURNO = '/venues/:venueId/shifts/business-current'

  it('pide shifts:read, el permiso de lectura más chico que tiene quien cobra', () => {
    expect(permisosDe(TURNO, 'get')).toEqual(['shifts:read'])
  })

  it('🔴 la cajera de la PC lo lee: { shiftId, startTime }', async () => {
    const inicio = new Date('2026-11-20T14:00:00.000Z')
    mockTurnoDelNegocio.mockResolvedValue({ shiftId: 'shift-A', startTime: inicio })
    const out = await correr(TURNO, 'get', StaffRole.CASHIER)
    expect(out).toMatchObject({ status: 200, json: { shiftId: 'shift-A', startTime: inicio } })
    expect(mockTurnoDelNegocio).toHaveBeenCalledWith(VENUE)
  })

  it('sin turno abierto: null', async () => {
    mockTurnoDelNegocio.mockResolvedValue(null)
    const out = await correr(TURNO, 'get', StaffRole.CASHIER)
    expect(out).toMatchObject({ status: 200, json: null })
  })

  it('un rol sin shifts:read (cocina) recibe 403', async () => {
    const out = await correr(TURNO, 'get', StaffRole.KITCHEN)
    expect(out.status).toBe(403)
    expect(mockTurnoDelNegocio).not.toHaveBeenCalled()
  })
})
