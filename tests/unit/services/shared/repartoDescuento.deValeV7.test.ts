/**
 * Tarjeta na24531d (v4, 18-nov): la marca `deValeV7` del reparto. La ponen sólo las filas que nacen al cobrar vales V7
 * (`materializeAreaTicketCheckout`) y es lo que el candado de «quitar» mira (`rechazarSiQuitaUnDescuentoDeVale`), así que tiene que
 * sobrevivir a todo lo que vuelve a escribir el reparto: leerlo, compararlo y el recorte de B2c al quitar o regalar un renglón.
 */
import { esFilaDeValeV7, leerReparto, mismoReparto, nuevoRepartoDirigido, recorteDeFila } from '@/services/shared/repartoDescuento'

const sinMarca = { v: 1, alcance: 'DIRIGIDO', conPromociones: null, espejo: true, renglones: { a: 1000, b: 400 } }
const marcada = { ...sinMarca, deValeV7: true }

describe('reparto: la marca de la fila de un cobro de vales V7 (na24531d)', () => {
  it('🔴 nuevoRepartoDirigido la pone sólo si se pide', () => {
    expect(nuevoRepartoDirigido(14, { a: 10, b: 4 }, { espejo: true, deValeV7: true })).toEqual(marcada)
    expect(nuevoRepartoDirigido(14, { a: 10, b: 4 }, { espejo: true })).toEqual(sinMarca)
  })

  it('🔴 leerReparto la conserva; una marca que no es booleana hace inválido el reparto (como reduceImpuesto)', () => {
    expect(leerReparto(marcada)).toEqual(marcada)
    expect(leerReparto(sinMarca)).toEqual(sinMarca)
    expect(leerReparto({ ...marcada, deValeV7: 'sí' })).toBeNull()
  })

  it('🔴 mismoReparto la distingue (una fila que la perdiera se reescribiría)', () => {
    expect(mismoReparto(marcada as any, sinMarca as any)).toBe(false)
    expect(mismoReparto(marcada as any, { ...marcada } as any)).toBe(true)
  })

  it('🔴 el recorte de B2c (quitar o regalar uno de sus renglones) la conserva en el reparto que reescribe', () => {
    const fila = {
      id: 'od-1',
      type: 'PERCENTAGE',
      value: 10,
      amount: 14,
      appliedToItemIds: ['a', 'b'],
      reparto: marcada,
      discountId: 'd10',
    }
    const recorte = recorteDeFila(fila, [{ id: 'b', appliedDiscountId: 'd10', discountAmount: 4 }])
    expect(recorte).toEqual(expect.objectContaining({ accion: 'RECORTAR', amountCents: 1000, appliedToItemIds: ['a'] }))
    expect(recorte.accion === 'RECORTAR' && recorte.reparto).toEqual({ ...marcada, renglones: { a: 1000 } })
  })

  it('🔴 esFilaDeValeV7 lee el JSON crudo: con la marca, aunque el resto del reparto no se pueda leer', () => {
    expect(esFilaDeValeV7(marcada)).toBe(true)
    expect(esFilaDeValeV7({ ...marcada, v: 2 })).toBe(true)
    expect(esFilaDeValeV7(sinMarca)).toBe(false)
    expect(esFilaDeValeV7({ ...marcada, deValeV7: 'true' })).toBe(false)
    expect(esFilaDeValeV7(null)).toBe(false)
    expect(esFilaDeValeV7([])).toBe(false)
  })
})
