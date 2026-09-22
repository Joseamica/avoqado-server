/*
  tests/api-tests/mobile/inventory-waste.api.test.ts

  Las tres rutas `/mobile` de merma, de punta a punta con Express real + supertest:
    GET  /mobile/venues/:venueId/inventory/waste-items
    POST /mobile/venues/:venueId/inventory/waste
    POST /mobile/venues/:venueId/inventory/waste/void

  Middleware real: authenticateTokenMiddleware → requireVenueMembership → … Los servicios de merma
  se mockean (los cubre la integración contra Postgres); aquí se prueba el CONTRATO HTTP que van a
  espejar Android e iOS: el orden de los candados, el formato del cuerpo y los códigos de error.

  🔴 Orden del POST (spec §4.4): membresía → recuperar por folio → plan → permiso → registrar. Sólo
  los candados de ESCRITURA NUEVA van detrás del folio: una respuesta perdida se recupera aunque
  entre tanto se revocara el permiso o el plan, pero nunca por quien ya no pertenece al venue.

  🔴 La anulación NO lleva candado de plan ni `checkPermission` (Ruling 12): la autorización es
  del servicio (membresía + log-waste O adjust). Un `checkPermission('inventory:log-waste')` en la
  ruta dejaría fuera al gerente que sólo tiene `inventory:adjust`.

  🔴 `null` = ausente: el POS Android serializa con `encodeDefaults = true`, así que un opcional
  que no aplica viaja como `"note": null`. Rechazarlo mataría toda merma sin nota (misma familia
  que el reembolso del 11-sep).
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
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../src/errors/AppError'

const logWaste = jest.fn()
const recoverByKey = jest.fn()
const voidWasteKey = jest.fn()
const requireWastePermission = jest.fn()
jest.mock('../../../src/services/shared/inventoryWaste.service', () => ({
  ...jest.requireActual('../../../src/services/shared/inventoryWaste.service'),
  logWaste: (...a: unknown[]) => logWaste(...a),
  recoverByKey: (...a: unknown[]) => recoverByKey(...a),
  voidWasteKey: (...a: unknown[]) => voidWasteKey(...a),
  requireWastePermission: (...a: unknown[]) => requireWastePermission(...a),
}))
const listWasteItems = jest.fn()
const listWasteReports = jest.fn()
jest.mock('../../../src/services/shared/inventoryWasteRead.service', () => ({
  listWasteItems: (...a: unknown[]) => listWasteItems(...a),
  listWasteReports: (...a: unknown[]) => listWasteReports(...a),
}))

const { prepareWaste } = jest.requireActual('../../../src/services/shared/inventoryWaste.service')
const app = require('../../../src/app').default

const venueId = 'clvenuewaste000000000001'
const otherVenueId = 'clvenuewaste000000000002'
const BASE = `/api/v1/mobile/venues/${venueId}/inventory`
const CONCESION = {
  id: 'vf-inv-1',
  active: true,
  endDate: null,
  suspendedAt: null,
  stripeSubscriptionId: null,
  feature: { code: 'INVENTORY_TRACKING', name: 'Inventario' },
}
const cuerpo = {
  itemType: 'PRODUCT',
  itemId: 'clproduct000000000000001',
  quantity: '2',
  unit: 'UNIT',
  reasonCode: 'DROPPED',
  idempotencyKey: '3f0e5c1a-7c1d-4a55-9c3e-2b8f4d6a1e90',
}
const RESUMEN = { reportId: 'r1', declared: '2', deducted: '2', unrecorded: '0' }
const PAGINA_VACIA = { items: [], total: 0, page: 1, pageSize: 100 }

/** Un mensaje de Zod sin traducir se reconoce por estas palabras. */
const INGLES = /\b(Invalid|Expected|Required|Unrecognized|received|String must|Number must|must contain|characters?)\b/

function token(role: string, tokenVenueId: string = venueId) {
  mirrorTokenRoleOnStaffVenue(role, tokenVenueId)
  return jwt.sign({ sub: 'user_test', orgId: 'org_test', venueId: tokenVenueId, role }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
}

/** Todos los textos de un 422 de merma: el mensaje y cada detalle de campo. */
function textos(body: any): string[] {
  const detalles = body?.details ?? {}
  const campos = Object.values(detalles.fieldErrors ?? {}).flat() as string[]
  return [body?.message, ...(detalles.formErrors ?? []), ...campos].filter(Boolean)
}

/** El WAITER con `inventory:log-waste` revocado por su venue, con la membresía intacta. */
function revocarLogWaste() {
  prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: [], deniedPermissions: ['inventory:log-waste'] })
}

beforeEach(() => {
  jest.clearAllMocks()
  prismaMock.staffVenue.findFirst.mockResolvedValue(null)
  prismaMock.staffVenue.findUnique.mockResolvedValue(null)
  prismaMock.venue.findUnique.mockResolvedValue(null)
  prismaMock.staffOrganization.findUnique.mockResolvedValue(null)
  prismaMock.venueRolePermission.findUnique.mockResolvedValue(null)
  prismaMock.venueFeature.findFirst.mockResolvedValue(CONCESION as never)
  recoverByKey.mockResolvedValue(null)
  logWaste.mockResolvedValue(RESUMEN)
  voidWasteKey.mockResolvedValue({ outcome: 'VOIDED', voidedByStaffId: 'user_test', voidedAt: '2026-09-21T00:00:00.000Z' })
  requireWastePermission.mockResolvedValue({})
  listWasteItems.mockResolvedValue(PAGINA_VACIA)
  listWasteReports.mockResolvedValue(PAGINA_VACIA)
})

describe('POST …/inventory/waste', () => {
  it('401 sin credencial', async () => {
    const res = await request(app).post(`${BASE}/waste`).send(cuerpo)
    expect(res.status).toBe(401)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it.each(['WAITER', 'CASHIER', 'MANAGER'])('201 para %s', async role => {
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token(role)}`)
      .send(cuerpo)
    expect(res.status).toBe(201)
    expect(res.body).toEqual(RESUMEN)
    expect(logWaste).toHaveBeenCalledWith(venueId, 'user_test', expect.objectContaining({ source: 'POS', reasonCode: 'DROPPED' }))
    // El candado white-label (AVOQADO_INVENTORY) lo pone el servicio, no checkPermission.
    expect(requireWastePermission).toHaveBeenCalledWith('user_test', venueId, 'inventory:log-waste')
  })

  it.each(['KITCHEN', 'HOST', 'VIEWER'])('🔴 403 real para %s, sin tocar existencias', async role => {
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token(role)}`)
      .send(cuerpo)
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:log-waste')
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 403 de plan con featureCode cuando el venue no tiene INVENTORY_TRACKING', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send(cuerpo)
    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 un folio ya aplicado se recupera ANTES del candado de plan y de permiso', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    recoverByKey.mockResolvedValue(RESUMEN)
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    expect(res.status).toBe(201)
    expect(res.body).toEqual(RESUMEN)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 quien no pertenece al venue no recupera nada por folio', async () => {
    recoverByKey.mockResolvedValue(RESUMEN)
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('MANAGER', otherVenueId)}`)
      .send(cuerpo)
    expect(res.status).toBe(403)
    expect(recoverByKey).not.toHaveBeenCalled()
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 con el permiso REVOCADO pero la membresía vigente SÍ recupera su folio', async () => {
    revocarLogWaste()
    recoverByKey.mockResolvedValue(RESUMEN)
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    expect(res.status).toBe(201)
    expect(res.body).toEqual(RESUMEN)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('🔴 con el permiso REVOCADO y sin folio previo, 403: no registra una merma nueva', async () => {
    revocarLogWaste()
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:log-waste')
    expect(recoverByKey).toHaveBeenCalled()
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('la recuperación usa el venue de la URL, el autor del token y la huella del cuerpo', async () => {
    await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    const esperado = prepareWaste('user_test', { ...cuerpo, source: 'POS' })
    expect(recoverByKey).toHaveBeenCalledWith(venueId, esperado.idempotencyKey, 'user_test', esperado.payloadHash)
  })

  it('🔴 el dueño de la organización pasa aunque no tenga StaffVenue en el local', async () => {
    const ownerToken = jwt.sign(
      { sub: 'user_test', orgId: 'org_test', venueId: otherVenueId, role: 'OWNER' },
      process.env.ACCESS_TOKEN_SECRET as string,
      { expiresIn: '15m' },
    )
    prismaMock.staffVenue.findUnique.mockResolvedValue(null)
    prismaMock.venue.findUnique.mockResolvedValue({ organizationId: 'org_test' })
    prismaMock.staffOrganization.findUnique.mockResolvedValue({ role: 'OWNER', isActive: true })
    const res = await request(app).post(`${BASE}/waste`).set('Authorization', `Bearer ${ownerToken}`).send(cuerpo)
    expect(res.status).toBe(201)
    expect(logWaste).toHaveBeenCalledWith(venueId, 'user_test', expect.objectContaining({ source: 'POS' }))
  })

  it('🔴 el candado white-label del servicio (requireWastePermission) corta con 403 antes de registrar', async () => {
    requireWastePermission.mockRejectedValue(new ForbiddenError('No tienes permiso para esta operación de inventario.'))
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    expect(res.status).toBe(403)
    expect(logWaste).not.toHaveBeenCalled()
  })

  it('422 con un cuerpo inválido, con su código', async () => {
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send({ ...cuerpo, reasonCode: 'NO_EXISTE' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
    expect(recoverByKey).not.toHaveBeenCalled()
  })

  it('rechaza campos de más (reportedByStaffId no existe en el contrato)', async () => {
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send({ ...cuerpo, reportedByStaffId: 'otro' })
    expect(res.status).toBe(422)
    expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
    expect(logWaste).not.toHaveBeenCalled()
  })

  describe('🔴 null = ausente (Android manda los opcionales vacíos como null)', () => {
    it('note: null y clientOccurredAt: null → 201, y el servicio recibe los campos AUSENTES', async () => {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, note: null, clientOccurredAt: null })
      expect(res.status).toBe(201)
      const input = logWaste.mock.calls[0][2]
      expect(input).not.toHaveProperty('note')
      expect(input).not.toHaveProperty('clientOccurredAt')
    })

    it('la huella de un cuerpo con null es la MISMA que sin el campo: un reintento de otra versión de la app recupera', async () => {
      await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, note: null, clientOccurredAt: null })
      await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send(cuerpo)
      expect(recoverByKey).toHaveBeenCalledTimes(2)
      expect(recoverByKey.mock.calls[0][3]).toBe(recoverByKey.mock.calls[1][3])
    })

    it('con valores, note y clientOccurredAt llegan al servicio (la fecha como Date)', async () => {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, note: 'Se cayó la charola', clientOccurredAt: '2026-09-21T13:05:00.000-06:00' })
      expect(res.status).toBe(201)
      const input = logWaste.mock.calls[0][2]
      expect(input.note).toBe('Se cayó la charola')
      expect(input.clientOccurredAt).toBeInstanceOf(Date)
      expect(input.clientOccurredAt.toISOString()).toBe('2026-09-21T19:05:00.000Z')
    })

    it('un requerido en null sigue siendo 422 (null no es un artículo)', async () => {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, itemId: null })
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
    })
  })

  describe('🔴 quantity en formato decimal estricto', () => {
    it.each(['0x10', '1e3', '-2', ' 2', '2 ', '+2', '1,5', '.5', '5.', '', 'Infinity', 'NaN', '0b11', '0o7'])(
      'rechaza %j con 422 INVALID_WASTE_PAYLOAD sin llegar al servicio',
      async quantity => {
        const res = await request(app)
          .post(`${BASE}/waste`)
          .set('Authorization', `Bearer ${token('WAITER')}`)
          .send({ ...cuerpo, quantity })
        expect(res.status).toBe(422)
        expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
        expect(recoverByKey).not.toHaveBeenCalled()
        expect(logWaste).not.toHaveBeenCalled()
      },
    )

    it.each([-1, -0.001, true, null])('rechaza la cantidad %j (no es un número no negativo ni un decimal)', async quantity => {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, quantity })
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
      expect(logWaste).not.toHaveBeenCalled()
    })

    it.each([
      ['2', '2'],
      ['2.500', '2.500'],
      ['0.001', '0.001'],
      ['007', '007'],
    ])('acepta el texto %j y lo entrega intacto al servicio', async (quantity, entregado) => {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, quantity })
      expect(res.status).toBe(201)
      expect(logWaste.mock.calls[0][2].quantity).toBe(entregado)
    })

    it('acepta un número JSON finito (Swift codifica Decimal como número) y lo entrega intacto', async () => {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send({ ...cuerpo, quantity: 2.5 })
      expect(res.status).toBe(201)
      expect(logWaste.mock.calls[0][2].quantity).toBe(2.5)
    })
  })

  it('🔴 todos los mensajes de un 422 del esquema salen en español', async () => {
    const malos: unknown[] = [
      {},
      [],
      { ...cuerpo, itemType: 'OTRO' },
      { ...cuerpo, itemId: '' },
      { ...cuerpo, itemId: 'x'.repeat(101) },
      { ...cuerpo, quantity: '0x10' },
      { ...cuerpo, quantity: false },
      { ...cuerpo, unit: '' },
      { ...cuerpo, unit: 7 },
      { ...cuerpo, reasonCode: 'NO_EXISTE' },
      { ...cuerpo, note: 'x'.repeat(281) },
      { ...cuerpo, note: 5 },
      { ...cuerpo, idempotencyKey: 'no-es-uuid' },
      { ...cuerpo, clientOccurredAt: 'ayer' },
      { ...cuerpo, extra: 1 },
    ]
    for (const malo of malos) {
      const res = await request(app)
        .post(`${BASE}/waste`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send(malo as object)
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
      const todos = textos(res.body)
      expect(todos.length).toBeGreaterThan(1)
      for (const texto of todos) expect(texto).not.toMatch(INGLES)
    }
  })

  it.each([
    [
      'QUANTITY_TOO_LARGE',
      422,
      () => new ValidationError('La cantidad o su valoración no cabe en la precisión permitida.', 'QUANTITY_TOO_LARGE'),
    ],
    ['INVALID_WASTE_REASON', 422, () => new ValidationError('Este motivo no está disponible en el POS.', 'INVALID_WASTE_REASON')],
    ['ITEM_NOT_FOUND', 404, () => new NotFoundError('Artículo no encontrado.', 'ITEM_NOT_FOUND')],
    ['UNIT_MISMATCH', 409, () => new ConflictError('La unidad del artículo cambió.', 'UNIT_MISMATCH')],
    ['IDEMPOTENCY_KEY_REUSED', 409, () => new ConflictError('El folio ya fue utilizado.', 'IDEMPOTENCY_KEY_REUSED')],
    ['WASTE_VOIDED', 409, () => new ConflictError('Este folio fue anulado.', 'WASTE_VOIDED')],
    ['WASTE_RETRYABLE_CONFLICT', 409, () => new ConflictError('Hubo un conflicto de inventario.', 'WASTE_RETRYABLE_CONFLICT')],
  ])('el %s del servicio sale como %i con su código en el cuerpo', async (code, status, error) => {
    logWaste.mockRejectedValue(error())
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    expect(res.status).toBe(status)
    expect(res.body.code).toBe(code)
  })

  it('🔴 un folio ANULADO contesta 409 WASTE_VOIDED aunque el venue ya no tenga el plan', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    recoverByKey.mockRejectedValue(new ConflictError('Este folio fue anulado.', 'WASTE_VOIDED'))
    const res = await request(app)
      .post(`${BASE}/waste`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send(cuerpo)
    expect(res.status).toBe(409)
    expect(res.body.code).toBe('WASTE_VOIDED')
    expect(logWaste).not.toHaveBeenCalled()
  })
})

describe('POST …/inventory/waste/void', () => {
  const VOID = `${BASE}/waste/void`

  it('401 sin credencial', async () => {
    const res = await request(app).post(VOID).send({ idempotencyKey: cuerpo.idempotencyKey })
    expect(res.status).toBe(401)
    expect(voidWasteKey).not.toHaveBeenCalled()
  })

  it('🔴 no exige plan: anular no escribe existencias', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    const res = await request(app)
      .post(VOID)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send({ idempotencyKey: cuerpo.idempotencyKey })
    expect(res.status).toBe(200)
    expect(res.body.outcome).toBe('VOIDED')
    expect(voidWasteKey).toHaveBeenCalledWith(venueId, 'user_test', cuerpo.idempotencyKey)
  })

  it('🔴 la ruta NO exige log-waste: el gerente que sólo tiene inventory:adjust llega al servicio', async () => {
    prismaMock.venueRolePermission.findUnique.mockResolvedValue({ permissions: [], deniedPermissions: ['inventory:log-waste'] })
    const res = await request(app)
      .post(VOID)
      .set('Authorization', `Bearer ${token('MANAGER')}`)
      .send({ idempotencyKey: cuerpo.idempotencyKey })
    expect(res.status).toBe(200)
    expect(voidWasteKey).toHaveBeenCalledWith(venueId, 'user_test', cuerpo.idempotencyKey)
  })

  it('🔴 quien decide el permiso es el servicio: su ForbiddenError sale como 403', async () => {
    voidWasteKey.mockRejectedValue(new ForbiddenError('No tienes permiso para anular este folio.'))
    const res = await request(app)
      .post(VOID)
      .set('Authorization', `Bearer ${token('KITCHEN')}`)
      .send({ idempotencyKey: cuerpo.idempotencyKey })
    expect(res.status).toBe(403)
    expect(voidWasteKey).toHaveBeenCalled()
  })

  it('🔴 quien no pertenece al venue no anula nada', async () => {
    const res = await request(app)
      .post(VOID)
      .set('Authorization', `Bearer ${token('MANAGER', otherVenueId)}`)
      .send({ idempotencyKey: cuerpo.idempotencyKey })
    expect(res.status).toBe(403)
    expect(voidWasteKey).not.toHaveBeenCalled()
  })

  it('ALREADY_APPLIED pasa tal cual, con el resumen cuando el servicio lo concede', async () => {
    voidWasteKey.mockResolvedValue({ outcome: 'ALREADY_APPLIED', report: RESUMEN })
    const res = await request(app)
      .post(VOID)
      .set('Authorization', `Bearer ${token('WAITER')}`)
      .send({ idempotencyKey: cuerpo.idempotencyKey })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ outcome: 'ALREADY_APPLIED', report: RESUMEN })
  })

  it.each([[{ idempotencyKey: 'no-es-uuid' }], [{}], [{ idempotencyKey: cuerpo.idempotencyKey, itemId: 'x' }], [{ idempotencyKey: null }]])(
    '422 INVALID_WASTE_PAYLOAD con el cuerpo %j, en español',
    async body => {
      const res = await request(app)
        .post(VOID)
        .set('Authorization', `Bearer ${token('WAITER')}`)
        .send(body)
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
      for (const texto of textos(res.body)) expect(texto).not.toMatch(INGLES)
      expect(voidWasteKey).not.toHaveBeenCalled()
    },
  )
})

describe('GET …/inventory/waste-items', () => {
  const ITEMS = `${BASE}/waste-items`

  it('pagina y nunca devuelve existencias', async () => {
    const res = await request(app)
      .get(`${ITEMS}?page=1&pageSize=9999`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual(PAGINA_VACIA)
  })

  it('🔴 un pageSize hostil se RECORTA a 200, no se rechaza', async () => {
    const res = await request(app)
      .get(`${ITEMS}?page=3&pageSize=9999&search=leche`)
      .set('Authorization', `Bearer ${token('WAITER')}`)
    expect(res.status).toBe(200)
    expect(listWasteItems).toHaveBeenCalledWith(venueId, expect.objectContaining({ page: 3, pageSize: 200, search: 'leche' }))
  })

  it('sin parámetros pide la primera página de 100', async () => {
    await request(app)
      .get(ITEMS)
      .set('Authorization', `Bearer ${token('WAITER')}`)
    expect(listWasteItems).toHaveBeenCalledWith(venueId, expect.objectContaining({ page: 1, pageSize: 100 }))
  })

  it('🔴 aunque el lector devolviera existencias o costos, la ruta sólo entrega los cinco campos del contrato', async () => {
    listWasteItems.mockResolvedValue({
      items: [
        {
          itemType: 'RAW_MATERIAL',
          itemId: 'clraw0000000000000000001',
          name: 'Leche',
          sku: 'LEC-1',
          unit: 'LITER',
          currentStock: '12.5',
          costPerUnit: '23.10',
        },
      ],
      total: 1,
      page: 1,
      pageSize: 100,
    })
    const res = await request(app)
      .get(ITEMS)
      .set('Authorization', `Bearer ${token('WAITER')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      items: [{ itemType: 'RAW_MATERIAL', itemId: 'clraw0000000000000000001', name: 'Leche', sku: 'LEC-1', unit: 'LITER' }],
      total: 1,
      page: 1,
      pageSize: 100,
    })
  })

  it('🔴 403 de plan con featureCode', async () => {
    prismaMock.venueFeature.findFirst.mockResolvedValue(null)
    const res = await request(app)
      .get(ITEMS)
      .set('Authorization', `Bearer ${token('WAITER')}`)
    expect(res.status).toBe(403)
    expect(res.body.featureCode).toBe('INVENTORY_TRACKING')
    expect(listWasteItems).not.toHaveBeenCalled()
  })

  it.each(['KITCHEN', 'HOST', 'VIEWER'])('🔴 403 para %s (sin inventory:log-waste)', async role => {
    const res = await request(app)
      .get(ITEMS)
      .set('Authorization', `Bearer ${token(role)}`)
    expect(res.status).toBe(403)
    expect(res.body).toHaveProperty('required', 'inventory:log-waste')
    expect(listWasteItems).not.toHaveBeenCalled()
  })

  it('🔴 quien no pertenece al venue no ve su catálogo', async () => {
    const res = await request(app)
      .get(ITEMS)
      .set('Authorization', `Bearer ${token('MANAGER', otherVenueId)}`)
    expect(res.status).toBe(403)
    expect(listWasteItems).not.toHaveBeenCalled()
  })

  it('🔴 el candado white-label del servicio corta con 403', async () => {
    requireWastePermission.mockRejectedValue(new ForbiddenError('No tienes permiso para esta operación de inventario.'))
    const res = await request(app)
      .get(ITEMS)
      .set('Authorization', `Bearer ${token('WAITER')}`)
    expect(res.status).toBe(403)
    expect(listWasteItems).not.toHaveBeenCalled()
  })

  it.each(['page=0', 'page=abc', 'pageSize=0', 'pageSize=-5', 'page=1.5', `search=${'x'.repeat(201)}`])(
    '422 INVALID_WASTE_PAYLOAD con %s, en español',
    async query => {
      const res = await request(app)
        .get(`${ITEMS}?${query}`)
        .set('Authorization', `Bearer ${token('WAITER')}`)
      expect(res.status).toBe(422)
      expect(res.body.code).toBe('INVALID_WASTE_PAYLOAD')
      for (const texto of textos(res.body)) expect(texto).not.toMatch(INGLES)
      expect(listWasteItems).not.toHaveBeenCalled()
    },
  )
})
