/**
 * «Ajustar puntos» de dos gerentes a la vez contra Postgres real (D1, 24-oct-2026).
 *
 * Antes la validación del saldo leía FUERA de la transacción y la resta era incondicional: cliente con 10 puntos, dos
 * gerentes quitan 6 al mismo tiempo, los dos leen 10 y el saldo queda en −2. El cruce se fuerza aparcando el primer ajuste
 * con la fila tomada y se COMPRUEBA en `pg_stat_activity` que el segundo lo espera.
 */
import '../../__helpers__/integration-setup'
import prisma from '@/utils/prismaClient'

import { adjustPoints } from '@/services/dashboard/loyalty.dashboard.service'
import { BadRequestError } from '@/errors/AppError'
import { aTiempo, aparcarLaSiguienteTransaccion, esperarBloqueado } from '@tests/__helpers__/candadosDePostgres'

const sello = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`
let orgId: string | undefined
let venueId: string | undefined
let n = 0
// `createdById` es opcional (FK a StaffVenue): la prueba no necesita un empleado.
const SIN_EMPLEADO = undefined as unknown as string

async function clienteCon(puntos: number): Promise<string> {
  return (await prisma.customer.create({ data: { venueId: venueId!, firstName: `Puntos ${++n}`, loyaltyPoints: puntos } })).id
}

async function saldo(customerId: string) {
  return (await prisma.customer.findUniqueOrThrow({ where: { id: customerId }, select: { loyaltyPoints: true } })).loyaltyPoints
}

beforeAll(async () => {
  orgId = (
    await prisma.organization.create({
      data: { name: `ITEST Puntos ${sello}`, email: `itest-puntos-${sello}@test.com`, phone: '5550000000' },
    })
  ).id
  venueId = (
    await prisma.venue.create({
      data: { name: `itest-puntos-${sello}`, slug: `itest-puntos-${sello}`, organizationId: orgId, timezone: 'America/Mexico_City' },
    })
  ).id
})

afterAll(async () => {
  // 🔴 Sin fixture no se limpia NADA: un filtro con venueId undefined borraría tablas enteras.
  if (!venueId || !orgId) return
  await prisma.customer.deleteMany({ where: { venueId } }) // sus LoyaltyTransaction se van en cascada
  await prisma.activityLog.deleteMany({ where: { venueId } })
  await prisma.venue.deleteMany({ where: { id: venueId } })
  await prisma.organization.deleteMany({ where: { id: orgId } })
  await prisma.$disconnect()
})

describe('dos gerentes quitan puntos al mismo cliente a la vez (Postgres real)', () => {
  it('🔴 el primero aparcado con la fila tomada: el segundo espera, ya no le alcanza y se rechaza; el saldo queda en 4', async () => {
    const c = await clienteCon(10)
    const aparcada = aparcarLaSiguienteTransaccion(prisma)
    let primero: ReturnType<typeof adjustPoints> | undefined
    let segundo: ReturnType<typeof adjustPoints> | undefined
    try {
      primero = adjustPoints(venueId!, c, -6, 'Corrección de saldo', SIN_EMPLEADO)
      const pid = await aTiempo(aparcada.pid, 8_000, 'el primer ajuste no llegó al commit')
      segundo = adjustPoints(venueId!, c, -6, 'Corrección de saldo', SIN_EMPLEADO)
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /UPDATE.*"Customer"/ })).not.toBeNull()
    } finally {
      aparcada.soltar()
      aparcada.restaurar()
    }
    const r = await Promise.allSettled([primero!, segundo!])
    expect(r[0]).toMatchObject({ status: 'fulfilled', value: { newBalance: 4 } })
    expect(r[1].status).toBe('rejected')
    expect((r[1] as PromiseRejectedResult).reason).toBeInstanceOf(BadRequestError)
    expect(await saldo(c)).toBe(4)
    expect(await prisma.loyaltyTransaction.count({ where: { customerId: c, type: 'ADJUST' } })).toBe(1)
  })

  it('🔴 Codex r1: una suma que espera más de 5 s la fila tomada por otro sigue aplicando (sin el límite por defecto de Prisma)', async () => {
    const c = await clienteCon(10)
    let soltar: () => void = () => undefined
    const puedeSoltar = new Promise<void>(r => (soltar = r))
    let avisar: (pid: number) => void = () => undefined
    const pidRetenedor = new Promise<number>(r => (avisar = r))
    const retenedor = prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "Customer" WHERE id = ${c} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`
        avisar(Number(pid))
        await puedeSoltar
      },
      { timeout: 30_000 },
    )
    let ajuste: ReturnType<typeof adjustPoints> | undefined
    try {
      const pid = await aTiempo(pidRetenedor, 8_000, 'el retenedor no tomó la fila')
      ajuste = adjustPoints(venueId!, c, 5, 'Bono', SIN_EMPLEADO)
      expect(await esperarBloqueado(prisma, { bloqueadoPor: [pid], consulta: /UPDATE.*"Customer"/ })).not.toBeNull()
      await new Promise(r => setTimeout(r, 6_000))
    } finally {
      soltar()
    }
    await retenedor
    await expect(ajuste!).resolves.toEqual({ newBalance: 15 })
    expect(await saldo(c)).toBe(15)
  }, 30_000)

  it('🔴 los dos leen 10 antes de que alguno reste (el caso reportado): uno pasa, el otro se rechaza y el saldo queda en 4', async () => {
    const c = await clienteCon(10)
    // Barrera: ninguna lectura del cliente regresa hasta que ocurrieron las dos.
    const leer = prisma.customer.findFirst.bind(prisma.customer)
    let lecturas = 0
    let abrir: () => void = () => undefined
    const ambas = new Promise<void>(r => (abrir = r))
    const espia = jest.spyOn(prisma.customer, 'findFirst').mockImplementation((async (args: unknown) => {
      const fila = await leer(args as never)
      if (++lecturas === 2) abrir()
      await aTiempo(ambas, 8_000, 'la segunda lectura nunca llegó')
      return fila
    }) as never)
    let r: PromiseSettledResult<{ newBalance: number }>[]
    try {
      r = await Promise.allSettled([
        adjustPoints(venueId!, c, -6, 'Corrección de saldo', SIN_EMPLEADO),
        adjustPoints(venueId!, c, -6, 'Corrección de saldo', SIN_EMPLEADO),
      ])
    } finally {
      espia.mockRestore()
    }
    expect(lecturas).toBe(2)
    expect(await saldo(c)).toBe(4)
    expect(r.map(x => x.status).sort()).toEqual(['fulfilled', 'rejected'])
    expect(await prisma.loyaltyTransaction.count({ where: { customerId: c, type: 'ADJUST' } })).toBe(1)
  })
})
