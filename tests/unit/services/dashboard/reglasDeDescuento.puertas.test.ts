/**
 * D14 v2 (5-nov-2026): cada puerta que escribe alcance o límites llama a la regla única y escribe con la protección de dos
 * ediciones. Un caso por hallazgo de Codex r1–r5 que pasa por una puerta (la regla en sí: reglasDeDescuento.test.ts).
 */
import { Request, Response } from 'express'
import { prismaMock } from '../../../__helpers__/setup'
import * as movilDescuentos from '../../../../src/controllers/mobile/discount.mobile.controller'
import * as movilCupones from '../../../../src/controllers/mobile/coupon.mobile.controller'
import {
  assignDiscountToCustomer,
  cloneDiscount,
  createDiscount,
  updateDiscount,
} from '../../../../src/services/dashboard/discount.dashboard.service'
import { bulkGenerateCouponCodes, createCouponCode, updateCouponCode } from '../../../../src/services/dashboard/coupon.dashboard.service'
import { createDiscountBodySchema, updateDiscountBodySchema } from '../../../../src/schemas/dashboard/discount.schema'
import { createCouponBodySchema, updateCouponBodySchema } from '../../../../src/schemas/dashboard/coupon.schema'
import { CAMBIO_CRUZADO, FORMA_INVALIDA, LIMITE_INVALIDO, SIN_CATEGORIAS } from '../../../../src/services/dashboard/reglasDeDescuento'

jest.mock('../../../../src/services/dashboard/activity-log.service', () => ({ logAction: jest.fn() }))

const descuento = (o: Record<string, unknown> = {}) =>
  ({
    id: 'd1',
    venueId: 'v1',
    name: 'Pan',
    type: 'PERCENTAGE',
    value: 10,
    scope: 'ORDER',
    targetCategoryIds: [],
    maxTotalUses: null,
    maxUsesPerCustomer: null,
    minPurchaseAmount: null,
    maxDiscountAmount: null,
    getDiscountPercent: null,
    ...o,
  }) as any
const p2025 = Object.assign(new Error('No record'), { code: 'P2025' })

const respuesta = () => {
  const res: any = {}
  res.status = jest.fn().mockReturnValue(res)
  res.json = jest.fn().mockReturnValue(res)
  return res as Response & { status: jest.Mock; json: jest.Mock }
}
const pedido = (body: any, params: any = { venueId: 'v1' }) =>
  ({ params, body, authContext: { staffVenueId: 'sv1' } }) as unknown as Request
const editar = { venueId: 'v1', discountId: 'd1' }

describe('Apps (ANDROID e iOS) · descuentos', () => {
  it('🔴 r1 #2: crear «Categorías» sin lista (iOS) o con [] → 400 en español, no se crea', async () => {
    for (const body of [{ scope: 'CATEGORY' }, { scope: 'CATEGORY', targetCategoryIds: [] }]) {
      const res = respuesta()
      await movilDescuentos.createDiscount(pedido({ name: 'Pan', type: 'PERCENTAGE', value: 10, ...body }), res)
      expect(res.status).toHaveBeenCalledWith(400)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: SIN_CATEGORIAS }))
    }
    expect(prismaMock.discount.create).not.toHaveBeenCalled()
  })

  it('🔴 r2 #2 y r3 #1: `{ set: [] }` o `{ set: "CATEGORY" }` → 400 de formato', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento())
    for (const body of [{ targetCategoryIds: { set: [] } }, { scope: { set: 'CATEGORY' } }]) {
      const res = respuesta()
      await movilDescuentos.updateDiscount(pedido(body, editar), res)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: FORMA_INVALIDA }))
    }
    expect(prismaMock.discount.update).not.toHaveBeenCalled()
  })

  it('🔴 r4 #1: iOS apaga uno viejo «Categorías» sin categorías reenviando sólo `scope` → se guarda', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento({ scope: 'CATEGORY' }))
    prismaMock.discount.update.mockResolvedValue(descuento({ scope: 'CATEGORY', active: false }))
    const res = respuesta()
    await movilDescuentos.updateDiscount(pedido({ name: 'Pan', type: 'PERCENTAGE', scope: 'CATEGORY', active: false }, editar), res)
    expect(res.status).not.toHaveBeenCalled() // 200 por res.json directo
    expect(prismaMock.discount.update).toHaveBeenCalled()
  })

  it('🔴 r4 #2: límites 0 o -1 al crear → 400', async () => {
    for (const body of [{ maxTotalUses: 0 }, { maxUsesPerCustomer: -1 }]) {
      const res = respuesta()
      await movilDescuentos.createDiscount(pedido({ name: 'Pan', type: 'PERCENTAGE', value: 10, ...body }), res)
      expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: LIMITE_INVALIDO }))
    }
  })

  it('🔴 r5 #1: reenviar `scope` igual escribe con la protección; si otro lo cambió en medio → 409 en español', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento({ scope: 'CATEGORY', targetCategoryIds: ['c1'] }))
    prismaMock.discount.update.mockRejectedValue(p2025)
    const res = respuesta()
    await movilDescuentos.updateDiscount(pedido({ scope: 'CATEGORY', name: 'A' }, editar), res)
    expect(prismaMock.discount.update.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ id: 'd1', scope: 'CATEGORY', targetCategoryIds: { equals: ['c1'] } }),
    )
    expect(res.status).toHaveBeenCalledWith(409)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: CAMBIO_CRUZADO }))
  })
})

describe('Apps · cupones', () => {
  it('🔴 r4 #2: crear con 0 usos (ANDROID manda lo escrito) → 400', async () => {
    const res = respuesta()
    await movilCupones.createCoupon(pedido({ discountId: 'd1', code: 'PAN10', maxUses: 0 }), res)
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ message: LIMITE_INVALIDO }))
    expect(prismaMock.couponCode.create).not.toHaveBeenCalled()
  })

  it('editar reenviando el 0 viejo pasa (con protección); cambiar a -1 no', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue({ id: 'k1', code: 'PAN10', maxUses: 0, maxUsesPerCustomer: null } as any)
    const r1 = respuesta()
    await movilCupones.updateCoupon(pedido({ maxUsesPerCustomer: -1 }, { venueId: 'v1', couponId: 'k1' }), r1)
    expect(r1.json).toHaveBeenCalledWith(expect.objectContaining({ message: LIMITE_INVALIDO }))

    prismaMock.couponCode.update.mockResolvedValue({ id: 'k1', code: 'PAN10', maxUses: 0, discount: { value: 10 } } as any)
    await movilCupones.updateCoupon(pedido({ maxUses: 0, active: false }, { venueId: 'v1', couponId: 'k1' }), respuesta())
    expect(prismaMock.couponCode.update.mock.calls[0][0].where).toEqual({ id: 'k1', maxUses: 0, maxUsesPerCustomer: null })
  })
})

describe('Panel y MCP · servicios', () => {
  it('🔴 r1 #1: editar parcial que deja «Categorías» vacía → 400', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento({ scope: 'CATEGORY', targetCategoryIds: ['c1'] }))
    await expect(updateDiscount('v1', 'd1', { targetCategoryIds: [] } as any)).rejects.toThrow(SIN_CATEGORIAS)
    prismaMock.discount.findFirst.mockResolvedValue(descuento())
    await expect(updateDiscount('v1', 'd1', { scope: 'CATEGORY' } as any)).rejects.toThrow(SIN_CATEGORIAS)
    expect(prismaMock.discount.update).not.toHaveBeenCalled()
  })

  it('crear (panel y MCP): «Categorías» sin categorías o límite 0 → 400', async () => {
    await expect(createDiscount('v1', { name: 'P', type: 'PERCENTAGE', value: 10, scope: 'CATEGORY' } as any)).rejects.toThrow(
      SIN_CATEGORIAS,
    )
    await expect(createDiscount('v1', { name: 'P', type: 'PERCENTAGE', value: 10, maxTotalUses: 0 } as any)).rejects.toThrow(
      LIMITE_INVALIDO,
    )
  })

  it('🔴 r2 #1 y r5 #2: «Duplicar» uno sin categorías o con límite 0/-1 → 400 «No se puede duplicar», no se crea', async () => {
    for (const viejo of [descuento({ scope: 'CATEGORY' }), descuento({ maxTotalUses: 0 }), descuento({ maxUsesPerCustomer: -1 })]) {
      prismaMock.discount.findFirst.mockResolvedValue(viejo)
      await expect(cloneDiscount('v1', 'd1')).rejects.toThrow(/^No se puede duplicar: /)
    }
    expect(prismaMock.discount.create).not.toHaveBeenCalled()
  })

  it('🔴 r5 #4 y r3 #2: reenviar CATEGORY + [] igual a lo guardado (apagar uno viejo) → se guarda', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento({ scope: 'CATEGORY' }))
    prismaMock.discount.update.mockResolvedValue(descuento({ scope: 'CATEGORY', active: false }))
    await updateDiscount('v1', 'd1', { scope: 'CATEGORY', targetCategoryIds: [], active: false } as any)
    // Lista vacía guardada: la protección acepta [] o NULL en la base (Codex, diseño #1)
    expect(prismaMock.discount.update.mock.calls[0][0].where).toEqual(
      expect.objectContaining({ OR: [{ targetCategoryIds: { equals: [] } }, { targetCategoryIds: { equals: null } }] }),
    )
  })

  it('🔴 r5 #3: reenviar un 0 viejo igual → se guarda; 🔴 r4 #3: null = sin límite', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento({ maxTotalUses: 0, maxUsesPerCustomer: 5 }))
    prismaMock.discount.update.mockResolvedValue(descuento())
    await updateDiscount('v1', 'd1', { maxTotalUses: 0, maxUsesPerCustomer: null, name: 'Otro' } as any)
    expect(prismaMock.discount.update.mock.calls[0][0].data).toEqual(
      expect.objectContaining({ maxTotalUses: 0, maxUsesPerCustomer: null, name: 'Otro' }),
    )
  })

  it('🔴 r2 #3 y r5 #1: otra edición en medio → 409 en español', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento({ scope: 'CATEGORY', targetCategoryIds: ['c1'] }))
    prismaMock.discount.update.mockRejectedValue(p2025)
    await expect(updateDiscount('v1', 'd1', { scope: 'CATEGORY', name: 'A' } as any)).rejects.toMatchObject({
      statusCode: 409,
      message: CAMBIO_CRUZADO,
    })
  })

  it('un cambio que no manda la regla escribe sólo por id (no hay 409 falso)', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento())
    prismaMock.discount.update.mockResolvedValue(descuento({ active: false }))
    await updateDiscount('v1', 'd1', { active: false } as any)
    expect(prismaMock.discount.update.mock.calls[0][0].where).toEqual({ id: 'd1' })
  })

  it('cupones del panel y del MCP: crear, editar y generar en lote con 0 → 400', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento())
    await expect(createCouponCode('v1', { discountId: 'd1', code: 'PAN10', maxUses: 0 } as any)).rejects.toThrow(LIMITE_INVALIDO)
    await expect(bulkGenerateCouponCodes('v1', { discountId: 'd1', quantity: 2, maxUsesPerCode: 0 } as any)).rejects.toThrow(
      LIMITE_INVALIDO,
    )
    prismaMock.couponCode.findFirst.mockResolvedValue({ id: 'k1', code: 'PAN10', maxUses: 5, maxUsesPerCustomer: null } as any)
    await expect(updateCouponCode('v1', 'k1', { maxUses: 0 } as any)).rejects.toThrow(LIMITE_INVALIDO)
  })

  it('cupón del panel: vaciar el límite (null) se guarda con protección; otra edición en medio → 409', async () => {
    prismaMock.couponCode.findFirst.mockResolvedValue({ id: 'k1', code: 'PAN10', maxUses: 5, maxUsesPerCustomer: null } as any)
    prismaMock.couponCode.update.mockRejectedValue(p2025)
    await expect(updateCouponCode('v1', 'k1', { maxUses: null } as any)).rejects.toMatchObject({ statusCode: 409 })
    expect(prismaMock.couponCode.update.mock.calls[0][0].where).toEqual({ id: 'k1', maxUses: 5, maxUsesPerCustomer: null })
  })

  it('🔴 diseño #2: reactivar una asignación sin mandar el límite no lo reescribe', async () => {
    prismaMock.discount.findFirst.mockResolvedValue(descuento())
    prismaMock.customer.findFirst.mockResolvedValue({ id: 'cu1' } as any)
    prismaMock.customerDiscount.findUnique.mockResolvedValue({ id: 'a1', maxUses: 5, validFrom: null, validUntil: null } as any)
    prismaMock.customerDiscount.update.mockResolvedValue({ id: 'a1' } as any)
    await assignDiscountToCustomer('v1', 'd1', 'cu1')
    const llamada = prismaMock.customerDiscount.update.mock.calls[0][0]
    expect(llamada.where).toEqual({ id: 'a1' })
    expect(llamada.data).not.toHaveProperty('maxUses')
  })
})

describe('Zod del panel · sólo forma, en español', () => {
  const crear = { name: 'P', type: 'PERCENTAGE', value: 10 }

  it('🔴 r1 #3: un 0 llega al servicio (que responde en español), no sale el inglés de Zod', () => {
    expect(createDiscountBodySchema.safeParse({ ...crear, maxTotalUses: 0 }).success).toBe(true)
    expect(createCouponBodySchema.safeParse({ discountId: 'd1', code: 'PAN10', maxUses: 0 }).success).toBe(true)
    const r = createDiscountBodySchema.safeParse({ ...crear, maxTotalUses: 1.5 })
    expect(r.success).toBe(false)
    expect(JSON.stringify(r)).toContain('Debe ser un número entero')
  })

  it('🔴 r5 #4: editar CATEGORY + [] (igual a lo guardado) pasa el esquema; null en límites también', () => {
    expect(updateDiscountBodySchema.safeParse({ scope: 'CATEGORY', targetCategoryIds: [], active: false }).success).toBe(true)
    expect(updateDiscountBodySchema.safeParse({ maxTotalUses: null }).success).toBe(true)
    expect(updateCouponBodySchema.safeParse({ maxUses: null }).success).toBe(true)
  })
})
