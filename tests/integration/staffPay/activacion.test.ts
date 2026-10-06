// tests/integration/staffPay/activacion.test.ts
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import {
  activarPagoAlPersonal,
  cambiarPropinas,
  estadoActivacion,
  ventanasDePropinas,
} from '@/services/dashboard/staffPay/activacion.service'
import { barreraDeLaOrganizacion, borrarMundo, crearMundo, Mundo, periodoCerrado } from './_mundo'

const mockPermiso = jest.fn()
jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  assertPermisoEnTodasLasSedes: (...a: unknown[]) => mockPermiso(...a),
}))

let m: Mundo
beforeEach(async () => {
  m = await crearMundo('activacion')
  mockPermiso.mockReset().mockResolvedValue(undefined)
})
afterEach(() => borrarMundo(m))

const activar = (periodicidad: 'MONTHLY' | 'SEMIMONTHLY', iso: string) =>
  activarPagoAlPersonal({ userId: m.owner, venueId: m.venueId, periodicidad, ahora: new Date(iso) })
const propinas = (encender: boolean, iso: string) =>
  cambiarPropinas({ userId: m.owner, venueId: m.venueId, encender, ahora: new Date(iso) })
const logs = (action: string) => prisma.activityLog.count({ where: { action, entityId: m.orgId } })
const periodicidad = async () =>
  (await prisma.organization.findUniqueOrThrow({ where: { id: m.orgId }, select: { servicePayPeriodicity: true } })).servicePayPeriodicity

describe('activar pago al personal (spec fase 3 §7.1, Codex r1-9)', () => {
  it('sin activar, el estado lo dice', async () => {
    expect(await estadoActivacion(prisma, m.orgId)).toEqual({ activado: false, startDate: null, propinasEncendidas: false })
  })

  it('quincenal el 20-sep: empieza el 16-sep, guarda la periodicidad y audita dentro de la transacción', async () => {
    expect(await activar('SEMIMONTHLY', '2026-09-20T18:00:00Z')).toEqual({ startDate: '2026-09-16', yaActivado: false })
    expect(await periodicidad()).toBe('SEMIMONTHLY')
    expect(await estadoActivacion(prisma, m.orgId)).toEqual({ activado: true, startDate: '2026-09-16', propinasEncendidas: false })
    expect(await logs('SERVICE_PAY_ACTIVATED')).toBe(1)
    expect(mockPermiso).toHaveBeenCalledWith(m.owner, m.orgId, 'staffpay:close')
  })

  it('elegir la mensual de fábrica TAMBIÉN activa (antes elegir «mensual» no activaba nada)', async () => {
    expect(await activar('MONTHLY', '2026-09-20T18:00:00Z')).toEqual({ startDate: '2026-09-01', yaActivado: false })
  })

  it('dos veces es idempotente: misma fecha, la periodicidad no cambia y un solo ActivityLog', async () => {
    await activar('SEMIMONTHLY', '2026-09-20T18:00:00Z')
    expect(await activar('MONTHLY', '2026-10-05T18:00:00Z')).toEqual({ startDate: '2026-09-16', yaActivado: true })
    expect(await periodicidad()).toBe('SEMIMONTHLY')
    expect(await logs('SERVICE_PAY_ACTIVATED')).toBe(1)
  })

  it('el inicio se toma en la zona de la sede: el 1-oct a las 03:00 UTC todavía es septiembre en CDMX', async () => {
    expect(await activar('MONTHLY', '2026-10-01T03:00:00Z')).toMatchObject({ startDate: '2026-09-01' })
  })

  it('con periodos guardados no se cambia la periodicidad al activar; con la misma, sí activa', async () => {
    await periodoCerrado(m, '2026-08-01', '2026-08-31')
    await expect(activar('SEMIMONTHLY', '2026-09-20T18:00:00Z')).rejects.toMatchObject({ statusCode: 409, code: 'PERIODICIDAD_FIJA' })
    expect((await estadoActivacion(prisma, m.orgId)).activado).toBe(false)
    expect(await activar('MONTHLY', '2026-09-20T18:00:00Z')).toEqual({ startDate: '2026-09-01', yaActivado: false })
  })

  it('sin staffpay:close en todas las sedes no activa nada', async () => {
    mockPermiso.mockRejectedValueOnce(
      new ForbiddenError('Esta acción afecta a toda la organización: necesitas staffpay:close en todas las sedes'),
    )
    await expect(activar('MONTHLY', '2026-09-20T18:00:00Z')).rejects.toBeInstanceOf(ForbiddenError)
    expect((await estadoActivacion(prisma, m.orgId)).activado).toBe(false)
    expect(await logs('SERVICE_PAY_ACTIVATED')).toBe(0)
  })

  it('espera el candado de periodos de la organización: un cierre que está creando periodos va primero', async () => {
    const b = await barreraDeLaOrganizacion(m.orgId)
    try {
      const enCurso = activar('MONTHLY', '2026-09-20T18:00:00Z')
      await b.esperarA(1)
      expect((await estadoActivacion(prisma, m.orgId)).activado).toBe(false)
      await b.soltar()
      expect(await enCurso).toEqual({ startDate: '2026-09-01', yaActivado: false })
    } finally {
      await b.soltar()
    }
  })
})

describe('interruptor de propinas (spec fase 3 §7.1, Codex r1-5)', () => {
  it('sin activar pago al personal no se prende', async () => {
    await expect(propinas(true, '2026-09-20T18:00:00Z')).rejects.toMatchObject({ statusCode: 409, code: 'NO_ACTIVADO' })
    expect(await prisma.staffPayTipWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
  })

  it('sin staffpay:close en todas las sedes no se prende ni se audita', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    mockPermiso.mockRejectedValueOnce(
      new ForbiddenError('Esta acción afecta a toda la organización: necesitas staffpay:close en todas las sedes'),
    )
    await expect(propinas(true, '2026-09-03T18:00:00Z')).rejects.toBeInstanceOf(ForbiddenError)
    expect(mockPermiso).toHaveBeenLastCalledWith(m.owner, m.orgId, 'staffpay:close')
    expect(await prisma.staffPayTipWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
    expect(await logs('SERVICE_PAY_TIPS_SET')).toBe(0)
  })

  it('espera el candado de periodos de la organización, como activar', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    const b = await barreraDeLaOrganizacion(m.orgId)
    try {
      const enCurso = propinas(true, '2026-09-03T18:00:00Z')
      await b.esperarA(1)
      expect((await estadoActivacion(prisma, m.orgId)).propinasEncendidas).toBe(false)
      await b.soltar()
      expect(await enCurso).toEqual({ encendidas: true })
    } finally {
      await b.soltar()
    }
  })

  it('prender, prender, apagar, apagar: UNA ventana [inicio, fin) con quién y cuándo, y sólo dos ActivityLog', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    expect(await propinas(true, '2026-09-03T18:00:00Z')).toEqual({ encendidas: true })
    expect(await propinas(true, '2026-09-04T18:00:00Z')).toEqual({ encendidas: true })
    expect((await estadoActivacion(prisma, m.orgId)).propinasEncendidas).toBe(true)
    expect(await propinas(false, '2026-09-10T18:00:00Z')).toEqual({ encendidas: false })
    expect(await propinas(false, '2026-09-11T18:00:00Z')).toEqual({ encendidas: false })
    const v = await prisma.staffPayTipWindow.findMany({ where: { organizationId: m.orgId }, take: 10 })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({
      startsAt: new Date('2026-09-03T18:00:00Z'),
      endsAt: new Date('2026-09-10T18:00:00Z'),
      startedById: m.owner,
      endedById: m.owner,
    })
    expect(await logs('SERVICE_PAY_TIPS_SET')).toBe(2)
  })

  it('volver a prender abre OTRA ventana (lo de en medio no entra); las ventanas se listan, la más nueva primero', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    await propinas(true, '2026-09-03T18:00:00Z')
    await propinas(false, '2026-09-10T18:00:00Z')
    await propinas(true, '2026-09-20T18:00:00Z')
    expect(await ventanasDePropinas(m.orgId)).toEqual([
      { desde: '2026-09-20T18:00:00.000Z', hasta: null },
      { desde: '2026-09-03T18:00:00.000Z', hasta: '2026-09-10T18:00:00.000Z' },
    ])
  })
})
