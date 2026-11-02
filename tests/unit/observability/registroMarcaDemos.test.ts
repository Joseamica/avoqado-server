/**
 * Los 6 negocios demo de prospectos se llaman normal («Café Tostado», «Lunaria Boutique») y escriben en el mismo registro
 * que los negocios reales. El founder (1-nov): «cuidado con las alertas de los demos, que no se confundan con productivas».
 * El formateador del registro marca «🧪 DEMO ·» y `demo: true` SÓLO lo que un job hace para un negocio demo
 * (`conNegocio`). La sesión no marca: Codex r1-r5 mostró que quien hizo la petición no dice de qué negocio es la línea, y
 * un real marcado como demo es peor que un demo sin marca (founder, 2-nov: «sólo el sistema»). Un id o un nombre en los
 * campos tampoco: un negocio real puede llamarse igual.
 */
import winston, { type Logform } from 'winston'
import TransportStream from 'winston-transport'
import prisma from '@/utils/prismaClient'
import { capturarContextoAlLlamar, contextFormat } from '@/observability/logContext'
import { runWithContext } from '@/observability/executionContext'
import { primeVenueNames, __resetVenueNameCacheForTests } from '@/observability/venueNames'
import { marcarNegocioDemo } from '@/observability/demoVenueIds'

const prismaMock = prisma as unknown as { venue: { findMany: jest.Mock } }

const apply = (info: Partial<Logform.TransformableInfo>): Record<string, unknown> =>
  contextFormat().transform(info as Logform.TransformableInfo) as unknown as Record<string, unknown>

const DEMO = 'cdemo000000000000000000aa'
const REAL = 'creal000000000000000000aa'
const USUARIO_DEMO = 'cusuariodemo0000000000aa'
const PERSONA_REAL = 'cpersonareal0000000000aa'
const sesion = (userId: string, venueId: string, role = 'OWNER') => ({
  correlationId: 'c',
  source: 'http' as const,
  entrypoint: 'POST /x',
  venueId,
  userId,
  role,
})
const job = (negocioFijado: string) => ({
  correlationId: 'c',
  source: 'job' as const,
  entrypoint: 'x',
  venueId: negocioFijado,
  negocioFijado,
})

beforeEach(async () => {
  __resetVenueNameCacheForTests()
  prismaMock.venue.findMany.mockReset()
  prismaMock.venue.findMany.mockResolvedValue([
    { id: DEMO, name: 'Café Tostado', status: 'LIVE_DEMO' },
    { id: REAL, name: 'Testarudo Cafe', status: 'ACTIVE' },
  ])
  await primeVenueNames()
})

it('🔴 lo que un job fija para un negocio demo sale marcado', () => {
  runWithContext(job(DEMO), () => {
    const r = apply({ level: 'error', message: '❌ [CLEANUP] Could not delete abandoned order CAFE-0012' })
    expect(r.demo).toBe(true)
    expect(r.message).toBe('🧪 DEMO · ❌ [CLEANUP] Could not delete abandoned order CAFE-0012')
  })
})

it('🔴 la sesión NO marca, ni la de un usuario demo en su demo: quien pide no dice de qué negocio es la línea (Codex r5)', () => {
  runWithContext(sesion(USUARIO_DEMO, DEMO), () => {
    const r = apply({ level: 'error', message: 'Error recording upsell impression' })
    expect(r.demo).toBeUndefined()
    expect(r.message).toBe('Error recording upsell impression')
  })
})

it('🔴 un SUPERADMIN con el demo abierto que opera un negocio real NO marca, ni con el id del demo en los campos (Codex r2)', () => {
  runWithContext(sesion(PERSONA_REAL, DEMO, 'SUPERADMIN'), () => {
    const r = apply({ level: 'info', message: 'Request End POST /superadmin/kyc/x/approve - 500', venueId: DEMO })
    expect(r.demo).toBeUndefined()
    expect(r.message).toBe('Request End POST /superadmin/kyc/x/approve - 500')
  })
})

it('🔴 un id o un nombre de demo en los campos, sin job demo, NO marca (Codex r1)', () => {
  expect(apply({ level: 'error', message: '🚨 sobrepago', venueId: DEMO, venueName: 'Café Tostado' }).demo).toBeUndefined()
})

it('regresión: un job de un negocio real no cambia, aunque lo dispare un usuario demo', () => {
  runWithContext({ ...sesion(USUARIO_DEMO, DEMO), negocioFijado: REAL }, () => {
    const r = apply({ level: 'error', message: '🚨 sobrepago' })
    expect(r.demo).toBeUndefined()
    expect(r.message).toBe('🚨 sobrepago')
  })
})

it('no se marca dos veces un mensaje que ya dice que es demo', () => {
  runWithContext(job(DEMO), () => {
    expect(apply({ level: 'error', message: '🚨 Negocio demo «Café Tostado» no se pudo sembrar' }).message).toBe(
      '🚨 Negocio demo «Café Tostado» no se pudo sembrar',
    )
  })
})

it('🔴 el negocio que crea el reinicio de las 3:00 se marca desde su primera línea, sin esperar la recarga', () => {
  const NUEVO = 'cnuevo00000000000000000aa'
  marcarNegocioDemo(NUEVO)
  runWithContext(job(NUEVO), () => {
    expect(apply({ level: 'error', message: 'x' }).demo).toBe(true)
  })
})

it('lo marcado por la semilla no lo borra una recarga que ya había salido antes de crearlo', async () => {
  const NUEVO = 'cnuevo00000000000000000bb'
  marcarNegocioDemo(NUEVO)
  await primeVenueNames() // la consulta simulada no trae el negocio nuevo
  runWithContext(job(NUEVO), () => {
    expect(apply({ level: 'error', message: 'x' }).demo).toBe(true)
  })
})

it('un negocio que deja de ser demo deja de marcarse en la siguiente recarga', async () => {
  prismaMock.venue.findMany.mockResolvedValue([{ id: DEMO, name: 'Café Tostado', status: 'ACTIVE' }])
  await primeVenueNames()
  runWithContext(job(DEMO), () => expect(apply({ level: 'error', message: 'x' }).demo).toBeUndefined())
})

it('🔴 Codex r3 · una línea demo que atora la salida no marca como demo las líneas reales que esperan detrás (D3)', async () => {
  const lineas: Record<string, unknown>[] = []
  class Lento extends TransportStream {
    log(info: Record<string, unknown>, listo: () => void) {
      lineas.push(info)
      setTimeout(listo, 2)
    }
  }
  const logger = capturarContextoAlLlamar(winston.createLogger({ transports: [new Lento({ format: contextFormat() })] }))

  runWithContext(job(DEMO), () => logger.error('limpieza del prospecto'))
  for (let i = 0; i < 5; i++) runWithContext(job(REAL), () => logger.error(`alerta real ${i}`))
  runWithContext(job(DEMO), () => logger.error('job nocturno'))
  while (lineas.length < 7) await new Promise(r => setTimeout(r, 5))

  const reales = lineas.filter(l => l.venueId === REAL)
  expect(reales).toHaveLength(5)
  for (const l of reales) {
    expect(l.demo).toBeUndefined()
    expect(l.message).not.toContain('DEMO')
  }
  expect(lineas.filter(l => l.demo === true).map(l => l.message)).toEqual(['🧪 DEMO · limpieza del prospecto', '🧪 DEMO · job nocturno'])
})
