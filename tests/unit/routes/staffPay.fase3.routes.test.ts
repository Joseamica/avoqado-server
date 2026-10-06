import * as schemas from '@/schemas/dashboard/staffPay.schema'
import { prismaMock } from '@tests/__helpers__/setup'

jest.mock('@/services/dashboard/staffPay/activacion.service', () => ({
  estadoActivacion: jest.fn(),
  activarPagoAlPersonal: jest.fn(),
  cambiarPropinas: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: jest.fn(),
  organizacionTieneServicePay: jest.fn(),
}))

import * as activacion from '@/services/dashboard/staffPay/activacion.service'
import * as acceso from '@/services/dashboard/staffPay/acceso'
import * as controller from '@/controllers/dashboard/staffPay.dashboard.controller'
import router from '@/routes/dashboard/staffPay.routes'

describe('Zod de la fase 3 (sólo forma, mensajes en español)', () => {
  it('activar exige la periodicidad, también la mensual de fábrica', () => {
    expect(schemas.activarSchema.safeParse({ periodicidad: 'MONTHLY' }).success).toBe(true)
    const malo = schemas.activarSchema.safeParse({})
    expect(malo.success).toBe(false)
    if (!malo.success) expect(malo.error.errors.map(e => e.message)).toEqual(['Elige mensual o quincenal'])
  })
  it('activar acepta, opcional, la fecha de inicio que se mostró (Codex bloque B #3)', () => {
    expect(schemas.activarSchema.safeParse({ periodicidad: 'MONTHLY', inicioEsperado: '2026-09-01' }).success).toBe(true)
    const mala = schemas.activarSchema.safeParse({ periodicidad: 'MONTHLY', inicioEsperado: '1-sep' })
    expect(mala.success).toBe(false)
    if (!mala.success) expect(mala.error.errors.map(e => e.message)).toEqual(['Fecha inválida (AAAA-MM-DD)'])
  })
  it('las propinas en el recibo son sí o no', () => {
    expect(schemas.propinasSchema.safeParse({ encender: false }).success).toBe(true)
    const malo = schemas.propinasSchema.safeParse({ encender: 'si' })
    expect(malo.success).toBe(false)
    if (!malo.success) expect(malo.error.errors.map(e => e.message)).toEqual(['Indica si las propinas se pagan en el recibo'])
    const falta = schemas.propinasSchema.safeParse({})
    expect(falta.success).toBe(false)
    if (!falta.success) expect(falta.error.errors.map(e => e.message)).toEqual(['Indica si las propinas se pagan en el recibo'])
  })
})

describe('Rutas de la fase 3', () => {
  const stack: any[] = (router as any).stack
  const gate = stack.findIndex(l => !l.route && l.handle?.name === 'servicePayGate')
  const ruta = (method: string, path: string) => stack.findIndex(l => l.route?.path === path && l.route.methods[method])
  it.each([
    ['post', '/activate'],
    ['put', '/tips'],
  ])('%s %s exige staffpay:close y va DESPUÉS del gate del módulo', (method, path) => {
    const i = ruta(method, path)
    expect(gate).toBeGreaterThan(-1)
    expect(i).toBeGreaterThan(gate)
    expect(stack[i].route.stack.map((l: any) => l.handle?.requiredPermission).find(Boolean)).toBe('staffpay:close')
  })
  it('GET /access sigue ANTES del gate: la pantalla tiene que poder explicar el módulo apagado', () => {
    expect(ruta('get', '/access')).toBeGreaterThan(-1)
    expect(ruta('get', '/access')).toBeLessThan(gate)
  })
})

describe('Controller de la fase 3', () => {
  const req = (extra: Record<string, unknown> = {}) =>
    ({ params: { venueId: 'v1' }, query: {}, body: {}, authContext: { userId: 'u1' }, ...extra }) as any
  const res = () => ({ json: jest.fn() }) as any

  it('GET /access suma la activación al estado del módulo', async () => {
    prismaMock.venue.findUniqueOrThrow.mockResolvedValue({ organizationId: 'o1', timezone: 'America/Mexico_City' })
    ;(acceso.venueHasServicePayAccess as jest.Mock).mockResolvedValue(true)
    ;(activacion.estadoActivacion as jest.Mock).mockResolvedValue({ activado: true, startDate: '2026-10-01', propinasEncendidas: false })
    const r = res()
    await controller.getAccess(req(), r, jest.fn())
    expect(r.json).toHaveBeenCalledWith({ enabled: true, activado: true, startDate: '2026-10-01', propinasEncendidas: false })
    expect(activacion.estadoActivacion).toHaveBeenCalledWith(expect.anything(), 'o1')
  })

  it('activar y propinas pasan SÓLO sus campos al service (nada de `ahora` desde la petición)', async () => {
    ;(activacion.activarPagoAlPersonal as jest.Mock).mockResolvedValue({ startDate: '2026-10-01', yaActivado: false })
    ;(activacion.cambiarPropinas as jest.Mock).mockResolvedValue({ encendidas: true })
    const ra = res()
    await controller.postActivate(req({ body: { periodicidad: 'MONTHLY', ahora: '2020-01-01' } }), ra, jest.fn())
    expect(activacion.activarPagoAlPersonal).toHaveBeenCalledWith({ venueId: 'v1', userId: 'u1', periodicidad: 'MONTHLY' })
    expect(ra.json).toHaveBeenCalledWith({ startDate: '2026-10-01', yaActivado: false })
    // La fecha que vio el dashboard llega al service, que la compara bajo el candado (Codex bloque B #3).
    await controller.postActivate(req({ body: { periodicidad: 'MONTHLY', inicioEsperado: '2026-09-01' } }), res(), jest.fn())
    expect(activacion.activarPagoAlPersonal).toHaveBeenLastCalledWith({
      venueId: 'v1',
      userId: 'u1',
      periodicidad: 'MONTHLY',
      inicioEsperado: '2026-09-01',
    })
    const rt = res()
    await controller.putTips(req({ body: { encender: true, ahora: '2020-01-01' } }), rt, jest.fn())
    expect(activacion.cambiarPropinas).toHaveBeenCalledWith({ venueId: 'v1', userId: 'u1', encender: true })
    expect(rt.json).toHaveBeenCalledWith({ encendidas: true })
  })

  it('un error del service (sin permiso en alguna sede, no activado) va a next, no se traga', async () => {
    const err = Object.assign(new Error('Activa primero el pago al personal'), { statusCode: 409, code: 'NO_ACTIVADO' })
    ;(activacion.cambiarPropinas as jest.Mock).mockRejectedValue(err)
    const next = jest.fn()
    await controller.putTips(req({ body: { encender: true } }), res(), next)
    expect(next).toHaveBeenCalledWith(err)
  })
})
