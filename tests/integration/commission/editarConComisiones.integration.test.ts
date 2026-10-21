// tests/integration/commission/editarConComisiones.integration.test.ts
/**
 * Fase 3 de Pago al personal, FT-GRAVES B1 (defecto viejo, de 2026-01), contra Postgres REAL y por la RUTA real (app + token).
 *
 * Medido en el /full-testing final (8-oct): tras la primera venta, un esquema ya no se podía editar en NADA. El candado de
 * `updateCommissionConfig` rechazaba que la tasa, el tipo, a quién se le paga y cuándo se calcula VINIERAN en el cuerpo, aunque
 * fueran iguales a lo guardado, y el editor del dashboard los manda siempre: cambiar sólo el nombre daba 400 en inglés («Cannot
 * modify defaultRate because this config has 1 existing calculations»). Tampoco se podía desactivar desde el editor.
 *
 * Lo correcto: con comisiones calculadas sólo se rechaza lo que CAMBIA de esos cuatro campos, en español y diciendo qué hacer.
 * Todo lo demás (nombre, descripción, fechas, base con o sin IVA, a quién aplica, desactivar) se guarda, con su ActivityLog.
 *
 * Correr: TZ=UTC TEST_DATABASE_URL="$PAGO_F3_DB" npx jest --selectProjects=integration \
 *   --runTestsByPath tests/integration/commission/editarConComisiones.integration.test.ts --ci --runInBand
 */
import type { Server } from 'http'
import jwt from 'jsonwebtoken'
import request from 'supertest'
import app from '@/app'
import prisma from '@/utils/prismaClient'
import { asegurarBaseDePrueba, borrarMundoComisiones, crearMundoComisiones, MundoComisiones, ventaConComision } from './_mundoComisiones'

// El plan (Comisiones es Premium) va simulado: aquí se prueba qué se puede editar.
jest.mock('@/services/access/basePlan.service', () => ({
  ...jest.requireActual('@/services/access/basePlan.service'),
  venueHasCommissionsAccess: jest.fn(async () => true),
}))

let m: MundoComisiones
let server: Server
beforeAll(async () => {
  asegurarBaseDePrueba()
  server = app.listen(0, '127.0.0.1')
  await new Promise<void>(listo => server.once('listening', () => listo()))
})
afterAll(async () => {
  await new Promise<void>(listo => server.close(() => listo()))
})
beforeEach(async () => {
  m = await crearMundoComisiones('editar-con-comisiones')
})
afterEach(async () => {
  const mundo = m
  m = undefined as unknown as MundoComisiones
  await borrarMundoComisiones(mundo)
})

const token = () =>
  jwt.sign({ sub: m.owner, orgId: m.orgId, venueId: m.venueId, role: 'OWNER' }, process.env.ACCESS_TOKEN_SECRET as string, {
    expiresIn: '15m',
  })
const put = (cuerpo: object, configId = m.configId) =>
  request(server)
    .put(`/api/v1/dashboard/commissions/venues/${m.venueId}/configs/${configId}`)
    .set('Authorization', `Bearer ${token()}`)
    .send(cuerpo)
const esquema = (id = m.configId) => prisma.commissionConfig.findUniqueOrThrow({ where: { id } })

/**
 * El cuerpo que manda el editor del dashboard (`EditConfigDialog.tsx`): TODOS los campos, con los valores guardados del esquema
 * del mundo (10 %, a quien cobró, «con IVA»), más lo que la prueba cambie.
 */
const comoElEditor = (cambios: object = {}) => ({
  name: 'Comisión 10 %',
  calcType: 'PERCENTAGE',
  recipient: 'PROCESSOR',
  trigger: 'PER_PAYMENT',
  defaultRate: 0.1,
  minAmount: null,
  maxAmount: null,
  includeTips: false,
  includeDiscount: false,
  includeTax: true,
  filterByCategories: false,
  categoryIds: [],
  useGoalAsTier: false,
  goalBonusRate: null,
  attendanceLinked: false,
  attendanceLatePenaltyRate: null,
  roleRates: null,
  priority: 0,
  active: true,
  ...cambios,
})

describe('B1 · un esquema con comisiones calculadas se puede editar en lo que no cambia el dinero ya calculado', () => {
  it('🔴 el editor cambia SÓLO el nombre (y manda la tasa, el tipo y a quién, iguales): se guarda', async () => {
    await ventaConComision(m)
    const r = await put(comoElEditor({ name: 'Comisión de meseros' }))
    expect(r.status).toBe(200)
    expect((await esquema()).name).toBe('Comisión de meseros')
  })

  it('🔴 la misma tasa escrita de otra forma (0.10, «0.1000») no es un cambio', async () => {
    await ventaConComision(m)
    expect((await put({ defaultRate: 0.1, name: 'A' })).status).toBe(200)
    expect((await put({ defaultRate: '0.1000', name: 'B' })).status).toBe(200)
    expect((await esquema()).defaultRate.toFixed(4)).toBe('0.1000')
  })

  it('🔴 con comisiones calculadas se guardan descripción, fechas, base con o sin IVA, descuento y «sólo personas elegidas»', async () => {
    await ventaConComision(m)
    const r = await put(
      comoElEditor({
        description: 'Para meseros',
        effectiveTo: '2030-01-01T06:00:00.000Z',
        includeTax: false,
        includeDiscount: true,
        filterByStaff: true,
        staffIds: [m.ana],
      }),
    )
    expect(r.status).toBe(200)
    expect(await esquema()).toMatchObject({
      description: 'Para meseros',
      effectiveTo: new Date('2030-01-01T06:00:00.000Z'),
      includeTax: false,
      includeDiscount: true,
      filterByStaff: true,
      staffIds: [m.ana],
      defaultRate: expect.anything(),
    })
    expect((await esquema()).defaultRate.toFixed(4)).toBe('0.1000')
  })

  it('🔴 desactivar un esquema con comisiones se guarda y deja ActivityLog con quién lo hizo', async () => {
    await ventaConComision(m)
    const r = await put(comoElEditor({ active: false }))
    expect(r.status).toBe(200)
    expect((await esquema()).active).toBe(false)
    const audit = await prisma.activityLog.findFirst({
      where: { venueId: m.venueId, entityId: m.configId, action: 'COMMISSION_CONFIG_UPDATED' },
      orderBy: { createdAt: 'desc' },
    })
    expect(audit).toMatchObject({ staffId: m.owner, entity: 'CommissionConfig' })
    expect(audit?.data).toMatchObject({ active: false, changes: expect.arrayContaining(['active']) })
  })

  it.each([
    ['la tasa', { defaultRate: 0.2 }, 'defaultRate'],
    ['el tipo de comisión', { calcType: 'TIERED' }, 'calcType'],
    ['a quién se le paga', { recipient: 'SERVER' }, 'recipient'],
    ['cuándo se calcula', { trigger: 'PER_ORDER' }, 'trigger'],
  ])('🔴 cambiar %s con comisiones calculadas da 400 en español y no guarda nada', async (nombre, cambio, campo) => {
    await ventaConComision(m)
    const r = await put(comoElEditor({ name: 'No debe guardarse', ...cambio }))
    expect(r.status).toBe(400)
    expect(r.body).toMatchObject({
      message: `Este esquema ya tiene 1 comisión calculada y no se puede cambiar ${nombre}. Desactívalo y crea uno nuevo con el cambio.`,
      code: 'ESQUEMA_CON_COMISIONES',
      details: { campo, comisiones: 1 },
    })
    const despues = await esquema()
    expect([despues.name, despues.defaultRate.toFixed(4), despues.calcType, despues.recipient, despues.trigger]).toEqual([
      'Comisión 10 %',
      '0.1000',
      'PERCENTAGE',
      'PROCESSOR',
      'PER_PAYMENT',
    ])
  })

  it('🔴 un monto fijo con comisiones: el mismo monto pasa; otro monto se rechaza nombrando «el monto fijo» y en plural', async () => {
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { calcType: 'FIXED', defaultRate: 10 } })
    await ventaConComision(m)
    await ventaConComision(m)
    expect((await put({ calcType: 'FIXED', defaultRate: 10, name: 'Fijo $10' })).status).toBe(200)
    const r = await put({ calcType: 'FIXED', defaultRate: 12 })
    expect(r.status).toBe(400)
    expect(r.body.message).toBe(
      'Este esquema ya tiene 2 comisiones calculadas y no se puede cambiar el monto fijo. Desactívalo y crea uno nuevo con el cambio.',
    )
    expect((await esquema()).defaultRate.toFixed(4)).toBe('10.0000')
  })

  it('🔴 una tasa guardada antes de las reglas de hoy (niveles al 500 %) que llega IGUAL no se revalida: el nombre se guarda', async () => {
    await prisma.commissionConfig.update({ where: { id: m.configId }, data: { calcType: 'TIERED', defaultRate: 5 } })
    const r = await put({ calcType: 'TIERED', defaultRate: 5, name: 'Esquema viejo' })
    expect(r.status).toBe(200)
    expect((await esquema()).name).toBe('Esquema viejo')
  })

  // ── Regresión: sin comisiones calculadas todo se sigue pudiendo cambiar, con las validaciones de siempre ──
  it('sin comisiones calculadas se cambian la tasa, el tipo y a quién se le paga', async () => {
    const r = await put({ defaultRate: 0.05, recipient: 'SERVER', trigger: 'PER_ORDER' })
    expect(r.status).toBe(200)
    const e = await esquema()
    expect([e.defaultRate.toFixed(4), e.recipient, e.trigger]).toEqual(['0.0500', 'SERVER', 'PER_ORDER'])
  })

  it('sin comisiones calculadas una tasa NUEVA fuera de rango sigue dando su 400 en español', async () => {
    const r = await put({ defaultRate: 1.5 })
    expect(r.status).toBe(400)
    expect(r.body.message).toMatch(/La tasa de comisión va de 0 % a 100 %: 150 % no es válida/)
  })
})
