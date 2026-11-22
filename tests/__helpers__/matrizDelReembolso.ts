/**
 * Máquina de efectivo · D5 (Codex servidor r3 #12, r6 caso 7): LA matriz de los reembolsos, escrita a mano celda por celda. La leen
 * la prueba de la decisión (`destinoDelReembolso.refund.test.ts`) y las pruebas que pasan por los escritores reales
 * (`devolucionDeLaMaquina*.test.ts`): si una celda cambia aquí, el escritor tiene que cambiar con ella, o su prueba se cae.
 *
 * Una celda = origen del dinero × ¿lo pagó un crédito de Cambio? × entrada × medio declarado en el cuerpo. El medio declarado es el
 * del cuerpo; la decisión recibe lo que de verdad llega al escritor (`medioQueLlegaAlEscritor`: el panel y la TPV no escogen).
 */
import type { DecisionDelReembolso, EntradaDelReembolso, OrigenDelDinero } from '@/services/shared/destinoDelReembolso'

const CAJA = 'payments:refund-to-cash'
const NORMAL = 'payments:refund'

export const MENSAJE_TPV_CREDITO = 'Lo pagado con crédito de cambio se devuelve desde el POS o el panel, por el medio de su origen.'
export const MENSAJE_MISMO_MEDIO = 'Este cobro sólo se devuelve por el mismo medio con que se pagó.'
export const MENSAJE_MCP =
  'Por el MCP sólo se devuelve por el mismo medio, en efectivo o por transferencia; el saldo a favor se da desde el POS.'
export const MENSAJE_SALDO = 'Lo pagado con saldo (tarjeta de regalo o saldo a favor) sólo regresa a ese mismo saldo.'
export const MENSAJE_SALDO_EN_TPV =
  'Lo pagado con saldo (tarjeta de regalo o saldo a favor) no se devuelve en la terminal: devuélvelo desde el POS o el panel y regresa a ese mismo saldo.'

const GAVETA: DecisionDelReembolso = { admitido: true, destinoEfectivo: 'GAVETA', permisoRequerido: CAJA }
const ESCOGIDO: DecisionDelReembolso = { admitido: true, destinoEfectivo: 'EFECTIVO_ESCOGIDO', permisoRequerido: CAJA }
const TRANSF: DecisionDelReembolso = { admitido: true, destinoEfectivo: 'TRANSFERENCIA', permisoRequerido: NORMAL }
const SALDO: DecisionDelReembolso = { admitido: true, destinoEfectivo: 'SALDO_A_FAVOR', permisoRequerido: NORMAL }
const MISMO: DecisionDelReembolso = { admitido: true, destinoEfectivo: 'MISMO_MEDIO', permisoRequerido: NORMAL }
/** r3 #12: la TPV no devuelve lo pagado con crédito de Cambio; se contesta ANTES de pedir permiso. */
const A_POS_O_PANEL: DecisionDelReembolso = {
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje: MENSAJE_TPV_CREDITO,
  dondeIr: ['POS', 'PANEL'],
}
/** r3 #12: lo pagado con crédito de Cambio no admite «Efectivo» ni transferencia escogidos (sí el mismo medio y el saldo a favor). */
const MISMO_O_SALDO: DecisionDelReembolso = {
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje: MENSAJE_MISMO_MEDIO,
  dondeIr: ['MISMO_MEDIO', 'SALDO_A_FAVOR'],
}

/** F10 (Codex servidor r4): la entrada pública del MCP sólo acepta efectivo o transferencia; otro medio no se admite ahí. */
const MCP_NO: DecisionDelReembolso = { admitido: false, codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA', mensaje: MENSAJE_MCP, dondeIr: ['POS'] }
/** F10: lo pagado con saldo (tarjeta de regalo o saldo a favor) sólo regresa a ese saldo: escoger un medio no se admite. */
const SOLO_AL_SALDO: DecisionDelReembolso = {
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje: MENSAJE_SALDO,
  dondeIr: ['MISMO_MEDIO'],
}

/** Los medios declarados en el cuerpo, en el orden de las columnas: '—' = vacío, 'OTRO' = un valor desconocido. */
export const MEDIOS = ['—', 'CASH', 'BANK_TRANSFER', 'STORE_CREDIT', 'OTRO'] as const
export type MedioDeclarado = (typeof MEDIOS)[number]
type Cinco = [DecisionDelReembolso, DecisionDelReembolso, DecisionDelReembolso, DecisionDelReembolso, DecisionDelReembolso]

/** [origen, ¿crédito de Cambio?, entrada, [—, CASH, BANK_TRANSFER, STORE_CREDIT, OTRO]]. */
const RENGLONES: Array<[OrigenDelDinero, boolean, EntradaDelReembolso, Cinco]> = [
  // ── Venta de la máquina (como antes de D5) ──────────────────────────────────────────────────────────────────────────────────
  ['MAQUINA', false, 'POS', [GAVETA, GAVETA, TRANSF, SALDO, GAVETA]],
  ['MAQUINA', false, 'PANEL', [GAVETA, GAVETA, GAVETA, GAVETA, GAVETA]],
  ['MAQUINA', false, 'TPV', [GAVETA, GAVETA, GAVETA, GAVETA, GAVETA]],
  ['MAQUINA', false, 'MCP', [GAVETA, GAVETA, TRANSF, MCP_NO, MCP_NO]],
  // ── Lo pagado con el crédito de un Cambio cuya raíz es de la máquina ─────────────────────────────────────────────────────────
  ['CADENA_DE_MAQUINA', true, 'POS', [GAVETA, MISMO_O_SALDO, MISMO_O_SALDO, SALDO, GAVETA]],
  ['CADENA_DE_MAQUINA', true, 'PANEL', [GAVETA, GAVETA, GAVETA, GAVETA, GAVETA]],
  ['CADENA_DE_MAQUINA', true, 'TPV', [A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL]],
  ['CADENA_DE_MAQUINA', true, 'MCP', [GAVETA, MISMO_O_SALDO, MISMO_O_SALDO, MCP_NO, MCP_NO]],
  // ── Cualquier otra venta (como antes de D5: en las apps, escoger «Efectivo» pide su permiso propio) ────────────────────────────
  ['ORDINARIO', false, 'POS', [MISMO, ESCOGIDO, TRANSF, SALDO, MISMO]],
  ['ORDINARIO', false, 'PANEL', [MISMO, MISMO, MISMO, MISMO, MISMO]],
  ['ORDINARIO', false, 'TPV', [MISMO, MISMO, MISMO, MISMO, MISMO]],
  ['ORDINARIO', false, 'MCP', [MISMO, ESCOGIDO, TRANSF, MCP_NO, MCP_NO]],
  // ── Lo pagado con el crédito de un Cambio de una venta ordinaria ─────────────────────────────────────────────────────────────
  ['ORDINARIO', true, 'POS', [MISMO, MISMO_O_SALDO, MISMO_O_SALDO, SALDO, MISMO]],
  ['ORDINARIO', true, 'PANEL', [MISMO, MISMO, MISMO, MISMO, MISMO]],
  ['ORDINARIO', true, 'TPV', [A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL]],
  ['ORDINARIO', true, 'MCP', [MISMO, MISMO_O_SALDO, MISMO_O_SALDO, MCP_NO, MCP_NO]],
  // ── Combinaciones que la lectura no produce (un cobro de la QuickPay nunca es crédito de Cambio y la cadena siempre lo es) ─────
  ['MAQUINA', true, 'POS', [GAVETA, MISMO_O_SALDO, MISMO_O_SALDO, SALDO, GAVETA]],
  ['MAQUINA', true, 'PANEL', [GAVETA, GAVETA, GAVETA, GAVETA, GAVETA]],
  ['MAQUINA', true, 'TPV', [A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL, A_POS_O_PANEL]],
  ['MAQUINA', true, 'MCP', [GAVETA, MISMO_O_SALDO, MISMO_O_SALDO, MCP_NO, MCP_NO]],
  ['CADENA_DE_MAQUINA', false, 'POS', [GAVETA, GAVETA, TRANSF, SALDO, GAVETA]],
  ['CADENA_DE_MAQUINA', false, 'PANEL', [GAVETA, GAVETA, GAVETA, GAVETA, GAVETA]],
  ['CADENA_DE_MAQUINA', false, 'TPV', [GAVETA, GAVETA, GAVETA, GAVETA, GAVETA]],
  ['CADENA_DE_MAQUINA', false, 'MCP', [GAVETA, GAVETA, TRANSF, MCP_NO, MCP_NO]],
]

export type Celda = [OrigenDelDinero, boolean, EntradaDelReembolso, MedioDeclarado, DecisionDelReembolso]

/** Las 120 celdas (3 orígenes × 2 × 4 entradas × 5 medios). */
export const MATRIZ_DEL_REEMBOLSO: Celda[] = RENGLONES.flatMap(([origen, credito, entrada, cinco]) =>
  MEDIOS.map((medio, i): Celda => [origen, credito, entrada, medio, cinco[i]]),
)

/**
 * H7 (Codex servidor r5): la terminal NO devuelve a un saldo —su escritor lo rechaza (la tarjeta de regalo con su código propio)—, así
 * que su fila dice «desde el POS o el panel». Se corrigió la matriz, no el escritor: que la terminal regresara dinero a un saldo sería un
 * flujo nuevo, y el rechazo ya existía.
 */
const SALDO_NO_EN_TPV: DecisionDelReembolso = {
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje: MENSAJE_SALDO_EN_TPV,
  dondeIr: ['POS', 'PANEL'],
}

/**
 * F10: lo pagado con SALDO (tarjeta de regalo o saldo a favor: nunca es de la máquina ni crédito de Cambio), entrada × medio. Sólo el
 * mismo medio se admite; el panel no escoge, así que siempre lo es. H7: la TPV, nunca.
 */
export const MATRIZ_DEL_SALDO: Array<[EntradaDelReembolso, MedioDeclarado, DecisionDelReembolso]> = (
  [
    ['POS', [MISMO, SOLO_AL_SALDO, SOLO_AL_SALDO, SOLO_AL_SALDO, SOLO_AL_SALDO]],
    ['PANEL', [MISMO, MISMO, MISMO, MISMO, MISMO]],
    ['TPV', [SALDO_NO_EN_TPV, SALDO_NO_EN_TPV, SALDO_NO_EN_TPV, SALDO_NO_EN_TPV, SALDO_NO_EN_TPV]],
    ['MCP', [MISMO, SOLO_AL_SALDO, SOLO_AL_SALDO, SOLO_AL_SALDO, SOLO_AL_SALDO]],
  ] as Array<[EntradaDelReembolso, Cinco]>
).flatMap(([entrada, cinco]) =>
  MEDIOS.map((medio, i): [EntradaDelReembolso, MedioDeclarado, DecisionDelReembolso] => [entrada, medio, cinco[i]]),
)

/** El valor del cuerpo que corresponde a un medio declarado de la matriz. */
export const medioDelCuerpo = (medio: MedioDeclarado): string | undefined => (medio === '—' ? undefined : medio)

/** Lo que dice la matriz para una celda (las pruebas de los escritores la leen de aquí, nunca la reescriben). */
export function celda(
  origen: OrigenDelDinero,
  credito: boolean,
  entrada: EntradaDelReembolso,
  medio: MedioDeclarado,
): DecisionDelReembolso {
  const fila = MATRIZ_DEL_REEMBOLSO.find(([o, c, e, m]) => o === origen && c === credito && e === entrada && m === medio)
  if (!fila) throw new Error(`la matriz no tiene la celda ${origen}|${credito}|${entrada}|${medio}`)
  return fila[4]
}

/**
 * H7 (Codex servidor r5): matriz B con el COBRO tal cual (lo que leen los escritores), para las entradas que escogen medio (POS y MCP)
 * y la terminal. Una celda = cobro × entrada × medio declarado. Lo admitido sale de las funciones de ruteo de los escritores
 * (`seDevuelveEnTerminal`, `devolverConEfectivo`, `sePuedeEscogerComoDevolver`); el MCP pide el permiso especial sólo cuando sale de la
 * gaveta dinero que nunca entró a ella.
 */
export const COBROS_DE_RUTEO = {
  EFECTIVO_DE_GAVETA: {
    method: 'CASH',
    source: 'POS',
    externalSource: null,
    tenderSatFormaPago: null,
    fundsFlow: 'CASH_DRAWER',
    tenderTypeId: null,
    tenderCountsAsCash: null,
  },
  TRANSFERENCIA: {
    method: 'BANK_TRANSFER',
    source: 'POS',
    externalSource: null,
    tenderSatFormaPago: null,
    fundsFlow: 'EXTERNAL_RECORDED',
    tenderTypeId: null,
    tenderCountsAsCash: null,
  },
  TARJETA_DE_LA_TERMINAL: {
    method: 'DEBIT_CARD',
    source: 'TPV',
    externalSource: null,
    tenderSatFormaPago: null,
    fundsFlow: 'AVOQADO_PROCESSED',
    tenderTypeId: null,
    tenderCountsAsCash: null,
  },
  TARJETA_EXTERNA: {
    method: 'CREDIT_CARD',
    source: 'POS',
    externalSource: null,
    tenderSatFormaPago: null,
    fundsFlow: 'EXTERNAL_RECORDED',
    tenderTypeId: null,
    tenderCountsAsCash: null,
  },
} as const
export type CobroDeRuteo = keyof typeof COBROS_DE_RUTEO

const A_LA_TPV: DecisionDelReembolso = {
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje:
    'Los cobros con tarjeta de la terminal se devuelven en la terminal, con la tarjeta presente: ábrela con «refund_card_on_terminal».',
  dondeIr: ['TPV'],
}
const SOLO_MISMO: DecisionDelReembolso = {
  admitido: false,
  codigo: 'NO_ADMITIDO_EN_ESTA_ENTRADA',
  mensaje: MENSAJE_MISMO_MEDIO,
  dondeIr: ['MISMO_MEDIO'],
}

/** [cobro, entrada, [—, CASH, BANK_TRANSFER, STORE_CREDIT, OTRO]] (cobros ordinarios: ni de la máquina ni de saldo ni de crédito). */
export const MATRIZ_DEL_RUTEO: Array<[CobroDeRuteo, EntradaDelReembolso, MedioDeclarado, DecisionDelReembolso]> = (
  [
    ['EFECTIVO_DE_GAVETA', 'POS', [MISMO, ESCOGIDO, TRANSF, SALDO, MISMO]],
    ['EFECTIVO_DE_GAVETA', 'MCP', [MISMO, MISMO, TRANSF, MCP_NO, MCP_NO]],
    ['EFECTIVO_DE_GAVETA', 'TPV', [MISMO, MISMO, MISMO, MISMO, MISMO]],
    ['TRANSFERENCIA', 'POS', [MISMO, ESCOGIDO, TRANSF, SALDO, MISMO]],
    ['TRANSFERENCIA', 'MCP', [MISMO, ESCOGIDO, TRANSF, MCP_NO, MCP_NO]],
    ['TRANSFERENCIA', 'TPV', [MISMO, MISMO, MISMO, MISMO, MISMO]],
    ['TARJETA_DE_LA_TERMINAL', 'POS', [MISMO, SOLO_MISMO, SOLO_MISMO, SALDO, MISMO]],
    ['TARJETA_DE_LA_TERMINAL', 'MCP', [A_LA_TPV, A_LA_TPV, A_LA_TPV, MCP_NO, MCP_NO]],
    ['TARJETA_DE_LA_TERMINAL', 'TPV', [MISMO, MISMO, MISMO, MISMO, MISMO]],
    ['TARJETA_EXTERNA', 'POS', [MISMO, SOLO_MISMO, SOLO_MISMO, SALDO, MISMO]],
    ['TARJETA_EXTERNA', 'MCP', [MISMO, SOLO_MISMO, SOLO_MISMO, MCP_NO, MCP_NO]],
    ['TARJETA_EXTERNA', 'TPV', [MISMO, MISMO, MISMO, MISMO, MISMO]],
  ] as Array<[CobroDeRuteo, EntradaDelReembolso, Cinco]>
).flatMap(([cobro, entrada, cinco]) =>
  MEDIOS.map((medio, i): [CobroDeRuteo, EntradaDelReembolso, MedioDeclarado, DecisionDelReembolso] => [cobro, entrada, medio, cinco[i]]),
)
