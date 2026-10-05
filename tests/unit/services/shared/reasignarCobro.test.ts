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
 *   4. aplicar sigue un orden fijo, TODO en una transacción (Codex r10 #6): candado de las dos
 *      órdenes → releer y revalidar (Codex r11 #7) → mover → preparar destino → totales de las dos
 *      → devolver la fecha de cierre real → bitácora en las dos órdenes. Nada se escribe si la
 *      validación falla, y una carrera (el cobro ya no estaba donde se dijo) aborta ANTES de los totales.
 */
import { Prisma } from '@prisma/client'
import {
  aplicarReasignacion,
  validarReasignacion,
  type BitacoraReasignacion,
  type CasoReasignacion,
  type CobroFoto,
  type DepsAplicar,
  type EscritorReasignacion,
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
  contratoDePrecio: 'IVA_INCLUIDO',
  taxAmount: D(0),
  source: 'TPV',
  externalId: null,
  items: [],
  tableId: null,
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
  contratoDePrecio: 'IVA_INCLUIDO',
  taxAmount: D(0),
  source: 'TPV',
  externalId: null,
  items: [],
  tableId: null,
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

function depsFalsas(
  over: {
    movidos?: number
    fallaEn?: keyof EscritorReasignacion
    fallaMesa?: boolean
    releido?: (antes: { cobro: CobroFoto; origen: OrdenFoto; destino: OrdenFoto }) => {
      cobro: CobroFoto
      origen: OrdenFoto
      destino: OrdenFoto
    }
  } = {},
) {
  const llamadas: string[] = []
  const paso = <A extends any[]>(nombre: keyof EscritorReasignacion, etiqueta: (...a: A) => string, valor?: unknown) =>
    jest.fn(async (...a: A) => {
      llamadas.push(etiqueta(...a))
      if (over.fallaEn === nombre) throw new Error(`falla inyectada en ${nombre}`)
      return valor
    })
  const escritor = {
    bloquear: paso('bloquear', (ids: string[]) => `bloquear:${ids.join(',')}`),
    // Sin `releido`, lo releído es lo mismo que la foto de afuera (nadie cambió nada).
    releer: jest.fn(async (antes: { cobro: CobroFoto; origen: OrdenFoto; destino: OrdenFoto }) => {
      llamadas.push('releer')
      return over.releido ? over.releido(antes) : antes
    }),
    moverCobro: paso('moverCobro', () => 'mover', over.movidos ?? 1),
    prepararDestino: paso('prepararDestino', () => 'preparar'),
    guardarTotales: paso('guardarTotales', (id: string, c: { id: string } | null) => `totales:${id}:${c?.id ?? '-'}`),
    fijarCompletadoEn: paso('fijarCompletadoEn', (id: string) => `completadoEn:${id}`),
    bitacora: paso('bitacora', (p: BitacoraReasignacion) => `bitacora:${p.entityId}`),
  }
  const deps: DepsAplicar = {
    enTransaccion: jest.fn(async fn => fn(escritor as unknown as EscritorReasignacion)),
    liberarMesa: jest.fn(async (_venueId: string, tableId: string) => {
      llamadas.push(`mesa:${tableId}`)
      if (over.fallaMesa) throw new Error('falla inyectada al liberar la mesa')
    }),
  }
  return { deps, escritor, llamadas }
}

describe('aplicarReasignacion — el orden de las escrituras', () => {
  it('bloquea las dos, relee, mueve, prepara el destino (CANCELLED → PENDING + turno del cobro), guarda los totales de ambas, restaura fechas y deja bitácora en las dos', async () => {
    const { deps, escritor, llamadas } = depsFalsas()
    const r = await aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())
    expect(r.ok).toBe(true)
    expect(escritor.moverCobro).toHaveBeenCalledWith('pay-b', 'ord-vecina', 'ord-cancelada')
    expect(escritor.prepararDestino).toHaveBeenCalledWith('ord-cancelada', { status: 'PENDING', shiftId: 'shift-1' })
    expect(llamadas).toEqual([
      'bloquear:ord-cancelada,ord-vecina',
      'releer',
      'mover',
      'preparar',
      'totales:ord-cancelada:pay-b',
      'totales:ord-vecina:-',
      'completadoEn:ord-cancelada',
      'completadoEn:ord-vecina',
      'bitacora:ord-cancelada',
      'bitacora:ord-vecina',
    ])
    // El destino se fecha cuando el cliente pagó, no cuando se corrió el script; el origen
    // conserva la fecha de cierre que ya tenía (el cierre la habría movido a hoy).
    expect(escritor.fijarCompletadoEn).toHaveBeenNthCalledWith(1, 'ord-cancelada', new Date('2026-09-02T19:40:19Z'))
    expect(escritor.fijarCompletadoEn).toHaveBeenNthCalledWith(2, 'ord-vecina', new Date('2026-09-02T19:41:00Z'))
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
    expect(escritor.guardarTotales).not.toHaveBeenCalled()
    expect(escritor.bitacora).not.toHaveBeenCalled()
  })

  it('🔴 una carrera (el cobro ya no estaba en el origen al escribir) aborta la transacción y NO guarda totales', async () => {
    const { deps, escritor } = depsFalsas({ movidos: 0 })
    await expect(aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())).rejects.toThrow(/carrera/i)
    expect(escritor.moverCobro).toHaveBeenCalledTimes(1)
    expect(escritor.prepararDestino).not.toHaveBeenCalled()
    expect(escritor.guardarTotales).not.toHaveBeenCalled()
    expect(escritor.bitacora).not.toHaveBeenCalled()
  })

  it('el origen sin fecha de cierre previa no recibe una inventada', async () => {
    const { deps, escritor } = depsFalsas()
    await aplicarReasignacion(deps, caso, cobro(), vecina({ completedAt: null }), cancelada())
    expect(escritor.fijarCompletadoEn).toHaveBeenCalledTimes(1)
    expect(escritor.fijarCompletadoEn).toHaveBeenCalledWith('ord-cancelada', new Date('2026-09-02T19:40:19Z'))
  })
})

describe('Codex r6 #1: el destino se valida con el estado que TENDRÁ (una cancelada se reabre a PENDING)', () => {
  /** La cancelada del cliente con IVA aparte: subtotal $100 + IVA $16 ⇒ reabierta debe $116 (P12). */
  const conIva = (over: Partial<OrdenFoto> = {}) =>
    cancelada({ subtotal: D(100), discountAmount: D(0), contratoDePrecio: 'IVA_APARTE', taxAmount: D(16), ...over })
  const pago = (importe: string) => cobro({ amount: D(importe), tipAmount: D(0) })
  /** La vecina: su cuenta de `importe` cubierta por su propio cobro aunque se le quite el ajeno. */
  const vecinaDe = (importe: string) =>
    vecina({
      subtotal: D(importe),
      discountAmount: D(0),
      cobros: [
        { id: 'pay-a', status: 'COMPLETED', type: 'REGULAR', amount: D(importe), tipAmount: D(0) },
        { id: 'pay-b', status: 'COMPLETED', type: 'REGULAR', amount: D(importe), tipAmount: D(0) },
      ],
    })

  it('🔴 acepta el cobro correcto de $116 (la v6 lo rechazaba: «sobra $16.00»)', () => {
    const v = validarReasignacion(caso, pago('116'), vecinaDe('116'), conIva())
    expect(motivosDe(v)).toEqual([])
    if (v.ok) expect(v.resumen).toMatchObject({ baseDestino: '116.00', destinoCambiaEstado: true })
  })
  it('🔴 rechaza un cobro de $100: reabierta faltarían $16 (la v6 lo aceptaba)', () => {
    expect(motivosDe(validarReasignacion(caso, pago('100'), vecinaDe('100'), conIva()))).toEqual([
      'el cobro no cubre la cuenta del destino: faltan $16.00',
    ])
  })
  it('control — un destino PENDING se mide con su propio estado (mismo resultado)', () => {
    expect(motivosDe(validarReasignacion(caso, pago('116'), vecinaDe('116'), conIva({ status: 'PENDING' })))).toEqual([])
  })
  it('🔴 recorrido completo con dobles: con $116 mueve, reabre a PENDING y reconcilia; con $100 no escribe nada', async () => {
    const bien = depsFalsas()
    expect((await aplicarReasignacion(bien.deps, caso, pago('116'), vecinaDe('116'), conIva())).ok).toBe(true)
    expect(bien.escritor.prepararDestino).toHaveBeenCalledWith('ord-cancelada', expect.objectContaining({ status: 'PENDING' }))
    expect(bien.escritor.guardarTotales).toHaveBeenCalledWith('ord-cancelada', expect.objectContaining({ id: 'pay-b' }), true)
    const mal = depsFalsas()
    expect(await aplicarReasignacion(mal.deps, caso, pago('100'), vecinaDe('100'), conIva())).toEqual({
      ok: false,
      motivos: ['el cobro no cubre la cuenta del destino: faltan $16.00'],
    })
    expect(mal.deps.enTransaccion).not.toHaveBeenCalled()
  })
})

describe('Codex r10 #6: la reasignación escribe TODO en una transacción, bajo el candado de las dos órdenes', () => {
  it('🔴 candado de las dos → mover → reabrir → totales del destino (con el cobro) y del origen (sin él) → fechas → bitácoras, en UNA llamada a `enTransaccion` (la v10: dos transacciones y cuatro escrituras sueltas después)', async () => {
    const { deps, llamadas } = depsFalsas()
    expect((await aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())).ok).toBe(true)
    expect(deps.enTransaccion).toHaveBeenCalledTimes(1)
    expect(llamadas.slice(0, 6)).toEqual([
      'bloquear:ord-cancelada,ord-vecina',
      'releer',
      'mover',
      'preparar',
      'totales:ord-cancelada:pay-b',
      'totales:ord-vecina:-',
    ])
    expect(llamadas.slice(-2)).toEqual(['bitacora:ord-cancelada', 'bitacora:ord-vecina'])
  })
  it.each(['guardarTotales', 'bitacora'] as const)(
    '🔴 si falla «%s», la reasignación lanza y no corre ningún paso posterior (la base revierte la transacción: lo comprueba la integración)',
    async paso => {
      const { deps, llamadas } = depsFalsas({ fallaEn: paso })
      await expect(aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())).rejects.toThrow(`falla inyectada en ${paso}`)
      expect(llamadas).not.toContain('bitacora:ord-vecina')
      expect(deps.enTransaccion).toHaveBeenCalledTimes(1)
    },
  )
  it.each(['moverCobro', 'prepararDestino'] as const)(
    'control — (verde en la v10: su primera transacción ya revierte, `reasignarCobro.ts:193`): si falla «%s», la reasignación lanza y no corre ningún paso posterior',
    async paso => {
      const { deps, llamadas } = depsFalsas({ fallaEn: paso })
      await expect(aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())).rejects.toThrow(`falla inyectada en ${paso}`)
      expect(llamadas).not.toContain('bitacora:ord-vecina')
      expect(deps.enTransaccion).toHaveBeenCalledTimes(1)
    },
  )
  it('🔴 Codex r11 #7: la validación que MANDA es la de dentro: si al releer bajo el candado el origen ya no queda cubierto (otro caso movió su otro cobro), no se escribe nada (la v11 validaba la foto de afuera)', async () => {
    const { deps, llamadas } = depsFalsas({
      releido: antes => ({ ...antes, origen: { ...antes.origen, cobros: antes.origen.cobros.filter(c => c.id === antes.cobro.id) } }),
    })
    const r = await aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.motivos.join(' ')).toContain('el origen quedaría con saldo')
    expect(llamadas).toEqual(['bloquear:ord-cancelada,ord-vecina', 'releer'])
  })
})

describe('Tarea 6d, fix 1 (revisión): quién salda el destino, la mesa, y el estado efectivo con importe + propina', () => {
  const conVales = () => cancelada({ items: [{ areaTicketLineId: 'atl-1' }] })
  const integrada = () => cancelada({ source: 'POS', externalId: 'SR-123' })

  it.each([
    ['con vales por área', conVales],
    ['integrada (SoftRestaurant)', integrada],
  ] as const)(
    '🔴 I-1: un destino %s se cierra SIN efectos de saldar (ni vale de inventario ni lealtad): el mismo criterio que `recordOrderPayment`, y el resumen lo avisa',
    async (_nombre, destino) => {
      const v = validarReasignacion(caso, cobro(), vecina(), destino())
      expect(v.ok && v.resumen.destinoConEfectosDeCierre).toBe(false)
      const { deps, escritor } = depsFalsas()
      expect((await aplicarReasignacion(deps, caso, cobro(), vecina(), destino())).ok).toBe(true)
      expect(escritor.guardarTotales).toHaveBeenCalledWith('ord-cancelada', expect.objectContaining({ id: 'pay-b' }), false)
      expect(escritor.guardarTotales).toHaveBeenCalledWith('ord-vecina', null, false)
    },
  )
  it('control — I-1: un destino normal se cierra con sus efectos; el origen, nunca', async () => {
    const v = validarReasignacion(caso, cobro(), vecina(), cancelada())
    expect(v.ok && v.resumen.destinoConEfectosDeCierre).toBe(true)
    const { deps, escritor } = depsFalsas()
    await aplicarReasignacion(deps, caso, cobro(), vecina(), cancelada())
    expect(escritor.guardarTotales).toHaveBeenCalledWith('ord-cancelada', expect.objectContaining({ id: 'pay-b' }), true)
    expect(escritor.guardarTotales).toHaveBeenCalledWith('ord-vecina', null, false)
  })

  it('🔴 M-1: tras el commit libera la mesa del destino (la reconciliación de antes lo hacía); si liberarla falla, la reasignación sigue ok', async () => {
    const bien = depsFalsas()
    expect((await aplicarReasignacion(bien.deps, caso, cobro(), vecina(), cancelada({ tableId: 'mesa-7' }))).ok).toBe(true)
    expect(bien.deps.liberarMesa).toHaveBeenCalledWith('v1', 'mesa-7')
    expect(bien.llamadas.slice(-2)).toEqual(['bitacora:ord-vecina', 'mesa:mesa-7'])
    const mal = depsFalsas({ fallaMesa: true })
    expect((await aplicarReasignacion(mal.deps, caso, cobro(), vecina(), cancelada({ tableId: 'mesa-7' }))).ok).toBe(true)
    expect(mal.deps.liberarMesa).toHaveBeenCalledTimes(1)
  })
  it('control — M-1: sin mesa, o si la revalidación rechaza, el plano no se toca', async () => {
    const sinMesa = depsFalsas()
    await aplicarReasignacion(sinMesa.deps, caso, cobro(), vecina(), cancelada())
    expect(sinMesa.deps.liberarMesa).not.toHaveBeenCalled()
    const rechazada = depsFalsas({
      releido: antes => ({ ...antes, origen: { ...antes.origen, cobros: antes.origen.cobros.filter(c => c.id === antes.cobro.id) } }),
    })
    expect((await aplicarReasignacion(rechazada.deps, caso, cobro(), vecina(), cancelada({ tableId: 'mesa-7' }))).ok).toBe(false)
    expect(rechazada.deps.liberarMesa).not.toHaveBeenCalled()
  })

  it('🔴 M-2/M-5: lo que reabre una cancelada es importe + propina (la regla del cierre): $0 + $10 de propina la reabre, y `destinoCambiaEstado` lo dice', async () => {
    const gratis = cancelada({ subtotal: D(0), discountAmount: D(0) })
    const soloPropina = cobro({ amount: D(0), tipAmount: D(10) })
    const v = validarReasignacion(caso, soloPropina, vecina(), gratis)
    expect(v.ok && v.resumen.destinoCambiaEstado).toBe(true)
    const { deps, escritor } = depsFalsas()
    expect((await aplicarReasignacion(deps, caso, soloPropina, vecina(), gratis)).ok).toBe(true)
    expect(escritor.prepararDestino).toHaveBeenCalledWith('ord-cancelada', { status: 'PENDING', shiftId: 'shift-1' })
  })
  it('🔴 M-5: sin dinero que la reabra, `destinoCambiaEstado` es false (la v6d decía true aunque no la reabría)', async () => {
    const gratis = cancelada({ subtotal: D(0), discountAmount: D(0) })
    const enCeros = cobro({ amount: D(0), tipAmount: D(0) })
    const v = validarReasignacion(caso, enCeros, vecina(), gratis)
    expect(v.ok && v.resumen.destinoCambiaEstado).toBe(false)
    const { deps, escritor } = depsFalsas()
    await aplicarReasignacion(deps, caso, enCeros, vecina(), gratis)
    expect(escritor.prepararDestino).toHaveBeenCalledWith('ord-cancelada', { shiftId: 'shift-1' })
  })

  it('🔴 M-4: un origen CANCELADO que conserva otros cobros se mide como el cierre lo guardará (reabierto, con su IVA aparte): faltarían $16', () => {
    const origenCancelado = vecina({
      status: 'CANCELLED',
      subtotal: D(100),
      discountAmount: D(0),
      contratoDePrecio: 'IVA_APARTE',
      taxAmount: D(16),
      cobros: [
        { id: 'pay-a', status: 'COMPLETED', type: 'REGULAR', amount: D(100), tipAmount: D(0) },
        { id: 'pay-b', status: 'COMPLETED', type: 'REGULAR', amount: D('46.75'), tipAmount: D('7.01') },
      ],
    })
    expect(motivosDe(validarReasignacion(caso, cobro(), origenCancelado, cancelada()))).toEqual([
      'el origen quedaría con saldo de $16.00 sin este cobro',
    ])
  })
})
