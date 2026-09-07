/**
 * Reasignar un cobro a la orden que de verdad pagó (corrección de datos, 2–5 sep 2026).
 *
 * Caso semilla (Testarudo, 2-sep 13:40): la orden del cliente quedó CANCELLED a las 13:39 y su
 * cobro con tarjeta ($46.75 + $7.01 de propina = $53.76 exactos) aterrizó en la orden VECINA,
 * que ya tenía su propio cobro. Resultado: una orden «sobrepagada» y una venta que en los
 * reportes aparece cancelada. Nadie pagó dos veces; los papeles están mal.
 *
 * Lo que estas pruebas protegen:
 *   1. 🔴 sólo se mueve un cobro COMPLETED que no sea reembolso, que esté HOY en la orden de
 *      origen declarada, y dentro del MISMO negocio.
 *   2. 🔴 el destino tiene que estar sin cobrar (ni un cobro completado) y no puede ser una
 *      orden ya pagada: mover un cobro a una orden pagada la sobrepaga, que es el defecto que
 *      se está corrigiendo.
 *   3. 🔴 el cobro tiene que CUBRIR la cuenta del destino (ni faltar ni sobrar más de un
 *      centavo), con la MISMA aritmética canónica del saldo (`computeOrderBalance`), y la orden
 *      de origen tiene que seguir cubierta sin él — si no, se abriría una deuda.
 *   4. aplicar sigue un orden fijo: mover → preparar destino → reconciliar ambas → devolver
 *      la fecha de cierre real → bitácora en las dos órdenes. Nada se escribe si la validación
 *      falla, y una carrera (el cobro ya no estaba donde se dijo) aborta ANTES de reconciliar.
 */
import { Prisma } from '@prisma/client'
import {
  aplicarReasignacion,
  validarReasignacion,
  type CasoReasignacion,
  type CobroFoto,
  type DepsAplicar,
  type OrdenFoto,
} from '@/services/shared/reasignarCobro'

const D = (v: string | number) => new Prisma.Decimal(v)

const caso: CasoReasignacion = {
  paymentId: 'pay-b',
  deOrden: 'ORD-VECINA',
  aOrden: 'ORD-CANCELADA',
  motivo: 'prueba',
}

const cobro = (over: Partial<CobroFoto> = {}): CobroFoto => ({
  id: 'pay-b',
  venueId: 'v1',
  orderId: 'ord-vecina',
  status: 'COMPLETED',
  type: 'REGULAR',
  amount: D('46.75'),
  tipAmount: D('7.01'),
  shiftId: 'shift-1',
  createdAt: new Date('2026-09-02T19:40:19Z'),
  ...over,
})

/** La orden vecina: su propio cobro (pay-a) + el cobro ajeno (pay-b). Base 55 − 8.25 = 46.75. */
const vecina = (over: Partial<OrdenFoto> = {}): OrdenFoto => ({
  id: 'ord-vecina',
  venueId: 'v1',
  orderNumber: 'ORD-VECINA',
  status: 'COMPLETED',
  paymentStatus: 'PAID',
  shiftId: 'shift-1',
  completedAt: new Date('2026-09-02T19:41:00Z'),
  subtotal: D('55.00'),
  discountAmount: D('8.25'),
  serviceChargeAmount: D(0),
  cobros: [
    { id: 'pay-a', status: 'COMPLETED', type: 'REGULAR', amount: D('46.75'), tipAmount: D('7.01') },
    { id: 'pay-b', status: 'COMPLETED', type: 'REGULAR', amount: D('46.75'), tipAmount: D('7.01') },
  ],
  ...over,
})

/** La orden cancelada del cliente real: misma cuenta, cero cobros. */
const cancelada = (over: Partial<OrdenFoto> = {}): OrdenFoto => ({
  id: 'ord-cancelada',
  venueId: 'v1',
  orderNumber: 'ORD-CANCELADA',
  status: 'CANCELLED',
  paymentStatus: 'PENDING',
  shiftId: null,
  completedAt: null,
  subtotal: D('55.00'),
  discountAmount: D('8.25'),
  serviceChargeAmount: D(0),
  cobros: [],
  ...over,
})

const motivosDe = (v: ReturnType<typeof validarReasignacion>) => (v.ok ? [] : v.motivos)

describe('validarReasignacion — cuándo un cobro puede moverse', () => {
  it('acepta el caso semilla: cobro completado, destino cancelado sin cobros, cuentas iguales, origen sigue cubierto', () => {
    const v = validarReasignacion(caso, cobro(), vecina(), cancelada())
    expect(v.ok).toBe(true)
    if (v.ok) {
      expect(v.resumen.baseDestino).toBe('46.75')
      expect(v.resumen.destinoCambiaEstado).toBe(true)
      expect(v.resumen.saldoOrigenDespues).toBe('0.00')
    }
  })

  it('🔴 rechaza un cobro que no esté COMPLETED, y uno que sea reembolso', () => {
    expect(motivosDe(validarReasignacion(caso, cobro({ status: 'PENDING' }), vecina(), cancelada()))).toEqual(
      expect.arrayContaining([expect.stringContaining('COMPLETED')]),
    )
    expect(motivosDe(validarReasignacion(caso, cobro({ type: 'REFUND' }), vecina(), cancelada()))).toEqual(
      expect.arrayContaining([expect.stringContaining('reembolso')]),
    )
  })

  it('🔴 rechaza si el cobro no está hoy en la orden de origen declarada (carrera o plan viejo)', () => {
    const v = validarReasignacion(caso, cobro({ orderId: 'otra' }), vecina(), cancelada())
    expect(motivosDe(v)).toEqual(expect.arrayContaining([expect.stringContaining('origen')]))
  })

  it('🔴 rechaza cruzar negocios: cobro, origen y destino deben compartir venue', () => {
    const v = validarReasignacion(caso, cobro(), vecina(), cancelada({ venueId: 'v2' }))
    expect(motivosDe(v)).toEqual(expect.arrayContaining([expect.stringContaining('negocio')]))
  })

  it('🔴 rechaza un destino ya pagado o con algún cobro completado', () => {
    const conCobro = cancelada({
      cobros: [{ id: 'pay-z', status: 'COMPLETED', type: 'REGULAR', amount: D('46.75'), tipAmount: D(0) }],
    })
    expect(motivosDe(validarReasignacion(caso, cobro(), vecina(), conCobro))).toEqual(
      expect.arrayContaining([expect.stringContaining('ya tiene')]),
    )
    const pagada = cancelada({ status: 'COMPLETED', paymentStatus: 'PAID' })
    expect(motivosDe(validarReasignacion(caso, cobro(), vecina(), pagada))).toEqual(
      expect.arrayContaining([expect.stringContaining('pagada')]),
    )
  })

  it('🔴 rechaza si el cobro no cubre la cuenta del destino, o la sobrepasa más de un centavo', () => {
    const masCara = cancelada({ subtotal: D('80.00'), discountAmount: D(0) })
    expect(motivosDe(validarReasignacion(caso, cobro(), vecina(), masCara))).toEqual(
      expect.arrayContaining([expect.stringContaining('no cubre')]),
    )
    const masBarata = cancelada({ subtotal: D('40.00'), discountAmount: D(0) })
    expect(motivosDe(validarReasignacion(caso, cobro(), vecina(), masBarata))).toEqual(
      expect.arrayContaining([expect.stringContaining('sobra')]),
    )
  })

  it('la propina NO decide: un destino con la misma mercancía se acepta aunque su total guardado traiga otra propina', () => {
    // El total guardado de la cancelada era $53.76 (46.75 + 7.01); el saldo canónico se calcula
    // desde subtotal/descuento y la propina la aporta el cobro. Aquí ni siquiera se lee `total`.
    const v = validarReasignacion(caso, cobro({ tipAmount: D(0) }), vecina(), cancelada())
    expect(v.ok).toBe(true)
  })

  it('🔴 rechaza si al quitar el cobro la orden de origen dejaría de estar cubierta', () => {
    const soloEseCobro = vecina({
      cobros: [{ id: 'pay-b', status: 'COMPLETED', type: 'REGULAR', amount: D('46.75'), tipAmount: D('7.01') }],
    })
    expect(motivosDe(validarReasignacion(caso, cobro(), soloEseCobro, cancelada()))).toEqual(
      expect.arrayContaining([expect.stringContaining('origen quedaría')]),
    )
  })

  it('acumula TODOS los motivos, no sólo el primero', () => {
    const v = validarReasignacion(caso, cobro({ status: 'PENDING', type: 'REFUND' }), vecina(), cancelada({ venueId: 'v2' }))
    expect(v.ok).toBe(false)
    if (!v.ok) expect(v.motivos.length).toBeGreaterThanOrEqual(3)
  })
})

function depsFalsas(over: Partial<DepsAplicar> & { movidos?: number } = {}) {
  const llamadas: string[] = []
  const escritor = {
    moverCobro: jest.fn(async () => {
      llamadas.push('mover')
      return over.movidos ?? 1
    }),
    prepararDestino: jest.fn(async () => {
      llamadas.push('preparar')
    }),
  }
  const deps: DepsAplicar = {
    enTransaccion: jest.fn(async fn => fn(escritor)),
    reconciliar: jest.fn(async (id: string) => {
      llamadas.push(`reconciliar:${id}`)
      return { orderId: id, warning: null }
    }),
    fijarCompletadoEn: jest.fn(async (id: string) => {
      llamadas.push(`completadoEn:${id}`)
    }),
    bitacora: jest.fn(async p => {
      llamadas.push(`bitacora:${p.entityId}`)
    }),
    ...over,
  }
  return { deps, escritor, llamadas }
}

describe('aplicarReasignacion — el orden de las escrituras', () => {
  it('mueve, prepara el destino (CANCELLED → PENDING + turno del cobro), reconcilia ambas, restaura fechas y deja bitácora en las dos', async () => {
    const { deps, escritor, llamadas } = depsFalsas()
    const r = await aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())
    expect(r.ok).toBe(true)
    expect(escritor.moverCobro).toHaveBeenCalledWith('pay-b', 'ord-vecina', 'ord-cancelada')
    expect(escritor.prepararDestino).toHaveBeenCalledWith('ord-cancelada', { status: 'PENDING', shiftId: 'shift-1' })
    expect(llamadas).toEqual([
      'mover',
      'preparar',
      'reconciliar:ord-cancelada',
      'reconciliar:ord-vecina',
      'completadoEn:ord-cancelada',
      'completadoEn:ord-vecina',
      'bitacora:ord-cancelada',
      'bitacora:ord-vecina',
    ])
    // El destino se fecha cuando el cliente pagó, no cuando se corrió el script; el origen
    // conserva la fecha de cierre que ya tenía (reconciliar la habría movido a hoy).
    expect(deps.fijarCompletadoEn).toHaveBeenNthCalledWith(1, 'ord-cancelada', new Date('2026-09-02T19:40:19Z'))
    expect(deps.fijarCompletadoEn).toHaveBeenNthCalledWith(2, 'ord-vecina', new Date('2026-09-02T19:41:00Z'))
  })

  it('no toca el estado del destino si ya está PENDING, y no pisa un turno que el destino ya tenía', async () => {
    const { deps, escritor } = depsFalsas()
    await aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada({ status: 'PENDING', shiftId: 'shift-9' }))
    expect(escritor.prepararDestino).not.toHaveBeenCalled()
  })

  it('🔴 no escribe NADA si la validación falla, y dice por qué', async () => {
    const { deps, escritor } = depsFalsas()
    const r = await aplicarReasignacion(deps, caso, cobro({ status: 'PENDING' }), vecina(), cancelada())
    expect(r.ok).toBe(false)
    expect(deps.enTransaccion).not.toHaveBeenCalled()
    expect(escritor.moverCobro).not.toHaveBeenCalled()
    expect(deps.reconciliar).not.toHaveBeenCalled()
    expect(deps.bitacora).not.toHaveBeenCalled()
  })

  it('🔴 una carrera (el cobro ya no estaba en el origen al escribir) aborta la transacción y NO reconcilia', async () => {
    const { deps, escritor } = depsFalsas({ movidos: 0 })
    await expect(aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())).rejects.toThrow(/carrera/i)
    expect(escritor.moverCobro).toHaveBeenCalledTimes(1)
    expect(escritor.prepararDestino).not.toHaveBeenCalled()
    expect(deps.reconciliar).not.toHaveBeenCalled()
    expect(deps.bitacora).not.toHaveBeenCalled()
  })

  it('el origen sin fecha de cierre previa no recibe una inventada', async () => {
    const { deps } = depsFalsas()
    await aplicarReasignacion(deps, caso, cobro(), vecina({ completedAt: null }), cancelada())
    expect(deps.fijarCompletadoEn).toHaveBeenCalledTimes(1)
    expect(deps.fijarCompletadoEn).toHaveBeenCalledWith('ord-cancelada', new Date('2026-09-02T19:40:19Z'))
  })
})
