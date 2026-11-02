/**
 * Los 6 negocios demo de prospectos se llaman normal («Café Tostado», «Lunaria Boutique») y escriben en el mismo registro
 * que los negocios reales. El founder (1-nov): «cuidado con las alertas de los demos, que no se confundan con productivas».
 * El formateador del registro marca «🧪 DEMO ·» y `demo: true` SÓLO lo que con certeza generó un demo: un job que fijó un
 * negocio demo (`conNegocio`) o la sesión de un usuario demo. Codex r1 y r2 mostraron que el negocio del token o un id en
 * los campos pueden ser de OTRO negocio (un SUPERADMIN con el demo abierto, un token viejo, `Request End` que copia el id
 * del contexto) y que un nombre lo puede repetir un negocio real: ninguno de esos marca. Peor marcar un real como demo que
 * dejar sin marca un demo.
 */
import winston, { type Logform } from 'winston'
import TransportStream from 'winston-transport'
import prisma from '@/utils/prismaClient'
import { capturarContextoAlLlamar, contextFormat } from '@/observability/logContext'
import { runWithContext } from '@/observability/executionContext'
import { DOMINIO_DE_USUARIOS_DEMO, primeVenueNames, marcarNegocioDemo, __resetVenueNameCacheForTests } from '@/observability/venueNames'
import { DOMINIO_DEMO } from '@/services/demo/candadoDemo'

const prismaMock = prisma as unknown as { venue: { findMany: jest.Mock }; staff: { findMany: jest.Mock } }

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
  prismaMock.staff.findMany.mockReset()
  prismaMock.venue.findMany.mockResolvedValue([
    { id: DEMO, name: 'Café Tostado', status: 'LIVE_DEMO' },
    { id: REAL, name: 'Testarudo Cafe', status: 'ACTIVE' },
  ])
  prismaMock.staff.findMany.mockResolvedValue([{ id: USUARIO_DEMO }])
  await primeVenueNames()
})

it('el dominio de los usuarios demo es el mismo del candado', () => {
  expect(DOMINIO_DE_USUARIOS_DEMO).toBe(DOMINIO_DEMO)
  expect(prismaMock.staff.findMany).toHaveBeenCalledWith(
    expect.objectContaining({ where: { email: { endsWith: `@${DOMINIO_DEMO}` } }, take: expect.any(Number) }),
  )
})

it('🔴 lo que hace la sesión de un usuario demo sale marcado', () => {
  runWithContext(sesion(USUARIO_DEMO, DEMO), () => {
    const r = apply({ level: 'error', message: 'Error recording upsell impression' })
    expect(r.demo).toBe(true)
    expect(r.message).toBe('🧪 DEMO · Error recording upsell impression')
  })
})

it('🔴 lo que un job fija para un negocio demo sale marcado', () => {
  runWithContext(job(DEMO), () => {
    expect(apply({ level: 'error', message: '❌ [CLEANUP] Could not delete abandoned order CAFE-0012' }).demo).toBe(true)
  })
})

it('🔴 un SUPERADMIN con el demo abierto que opera un negocio real NO marca, ni con el id del demo en los campos (Codex r2)', () => {
  runWithContext(sesion(PERSONA_REAL, DEMO, 'SUPERADMIN'), () => {
    const r = apply({ level: 'info', message: 'Request End POST /superadmin/kyc/x/approve - 500', venueId: DEMO })
    expect(r.demo).toBeUndefined()
    expect(r.message).toBe('Request End POST /superadmin/kyc/x/approve - 500')
  })
})

it('🔴 una persona real con un token viejo del demo NO marca lo que hace en otro negocio (Codex r2)', () => {
  runWithContext(sesion(PERSONA_REAL, DEMO, 'MANAGER'), () => {
    expect(apply({ level: 'error', message: 'Error recording upsell impression (mobile)' }).demo).toBeUndefined()
  })
})

it('🔴 un id o un nombre de demo en los campos, sin sesión ni job demo, NO marca (Codex r1)', () => {
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

it('si la consulta de usuarios demo falla, los nombres se cargan igual', async () => {
  __resetVenueNameCacheForTests()
  prismaMock.staff.findMany.mockRejectedValueOnce(new Error('db'))
  expect(await primeVenueNames()).toBe(2)
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

  runWithContext(sesion(USUARIO_DEMO, DEMO), () => logger.error('cobro del prospecto'))
  for (let i = 0; i < 5; i++) runWithContext(sesion(PERSONA_REAL, REAL), () => logger.error(`alerta real ${i}`))
  runWithContext(job(DEMO), () => logger.error('job nocturno'))
  while (lineas.length < 7) await new Promise(r => setTimeout(r, 5))

  const reales = lineas.filter(l => l.venueId === REAL)
  expect(reales).toHaveLength(5)
  for (const l of reales) {
    expect(l.demo).toBeUndefined()
    expect(l.message).not.toContain('DEMO')
  }
  expect(lineas.filter(l => l.demo === true).map(l => l.message)).toEqual(['🧪 DEMO · cobro del prospecto', '🧪 DEMO · job nocturno'])
})
