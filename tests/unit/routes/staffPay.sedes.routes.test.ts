// tests/unit/routes/staffPay.sedes.routes.test.ts — fase 3, B11 (diseño r3.7, r4.7, r7.3): activar o desactivar UNA sede y su
// vista previa con montos. Puertas, permisos, validación (español) y que el controller pasa sólo sus campos.
import * as schemas from '@/schemas/dashboard/staffPay.schema'

jest.mock('@/services/dashboard/staffPay/participacion', () => ({ activarSede: jest.fn(), desactivarSede: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/participacion.vistaPrevia', () => ({ vistaPreviaParticipacion: jest.fn() }))
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  venueHasServicePayAccess: jest.fn(),
  organizacionTieneServicePay: jest.fn(),
}))

import * as participacion from '@/services/dashboard/staffPay/participacion'
import { vistaPreviaParticipacion } from '@/services/dashboard/staffPay/participacion.vistaPrevia'
import * as controller from '@/controllers/dashboard/staffPay.dashboard.controller'
import router from '@/routes/dashboard/staffPay.routes'

const SEDE = 'ckvenue00000000000000000009'
const VENUE = 'ckvenue00000000000000000001'

describe('Zod de activar / desactivar UNA sede (sólo forma, en español)', () => {
  it('fechas opcionales con forma de día; un campo de más es 400', () => {
    expect(schemas.activarSedeSchema.safeParse({}).success).toBe(true)
    expect(schemas.activarSedeSchema.safeParse({ desde: '2026-10-01', fechaEsperada: '2026-10-20' }).success).toBe(true)
    expect(schemas.desactivarSedeSchema.safeParse({ hasta: '2026-10-15', fechaEsperada: '2026-10-20' }).success).toBe(true)
    const mala = schemas.activarSedeSchema.safeParse({ desde: '1-oct' })
    expect(mala.success).toBe(false)
    if (!mala.success) expect(mala.error.errors.map(e => e.message)).toEqual(['Fecha inválida (AAAA-MM-DD)'])
    const deMas = schemas.desactivarSedeSchema.safeParse({ hasta: '2026-10-15', desde: '2026-10-01' })
    expect(deMas.success).toBe(false)
    if (!deMas.success) expect(deMas.error.errors.map(e => e.message)).toEqual(['Hay un campo que desactivar la sede no acepta'])
    const sinSede = schemas.sedeParamsSchema.safeParse({ venueId: VENUE, sedeId: 'b' })
    expect(sinSede.success).toBe(false)
    if (!sinSede.success) expect(sinSede.error.errors.map(e => e.message)).toEqual(['Sede inválida'])
  })
  it('la vista previa pide la acción', () => {
    expect(schemas.vistaPreviaSedeQuerySchema.safeParse({ accion: 'activar' }).success).toBe(true)
    expect(schemas.vistaPreviaSedeQuerySchema.safeParse({ accion: 'desactivar', fecha: '2026-10-15' }).success).toBe(true)
    const mala = schemas.vistaPreviaSedeQuerySchema.safeParse({ accion: 'borrar' })
    expect(mala.success).toBe(false)
    if (!mala.success) expect(mala.error.errors.map(e => e.message)).toEqual(['Elige activar o desactivar'])
  })
})

describe('Rutas por sede (B11, r4.7): puertas y permisos', () => {
  const stack: any[] = (router as any).stack
  const gate = stack.findIndex(l => !l.route && l.handle?.name === 'servicePayGate')
  const ruta = (method: string, path: string) => stack.findIndex(l => l.route?.path === path && l.route.methods[method])
  const capas = (i: number) => stack[i].route.stack.map((l: any) => l.handle)
  const permiso = (i: number) =>
    capas(i)
      .map((h: any) => h?.requiredPermission)
      .find(Boolean)
  const nombres = (i: number) => capas(i).map((h: any) => h?.name)

  it('desactivar y la vista previa van ANTES del gate de plan y sin puerta de plan: desactivar es la salida del bloqueo', () => {
    const des = ruta('post', '/sedes/:sedeId/deactivate')
    const pv = ruta('get', '/sedes/:sedeId/participation-preview')
    expect(gate).toBeGreaterThan(-1)
    for (const i of [des, pv]) {
      expect(i).toBeGreaterThan(-1)
      expect(i).toBeLessThan(gate)
      expect(nombres(i)).not.toContain('servicePayGate')
      expect(nombres(i)).not.toContain('servicePayGateOrganizacion')
    }
    expect(permiso(des)).toBe('staffpay:close')
    expect(permiso(pv)).toBe('staffpay:read')
  })

  it('activar va con la puerta de plan de la ORGANIZACIÓN y staffpay:close (el service exige el plan en la sede)', () => {
    const act = ruta('post', '/sedes/:sedeId/activate')
    expect(act).toBeGreaterThan(-1)
    expect(act).toBeLessThan(gate)
    expect(nombres(act)[0]).toBe('servicePayGateOrganizacion')
    expect(permiso(act)).toBe('staffpay:close')
  })

  it('la validación de la ruta corta una sede mal formada o un campo de más antes del controller', async () => {
    const act = ruta('post', '/sedes/:sedeId/activate')
    const validar = capas(act)[capas(act).findIndex((h: any) => h?.requiredPermission) + 1]
    const next = jest.fn()
    await validar({ params: { venueId: VENUE, sedeId: 'x' }, query: {}, body: {} }, {}, next)
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400, message: expect.stringMatching(/Sede inválida/) }))
    const otro = jest.fn()
    await validar({ params: { venueId: VENUE, sedeId: SEDE }, query: {}, body: { ahora: '2020-01-01' } }, {}, otro)
    expect(otro).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 400 }))
    const ok = jest.fn()
    await validar({ params: { venueId: VENUE, sedeId: SEDE }, query: {}, body: { desde: '2026-10-01' } }, {}, ok)
    expect(ok).toHaveBeenCalledWith()
  })
})

describe('Controller por sede: sólo sus campos (nada de `ahora` desde la petición)', () => {
  const req = (extra: Record<string, unknown> = {}) =>
    ({ params: { venueId: 'v1', sedeId: 'b' }, query: {}, body: {}, authContext: { userId: 'u1' }, ...extra }) as any
  const res = () => ({ json: jest.fn() }) as any

  it('activar, desactivar y la vista previa', async () => {
    ;(participacion.activarSede as jest.Mock).mockResolvedValue({ ventana: { venueId: 'b', desde: '2026-10-01', hasta: null } })
    ;(participacion.desactivarSede as jest.Mock).mockResolvedValue({ ventana: null })
    ;(vistaPreviaParticipacion as jest.Mock).mockResolvedValue({ accion: 'activar' })
    const r = res()
    await controller.postActivateSede(req({ body: { desde: '2026-10-01', fechaEsperada: '2026-10-20', ahora: 'x' } }), r, jest.fn())
    expect(participacion.activarSede).toHaveBeenCalledWith({
      venueId: 'v1',
      userId: 'u1',
      sedeId: 'b',
      desde: '2026-10-01',
      fechaEsperada: '2026-10-20',
    })
    expect(r.json).toHaveBeenCalledWith({ ventana: { venueId: 'b', desde: '2026-10-01', hasta: null } })
    await controller.postDeactivateSede(req({ body: { hasta: '2026-10-15', ahora: 'x' } }), res(), jest.fn())
    expect(participacion.desactivarSede).toHaveBeenCalledWith({ venueId: 'v1', userId: 'u1', sedeId: 'b', hasta: '2026-10-15' })
    await controller.getParticipationPreview(req({ query: { accion: 'desactivar', fecha: '2026-10-15', ahora: 'x' } }), res(), jest.fn())
    expect(vistaPreviaParticipacion).toHaveBeenCalledWith({
      venueId: 'v1',
      userId: 'u1',
      sedeId: 'b',
      accion: 'desactivar',
      fecha: '2026-10-15',
    })
  })

  it('un error del service (403, 409 VENTANA_SE_CRUZA…) va a next', async () => {
    const err = Object.assign(new Error('Esas fechas se cruzan'), { statusCode: 409, code: 'VENTANA_SE_CRUZA' })
    ;(participacion.activarSede as jest.Mock).mockRejectedValue(err)
    const next = jest.fn()
    await controller.postActivateSede(req({ body: {} }), res(), next)
    expect(next).toHaveBeenCalledWith(err)
  })
})
