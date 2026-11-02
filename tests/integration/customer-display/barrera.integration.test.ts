// tests/integration/customer-display/barrera.integration.test.ts
import prisma from '@/utils/prismaClient'
import { retener } from './barrera'

/**
 * La barrera retiene un candado a propósito. Si una prueba se olvida de soltarla (o truena antes de llegar a `soltar`),
 * ese candado NO puede quedarse vivo: todo lo que después toque la misma fila esperaría hasta su propio tope, en cascada.
 * Medido en la Task 7: sin red de seguridad, una barrera olvidada se quedó «idle in transaction» más de 5 minutos.
 */

const suffix = `cdb-${Date.now()}`
let orgId: string
let venueId: string
let terminalId: string

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `Org ${suffix}`, email: `${suffix}@example.test`, phone: '0000000000' },
      select: { id: true },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { organizationId: orgId, name: `V ${suffix}`, slug: `v-${suffix}`, timezone: 'America/Mexico_City' },
      select: { id: true },
    })
  ).id
  terminalId = (await prisma.terminal.create({ data: { venueId, name: `Caja ${suffix}`, type: 'POS_ANDROID' }, select: { id: true } })).id
})

afterAll(async () => {
  if (!venueId) return
  await prisma.terminal.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
})

const tomarLaFila = (tx: any) => tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE`

/** ¿Alguien más puede tomar la fila AHORA? `NOWAIT` contesta en el acto en vez de esperar. */
async function filaLibre(): Promise<boolean> {
  try {
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT id FROM "Terminal" WHERE id = ${terminalId} FOR UPDATE NOWAIT`
    })
    return true
  } catch {
    return false
  }
}

/** Espera, con tope, a que la barrera termine sola. Nunca cuelga la corrida: devuelve 'sigue' si no terminó. */
async function terminaSola(transaccion: Promise<unknown>, topeMs: number): Promise<'termino' | 'sigue'> {
  let reloj: NodeJS.Timeout | undefined
  const resultado = await Promise.race([
    transaccion.then(
      () => 'termino' as const,
      () => 'termino' as const,
    ),
    new Promise<'sigue'>(r => (reloj = setTimeout(() => r('sigue'), topeMs))),
  ])
  clearTimeout(reloj)
  return resultado
}

describe('la barrera tiene red de seguridad', () => {
  it('una barrera que NADIE suelta se deshace sola dentro de su tope y libera la fila', async () => {
    const { soltar, transaccion } = await retener(tomarLaFila, { maxRetencionMs: 500 })
    try {
      expect(await filaLibre()).toBe(false) // de verdad la tenía

      expect(await terminaSola(transaccion, 5_000)).toBe('termino')
      await expect(transaccion).rejects.toThrow(/sin que la prueba la soltara/)
      expect(await filaLibre()).toBe(true)
    } finally {
      soltar() // si la red faltara, no dejamos la fila tomada para las pruebas de abajo
      await transaccion.catch(() => undefined)
    }
  })

  // El respaldo que no depende de JS: aunque el temporizador no corriera, la BASE cierra la sesión inactiva.
  it('si el temporizador no la suelta, la base corta la sesión inactiva y la fila queda libre', async () => {
    // 3 s de inactividad y no 1: con la máquina cargada, la primera `filaLibre()` puede tardar más de un segundo y ver la
    // fila ya liberada por la base. La espera de abajo (hasta ~10 s) va holgada por encima de esos 3 s.
    const { soltar, transaccion } = await retener(tomarLaFila, { maxRetencionMs: 60_000, inactividadMaximaMs: 3_000 })
    try {
      expect(await filaLibre()).toBe(false)

      let libre = false
      for (let i = 0; i < 100 && !libre; i++) {
        await new Promise(r => setTimeout(r, 100))
        libre = await filaLibre()
      }
      expect(libre).toBe(true)
    } finally {
      soltar()
      await transaccion.catch(() => undefined)
    }
    // Y el pool sigue sirviendo: la conexión cortada no envenena las consultas de después.
    for (let i = 0; i < 5; i++) {
      await expect(prisma.terminal.findUnique({ where: { id: terminalId }, select: { id: true } })).resolves.toEqual({ id: terminalId })
    }
  })

  it('soltarla a tiempo sigue funcionando igual: ejecuta la acción y confirma', async () => {
    const { soltar, transaccion } = await retener(tomarLaFila)
    soltar(async tx => {
      await tx.terminal.update({ where: { id: terminalId }, data: { name: `Caja renombrada ${suffix}` } })
    })
    await transaccion
    expect((await prisma.terminal.findUnique({ where: { id: terminalId }, select: { name: true } }))?.name).toBe(
      `Caja renombrada ${suffix}`,
    )
  })
})
