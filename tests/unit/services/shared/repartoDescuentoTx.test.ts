/** IVA por producto, B2: el único escritor de repartos — una actualización por fila, con el tx del llamador. */
import { Prisma } from '@prisma/client'
import { prismaMock } from '../../../__helpers__/setup'
import {
  conservarDescuentoHistorico,
  recortarDescuentosDeRenglones,
  retirarImpuestoDeRenglones,
  revertirDescuentoDelRenglon,
  sincronizarRepartos,
} from '@/services/shared/repartoDescuentoTx'
import { nuevoRepartoDeCuenta, nuevoRepartoDirigido } from '@/services/shared/repartoDescuento'

function txDoble(renglones: unknown[], filas: unknown[]) {
  return {
    orderItem: { findMany: jest.fn().mockResolvedValue(renglones) },
    orderDiscount: { findMany: jest.fn().mockResolvedValue(filas), update: jest.fn().mockResolvedValue({}) },
  } as any
}

it('lee renglones y filas con el tx y escribe el reparto que cambió; nada con el cliente global', async () => {
  const tx = txDoble(
    [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null }],
    [
      {
        id: 'od',
        type: 'FIXED_AMOUNT',
        value: 10,
        amount: 10,
        appliedToItemIds: [],
        reparto: nuevoRepartoDeCuenta({ conPromociones: true }),
        createdAt: null,
      },
    ],
  )
  await sincronizarRepartos(tx, 'o1')
  expect(tx.orderItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1' } }))
  expect(tx.orderDiscount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1' } }))
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'od' },
    data: { reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { a: 1000 } } },
  })
  expect(prismaMock.orderDiscount.update).not.toHaveBeenCalled()
})

it('con datos ya leídos y un importe re-derivado: UNA actualización con importe y reparto, sin volver a leer', async () => {
  const tx = txDoble([], [])
  const renglones = [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null }]
  const filas = [{ id: 'pct', type: 'PERCENTAGE', value: 20, amount: 39.8, appliedToItemIds: [], reparto: null, createdAt: null }]
  await sincronizarRepartos(tx, 'o1', { renglones, filas, montosRederivados: new Map([['pct', 20]]) })
  expect(tx.orderItem.findMany).not.toHaveBeenCalled()
  expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
  expect(tx.orderDiscount.update).toHaveBeenCalledWith({
    where: { id: 'pct' },
    data: { amount: 20, reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { a: 2000 } } },
  })
})

it('un error transitorio al escribir sale tal cual (el reducer lo marca RETRY)', async () => {
  const tx = txDoble(
    [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null }],
    [
      {
        id: 'od',
        type: 'FIXED_AMOUNT',
        value: 10,
        amount: 10,
        appliedToItemIds: [],
        reparto: nuevoRepartoDeCuenta({ conPromociones: true }),
        createdAt: null,
      },
    ],
  )
  tx.orderDiscount.update.mockRejectedValue(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
  await expect(sincronizarRepartos(tx, 'o1')).rejects.toMatchObject({ code: 'P2028' })
})

// Control de regresión: pasa con el escritor neutro; muerde si se escribe un reparto que no cambió.
it('sin cambios ⇒ ninguna escritura', async () => {
  const fijo = { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { a: 1000 } }
  const tx = txDoble(
    [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null }],
    [{ id: 'od', type: 'FIXED_AMOUNT', value: 10, amount: 10, appliedToItemIds: [], reparto: fijo, createdAt: null }],
  )
  await sincronizarRepartos(tx, 'o1')
  expect(tx.orderDiscount.update).not.toHaveBeenCalled()
})

const D = (n: number) => new Prisma.Decimal(n)
const txQuitar = (renglones: unknown[]) =>
  ({ orderItem: { findMany: jest.fn().mockResolvedValue(renglones), update: jest.fn().mockResolvedValue({}) } }) as any

describe('revertirDescuentoDelRenglon (R3-2)', () => {
  it('espejo de un artículo: el renglón queda sin descuento y sin liga al catálogo', async () => {
    const tx = txQuitar([{ id: 'i1', discountAmount: D(20), appliedDiscountId: 'cat-20', isCortesia: false }])
    const r = await revertirDescuentoDelRenglon(tx, 'o1', {
      id: 'od',
      discountId: 'cat-20',
      type: 'PERCENTAGE',
      isComp: false,
      amount: 20,
      appliedToItemIds: ['i1'],
      reparto: nuevoRepartoDirigido(20, { i1: 20 }, { espejo: true }),
    })
    expect(r).toEqual(['i1'])
    expect(tx.orderItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1', id: { in: ['i1'] } }, take: 1 }))
    expect(Number(tx.orderItem.update.mock.calls[0][0].data.discountAmount)).toBe(0)
    expect(tx.orderItem.update.mock.calls[0][0]).toMatchObject({ where: { id: 'i1' }, data: { appliedDiscountId: null } })
  })
  it('cortesía de «Cobrar» (espejo COMP): el renglón deja de ser cortesía', async () => {
    const tx = txQuitar([{ id: 'pan', discountAmount: D(50), appliedDiscountId: null, isCortesia: true }])
    await revertirDescuentoDelRenglon(tx, 'o1', {
      id: 'comp',
      discountId: null,
      type: 'COMP',
      isComp: true,
      amount: 50,
      appliedToItemIds: ['pan'],
      reparto: nuevoRepartoDirigido(50, { pan: 50 }, { espejo: true }),
    })
    expect(tx.orderItem.update).toHaveBeenCalledTimes(1)
    expect(tx.orderItem.update.mock.calls[0][0]).toMatchObject({ where: { id: 'pan' }, data: { isCortesia: false, cortesiaReason: null } })
    expect(Number(tx.orderItem.update.mock.calls[0][0].data.discountAmount)).toBe(0)
  })
  it('fila VIEJA sin reparto con la forma de buildItemDiscountRow: también limpia su renglón', async () => {
    const tx = txQuitar([{ id: 'i1', discountAmount: D(20), appliedDiscountId: 'cat-20', isCortesia: false }])
    expect(
      await revertirDescuentoDelRenglon(tx, 'o1', {
        id: 'od',
        discountId: 'cat-20',
        type: 'PERCENTAGE',
        isComp: false,
        amount: 20,
        appliedToItemIds: ['i1'],
        reparto: null,
      }),
    ).toEqual(['i1'])
  })
  // Control de regresión: pasa con el cuerpo neutro; muerde si una fila no espejo toca renglones.
  it('fila de cuenta o dirigida no espejo, o sin appliedToItemIds: no lee ni toca renglones', async () => {
    const tx = txQuitar([])
    expect(
      await revertirDescuentoDelRenglon(tx, 'o1', {
        id: 'od',
        amount: 10,
        reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { a: 1000 } },
      }),
    ).toEqual([])
    expect(await revertirDescuentoDelRenglon(tx, 'o1', { id: 'od2', amount: 10 })).toEqual([])
    expect(tx.orderItem.findMany).not.toHaveBeenCalled()
  })
  // Codex r1 P2: la fila de cuenta del catálogo (COMP con discountId, forma de antes de B2) NO es el espejo de una cortesía.
  it('🔴 quitar la fila COMP de cuenta del catálogo (con discountId, sin reparto) deja intacta la cortesía independiente', async () => {
    const tx = txQuitar([{ id: 'cafe', discountAmount: D(100), appliedDiscountId: null, isCortesia: true }])
    expect(
      await revertirDescuentoDelRenglon(tx, 'o1', {
        id: 'cuenta',
        discountId: 'cat-comp',
        type: 'COMP',
        isComp: true,
        amount: 20,
        appliedToItemIds: ['cafe'],
        reparto: null,
      }),
    ).toEqual([])
    expect(tx.orderItem.update).not.toHaveBeenCalled()
  })
  // Control de regresión: la cortesía VIEJA de «Cobrar» (sin discountId) se sigue revirtiendo.
  it('control — cortesía vieja de «Cobrar» sin reparto ni discountId: el renglón deja de ser cortesía', async () => {
    const tx = txQuitar([{ id: 'pan', discountAmount: D(50), appliedDiscountId: null, isCortesia: true }])
    expect(
      await revertirDescuentoDelRenglon(tx, 'o1', {
        id: 'comp',
        discountId: null,
        type: 'COMP',
        isComp: true,
        amount: 50,
        appliedToItemIds: ['pan'],
        reparto: null,
      }),
    ).toEqual(['pan'])
    expect(tx.orderItem.update.mock.calls[0][0]).toMatchObject({ where: { id: 'pan' }, data: { isCortesia: false, cortesiaReason: null } })
  })
})

describe('F2b: revertir un espejo SIN liga que deja el renglón en $0 limpia su appliedDiscountId (Codex r2)', () => {
  const txRevertir = (renglones: unknown[]) =>
    ({ orderItem: { findMany: jest.fn().mockResolvedValue(renglones), update: jest.fn().mockResolvedValue({}) } }) as any
  const espejoNormalizado = {
    id: 'e',
    type: 'PERCENTAGE',
    isComp: false,
    discountId: null,
    amount: D(10),
    appliedToItemIds: ['plato'],
    reparto: nuevoRepartoDirigido(10, { plato: 10 }, { espejo: true }),
  }

  it('🔴 el espejo normalizado de un descuento del catálogo: el renglón queda en 0 y sin appliedDiscountId', async () => {
    const t = txRevertir([{ id: 'plato', discountAmount: D(10), appliedDiscountId: 'd10', isCortesia: false }])
    await revertirDescuentoDelRenglon(t, 'o1', espejoNormalizado)
    const { data } = t.orderItem.update.mock.calls[0][0]
    expect([Number(data.discountAmount), data.appliedDiscountId]).toEqual([0, null])
  })

  it('control — si al renglón le queda descuento, su appliedDiscountId se conserva', async () => {
    const t = txRevertir([{ id: 'plato', discountAmount: D(15), appliedDiscountId: 'd10', isCortesia: false }])
    await revertirDescuentoDelRenglon(t, 'o1', espejoNormalizado)
    const { data } = t.orderItem.update.mock.calls[0][0]
    expect(Number(data.discountAmount)).toBe(5)
    expect(data).not.toHaveProperty('appliedDiscountId')
  })
})

describe('conservarDescuentoHistorico (Codex r1 P1)', () => {
  const txHistorico = (filas: unknown[], renglones: unknown[] = []) =>
    ({
      orderItem: { findMany: jest.fn().mockResolvedValue(renglones) },
      orderDiscount: { findMany: jest.fn().mockResolvedValue(filas), create: jest.fn().mockResolvedValue({}) },
    }) as any

  it('🔴 cabecera de $20 sin filas: el resto queda en una fila FIJA sin reparto, con el tx del llamador', async () => {
    const tx = txHistorico([])
    await conservarDescuentoHistorico(tx, 'o1', D(20))
    expect(tx.orderDiscount.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1' } }))
    expect(tx.orderDiscount.create).toHaveBeenCalledTimes(1)
    const { data } = tx.orderDiscount.create.mock.calls[0][0]
    expect(data).toMatchObject({ orderId: 'o1', type: 'FIXED_AMOUNT', name: 'Descuento anterior', isManual: true })
    expect([Number(data.value), Number(data.amount), Number(data.taxReduction)]).toEqual([20, 20, 0])
    expect(data.reparto).toBeUndefined() // D8: importe congelado, nunca se re-deriva
    expect(data.appliedToItemIds).toBeUndefined()
    expect(prismaMock.orderDiscount.create).not.toHaveBeenCalled()
  })
  it('🔴 con filas: sólo materializa lo que la cabecera trae DE MÁS, en centavos exactos (30.00 − 10.01 = 19.99)', async () => {
    const tx = txHistorico([{ id: 'od', amount: D(10.01) }])
    await conservarDescuentoHistorico(tx, 'o1', 30)
    expect(tx.orderDiscount.create.mock.calls.map((c: any) => Number(c[0].data.amount))).toEqual([19.99])
  })
  // Controles de regresión: una orden sana (cabecera = Σ filas) o con cabecera menor no gana fila.
  it('control — cabecera igual a la suma de sus filas, menor, o en 0: ninguna fila nueva', async () => {
    for (const [cabecera, filas] of [
      [D(15), [{ amount: D(10) }, { amount: D(5) }]],
      [D(5), [{ amount: D(10) }]],
      [D(0), []],
      [null, []],
    ] as const) {
      const tx = txHistorico([...filas])
      await conservarDescuentoHistorico(tx, 'o1', cabecera)
      expect(tx.orderDiscount.create).not.toHaveBeenCalled()
    }
  })
})

// B2c F2 (Codex r1 #3, #4; ruling «P2 R5/R15, transición»): en una orden VIEJA parte del resto de cabecera es de renglones
// identificables (la cortesía vieja de la terminal, el descuento propio de un vale sin espejo). Antes de congelar el resto,
// esos renglones reciben su fila ESPEJO —tomando SÓLO del resto, por id— para que borrarlos o agregar después salga bien.
describe('B2c F2: conservar normaliza los descuentos de renglón sin espejo (Codex r1 #3, #4)', () => {
  const tx = (renglones: unknown[], filas: unknown[]) =>
    ({
      orderItem: { findMany: jest.fn().mockResolvedValue(renglones) },
      orderDiscount: { findMany: jest.fn().mockResolvedValue(filas), create: jest.fn().mockResolvedValue({}) },
    }) as any
  const creadas = (t: any) =>
    t.orderDiscount.create.mock.calls.map(([{ data }]: any) => ({
      name: data.name,
      amount: Number(data.amount),
      items: data.appliedToItemIds ?? null,
      reparto: data.reparto ?? null,
    }))
  const renglon = (id: string, total: number, descuento: number, extra: Record<string, unknown> = {}) => ({
    id,
    total: D(total),
    discountAmount: D(descuento),
    orderPromotionId: null,
    isCortesia: false,
    cortesiaReason: null,
    appliedDiscountId: null,
    appliedDiscount: null,
    ...extra,
  })
  const espejo = (renglones: Record<string, number>) => ({ v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones })
  const fijoDeCuenta = { id: 'fijo', type: 'FIXED_AMOUNT', amount: D(10), reparto: nuevoRepartoDeCuenta({ conPromociones: true }) }

  it('🔴 Codex #3: café regalado $100 + pan $50, fijo $10, cabecera $110 ⇒ la cortesía gana su espejo COMP de $100 y no queda «Descuento anterior»', async () => {
    const t = tx([renglon('cafe', 100, 100, { isCortesia: true, cortesiaReason: 'Invitación' }), renglon('pan', 50, 0)], [fijoDeCuenta])
    await conservarDescuentoHistorico(t, 'o1', D(110))
    expect(t.orderItem.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: { orderId: 'o1' } }))
    expect(creadas(t)).toEqual([{ name: 'Cortesía', amount: 100, items: ['cafe'], reparto: espejo({ cafe: 10000 }) }])
    const { data } = t.orderDiscount.create.mock.calls[0][0]
    expect(data).toMatchObject({ orderId: 'o1', type: 'COMP', isComp: true, isManual: true, compReason: 'Invitación', appliedById: null })
    expect([Number(data.value), Number(data.taxReduction)]).toEqual([100, 0])
  })

  it('🔴 Codex #4: vale viejo con plato de $100 y descuento propio de $10 sin espejo ⇒ espejo dirigido de $10 (no «Descuento anterior»)', async () => {
    const t = tx([renglon('plato', 100, 10)], [])
    await conservarDescuentoHistorico(t, 'o1', D(10))
    expect(creadas(t)).toEqual([{ name: 'Descuento del artículo', amount: 10, items: ['plato'], reparto: espejo({ plato: 1000 }) }])
    expect(t.orderDiscount.create.mock.calls[0][0].data).toMatchObject({
      orderId: 'o1',
      type: 'FIXED_AMOUNT',
      discountId: null,
      isComp: false,
    })
  })

  // F2b (Codex r2): el espejo NORMALIZADO nunca consumió un uso del catálogo; ligado por `discountId`, quitarlo lo «devolvía»
  // (`currentUses` −1) y lo contaba como uso del cliente. Lleva nombre, tipo y valor del catálogo, SIN `discountId`.
  it('🔴 F2b: con el descuento del catálogo ligado al renglón, el espejo lleva su nombre, tipo y valor pero NO su discountId', async () => {
    const diez = { id: 'd10', type: 'PERCENTAGE', name: '10 % plato', value: D(10), compReason: null }
    const t = tx([renglon('plato', 100, 10, { appliedDiscountId: 'd10', appliedDiscount: diez })], [])
    await conservarDescuentoHistorico(t, 'o1', D(10))
    expect(creadas(t)).toEqual([{ name: '10 % plato', amount: 10, items: ['plato'], reparto: espejo({ plato: 1000 }) }])
    const { data } = t.orderDiscount.create.mock.calls[0][0]
    expect(data).toMatchObject({ discountId: null, type: 'PERCENTAGE', isComp: false })
    expect(Number(data.value)).toBe(10)
  })

  it('🔴 si el resto no alcanza, el espejo lleva sólo lo que queda (cortesía de $100, resto $60 ⇒ espejo $60, sin «Descuento anterior»)', async () => {
    const t = tx([renglon('a', 100, 100, { isCortesia: true })], [])
    await conservarDescuentoHistorico(t, 'o1', D(60))
    expect(creadas(t)).toEqual([{ name: 'Cortesía', amount: 60, items: ['a'], reparto: espejo({ a: 6000 }) }])
  })

  it('🔴 si el resto alcanza y sobra, lo que sobra sigue como «Descuento anterior» sin reparto ($10 de espejo + $20.01)', async () => {
    const t = tx([renglon('a', 100, 10)], [])
    await conservarDescuentoHistorico(t, 'o1', D(30.01))
    expect(creadas(t)).toEqual([
      { name: 'Descuento del artículo', amount: 10, items: ['a'], reparto: espejo({ a: 1000 }) },
      { name: 'Descuento anterior', amount: 20.01, items: null, reparto: null },
    ])
  })

  it('🔴 orden determinista por id: el resto se reparte a «a» antes que a «b», aunque lleguen al revés', async () => {
    const t = tx([renglon('b', 100, 100, { isCortesia: true }), renglon('a', 80, 10)], [])
    await conservarDescuentoHistorico(t, 'o1', D(50))
    expect(creadas(t)).toEqual([
      { name: 'Descuento del artículo', amount: 10, items: ['a'], reparto: espejo({ a: 1000 }) },
      { name: 'Cortesía', amount: 40, items: ['b'], reparto: espejo({ b: 4000 }) },
    ])
  })

  it('🔴 la cortesía de la terminal en una línea de promoción SÍ se normaliza (su total bruto sigue en el subtotal)', async () => {
    const t = tx([renglon('combo', 80, 80, { isCortesia: true, orderPromotionId: 'op1' })], [])
    await conservarDescuentoHistorico(t, 'o1', D(80))
    expect(creadas(t)).toEqual([{ name: 'Cortesía', amount: 80, items: ['combo'], reparto: espejo({ combo: 8000 }) }])
  })

  it('control — una línea de promoción normal no se normaliza: su descuento es de la promoción; el resto queda entero', async () => {
    const t = tx([renglon('combo', 80, 20, { orderPromotionId: 'op1' })], [])
    await conservarDescuentoHistorico(t, 'o1', D(20))
    expect(creadas(t)).toEqual([{ name: 'Descuento anterior', amount: 20, items: null, reparto: null }])
  })

  it('control — la cortesía del móvil (total 0: ya salió del subtotal) no se normaliza', async () => {
    const t = tx([renglon('pan', 0, 50, { isCortesia: true })], [])
    await conservarDescuentoHistorico(t, 'o1', D(20))
    expect(creadas(t)).toEqual([{ name: 'Descuento anterior', amount: 20, items: null, reparto: null }])
  })

  it.each([
    [
      'forma nueva (reparto espejo)',
      { id: 'e', type: 'FIXED_AMOUNT', amount: D(10), reparto: espejo({ a: 1000 }), appliedToItemIds: ['a'] },
    ],
    [
      'forma vieja de buildItemDiscountRow (ligada al descuento del renglón)',
      { id: 'e', type: 'PERCENTAGE', amount: D(10), discountId: 'd10', appliedToItemIds: ['a'], reparto: null },
    ],
    [
      'forma vieja de la cortesía de «Cobrar» (COMP sin discountId)',
      { id: 'e', type: 'COMP', isComp: true, amount: D(10), discountId: null, appliedToItemIds: ['a'], reparto: null },
    ],
  ])('control — un renglón ya espejado por la %s no gana otro espejo', async (_forma, fila) => {
    const a = renglon('a', 100, 10, { appliedDiscountId: 'd10', isCortesia: (fila as any).type === 'COMP' })
    const t = tx([a], [fila])
    await conservarDescuentoHistorico(t, 'o1', D(30))
    expect(creadas(t)).toEqual([{ name: 'Descuento anterior', amount: 20, items: null, reparto: null }])
  })

  it('control — una orden nueva (cabecera = Σ filas) no lee renglones ni crea nada', async () => {
    const t = tx([renglon('a', 100, 100, { isCortesia: true })], [{ id: 'f', amount: D(100) }])
    await conservarDescuentoHistorico(t, 'o1', D(100))
    expect(t.orderItem.findMany).not.toHaveBeenCalled()
    expect(t.orderDiscount.create).not.toHaveBeenCalled()
  })

  it('control — el cobro no cambia: Σ filas de antes + lo creado = la cabecera, con espejos parciales y resto', async () => {
    for (const cabecera of [5, 10, 55, 110, 200.37]) {
      const t = tx(
        [renglon('c', 100, 100, { isCortesia: true }), renglon('a', 100, 10), renglon('p', 80, 20, { orderPromotionId: 'op' })],
        [fijoDeCuenta],
      )
      await conservarDescuentoHistorico(t, 'o1', D(cabecera))
      const suma = creadas(t).reduce((s: number, f: any) => s + Math.round(f.amount * 100), 1000)
      expect({ cabecera, suma: suma / 100 }).toEqual({ cabecera, suma: Math.max(cabecera, 10) })
    }
  })
})

describe('B2b: la reducción de impuesto sigue al reparto (D16; Codex r1 #3, r2 N3)', () => {
  const cuenta = (renglones: Record<string, number>) => ({
    v: 1,
    alcance: 'CUENTA',
    conPromociones: false,
    espejo: false,
    reduceImpuesto: true,
    renglones,
  })
  it('🔴 IVA_APARTE: $10 sobre el renglón gravado; entra uno exento ⇒ 5/5 ⇒ 1.60 → 0.80, y el impuesto de la orden sube 0.80', async () => {
    const tx = txDoble(
      [
        { id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 },
        { id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      ],
      [
        {
          id: 'od',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 1.6,
          appliedToItemIds: [],
          createdAt: null,
          reparto: cuenta({ a: 1000 }),
        },
      ],
    )
    tx.order = {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 14.4 }),
      update: jest.fn().mockResolvedValue({}),
    }
    const res = await sincronizarRepartos(tx, 'o1')
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od' },
      data: { taxReduction: 0.8, reparto: cuenta({ a: 500, b: 500 }) },
    })
    expect(Number(tx.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(0.8)
    expect(tx.order.update.mock.calls[0][0].where).toEqual({ id: 'o1' })
    expect(Number(res.impuestoDevuelto)).toBe(0.8)
  })
  it('🔴 Codex r2 N3: una reducción que llegó a 0 vuelve cuando el reparto regresa al renglón gravado ($0.80 → $0 → $0.80)', async () => {
    const renglones = (aCobra: boolean) => [
      { id: 'a', total: 100, discountAmount: aCobra ? 0 : 100, orderPromotionId: null, taxAmount: 16 },
      { id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
    ]
    const fila = (taxReduction: number, partes: Record<string, number>) => ({
      id: 'od',
      type: 'FIXED_AMOUNT',
      value: 10,
      amount: 10,
      taxReduction,
      appliedToItemIds: [],
      createdAt: null,
      reparto: cuenta(partes),
    })
    // 1) A se regala (sin lugar): los $10 caen en B, exento ⇒ 0.80 → 0.
    const paso1 = txDoble(renglones(false), [fila(0.8, { a: 500, b: 500 })])
    paso1.order = {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 15.2 }),
      update: jest.fn().mockResolvedValue({}),
    }
    await sincronizarRepartos(paso1, 'o1')
    expect(paso1.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od' },
      data: { taxReduction: 0, reparto: cuenta({ b: 1000 }) },
    })
    // 2) Se quita la cortesía: vuelve el 5/5 ⇒ 0 → 0.80 (v2 lo dejaba en 0 porque sólo miraba reducciones > 0).
    const paso2 = txDoble(renglones(true), [fila(0, { b: 1000 })])
    paso2.order = {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 16 }),
      update: jest.fn().mockResolvedValue({}),
    }
    await sincronizarRepartos(paso2, 'o1')
    expect(paso2.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od' },
      data: { taxReduction: 0.8, reparto: cuenta({ a: 500, b: 500 }) },
    })
    expect(Number(paso2.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(-0.8)
  })
  it('🔴 Codex r3 V4: el renglón cambia de importe y el reparto NO ⇒ la reducción se recalcula igual (1.60 → 0.80) y sólo ella se escribe', async () => {
    // A subió de $100 a $200 por el camino de hoy (`addItemsToOrder` con el carrito completo: misma fila, otra cantidad) sin
    // cambiar su impuesto registrado; el mapa sigue { a: 1000 }.
    const tx = txDoble(
      [{ id: 'a', total: 200, discountAmount: 0, orderPromotionId: null, taxAmount: 16 }],
      [
        {
          id: 'od',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 1.6,
          appliedToItemIds: [],
          createdAt: null,
          reparto: cuenta({ a: 1000 }),
        },
      ],
    )
    tx.order = {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 14.4 }),
      update: jest.fn().mockResolvedValue({}),
    }
    const res = await sincronizarRepartos(tx, 'o1')
    expect(tx.orderDiscount.update.mock.calls).toEqual([[{ where: { id: 'od' }, data: { taxReduction: 0.8 } }]])
    expect(Number(tx.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(0.8)
    expect(Number(res.impuestoDevuelto)).toBe(0.8)
  })
  it('control — Codex r3 V4: sincronizar otra vez sin cambios no escribe nada (ni la fila ni el impuesto)', async () => {
    const tx = txDoble(
      [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 }],
      [
        {
          id: 'od',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 1.6,
          appliedToItemIds: [],
          createdAt: null,
          reparto: cuenta({ a: 1000 }),
        },
      ],
    )
    tx.order = { findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 14.4 }), update: jest.fn() }
    const res = await sincronizarRepartos(tx, 'o1')
    expect(tx.orderDiscount.update).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(Number(res.impuestoDevuelto)).toBe(0)
  })
  it('🔴 Codex r3 V3: la fila nueva del motor (marcada, en 0, reparto de cuenta aún vacío) recibe aquí su reducción, UNA vez', async () => {
    const tx = txDoble(
      [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 }],
      [
        {
          id: 'nueva',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 0,
          appliedToItemIds: [],
          createdAt: null,
          reparto: cuenta({}),
        },
      ],
    )
    tx.order = {
      findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 16 }),
      update: jest.fn().mockResolvedValue({}),
    }
    const res = await sincronizarRepartos(tx, 'o1')
    expect(tx.orderDiscount.update.mock.calls).toEqual([
      [{ where: { id: 'nueva' }, data: { taxReduction: 1.6, reparto: cuenta({ a: 1000 }) } }],
    ])
    expect(Number(res.impuestoDevuelto)).toBe(-1.6)
  })
  it('control — una fila que NO participa en D16 (vieja del 16 %, o sin la marca): su reducción no se toca aunque cambie el reparto, ni se lee la orden', async () => {
    const tx = txDoble(
      [
        { id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
        { id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      ],
      [
        {
          id: 'od',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 1.6,
          appliedToItemIds: [],
          createdAt: null,
          reparto: { ...cuenta({ a: 1000 }), reduceImpuesto: undefined },
        },
      ],
    )
    tx.order = { findUniqueOrThrow: jest.fn(), update: jest.fn() }
    const res = await sincronizarRepartos(tx, 'o1')
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({
      where: { id: 'od' },
      data: { reparto: { v: 1, alcance: 'CUENTA', conPromociones: false, espejo: false, renglones: { a: 500, b: 500 } } },
    })
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(Number(res.impuestoDevuelto)).toBe(0)
  })
  it('control — con la marca pero en una orden que no es IVA_APARTE: no se recalcula', async () => {
    const tx = txDoble(
      [
        { id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 },
        { id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      ],
      [
        {
          id: 'od',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 0,
          appliedToItemIds: [],
          createdAt: null,
          reparto: cuenta({ a: 1000 }),
        },
      ],
    )
    tx.order = { findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'DESCONOCIDO', taxAmount: 16 }), update: jest.fn() }
    await sincronizarRepartos(tx, 'o1')
    expect(tx.orderDiscount.update).toHaveBeenCalledWith({ where: { id: 'od' }, data: { reparto: cuenta({ a: 500, b: 500 }) } })
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  // Revisión de T3: el tope de cabecera se reconstruye con lo que las filas YA restaron (taxAmount + Σ guardadas). Sin ese
  // término, un descuento marcado de más de la mitad de la base gravada perdería reducción en cada sincronización (6.40 en vez
  // de 9.60, +3.20 de IVA cobrado de más). Control: pasa con el cuerpo neutro; cae con el sabotaje «sin + Σ guardadas».
  it('control — la base del tope suma lo que la fila ya restó: una reducción de 9.60 con cabecera en 6.40 no se devuelve', async () => {
    const tx = txDoble(
      [{ id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 }],
      [
        {
          id: 'od',
          type: 'FIXED_AMOUNT',
          value: 60,
          amount: 60,
          taxReduction: 9.6,
          appliedToItemIds: [],
          createdAt: null,
          reparto: cuenta({ a: 6000 }),
        },
      ],
    )
    tx.order = { findUniqueOrThrow: jest.fn().mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 6.4 }), update: jest.fn() }
    const res = await sincronizarRepartos(tx, 'o1')
    expect(tx.order.findUniqueOrThrow).toHaveBeenCalledTimes(1) // la fila participa (reduceImpuesto: true)
    expect(tx.orderDiscount.update).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
    expect(Number(res.impuestoDevuelto)).toBe(0)
  })
})

describe('retirarImpuestoDeRenglones — R9 (Codex r4 R4-1)', () => {
  const txR9 = (orden: unknown, filas: unknown[] = []) =>
    ({
      order: { findUniqueOrThrow: jest.fn().mockResolvedValue(orden), update: jest.fn().mockResolvedValue({}) },
      orderDiscount: { findMany: jest.fn().mockResolvedValue(filas) },
    }) as any
  it('🔴 baja la cabecera por el IVA de lo que sale, con la transacción de quien llama (24 ⇒ increment −16)', async () => {
    const tx = txR9({ contratoDePrecio: 'IVA_APARTE', taxAmount: 24 })
    expect(Number(await retirarImpuestoDeRenglones(tx, 'o1', [{ taxAmount: 16 }]))).toBe(16)
    expect(tx.order.update.mock.calls).toHaveLength(1)
    expect(tx.order.update.mock.calls[0][0].where).toEqual({ id: 'o1' })
    expect(Number(tx.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(-16)
  })
  it('🔴 caso 2: la base suma lo que restaron las filas que VUELVEN (cabecera 0, una dirigida D16 con 16 ⇒ increment −16)', async () => {
    const dirigida = {
      id: 'dirigida',
      name: '100 % café',
      taxReduction: 16,
      reparto: { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: false, reduceImpuesto: true, renglones: { a: 10000 } },
    }
    const tx = txR9({ contratoDePrecio: 'IVA_APARTE', taxAmount: 0 }, [dirigida])
    expect(Number(await retirarImpuestoDeRenglones(tx, 'o1', [{ taxAmount: 16 }]))).toBe(16)
    expect(tx.orderDiscount.findMany).toHaveBeenCalledWith({ where: { orderId: 'o1' } })
    expect(Number(tx.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(-16)
  })
  it('🔴 Codex r5 #1: una reducción HEREDADA (sin la marca) rechaza la operación sin escribir nada (la v5: increment −16 y cabecera −3.20)', async () => {
    const tx = txR9({ contratoDePrecio: 'IVA_APARTE', taxAmount: 12.8 }, [
      { id: 'vieja', name: 'Viejo 16 %', taxReduction: 3.2, reparto: null },
    ])
    await expect(retirarImpuestoDeRenglones(tx, 'o1', [{ taxAmount: 16 }])).rejects.toMatchObject({
      code: 'DESCUENTO_CON_IVA_ANTERIOR',
      details: { descuentos: [{ id: 'vieja', name: 'Viejo 16 %' }] },
    })
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  // Preflight R-1: los dos pasan con el cuerpo neutro (ni lee ni escribe); caen con los sabotajes «sin el atajo de lo que sale
  // sin IVA» y «sin la rama de IVA incluido».
  it('control — sin IVA en lo que sale (toda venta nativa) no lee ni escribe nada', async () => {
    const tx = txR9({ contratoDePrecio: 'IVA_INCLUIDO', taxAmount: 0 })
    expect(Number(await retirarImpuestoDeRenglones(tx, 'o1', [{ taxAmount: 0 }, {}]))).toBe(0)
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  it('control — con IVA incluido no lee las filas ni toca la cabecera', async () => {
    const tx = txR9({ contratoDePrecio: 'IVA_INCLUIDO', taxAmount: 16 })
    expect(Number(await retirarImpuestoDeRenglones(tx, 'o1', [{ taxAmount: 16 }]))).toBe(0)
    expect(tx.orderDiscount.findMany).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })
})

describe('recortarDescuentosDeRenglones — B2c (P4, P5)', () => {
  const dirigido = (renglones: Record<string, number>, espejo = false) => ({
    v: 1,
    alcance: 'DIRIGIDO',
    conPromociones: null,
    espejo,
    renglones,
  })
  function txRecorte(cambian: unknown[], filas: unknown[], vivos: unknown[] = []) {
    return {
      orderItem: { findMany: jest.fn(async (a: any) => (a.where.id ? cambian : vivos)) },
      orderDiscount: {
        findMany: jest.fn().mockResolvedValue(filas),
        update: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
      },
      stampReward: { findFirst: jest.fn().mockResolvedValue(null), update: jest.fn().mockResolvedValue({}) },
      loyaltyTransaction: { findUnique: jest.fn(), create: jest.fn() },
      customer: { update: jest.fn() },
      staffVenue: { findUnique: jest.fn() },
      order: { findUniqueOrThrow: jest.fn(), update: jest.fn().mockResolvedValue({}) },
    } as any
  }

  it('🔴 lee los renglones que cambian con su tope y retira el premio dirigido devolviendo el premio', async () => {
    const tx = txRecorte(
      [{ id: 'cort', appliedDiscountId: null, isCortesia: true, discountAmount: 200 }],
      [
        {
          id: 'premio',
          name: 'Café gratis',
          type: 'FIXED_AMOUNT',
          value: 100,
          amount: 100,
          taxReduction: 0,
          loyaltyTransactionId: null,
          appliedToItemIds: [],
          reparto: dirigido({ cort: 0 }),
        },
      ],
    )
    tx.stampReward.findFirst.mockResolvedValue({ id: 'rw', customerId: 'c1', rewardLabel: 'Café gratis' })
    const res = await recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['cort'], venueId: 'v1' })
    expect(tx.orderItem.findMany).toHaveBeenCalledWith({
      where: { orderId: 'o1', id: { in: ['cort'] } },
      select: { id: true, appliedDiscountId: true, isCortesia: true, discountAmount: true },
      take: 1,
    })
    expect(tx.stampReward.update).toHaveBeenCalledWith({
      where: { id: 'rw' },
      data: { status: 'PENDING', redeemedAt: null, orderDiscountId: null },
    })
    expect(tx.orderDiscount.delete).toHaveBeenCalledWith({ where: { id: 'premio' } })
    expect(res).toMatchObject({
      recortadoPesos: 100,
      retiradas: [{ id: 'premio', name: 'Café gratis', pointsRefunded: 0, stampRewardReturned: 'rw' }],
    })
  })
  it('recorta una DIRIGIDA por su parte guardada, en UNA actualización', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
      [
        {
          id: 'cat',
          name: '10 % pan',
          type: 'PERCENTAGE',
          value: 10,
          amount: 20,
          taxReduction: 0,
          appliedToItemIds: [],
          reparto: dirigido({ a: 500, b: 1500 }),
        },
      ],
    )
    const res = await recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })
    expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
    const { where, data } = tx.orderDiscount.update.mock.calls[0][0]
    expect(where).toEqual({ id: 'cat' })
    expect(Number(data.amount)).toBe(15)
    expect(data).toMatchObject({ appliedToItemIds: [], reparto: dirigido({ b: 1500 }) })
    expect(res.recortadoPesos).toBe(5)
  })
  it('B2b: retirar una fila con reducción de impuesto la devuelve a la orden', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: 'cat-10', isCortesia: false, discountAmount: 10 }],
      [
        {
          id: 'esp',
          name: '10 %',
          type: 'PERCENTAGE',
          value: 10,
          amount: 10,
          taxReduction: 1.6,
          appliedToItemIds: ['a'],
          reparto: dirigido({ a: 1000 }, true),
        },
      ],
    )
    const res = await recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })
    expect(tx.order.update).toHaveBeenCalledTimes(1)
    expect(Number(tx.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(1.6)
    expect(Number(res.impuestoDevuelto)).toBe(1.6)
  })
  // Provisional a propósito (preflight T-3): la sincronización que corre después recalcula toda fila marcada.
  it('B2b: recortar una DIRIGIDA de una orden IVA_APARTE recalcula su reducción con lo que le queda (0.80 → 0)', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
      [
        {
          id: 'cat',
          name: 'Categoría',
          type: 'FIXED_AMOUNT',
          value: 20,
          amount: 20,
          taxReduction: 0.8,
          appliedToItemIds: [],
          reparto: { ...dirigido({ a: 500, b: 1500 }), reduceImpuesto: true },
        },
      ],
      [
        { id: 'a', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 16 },
        { id: 'b', total: 100, discountAmount: 0, orderPromotionId: null, taxAmount: 0 },
      ],
    )
    tx.order.findUniqueOrThrow.mockResolvedValue({ contratoDePrecio: 'IVA_APARTE', taxAmount: 15.2 })
    await recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })
    expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
    expect(tx.orderDiscount.update.mock.calls[0][0].data.taxReduction).toBe(0)
    expect(tx.order.update).toHaveBeenCalledTimes(1)
    expect(Number(tx.order.update.mock.calls[0][0].data.taxAmount.increment)).toBe(0.8)
  })
  it('B2b: una recortada SIN la marca de D16 no relee la orden ni toca su reducción', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
      [
        {
          id: 'cat',
          name: 'Categoría',
          type: 'FIXED_AMOUNT',
          value: 20,
          amount: 20,
          taxReduction: 0.8,
          appliedToItemIds: [],
          reparto: dirigido({ a: 500, b: 1500 }),
        },
      ],
    )
    await recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })
    expect(tx.order.findUniqueOrThrow).not.toHaveBeenCalled()
    expect(tx.orderDiscount.update).toHaveBeenCalledTimes(1)
    expect(tx.orderDiscount.update.mock.calls[0][0].data.taxReduction).toBeUndefined()
  })
  it('control — sin filas afectadas no escribe nada', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
      [
        {
          id: 'cta',
          name: 'Cuenta',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 0,
          appliedToItemIds: [],
          reparto: { v: 1, alcance: 'CUENTA', conPromociones: true, espejo: false, renglones: { a: 1000 } },
        },
      ],
    )
    expect(await recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })).toMatchObject({
      recortadoPesos: 0,
      retiradas: [],
    })
    expect(tx.orderDiscount.update).not.toHaveBeenCalled()
    expect(tx.orderDiscount.delete).not.toHaveBeenCalled()
    expect(tx.order.update).not.toHaveBeenCalled()
  })
  it('un error transitorio al borrar sale tal cual', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
      [
        {
          id: 'esp',
          name: 'x',
          type: 'FIXED_AMOUNT',
          value: 10,
          amount: 10,
          taxReduction: 0,
          appliedToItemIds: ['a'],
          reparto: dirigido({ a: 1000 }, true),
        },
      ],
    )
    tx.orderDiscount.delete.mockRejectedValue(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
    await expect(recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })).rejects.toMatchObject({ code: 'P2028' })
  })

  // Tarea 7a (hueco del sabotaje «envolver el P2028 del recorte»): la prueba de arriba sólo cubre RETIRAR; un transitorio al
  // RECORTAR (la actualización de la fila) también tiene que salir tal cual para que el reducer lo deje en RETRY.
  it('control — un error transitorio al recortar sale tal cual', async () => {
    const tx = txRecorte(
      [{ id: 'a', appliedDiscountId: null, isCortesia: false, discountAmount: 0 }],
      [
        {
          id: 'cat',
          name: '10 % pan',
          type: 'PERCENTAGE',
          value: 10,
          amount: 20,
          taxReduction: 0,
          appliedToItemIds: [],
          reparto: dirigido({ a: 500, b: 1500 }),
        },
      ],
    )
    tx.orderDiscount.update.mockRejectedValue(Object.assign(new Error('Transaction API error'), { code: 'P2028' }))
    await expect(recortarDescuentosDeRenglones(tx, 'o1', { renglones: ['a'], venueId: 'v1' })).rejects.toMatchObject({ code: 'P2028' })
  })
})
