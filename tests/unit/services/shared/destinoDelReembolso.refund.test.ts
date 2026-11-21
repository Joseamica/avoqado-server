/**
 * Máquina de efectivo · Codex servidor r2, familia B, y D5 (r3 #12, r6 caso 7): «¿a dónde sale el dinero de un reembolso, qué permiso
 * pide y ESTA entrada lo admite?». UNA decisión (`decidirDestinoDelReembolso`) para la autorización de cada entrada y para su escritor.
 * La matriz (`tests/__helpers__/matrizDelReembolso.ts`) enumera TODAS las combinaciones de origen del dinero × ¿crédito de Cambio? ×
 * entrada × medio declarado en el cuerpo, escritas a mano; las pruebas de los escritores reales leen la misma matriz.
 *
 * La regla: siempre que el escritor vaya a sacar billetes de la gaveta por dinero que nunca entró a ella (una venta de la QuickPay,
 * directa o por la cadena de un Cambio) se pide `payments:refund-to-cash`. El panel y la TPV no escogen medio: lo que diga el cuerpo
 * no cambia el destino (r2 #3). Lo pagado con crédito de Cambio no se devuelve en la TPV, ni con «Efectivo» o transferencia escogidos:
 * eso se contesta `NO_ADMITIDO_EN_ESTA_ENTRADA`, con a dónde ir, antes de pedir permiso (r3 #12).
 */
import {
  decidirDestinoDelReembolso,
  errorDeNoAdmitido,
  medioQueLlegaAlEscritor,
  origenDelDinero,
} from '@/services/shared/destinoDelReembolso'
import { MATRIZ_DEL_REEMBOLSO, MENSAJE_MISMO_MEDIO, medioDelCuerpo } from '../../../__helpers__/matrizDelReembolso'

describe('decidirDestinoDelReembolso · la matriz completa (familia B + D5)', () => {
  it('cubre TODAS las combinaciones, una vez cada una (3 orígenes × 2 × 4 entradas × 5 medios = 120)', () => {
    const llaves = MATRIZ_DEL_REEMBOLSO.map(([o, c, e, m]) => `${o}|${c}|${e}|${m}`)
    expect(new Set(llaves).size).toBe(120)
    expect(llaves).toHaveLength(120)
  })

  it.each(MATRIZ_DEL_REEMBOLSO)('%s · crédito de Cambio %s · %s · medio %s', (origen, esCreditoDeCambio, entrada, declarado, esperado) => {
    expect(
      decidirDestinoDelReembolso({
        entrada,
        origen,
        medio: medioQueLlegaAlEscritor(entrada, medioDelCuerpo(declarado)),
        esCreditoDeCambio,
      }),
    ).toEqual(esperado)
  })

  it('🔴 la regla: TODA salida de la gaveta pide payments:refund-to-cash', () => {
    for (const [, , , , d] of MATRIZ_DEL_REEMBOLSO)
      if (d.admitido && d.destinoEfectivo === 'GAVETA') expect(d.permisoRequerido).toBe('payments:refund-to-cash')
  })

  it('🔴 r3 #12: lo que ninguna entrada admite nunca pide permiso (no hay PIN inútil que pedir)', () => {
    const noAdmitidas = MATRIZ_DEL_REEMBOLSO.filter(([, , , , d]) => !d.admitido)
    expect(noAdmitidas.length).toBeGreaterThan(0)
    for (const [, , , , d] of noAdmitidas) expect(d).not.toHaveProperty('permisoRequerido')
  })

  it('el rechazo es un 400 NO_ADMITIDO_EN_ESTA_ENTRADA con a dónde ir en los detalles', () => {
    const e = errorDeNoAdmitido({
      admitido: false,
      codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
      mensaje: MENSAJE_MISMO_MEDIO,
      dondeIr: ['MISMO_MEDIO', 'SALDO_A_FAVOR'],
    })
    expect(e).toMatchObject({
      statusCode: 400,
      code: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
      message: MENSAJE_MISMO_MEDIO,
      details: { dondeIr: ['MISMO_MEDIO', 'SALDO_A_FAVOR'] },
    })
  })
})

describe('origenDelDinero · de dónde viene el dinero y si lo pagó un crédito de Cambio, leído antes de autorizar', () => {
  const db = (filas: Record<string, { cashMachineRef: string | null; tenderType?: { systemKind: string } | null }>, vinculo?: string) => ({
    payment: { findFirst: jest.fn(async (a: any) => filas[a.where.id] ?? null) },
    exchangeCreditLink: { findFirst: jest.fn(async () => (vinculo ? { originPaymentId: vinculo } : null)) },
  })

  it('la venta directa de la máquina', async () => {
    await expect(origenDelDinero(db({ p: { cashMachineRef: 'AQ0123456789AB' } }) as any, 'v1', 'p')).resolves.toEqual({
      origen: 'MAQUINA',
      esCreditoDeCambio: false,
    })
  })

  it('🔴 r2 #2: lo pagado con el crédito de un Cambio cuya raíz es de la máquina', async () => {
    const d = db(
      { credito: { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } }, raiz: { cashMachineRef: 'AQ0123456789AB' } },
      'raiz',
    )
    await expect(origenDelDinero(d as any, 'v1', 'credito')).resolves.toEqual({ origen: 'CADENA_DE_MAQUINA', esCreditoDeCambio: true })
    expect(d.exchangeCreditLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', creditPaymentId: 'credito' } }),
    )
  })

  it('🔴 r6 caso 7: un crédito de Cambio de una venta ordinaria se distingue de una venta ordinaria', async () => {
    const d = db(
      { credito: { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } }, raiz: { cashMachineRef: null } },
      'raiz',
    )
    await expect(origenDelDinero(d as any, 'v1', 'credito')).resolves.toEqual({ origen: 'ORDINARIO', esCreditoDeCambio: true })
    await expect(origenDelDinero(db({ p: { cashMachineRef: null } }) as any, 'v1', 'p')).resolves.toEqual({
      origen: 'ORDINARIO',
      esCreditoDeCambio: false,
    })
  })

  it('sin cobro (o sin sucursal): ordinario y sin crédito; el servicio contesta 404', async () => {
    await expect(origenDelDinero(db({}) as any, 'v1', 'nadie')).resolves.toEqual({ origen: 'ORDINARIO', esCreditoDeCambio: false })
    await expect(origenDelDinero(db({}) as any, undefined, 'p')).resolves.toEqual({ origen: 'ORDINARIO', esCreditoDeCambio: false })
  })
})
