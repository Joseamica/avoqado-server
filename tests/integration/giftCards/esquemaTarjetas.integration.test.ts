/**
 * Tarjetas de regalo · lo que la BASE garantiza por sí sola (Tarea A1), contra Postgres real:
 * la libreta sólo admite inserciones, el saldo nunca es negativo, un sobre cuelga de UNA línea, el tender de sistema
 * es uno por negocio y una línea de tarjeta (NO_OBJETO) no enciende la marca pegajosa de IVA mixto.
 *
 * Correr: source ../urls-tarjetas.sh && TZ=UTC npx jest --selectProjects integration \
 *   --runTestsByPath tests/integration/giftCards/esquemaTarjetas.integration.test.ts --ci --runInBand
 *
 * La libreta no se puede borrar (trigger) y el sobre con libreta tampoco (FK Restrict): la base es desechable, así que
 * este archivo NO limpia negocio, organización ni sobres. Cada corrida usa nombres únicos.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'

const SUF = `esq-${process.pid}-${Date.now()}`
let orgId: string
let venueId: string
let n = 0

beforeAll(async () => {
  orgId = (await prisma.organization.create({ data: { name: SUF, email: `${SUF}@example.test`, phone: '5500000000' } })).id
  venueId = (await prisma.venue.create({ data: { organizationId: orgId, name: SUF, slug: SUF } })).id
})

async function sobre(extra: Partial<Prisma.GiftCardUncheckedCreateInput> = {}) {
  n += 1
  return prisma.giftCard.create({
    data: {
      venueId,
      organizationId: orgId,
      codeHash: `${SUF}-h${n}`,
      codeEnc: 'cifrado-de-prueba',
      codeLast4: 'ABCD',
      pageToken: `${SUF}-p${n}`,
      initialAmount: new Prisma.Decimal(500),
      balance: new Prisma.Decimal(500),
      status: 'ACTIVE',
      termsVersion: '2026-10-14',
      deliveryChannel: 'PRINTED',
      ...extra,
    },
  })
}

async function orden(renglones: Array<Prisma.OrderItemCreateWithoutOrderInput | Prisma.OrderItemUncheckedCreateWithoutOrderInput>) {
  n += 1
  return prisma.order.create({
    data: {
      venueId,
      orderNumber: `${SUF}-o${n}`,
      subtotal: new Prisma.Decimal(500),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(500),
      contratoDePrecio: 'IVA_INCLUIDO',
      items: { create: renglones },
    },
  })
}

describe('tarjetas de regalo · garantías del esquema', () => {
  it('la libreta sólo admite inserciones: UPDATE y DELETE truenan', async () => {
    const s = await sobre()
    const renglon = await prisma.giftCardActivity.create({
      data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: new Prisma.Decimal(500), balanceAfter: new Prisma.Decimal(500) },
    })
    await expect(prisma.giftCardActivity.update({ where: { id: renglon.id }, data: { note: 'editado' } })).rejects.toThrow(
      /sólo admite inserciones/,
    )
    await expect(prisma.giftCardActivity.delete({ where: { id: renglon.id } })).rejects.toThrow(/sólo admite inserciones/)
  })

  it('E2: el DELETE sólo pasa dentro de una transacción que declaró el borrado de un negocio entero; el UPDATE nunca', async () => {
    const s = await sobre()
    const renglon = await prisma.giftCardActivity.create({
      data: { giftCardId: s.id, venueId, type: 'ACTIVATE', amount: new Prisma.Decimal(500), balanceAfter: new Prisma.Decimal(500) },
    })
    await expect(
      prisma.$transaction(async tx => {
        await tx.$executeRaw`SET LOCAL avoqado.borrado_de_negocio = 'on'`
        await tx.giftCardActivity.update({ where: { id: renglon.id }, data: { note: 'editado' } })
      }),
    ).rejects.toThrow(/sólo admite inserciones/)
    await prisma.$transaction(async tx => {
      await tx.$executeRaw`SET LOCAL avoqado.borrado_de_negocio = 'on'`
      await tx.giftCardActivity.delete({ where: { id: renglon.id } })
    })
    expect(await prisma.giftCardActivity.count({ where: { id: renglon.id } })).toBe(0)
    // `SET LOCAL` muere con su transacción: fuera de ella, el borrado suelto vuelve a fallar.
    const otro = await prisma.giftCardActivity.create({
      data: { giftCardId: s.id, venueId, type: 'BLOCK', amount: new Prisma.Decimal(0), balanceAfter: new Prisma.Decimal(500) },
    })
    await expect(prisma.giftCardActivity.delete({ where: { id: otro.id } })).rejects.toThrow(/sólo admite inserciones/)
  })

  it('el saldo de un sobre nunca queda negativo (CHECK de la base)', async () => {
    const s = await sobre()
    await expect(prisma.giftCard.update({ where: { id: s.id }, data: { balance: { decrement: 600 } } })).rejects.toThrow(
      /GiftCard_balance_no_negativo/,
    )
    const releido = await prisma.giftCard.findUniqueOrThrow({ where: { id: s.id } })
    expect(releido.balance.toFixed(2)).toBe('500.00')
  })

  it('un sobre cuelga de UNA sola línea de venta (OrderItem.giftCardId es único)', async () => {
    const s = await sobre({ status: 'PENDING', balance: new Prisma.Decimal(0) })
    // Con la columna `giftCardId`, no con `giftCard: { connect }`: en una relación 1:1, el `connect` anidado de Prisma
    // DESCONECTA en silencio la línea anterior (le pone giftCardId NULL) y mueve el sobre a la nueva, sin P2002
    // (medido el 14-oct en A1). Quien cree líneas de tarjeta debe escribir la columna, para que la base rechace la segunda.
    const linea = {
      productName: 'Tarjeta de regalo',
      quantity: 1,
      unitPrice: new Prisma.Decimal(500),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(500),
      ivaTratamiento: 'NO_OBJETO' as const,
      giftCardId: s.id,
    }
    const primera = await orden([linea])
    await expect(orden([linea])).rejects.toMatchObject({ code: 'P2002' })
    // La primera línea sigue dueña del sobre.
    expect(await prisma.orderItem.count({ where: { orderId: primera.id, giftCardId: s.id } })).toBe(1)
  })

  it('una línea de tarjeta (NO_OBJETO con giftCardId) NO enciende ivaMixtoAlgunaVez; una NO_OBJETO sin tarjeta sí', async () => {
    const s = await sobre({ status: 'PENDING', balance: new Prisma.Decimal(0) })
    await orden([
      {
        productName: 'Tarjeta de regalo',
        quantity: 1,
        unitPrice: new Prisma.Decimal(500),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(500),
        ivaTratamiento: 'NO_OBJETO',
        giftCard: { connect: { id: s.id } },
      },
    ])
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).ivaMixtoAlgunaVez).toBe(false)

    await orden([
      {
        productName: 'Servicio no objeto',
        quantity: 1,
        unitPrice: new Prisma.Decimal(500),
        taxAmount: new Prisma.Decimal(0),
        total: new Prisma.Decimal(500),
        ivaTratamiento: 'NO_OBJETO',
      },
    ])
    expect((await prisma.organization.findUniqueOrThrow({ where: { id: orgId } })).ivaMixtoAlgunaVez).toBe(true)
  })

  it('el tender de sistema «Tarjeta de regalo» es uno por negocio; los tenders normales (systemKind nulo) no chocan', async () => {
    const base = { venueId, baseMethod: 'OTHER' as const, isSystem: true, showOnPos: false }
    await prisma.venueTenderType.create({ data: { ...base, name: 'Regalo A', normalizedName: `${SUF}-a`, systemKind: 'GIFT_CARD' } })
    await expect(
      prisma.venueTenderType.create({ data: { ...base, name: 'Regalo B', normalizedName: `${SUF}-b`, systemKind: 'GIFT_CARD' } }),
    ).rejects.toMatchObject({ code: 'P2002' })
    await prisma.venueTenderType.create({ data: { venueId, baseMethod: 'OTHER', name: 'Vale 1', normalizedName: `${SUF}-v1` } })
    await prisma.venueTenderType.create({ data: { venueId, baseMethod: 'OTHER', name: 'Vale 2', normalizedName: `${SUF}-v2` } })
  })
})
