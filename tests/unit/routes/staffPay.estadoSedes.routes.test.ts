// tests/unit/routes/staffPay.estadoSedes.routes.test.ts — fase 3, B13 (diseño r3.7(1), r4.7, r5.1): la pantalla 1
// (Configuración › Sedes, `GET /sedes`) sin puerta de plan, y la vista previa del ajuste manual (`GET /adjustments/preview`)
// con su aviso de devoluciones pendientes. Puertas, permisos, validación (español) y que el controller pasa sólo sus campos.
import * as schemas from '@/schemas/dashboard/staffPay.schema'

jest.mock('@/services/dashboard/staffPay/sedes.service', () => ({ estadoSedes: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/ajustesManuales.service', () => ({
  previewAjusteManual: jest.fn(),
  agregarAjusteManual: jest.fn(),
}))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: jest.fn(),
  organizacionTieneServicePay: jest.fn(),
}))

import { estadoSedes } from '@/services/dashboard/staffPay/sedes.service'
import { previewAjusteManual } from '@/services/dashboard/staffPay/ajustesManuales.service'
import * as controller from '@/controllers/dashboard/staffPay.dashboard.controller'
import router from '@/routes/dashboard/staffPay.routes'

const VENUE = 'ckvenue00000000000000000001'
const SEDE = 'ckvenue00000000000000000009'
const PERSONA = 'ckstaff00000000000000000001'

const stack: any[] = (router as any).stack
const gate = stack.findIndex(l => !l.route && l.handle?.name === 'servicePayGate')
const ruta = (method: string, path: string) => stack.findIndex(l => l.route?.path === path && l.route.methods[method])
const capas = (i: number) => stack[i].route.stack.map((l: any) => l.handle)
const permiso = (i: number) =>
  capas(i)
    .map((h: any) => h?.requiredPermission)
    .find(Boolean)
const nombres = (i: number) => capas(i).map((h: any) => h?.name)
const validacion = (i: number) => capas(i)[capas(i).findIndex((h: any) => h?.requiredPermission) + 1]

describe('GET /sedes (pantalla 1, r4.7): staffpay:read y SIN puerta de plan', () => {
  it('va ANTES del gate de plan y sin ninguna puerta de plan', () => {
    const i = ruta('get', '/sedes')
    expect(gate).toBeGreaterThan(-1)
    expect(i).toBeGreaterThan(-1)
    expect(i).toBeLessThan(gate)
    expect(nombres(i)).not.toContain('servicePayGate')
    expect(nombres(i)).not.toContain('servicePayGateOrganizacion')
    expect(permiso(i)).toBe('staffpay:read')
  })

  it('una sede mal formada en la URL es 400 antes del controller', async () => {
    const validar = validacion(ruta('get', '/sedes'))
    const next = jest.fn()
    await validar({ params: { venueId: 'x' }, query: {}, body: {} }, {}, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/Venue ID inválido/) }))
    const ok = jest.fn()
    await validar({ params: { venueId: VENUE }, query: {}, body: {} }, {}, ok)
    expect(ok).toHaveBeenCalledWith()
  })
})

describe('GET /adjustments/preview (r5.1): lo que registraría el ajuste y el aviso de devoluciones pendientes', () => {
  it('va con el plan (como el ajuste que previsualiza) y pide leer; el service exige cerrar en la sede del ajuste', () => {
    const i = ruta('get', '/adjustments/preview')
    expect(i).toBeGreaterThan(gate)
    expect(permiso(i)).toBe('staffpay:read')
    // Antes de cualquier ruta con parámetro que pudiera tragarse «preview».
    expect(i).toBeLessThan(ruta('post', '/adjustments'))
  })

  it('Zod: sólo forma y en español; el monto llega de la URL como texto y sale como número', () => {
    const ok = schemas.ajustePreviewQuerySchema.safeParse({ sede: SEDE, staffId: PERSONA, amount: '-50', reason: ' Devolución ' })
    expect(ok.success && ok.data).toEqual({ sede: SEDE, staffId: PERSONA, amount: -50, reason: 'Devolución' })
    const conFecha = schemas.ajustePreviewQuerySchema.safeParse({
      sede: SEDE,
      staffId: PERSONA,
      amount: '100.5',
      reason: 'Bono',
      fecha: '2026-10-20',
    })
    expect(conFecha.success).toBe(true)
    const malas = (q: Record<string, unknown>) => {
      const r = schemas.ajustePreviewQuerySchema.safeParse({ sede: SEDE, staffId: PERSONA, amount: '50', reason: 'Bono', ...q })
      return r.success ? [] : r.error.errors.map(e => e.message)
    }
    expect(malas({ amount: '0' })).toEqual(['El monto no puede ser cero'])
    expect(malas({ amount: 'diez' })).toEqual(['Escribe un monto'])
    expect(malas({ amount: '1.234' })).toEqual(['El monto admite hasta 2 decimales'])
    expect(malas({ reason: 'x' })).toEqual(['Escribe el motivo (mínimo 3 letras)'])
    expect(malas({ sede: 'b' })).toEqual(['Sede inválida'])
    expect(malas({ fecha: '20-oct' })).toEqual(['Fecha inválida (AAAA-MM-DD)'])
  })
})

describe('Controller: sólo sus campos (nada de `ahora`, `soloSedes` ni `entreLecturas` desde la petición)', () => {
  const req = (extra: Record<string, unknown> = {}) =>
    ({ params: { venueId: 'v1' }, query: {}, body: {}, authContext: { userId: 'u1' }, ...extra }) as any
  const res = () => ({ json: jest.fn() }) as any

  it('GET /sedes', async () => {
    ;(estadoSedes as jest.Mock).mockResolvedValue({ activado: true, sedes: [] })
    const r = res()
    await controller.getSedes(req({ query: { ahora: 'x', soloSedes: ['b'] } }), r, jest.fn())
    expect(estadoSedes).toHaveBeenCalledWith({ venueId: 'v1', userId: 'u1' })
    expect(r.json).toHaveBeenCalledWith({ activado: true, sedes: [] })
  })

  it('GET /adjustments/preview', async () => {
    ;(previewAjusteManual as jest.Mock).mockResolvedValue({ avisoPendientes: { n: 0 } })
    const q = { sede: 'b', staffId: 'p', amount: -50, reason: 'Devolución', fecha: '2026-10-20', ahora: 'x', soloSedes: ['b'] }
    await controller.getAdjustmentPreview(req({ query: q }), res(), jest.fn())
    expect(previewAjusteManual).toHaveBeenCalledWith({
      venueId: 'v1',
      userId: 'u1',
      sede: 'b',
      staffId: 'p',
      amount: -50,
      reason: 'Devolución',
      fecha: '2026-10-20',
    })
  })

  it('un error del service va a next', async () => {
    const err = Object.assign(new Error('Demasiadas sedes'), { statusCode: 400, code: 'DEMASIADAS_SEDES' })
    ;(estadoSedes as jest.Mock).mockRejectedValue(err)
    const next = jest.fn()
    await controller.getSedes(req(), res(), next)
    expect(next).toHaveBeenCalledWith(err)
  })
})
