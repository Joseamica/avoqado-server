// tests/integration/staffPay/activacion.reloj.test.ts — fase 3, B14-fix F5 (Codex participación r1 #5, preexistente): las escrituras
// de la organización deciden con el reloj DESPUÉS de tomar su candado, como `activarSede` (B11). Activar: una confirmación del
// 30-sep a las 23:59:59.7 (CDMX) con `inicioEsperado` = 1-sep que obtiene el candado el 1-oct a las 00:00:02 ⇒ 409 INICIO_CAMBIO y
// nada escrito (antes: activaba desde el 1-sep). Hermano, las propinas: la ventana empieza o termina en el instante en que se
// obtuvo el candado, no en el de la petición. Reloj simulado SÓLO en `Date` (los temporizadores reales: la barrera los usa).
import prisma from '@/utils/prismaClient'
import { activarPagoAlPersonal, cambiarPropinas, estadoActivacion } from '@/services/dashboard/staffPay/activacion.service'
import { barreraDeLaOrganizacion, borrarMundo, crearMundo, Mundo } from './_mundo'

jest.mock('@/services/dashboard/staffPay/acceso', () => ({
  ...jest.requireActual('@/services/dashboard/staffPay/acceso'),
  assertPermisoEnTodasLasSedes: jest.fn(async () => undefined),
  sedesConServicePay: jest.fn(async () => (global as any).__sedes),
}))

let m: Mundo
beforeEach(async () => {
  m = await crearMundo('activacion-reloj')
  ;(global as any).__sedes = [m.venueId]
})
afterEach(async () => {
  jest.useRealTimers()
  await borrarMundo(m)
})

/** Sólo `Date` es simulado: los temporizadores, `nextTick` y las promesas siguen reales (Prisma y la barrera los usan). */
const relojEn = (iso: string) =>
  jest.useFakeTimers({
    now: new Date(iso),
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  })
const resultado = <T>(p: Promise<T>) =>
  p.then(
    valor => ({ valor, error: null as any }),
    (error: unknown) => ({ valor: null, error: error as any }),
  )
const logs = (action: string) => prisma.activityLog.count({ where: { action, entityId: m.orgId } })

/** Corre `operacion` detenida en el candado de periodos de la organización; con ella esperando, el reloj pasa a `despues`. */
async function conElRelojMoviendoseEnElCandado<T>(operacion: () => Promise<T>, despues: string) {
  const b = await barreraDeLaOrganizacion(m.orgId)
  try {
    const enCurso = resultado(operacion())
    await b.esperarA(1)
    jest.setSystemTime(new Date(despues))
    await b.soltar()
    return await enCurso
  } finally {
    await b.soltar()
  }
}

describe('B14-fix F5: el reloj se lee bajo el candado', () => {
  it('activar: vista previa el 30-sep 23:59:59.7 (1-sep), candado el 1-oct 00:00:02 ⇒ 409 INICIO_CAMBIO y nada escrito', async () => {
    relojEn('2026-10-01T05:59:59.700Z') // 23:59:59.7 del 30-sep en CDMX
    const r = await conElRelojMoviendoseEnElCandado(
      () => activarPagoAlPersonal({ userId: m.owner, venueId: m.venueId, periodicidad: 'MONTHLY', inicioEsperado: '2026-09-01' }),
      '2026-10-01T06:00:02.000Z', // 00:00:02 del 1-oct en CDMX
    )
    expect(r.valor).toBeNull()
    expect(r.error).toMatchObject({ statusCode: 409, code: 'INICIO_CAMBIO' })
    jest.useRealTimers()
    expect(await estadoActivacion(prisma, m.orgId)).toEqual({ activado: false, startDate: null, propinasEncendidas: false })
    expect(await prisma.staffPayVenueWindow.count({ where: { organizationId: m.orgId } })).toBe(0)
    expect(await logs('SERVICE_PAY_ACTIVATED')).toBe(0)
  }, 60_000)

  it('activar con la fecha que corresponde al día del candado (1-oct) sí activa desde el 1-oct', async () => {
    relojEn('2026-10-01T05:59:59.700Z')
    const r = await conElRelojMoviendoseEnElCandado(
      () => activarPagoAlPersonal({ userId: m.owner, venueId: m.venueId, periodicidad: 'MONTHLY', inicioEsperado: '2026-10-01' }),
      '2026-10-01T06:00:02.000Z',
    )
    expect(r.error).toBeNull()
    expect(r.valor).toEqual({ startDate: '2026-10-01', yaActivado: false })
  }, 60_000)

  it('propinas: la ventana se abre en el instante en que se obtuvo el candado, no en el de la petición', async () => {
    await activarPagoAlPersonal({ userId: m.owner, venueId: m.venueId, periodicidad: 'MONTHLY', ahora: new Date('2026-10-01T18:00:00Z') })
    relojEn('2026-10-07T18:00:00.000Z')
    const r = await conElRelojMoviendoseEnElCandado(
      () => cambiarPropinas({ userId: m.owner, venueId: m.venueId, encender: true }),
      '2026-10-07T18:00:05.000Z',
    )
    expect(r.valor).toEqual({ encendidas: true, cambio: true })
    jest.useRealTimers()
    const v = await prisma.staffPayTipWindow.findMany({ where: { organizationId: m.orgId }, take: 10 })
    expect(v.map(w => [w.startsAt.toISOString(), w.endsAt])).toEqual([['2026-10-07T18:00:05.000Z', null]])
  }, 60_000)
})
