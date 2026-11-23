/**
 * Integración (base REAL) — D679, la marca «Ilimitado» de un paquete (Inventario 2).
 *
 * W5: dos ediciones a la vez (una lo vuelve Ilimitado, otra le quita la vigencia) nunca dejan un Ilimitado sin vigencia: el
 * paquete se toma bajo candado antes de leer su vigencia y sus renglones.
 * W10: editar un Ilimitado ya vendido no toca lo vendido: el saldo conserva su número, su renglón y su marca.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { updateCreditPack } from '@/services/dashboard/creditPack.dashboard.service'

const RUN = Date.now()

describe('D679 · la marca del paquete Ilimitado (integración, base real)', () => {
  let orgId: string | undefined
  let venueId: string | undefined
  let lagree: string
  let shake: string
  let clienta: string
  let n = 0

  beforeAll(async () => {
    const org = await prisma.organization.create({
      data: { name: 'ITEST Marca Ilimitado', email: `itest-marca-ili-${RUN}@test.com`, phone: '5550000000' },
    })
    orgId = org.id
    venueId = (
      await prisma.venue.create({
        data: {
          name: 'ITEST Marca Ilimitado',
          slug: `itest-marca-ili-${RUN}`,
          organizationId: org.id,
          address: 'X',
          city: 'X',
          state: 'X',
          country: 'MX',
          zipCode: '00000',
          timezone: 'America/Mexico_City',
          status: 'TRIAL' as any,
        },
        select: { id: true },
      })
    ).id
    const category = await prisma.menuCategory.create({ data: { venueId, name: 'Clases', slug: `clases-ili-${RUN}` } })
    const producto = async (name: string) =>
      (
        await prisma.product.create({
          data: {
            venueId: venueId!,
            sku: `ILI-${name}-${RUN}`,
            name,
            type: 'CLASS',
            categoryId: category.id,
            price: new Prisma.Decimal(200),
          },
          select: { id: true },
        })
      ).id
    lagree = await producto('Lagree')
    shake = await producto('Shake')
    clienta = (await prisma.customer.create({ data: { venueId, firstName: 'Ana' }, select: { id: true } })).id
  })

  afterAll(async () => {
    const step = (fn: () => Promise<unknown>) => fn().catch(() => {})
    if (venueId) {
      const v = venueId
      await step(() => prisma.creditTransaction.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.creditItemBalance.deleteMany({ where: { creditPackPurchase: { venueId: v } } }))
      await step(() => prisma.creditPackPurchase.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.creditPackItem.deleteMany({ where: { creditPack: { venueId: v } } }))
      await step(() => prisma.creditPack.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.customer.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.product.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.menuCategory.deleteMany({ where: { venueId: v } }))
      await step(() => prisma.venue.deleteMany({ where: { id: v } }))
    }
    if (orgId) await step(() => prisma.organization.deleteMany({ where: { id: orgId } }))
  })

  const paquete = async (items: Array<{ productId: string; quantity: number; unlimited?: boolean }>, validityDays: number | null = 30) => {
    n += 1
    return prisma.creditPack.create({
      data: { venueId: venueId!, name: `Paquete ${n}`, price: new Prisma.Decimal(2500), validityDays, items: { create: items } },
      select: { id: true, items: { select: { id: true, productId: true } } },
    })
  }

  /**
   * Corre `pasos` mientras otra transacción tiene la fila del paquete: arranca uno, espera a que ya esté bloqueado, arranca el
   * siguiente; cuando todos esperan, suelta. Devuelve cuántos llegaron a esperar a la vez (la prueba de que hubo cruce). Misma
   * técnica que tests/integration/classSession/devoluciones-al-cancelar.test.ts.
   */
  const enCarrera = async (packId: string, pasos: Array<() => Promise<unknown>>) => {
    let enCurso: Promise<PromiseSettledResult<unknown>>[] = []
    let esperando = 0
    await prisma.$transaction(
      async tx => {
        await tx.$queryRaw`SELECT id FROM "CreditPack" WHERE id = ${packId} FOR UPDATE`
        const [{ pid }] = await tx.$queryRaw<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`
        const bloqueadas = async () => {
          await tx.$executeRaw`SELECT pg_stat_clear_snapshot()`
          const [{ total }] = await tx.$queryRaw<{ total: number }[]>`
            WITH RECURSIVE bloqueadas(pid) AS (
              SELECT a.pid FROM pg_stat_activity a WHERE ${pid}::int = ANY(pg_blocking_pids(a.pid))
              UNION
              SELECT a.pid FROM pg_stat_activity a JOIN bloqueadas b ON b.pid = ANY(pg_blocking_pids(a.pid))
            )
            SELECT count(*)::int AS total FROM bloqueadas`
          return total
        }
        for (const paso of pasos) {
          enCurso = [...enCurso, Promise.allSettled([paso()]).then(([r]) => r)]
          const limite = Date.now() + 10_000
          while ((esperando = await bloqueadas()) < enCurso.length && Date.now() < limite) await new Promise(r => setTimeout(r, 25))
        }
      },
      { timeout: 40_000 },
    )
    return { resultados: await Promise.all(enCurso), esperando }
  }

  it('W5 · dos ediciones a la vez (una lo vuelve Ilimitado, otra quita la vigencia): una falla con NEEDS_VALIDITY y nunca queda un Ilimitado sin vigencia', async () => {
    const pack = await paquete([{ productId: lagree, quantity: 10 }])
    const { resultados, esperando } = await enCarrera(pack.id, [
      () => updateCreditPack(venueId!, pack.id, { items: [{ productId: lagree, unlimited: true }] }),
      () => updateCreditPack(venueId!, pack.id, { validityDays: null }),
    ])
    expect(esperando).toBe(2)
    const fallidas = resultados.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    expect(fallidas).toHaveLength(1)
    expect(fallidas[0].reason).toMatchObject({ code: 'CREDIT_UNLIMITED_NEEDS_VALIDITY' })

    const final = await prisma.creditPack.findUniqueOrThrow({
      where: { id: pack.id },
      select: { validityDays: true, items: { select: { unlimited: true } } },
    })
    expect(final.items.some(i => i.unlimited) && final.validityDays == null).toBe(false)
  })

  it('W10 · editar un Ilimitado ya vendido conserva saldo, renglón y la marca del saldo', async () => {
    const pack = await paquete([{ productId: lagree, quantity: 99999, unlimited: true }])
    const renglon = pack.items[0].id
    const compra = await prisma.creditPackPurchase.create({
      data: {
        venueId: venueId!,
        customerId: clienta,
        creditPackId: pack.id,
        amountPaid: new Prisma.Decimal(2500),
        expiresAt: new Date(Date.now() + 30 * 86_400_000),
        itemBalances: {
          create: [{ creditPackItemId: renglon, productId: lagree, originalQuantity: 99999, remainingQuantity: 99998, unlimited: true }],
        },
      },
      select: { itemBalances: { select: { id: true } } },
    })
    const saldoId = compra.itemBalances[0].id
    const saldo = () =>
      prisma.creditItemBalance.findUniqueOrThrow({
        where: { id: saldoId },
        select: { remainingQuantity: true, originalQuantity: true, creditPackItemId: true, unlimited: true },
      })
    const intacto = { remainingQuantity: 99998, originalQuantity: 99999, creditPackItemId: renglon, unlimited: true }

    // El panel nuevo agrega un shake y le cambia el nombre.
    await updateCreditPack(venueId!, pack.id, {
      name: 'Ilimitado + shake',
      items: [
        { productId: lagree, unlimited: true },
        { productId: shake, quantity: 2, unlimited: false },
      ],
    })
    expect(await saldo()).toEqual(intacto)

    // Un editor viejo (sin la llave) vuelve a guardar los mismos productos con otro número: el renglón sigue Ilimitado.
    await updateCreditPack(venueId!, pack.id, {
      items: [
        { productId: lagree, quantity: 10 },
        { productId: shake, quantity: 2 },
      ],
    })
    expect(await saldo()).toEqual(intacto)
    const item = await prisma.creditPackItem.findUniqueOrThrow({ where: { id: renglon }, select: { quantity: true, unlimited: true } })
    expect(item).toEqual({ quantity: 99999, unlimited: true })
  })
})
