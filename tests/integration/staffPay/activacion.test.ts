// tests/integration/staffPay/activacion.test.ts
import prisma from '@/utils/prismaClient'
import { ForbiddenError } from '@/errors/AppError'
import {
  activarPagoAlPersonal,
  cambiarPropinas,
  estadoActivacion,
  previewActivacion,
  ventanasDePropinas,
} from '@/services/dashboard/staffPay/activacion.service'
import { cambiarPeriodicidad, lockPeriodosDeOrganizacion } from '@/services/dashboard/staffPay/periodosGuardados'
import { barreraDeLaOrganizacion, borrarMundo, CIERRE_EN_CURSO, conCandadoRetenido, crearMundo, Mundo, periodoCerrado } from './_mundo'

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

  it('si el periodo que contiene «hoy» ya está CERRADO, empieza el día siguiente a su fin: nunca promete barrer lo cerrado (spec §7.1)', async () => {
    await periodoCerrado(m, '2026-09-01', '2026-09-30')
    expect(await activar('MONTHLY', '2026-09-20T18:00:00Z')).toEqual({ startDate: '2026-10-01', yaActivado: false })
    expect(await estadoActivacion(prisma, m.orgId)).toMatchObject({ activado: true, startDate: '2026-10-01' })
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
      expect(await enCurso).toEqual({ encendidas: true, cambio: true })
    } finally {
      await b.soltar()
    }
  })

  it('prender, prender, apagar, apagar: UNA ventana [inicio, fin) con quién y cuándo, y sólo dos ActivityLog', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    expect(await propinas(true, '2026-09-03T18:00:00Z')).toEqual({ encendidas: true, cambio: true })
    expect(await propinas(true, '2026-09-04T18:00:00Z')).toEqual({ encendidas: true, cambio: false })
    expect((await estadoActivacion(prisma, m.orgId)).propinasEncendidas).toBe(true)
    expect(await propinas(false, '2026-09-10T18:00:00Z')).toEqual({ encendidas: false, cambio: true })
    expect(await propinas(false, '2026-09-11T18:00:00Z')).toEqual({ encendidas: false, cambio: false })
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

  it('apagar con un reloj anterior al inicio de la ventana (reintento o desfase entre instancias) no truena: queda vacía [inicio, inicio)', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    await propinas(true, '2026-09-10T18:00:00Z')
    expect(await propinas(false, '2026-09-10T17:59:59Z')).toEqual({ encendidas: false, cambio: true })
    const v = await prisma.staffPayTipWindow.findMany({ where: { organizationId: m.orgId }, take: 10 })
    expect(v).toHaveLength(1)
    expect(v[0]).toMatchObject({ startsAt: new Date('2026-09-10T18:00:00Z'), endsAt: new Date('2026-09-10T18:00:00Z'), endedById: m.owner })
  })

  it('el límite de la lista: un número que no es entero usa 20 y el tope es 100', async () => {
    const base = Date.parse('2026-01-01T00:00:00Z')
    await prisma.staffPayTipWindow.createMany({
      data: Array.from({ length: 101 }, (_, i) => ({
        organizationId: m.orgId,
        startsAt: new Date(base + i * 3_600_000),
        endsAt: new Date(base + i * 3_600_000 + 60_000),
        startedById: m.owner,
        endedById: m.owner,
      })),
    })
    expect(await ventanasDePropinas(m.orgId, NaN)).toHaveLength(20)
    expect(await ventanasDePropinas(m.orgId, 2.5)).toHaveLength(20)
    expect(await ventanasDePropinas(m.orgId, 1000)).toHaveLength(100)
    expect(await ventanasDePropinas(m.orgId, 0)).toHaveLength(1)
  })
})

describe('vista previa de activar (B6 ronda 1): lo mismo que haría activar, sin escribir', () => {
  const plan = (periodicidad: 'MONTHLY' | 'SEMIMONTHLY', iso: string) =>
    previewActivacion({ venueId: m.venueId, periodicidad, ahora: new Date(iso) })

  it('sin periodos guardados: la periodicidad no es fija, el inicio es el del periodo de hoy y no escribe nada', async () => {
    expect(await plan('SEMIMONTHLY', '2026-09-20T18:00:00Z')).toEqual({
      periodicidad: 'MONTHLY',
      periodicidadFija: false,
      startDate: '2026-09-16',
    })
    expect(await estadoActivacion(prisma, m.orgId)).toEqual({ activado: false, startDate: null, propinasEncendidas: false })
    expect(await periodicidad()).toBe('MONTHLY')
    expect(await logs('SERVICE_PAY_ACTIVATED')).toBe(0)
  })

  it('con periodos guardados en MONTHLY dice que la periodicidad ya es fija', async () => {
    await periodoCerrado(m, '2026-08-01', '2026-08-31')
    expect(await plan('SEMIMONTHLY', '2026-09-20T18:00:00Z')).toMatchObject({ periodicidad: 'MONTHLY', periodicidadFija: true })
  })

  it('si el periodo de hoy ya está cerrado, la fecha es la del día siguiente a su fin: la misma que da activar', async () => {
    await periodoCerrado(m, '2026-09-01', '2026-09-30')
    expect(await plan('MONTHLY', '2026-09-20T18:00:00Z')).toEqual({
      periodicidad: 'MONTHLY',
      periodicidadFija: true,
      startDate: '2026-10-01',
    })
    expect(await activar('MONTHLY', '2026-09-20T18:00:00Z')).toEqual({ startDate: '2026-10-01', yaActivado: false })
  })
})

/**
 * B7 ronda 1: un cierre retiene el candado de periodos de la organización todo lo que dura (~42 s con 150,000 líneas). Las
 * operaciones CORTAS que lo piden esperan con tope y, si vence, contestan 409 CIERRE_EN_CURSO: nunca el P2028 de su
 * transacción de 10 s (un 500). La barrera hace de cierre y retiene el candado 30 s (mucho más que el tope de 5 s); si una
 * espera SIN tope la dejara pasar, `ms` rebasaría el techo y la prueba caería en vez de colgarse.
 */
describe('con un cierre en curso, las operaciones cortas no esperan sin tope (B7 r1)', () => {
  const conCierreEnCurso = async (operacion: () => Promise<unknown>) =>
    conCandadoRetenido(await barreraDeLaOrganizacion(m.orgId), operacion)

  it('activar contesta 409 CIERRE_EN_CURSO a los ~5 s y no activa nada', async () => {
    const r = await conCierreEnCurso(() => activar('MONTHLY', '2026-09-20T18:00:00Z'))
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeGreaterThanOrEqual(4_500)
    expect(r.ms).toBeLessThan(25_000)
    expect(await estadoActivacion(prisma, m.orgId)).toMatchObject({ activado: false })
    expect(await logs('SERVICE_PAY_ACTIVATED')).toBe(0)
  }, 60_000)

  it('cambiar las propinas contesta 409 CIERRE_EN_CURSO a los ~5 s y no abre ventana', async () => {
    await activar('MONTHLY', '2026-09-01T18:00:00Z')
    const r = await conCierreEnCurso(() => propinas(true, '2026-09-03T18:00:00Z'))
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeGreaterThanOrEqual(4_500)
    expect(r.ms).toBeLessThan(25_000)
    expect(await prisma.staffPayTipWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
    expect(await logs('SERVICE_PAY_TIPS_SET')).toBe(0)
  }, 60_000)

  it('cambiar la periodicidad también (el mismo candado)', async () => {
    const r = await conCierreEnCurso(() => cambiarPeriodicidad({ userId: m.owner, venueId: m.venueId, periodicidad: 'SEMIMONTHLY' }))
    expect(r.error).toMatchObject(CIERRE_EN_CURSO)
    expect(r.ms).toBeGreaterThanOrEqual(4_500)
    expect(r.ms).toBeLessThan(25_000)
    expect(await periodicidad()).toBe('MONTHLY')
  }, 60_000)

  it('después, la espera queda como estaba: el resto de la transacción no hereda el tope', async () => {
    // Activa con el candado libre y, dentro de la misma tx, el `lock_timeout` vuelve al de la sesión (0 = sin tope).
    await activar('MONTHLY', '2026-09-20T18:00:00Z')
    const [{ lt }] = await prisma.$transaction(async tx => {
      await lockPeriodosDeOrganizacion(tx, m.orgId)
      return tx.$queryRaw<Array<{ lt: string }>>`SELECT current_setting('lock_timeout') AS lt`
    })
    expect(lt).toBe('0')
  })
})
