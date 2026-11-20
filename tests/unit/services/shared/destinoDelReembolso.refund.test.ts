/**
 * Máquina de efectivo · Codex servidor r2, familia B: «¿a dónde sale el dinero de un reembolso y qué permiso pide?». UNA decisión
 * (`decidirDestinoDelReembolso`) para la autorización de cada entrada y para su escritor. La matriz enumera TODAS las combinaciones
 * de origen del dinero × entrada × medio declarado en el cuerpo, con el destino y el permiso escritos a mano, fila por fila.
 *
 * La regla: siempre que el escritor vaya a sacar billetes de la gaveta por dinero que nunca entró a ella (una venta de la QuickPay,
 * directa o por la cadena de un Cambio) se pide `payments:refund-to-cash`. El panel y la TPV no escogen medio: lo que diga el cuerpo
 * no cambia el destino (r2 #3).
 */
import {
  decidirDestinoDelReembolso,
  medioQueLlegaAlEscritor,
  origenDelDinero,
  type DestinoEfectivo,
  type EntradaDelReembolso,
  type OrigenDelDinero,
} from '@/services/shared/destinoDelReembolso'

const A_CAJA = 'payments:refund-to-cash'
const NORMAL = 'payments:refund'
type Fila = [OrigenDelDinero, EntradaDelReembolso, string, DestinoEfectivo, string]

/** [origen, entrada, medio declarado en el cuerpo ('—' = vacío, 'OTRO' = un valor desconocido), destino, permiso]. */
const MATRIZ: Fila[] = [
  // ── Venta de la máquina ───────────────────────────────────────────────────────────────────────────────────────────────────────
  ['MAQUINA', 'POS', '—', 'GAVETA', A_CAJA],
  ['MAQUINA', 'POS', 'CASH', 'GAVETA', A_CAJA],
  ['MAQUINA', 'POS', 'BANK_TRANSFER', 'TRANSFERENCIA', NORMAL],
  ['MAQUINA', 'POS', 'STORE_CREDIT', 'SALDO_A_FAVOR', NORMAL],
  ['MAQUINA', 'POS', 'OTRO', 'GAVETA', A_CAJA],
  // r2 #3: el panel y la TPV no escogen; su escritor devuelve por el mismo medio, que para la máquina es la gaveta.
  ['MAQUINA', 'PANEL', '—', 'GAVETA', A_CAJA],
  ['MAQUINA', 'PANEL', 'CASH', 'GAVETA', A_CAJA],
  ['MAQUINA', 'PANEL', 'BANK_TRANSFER', 'GAVETA', A_CAJA],
  ['MAQUINA', 'PANEL', 'STORE_CREDIT', 'GAVETA', A_CAJA],
  ['MAQUINA', 'PANEL', 'OTRO', 'GAVETA', A_CAJA],
  ['MAQUINA', 'TPV', '—', 'GAVETA', A_CAJA],
  ['MAQUINA', 'TPV', 'CASH', 'GAVETA', A_CAJA],
  ['MAQUINA', 'TPV', 'BANK_TRANSFER', 'GAVETA', A_CAJA],
  ['MAQUINA', 'TPV', 'STORE_CREDIT', 'GAVETA', A_CAJA],
  ['MAQUINA', 'TPV', 'OTRO', 'GAVETA', A_CAJA],
  ['MAQUINA', 'MCP', '—', 'GAVETA', A_CAJA],
  ['MAQUINA', 'MCP', 'CASH', 'GAVETA', A_CAJA],
  ['MAQUINA', 'MCP', 'BANK_TRANSFER', 'TRANSFERENCIA', NORMAL],
  ['MAQUINA', 'MCP', 'STORE_CREDIT', 'SALDO_A_FAVOR', NORMAL],
  ['MAQUINA', 'MCP', 'OTRO', 'GAVETA', A_CAJA],
  // ── Lo pagado con el crédito de un Cambio cuya raíz es de la máquina (r2 #2) ────────────────────────────────────────────────────
  ['CADENA_DE_MAQUINA', 'POS', '—', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'POS', 'CASH', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'POS', 'BANK_TRANSFER', 'TRANSFERENCIA', NORMAL],
  ['CADENA_DE_MAQUINA', 'POS', 'STORE_CREDIT', 'SALDO_A_FAVOR', NORMAL],
  ['CADENA_DE_MAQUINA', 'POS', 'OTRO', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'PANEL', '—', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'PANEL', 'CASH', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'PANEL', 'BANK_TRANSFER', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'PANEL', 'STORE_CREDIT', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'PANEL', 'OTRO', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'TPV', '—', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'TPV', 'CASH', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'TPV', 'BANK_TRANSFER', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'TPV', 'STORE_CREDIT', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'TPV', 'OTRO', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'MCP', '—', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'MCP', 'CASH', 'GAVETA', A_CAJA],
  ['CADENA_DE_MAQUINA', 'MCP', 'BANK_TRANSFER', 'TRANSFERENCIA', NORMAL],
  ['CADENA_DE_MAQUINA', 'MCP', 'STORE_CREDIT', 'SALDO_A_FAVOR', NORMAL],
  ['CADENA_DE_MAQUINA', 'MCP', 'OTRO', 'GAVETA', A_CAJA],
  // ── Cualquier otra venta: como siempre (en las apps, escoger «Efectivo» pide su permiso propio; el panel y la TPV, no) ──────────
  ['ORDINARIO', 'POS', '—', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'POS', 'CASH', 'EFECTIVO_ESCOGIDO', A_CAJA],
  ['ORDINARIO', 'POS', 'BANK_TRANSFER', 'TRANSFERENCIA', NORMAL],
  ['ORDINARIO', 'POS', 'STORE_CREDIT', 'SALDO_A_FAVOR', NORMAL],
  ['ORDINARIO', 'POS', 'OTRO', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'PANEL', '—', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'PANEL', 'CASH', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'PANEL', 'BANK_TRANSFER', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'PANEL', 'STORE_CREDIT', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'PANEL', 'OTRO', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'TPV', '—', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'TPV', 'CASH', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'TPV', 'BANK_TRANSFER', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'TPV', 'STORE_CREDIT', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'TPV', 'OTRO', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'MCP', '—', 'MISMO_MEDIO', NORMAL],
  ['ORDINARIO', 'MCP', 'CASH', 'EFECTIVO_ESCOGIDO', A_CAJA],
  ['ORDINARIO', 'MCP', 'BANK_TRANSFER', 'TRANSFERENCIA', NORMAL],
  ['ORDINARIO', 'MCP', 'STORE_CREDIT', 'SALDO_A_FAVOR', NORMAL],
  ['ORDINARIO', 'MCP', 'OTRO', 'MISMO_MEDIO', NORMAL],
]

describe('decidirDestinoDelReembolso · la matriz completa (familia B)', () => {
  it('cubre TODAS las combinaciones, una vez cada una (3 orígenes × 4 entradas × 5 medios = 60)', () => {
    const llaves = MATRIZ.map(([o, e, m]) => `${o}|${e}|${m}`)
    expect(new Set(llaves).size).toBe(60)
    expect(llaves).toHaveLength(60)
  })

  it.each(MATRIZ)('%s · %s · medio %s → %s con %s', (origen, entrada, declarado, destinoEfectivo, permisoRequerido) => {
    const medio = declarado === '—' ? undefined : declarado
    expect(decidirDestinoDelReembolso({ origen, medio: medioQueLlegaAlEscritor(entrada, medio) })).toEqual({
      destinoEfectivo,
      permisoRequerido,
    })
  })

  it('🔴 la regla: TODA salida de la gaveta pide payments:refund-to-cash', () => {
    for (const [, , , destino, permiso] of MATRIZ) if (destino === 'GAVETA') expect(permiso).toBe(A_CAJA)
  })
})

describe('origenDelDinero · de dónde viene el dinero, leído antes de autorizar', () => {
  const db = (filas: Record<string, { cashMachineRef: string | null; tenderType?: { systemKind: string } | null }>, vinculo?: string) => ({
    payment: { findFirst: jest.fn(async (a: any) => filas[a.where.id] ?? null) },
    exchangeCreditLink: { findFirst: jest.fn(async () => (vinculo ? { originPaymentId: vinculo } : null)) },
  })

  it('la venta directa de la máquina', async () => {
    await expect(origenDelDinero(db({ p: { cashMachineRef: 'AQ0123456789AB' } }) as any, 'v1', 'p')).resolves.toBe('MAQUINA')
  })

  it('🔴 r2 #2: lo pagado con el crédito de un Cambio cuya raíz es de la máquina', async () => {
    const d = db(
      { credito: { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } }, raiz: { cashMachineRef: 'AQ0123456789AB' } },
      'raiz',
    )
    await expect(origenDelDinero(d as any, 'v1', 'credito')).resolves.toBe('CADENA_DE_MAQUINA')
    expect(d.exchangeCreditLink.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { venueId: 'v1', creditPaymentId: 'credito' } }),
    )
  })

  it('un crédito de Cambio de una venta ordinaria, una venta ordinaria, o sin cobro', async () => {
    const d = db(
      { credito: { cashMachineRef: null, tenderType: { systemKind: 'EXCHANGE_CREDIT' } }, raiz: { cashMachineRef: null } },
      'raiz',
    )
    await expect(origenDelDinero(d as any, 'v1', 'credito')).resolves.toBe('ORDINARIO')
    await expect(origenDelDinero(db({ p: { cashMachineRef: null } }) as any, 'v1', 'p')).resolves.toBe('ORDINARIO')
    await expect(origenDelDinero(db({}) as any, 'v1', 'nadie')).resolves.toBe('ORDINARIO')
    await expect(origenDelDinero(db({}) as any, undefined, 'p')).resolves.toBe('ORDINARIO')
  })
})
