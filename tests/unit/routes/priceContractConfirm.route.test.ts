/**
 * POST /api/v1/dashboard/venues/:venueId/orders/:orderId/price-contract/confirm — confirmar que una venta VIEJA se
 * cobró con el IVA incluido (IVA por producto, B3b, Tarea 2).
 *
 * Confirmar exige `cfdi:configure`, el MISMO permiso que el MCP `confirm_order_price_contract`. De fábrica lo tienen
 * OWNER y ADMIN; MANAGER factura (`cfdi:issue`) pero no confirma. 🔴 Y se respeta el modelo de permisos del sistema
 * (`permissions-policy.md`): si el dueño le da `cfdi:configure` a un rol a propósito, ese rol confirma — no hay un candado
 * por rol escondido. El código del encargado (`x-permission-override`) sólo pasa si quien lo autorizó tiene el permiso.
 *
 * Monta el router REAL de Express con `validateRequest` y `checkPermission` REALES; sólo la autenticación, el gate de
 * plan (`checkFeatureAccess`) y el controlador van simulados — el controlador tiene sus propias pruebas.
 */
import express, { type NextFunction, type Request, type Response } from 'express'
import request from 'supertest'

import { prismaMock } from '@tests/__helpers__/setup'

const mockConfirmController = jest.fn((_req: Request, res: Response) => {
  res.status(200).json({ ok: true })
})

jest.mock('@/middlewares/authenticateToken.middleware', () => ({
  authenticateTokenMiddleware: (req: Request, _res: Response, next: NextFunction) => {
    ;(req as any).authContext = { userId: 'staff-1', venueId: 'venue-1', orgId: 'org-1', role: req.headers['x-test-role'] }
    next()
  },
}))

jest.mock('@/middlewares/checkFeatureAccess.middleware', () => ({
  ...jest.requireActual('@/middlewares/checkFeatureAccess.middleware'),
  checkFeatureAccess: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}))

jest.mock('@/controllers/dashboard/cfdi.dashboard.controller', () => ({
  ...jest.requireActual('@/controllers/dashboard/cfdi.dashboard.controller'),
  confirmOrderPriceContractController: (req: Request, res: Response) => mockConfirmController(req, res),
}))

import dashboardRoutes from '@/routes/dashboard.routes'
import { createPermissionOverride, OverrideInsufficientError } from '@/services/mobile/permission-override.mobile.service'
import { huellaContrato } from '@/services/fiscal/confirmarContratoDePrecio.service'

const URL = '/api/v1/dashboard/venues/venue-1/orders/o1/price-contract/confirm'
const CUERPO = { version: 7, huella: 'h-7' }

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api/v1/dashboard', dashboardRoutes)
  app.use((error: any, _req: Request, res: Response, _next: NextFunction) => {
    res.status(error.statusCode ?? 500).json({ message: error.message })
  })
  return app
}

/**
 * Lo que `checkPermission` lee de la base: la persona activa, su rol en la sucursal y, si los hay, los permisos
 * personalizados que el dueño le dio a ese rol. Sin superadmin.
 */
function enLaBase(role: string, permisosPersonalizados: string[] | null = null, permisosQuitados: string[] = []) {
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staff.findUnique.mockResolvedValue({ active: true })
  prismaMock.staffVenue.findUnique.mockResolvedValue({ role, active: true, permissionSetId: null, permissionSet: null })
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(
    permisosPersonalizados || permisosQuitados.length > 0
      ? { permissions: permisosPersonalizados ?? [], deniedPermissions: permisosQuitados }
      : null,
  )
}

/** Tokens del PIN del encargado, como los guarda `createPermissionOverride`: uno por permiso, de un solo uso. */
const tokens = new Map<string, { venueId: string; permission: string; authorizedById: string; consumedAt: Date | null }>()

beforeEach(() => {
  mockConfirmController.mockClear()
  tokens.clear()
  prismaMock.venueSettings.findUnique.mockResolvedValue({ managerPinOverrideEnabled: true })
  // Lo que `createPermissionOverride` guarda queda disponible para que `checkPermission` lo consuma, como en la base.
  prismaMock.permissionOverride.create.mockImplementation(async ({ data }: any) => {
    tokens.set(data.token, { venueId: data.venueId, permission: data.permission, authorizedById: data.authorizedById, consumedAt: null })
    return data
  })
  prismaMock.permissionOverride.updateMany.mockImplementation(async ({ where }: any) => {
    const t = tokens.get(where.token)
    if (!t || t.venueId !== where.venueId || t.permission !== where.permission || t.consumedAt) return { count: 0 }
    t.consumedAt = new Date()
    return { count: 1 }
  })
  prismaMock.permissionOverride.findUnique.mockImplementation(async ({ where }: any) => {
    const t = tokens.get(where.token)
    return t ? { authorizedById: t.authorizedById } : null
  })
})

describe('POST …/orders/:orderId/price-contract/confirm — quién puede confirmar', () => {
  it('🔴 MANAGER de fábrica (factura, no confirma) ⇒ 403 y el controlador nunca se llama', async () => {
    enLaBase('MANAGER')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'MANAGER').send(CUERPO)
    expect(res.status).toBe(403)
    expect(res.body).toMatchObject({ required: 'cfdi:configure' })
    expect(mockConfirmController).not.toHaveBeenCalled()
  })

  it('OWNER ⇒ llega al controlador', async () => {
    enLaBase('OWNER')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'OWNER').send(CUERPO)
    expect(res.status).toBe(200)
    expect(mockConfirmController).toHaveBeenCalledTimes(1)
  })

  it('ADMIN ⇒ llega al controlador', async () => {
    enLaBase('ADMIN')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'ADMIN').send(CUERPO)
    expect(res.status).toBe(200)
    expect(mockConfirmController).toHaveBeenCalledTimes(1)
  })

  it.each([['cfdi:configure'], ['cfdi:*']])(
    'MANAGER al que el dueño le dio %s (permiso personalizado) ⇒ llega al controlador: es el modelo de permisos',
    async permiso => {
      enLaBase('MANAGER', [permiso])
      const res = await request(makeApp()).post(URL).set('x-test-role', 'MANAGER').send(CUERPO)
      expect(res.status).toBe(200)
      expect(mockConfirmController).toHaveBeenCalledTimes(1)
    },
  )

  it('🔴 el PIN de un encargado SIN cfdi:configure no salta el permiso ⇒ 403', async () => {
    // El encargado es un MANAGER de fábrica. Su PIN no puede emitir un token de `cfdi:configure`: se rechaza al pedirlo…
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({
      id: 'sv-gerente',
      role: 'MANAGER',
      permissionSetId: null,
      permissionSet: null,
      staff: { firstName: 'Ge', lastName: 'Rente' },
    })
    prismaMock.venueRolePermission.findUnique.mockResolvedValueOnce(null)
    await expect(createPermissionOverride({ venueId: 'venue-1', pin: '1234', permission: 'cfdi:configure' })).rejects.toBeInstanceOf(
      OverrideInsufficientError,
    )
    // …y el token que SÍ pudo obtener (de un permiso que tiene, facturar) no sirve para confirmar.
    tokens.set('tok-gerente', { venueId: 'venue-1', permission: 'cfdi:issue', authorizedById: 'sv-gerente', consumedAt: null })

    enLaBase('CASHIER')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'CASHIER').set('x-permission-override', 'tok-gerente').send(CUERPO)
    expect(res.status).toBe(403)
    expect(mockConfirmController).not.toHaveBeenCalled()
    expect(tokens.get('tok-gerente')!.consumedAt).toBeNull() // ni siquiera se gastó
  })

  /**
   * 🔴 Codex (B3b, código r1, P1 #2): el dueño le QUITÓ `cfdi:configure` al rol ADMIN (`deniedPermissions`).
   * `checkPermission` lo respeta (403 sin PIN), pero la emisión del token por PIN no lo miraba: el mismo ADMIN
   * tecleaba su propio PIN, obtenía un token de `cfdi:configure` y pasaba el middleware presentándolo.
   */
  it('🔴 un ADMIN al que el dueño le QUITÓ cfdi:configure no confirma: ni sin PIN, ni con su propio PIN', async () => {
    enLaBase('ADMIN', null, ['cfdi:configure'])
    const sinPin = await request(makeApp()).post(URL).set('x-test-role', 'ADMIN').send(CUERPO)
    expect(sinPin.status).toBe(403)

    // Su propio PIN (`createPermissionOverride` REAL, mismas lecturas de la base que el middleware).
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({
      id: 'sv-admin',
      role: 'ADMIN',
      permissionSetId: null,
      permissionSet: null,
      staff: { firstName: 'Ana', lastName: 'Admin' },
    })
    const emision = await createPermissionOverride({ venueId: 'venue-1', pin: '4321', permission: 'cfdi:configure' }).then(
      r => r.token,
      (error: unknown) => error,
    )
    // Si el PIN hubiera emitido el token, se presenta tal cual: es exactamente el ataque.
    const token = typeof emision === 'string' ? emision : 'tok-que-no-se-emitio'
    const conPin = await request(makeApp()).post(URL).set('x-test-role', 'ADMIN').set('x-permission-override', token).send(CUERPO)
    expect(conPin.status).toBe(403)
    expect(mockConfirmController).not.toHaveBeenCalled()
    expect(emision).toBeInstanceOf(OverrideInsufficientError)
    expect(tokens.size).toBe(0)
  })

  it('un ADMIN SIN exclusiones sí autoriza con su PIN a un cajero (token emitido y consumido): el 403 de arriba es la exclusión', async () => {
    enLaBase('ADMIN')
    prismaMock.staffVenue.findFirst.mockResolvedValueOnce({
      id: 'sv-admin',
      role: 'ADMIN',
      permissionSetId: null,
      permissionSet: null,
      staff: { firstName: 'Ana', lastName: 'Admin' },
    })
    const { token } = await createPermissionOverride({ venueId: 'venue-1', pin: '4321', permission: 'cfdi:configure' })

    enLaBase('CASHIER')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'CASHIER').set('x-permission-override', token).send(CUERPO)
    expect(res.status).toBe(200)
    expect(mockConfirmController).toHaveBeenCalledTimes(1)
    expect(tokens.get(token)!.consumedAt).not.toBeNull()
  })

  it('el PIN de un autorizador CON cfdi:configure (token de ese permiso) sí pasa — el 403 de arriba no es el arnés', async () => {
    tokens.set('tok-dueno', { venueId: 'venue-1', permission: 'cfdi:configure', authorizedById: 'sv-dueno', consumedAt: null })
    enLaBase('CASHIER')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'CASHIER').set('x-permission-override', 'tok-dueno').send(CUERPO)
    expect(res.status).toBe(200)
    expect(mockConfirmController).toHaveBeenCalledTimes(1)
  })
})

/**
 * 🔴 Codex (B3b, código r1, P2 #4): la huella metía el folio COMPLETO y la ruta topa la huella en el esquema. Un folio
 * de 250 caracteres (el campo no tiene límite y el editor lo deja guardar) daba una huella de 311 ⇒ 400: el dashboard
 * ofrecía confirmar una venta cuya confirmación HTTP nunca se aceptaba. La huella es ahora un SHA-256 en hex: misma
 * longitud para cualquier venta.
 */
describe('POST …/orders/:orderId/price-contract/confirm — la huella del servidor siempre cabe', () => {
  const venta = (orderNumber: string) => ({
    version: 3,
    orderNumber,
    createdAt: new Date('2026-09-15T18:30:00.000Z'),
    status: 'COMPLETED',
    total: 3082,
    paidAmount: 3082,
    discountAmount: 2958,
    paymentStatus: 'PAID',
  })

  it('🔴 la huella REAL de una venta con folio de 250 caracteres pasa la validación y llega al controlador', async () => {
    enLaBase('OWNER')
    const huella = huellaContrato(venta('F'.repeat(250)))
    const res = await request(makeApp()).post(URL).set('x-test-role', 'OWNER').send({ version: 3, huella })
    expect(res.status).toBe(200)
    expect(mockConfirmController).toHaveBeenCalledTimes(1)
    expect(huella).toMatch(/^[0-9a-f]{64}$/)
  })

  it('la huella es de longitud fija y sigue distinguiendo ventas (folio corto ≠ folio largo)', () => {
    const corta = huellaContrato(venta('A-1'))
    const larga = huellaContrato(venta('A-1'.padEnd(250, '0')))
    expect(corta).toHaveLength(64)
    expect(larga).toHaveLength(64)
    expect(corta).not.toBe(larga)
    expect(huellaContrato(venta('A-1'))).toBe(corta) // determinista: la misma venta, la misma huella
  })
})

describe('POST …/orders/:orderId/price-contract/confirm — el cuerpo se valida ANTES', () => {
  it.each([
    ['sin version', { huella: 'h-7' }],
    ['version no entera', { version: 7.5, huella: 'h-7' }],
    ['version como texto', { version: '7', huella: 'h-7' }],
    ['sin huella', { version: 7 }],
    ['huella vacía', { version: 7, huella: '' }],
  ])('%s ⇒ 400 y el controlador nunca se llama', async (_caso, cuerpo) => {
    enLaBase('OWNER')
    const res = await request(makeApp()).post(URL).set('x-test-role', 'OWNER').send(cuerpo)
    expect(res.status).toBe(400)
    expect(res.body.message).toMatch(/[áéíóúñ]|requerida|entero/) // mensaje en español, no el de Zod en inglés
    expect(mockConfirmController).not.toHaveBeenCalled()
  })
})
