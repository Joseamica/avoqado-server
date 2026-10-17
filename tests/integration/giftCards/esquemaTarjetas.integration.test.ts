/**
 * Tarjetas de regalo · lo que la BASE garantiza por sí sola (Tarea A1), contra Postgres real:
 * - la libreta (`GiftCardActivity`) sólo admite inserciones: UPDATE nunca; DELETE sólo dentro de una transacción que
 *   declaró `SET LOCAL avoqado.borrado_de_negocio = 'on'` (enmienda E2);
 * - el saldo de un sobre nunca es negativo (CHECK `GiftCard_balance_no_negativo`);
 * - un sobre cuelga de UNA sola línea: ninguna otra línea puede tomarlo (índice único `OrderItem_giftCardId_key`) y la
 *   línea que ya lo tiene no lo suelta ni lo cambia (trigger `TARJETA_LINEA_INMUTABLE`, que también frena el `connect`
 *   anidado de Prisma: en una relación 1:1 ese `connect` intenta quitarle el sobre a la línea anterior);
 * - el tender de sistema «Tarjeta de regalo» es uno por negocio (índice único `VenueTenderType_venueId_systemKind_key`);
 * - una línea de tarjeta (NO_OBJETO con `giftCardId`) no enciende la marca pegajosa `ivaMixtoAlgunaVez`.
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

  it('un sobre cuelga de UNA sola línea de venta: ninguna otra lo toma y la suya no lo suelta', async () => {
    const s = await sobre({ status: 'PENDING', balance: new Prisma.Decimal(0) })
    const renglon = {
      productName: 'Tarjeta de regalo',
      quantity: 1,
      unitPrice: new Prisma.Decimal(500),
      taxAmount: new Prisma.Decimal(0),
      total: new Prisma.Decimal(500),
      ivaTratamiento: 'NO_OBJETO' as const,
    }
    const primera = await orden([{ ...renglon, giftCardId: s.id }])

    // Otra línea que escribe la columna: el índice único la rechaza.
    await expect(orden([{ ...renglon, giftCardId: s.id }])).rejects.toMatchObject({
      code: 'P2002',
      meta: { target: ['giftCardId'] },
    })
    // El `connect` anidado de Prisma, en una relación 1:1, primero le QUITA el sobre a la línea anterior
    // (UPDATE … SET "giftCardId" = NULL) y luego se lo pone a la nueva, sin P2002 (medido el 14-oct en A1).
    // El trigger de 20261017180300 rechaza ese UPDATE: el sobre no se mueve.
    await expect(orden([{ ...renglon, giftCard: { connect: { id: s.id } } }])).rejects.toThrow(/TARJETA_LINEA_INMUTABLE/)
    // Soltarlo a mano tampoco.
    await expect(prisma.orderItem.updateMany({ where: { orderId: primera.id }, data: { giftCardId: null } })).rejects.toThrow(
      /TARJETA_LINEA_INMUTABLE/,
    )
    // La primera línea sigue dueña del sobre.
    expect(await prisma.orderItem.count({ where: { orderId: primera.id, giftCardId: s.id } })).toBe(1)
    expect(await prisma.orderItem.count({ where: { giftCardId: s.id } })).toBe(1)
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
        giftCardId: s.id,
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
    ).rejects.toMatchObject({ code: 'P2002', meta: { target: ['venueId', 'systemKind'] } })
    await prisma.venueTenderType.create({ data: { venueId, baseMethod: 'OTHER', name: 'Vale 1', normalizedName: `${SUF}-v1` } })
    await prisma.venueTenderType.create({ data: { venueId, baseMethod: 'OTHER', name: 'Vale 2', normalizedName: `${SUF}-v2` } })
  })
})
