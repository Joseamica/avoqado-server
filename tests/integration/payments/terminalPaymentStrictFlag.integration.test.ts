/**
 * El INTERRUPTOR POR VENUE del predicado estricto (I.6 del diseño v3, 11-sep-2026).
 *
 * Por qué existe: el árbol trae la lista blanca estricta de §8 C.1, y el día del despliegue ésa
 * bloquearía 375 filas HISTÓRICAS de producción (305 en la PAX de Testarudo, 53 y 12 en las Nexgo)
 * — filas que producción liberó por tiempo o que nacieron sin `cancelDisposition`, porque esa
 * columna no existía. Bloquearlas deja las terminales muertas y **todavía no existe B**, que es la
 * única salida documentada.
 *
 * 🔴 QUÉ relaja el interruptor (decisión del founder, 11-sep, tras la auditoría de Codex):
 *
 *   · la **ranura física de la terminal** — SÍ la relaja. Es lo que traba los 386 aparatos, y el riesgo que
 *     cubre (encimar dos cobros en el mismo aparato) no aplica a una fila de hace semanas.
 *   · el **bloqueo por ORDEN** — NO la relaja NUNCA. Es lo que impide cobrar dos veces la misma venta, y ese
 *     riesgo no caduca. Medido en producción: de las 386, sólo **29** tienen la orden todavía abierta.
 *
 * La forma: `Venue.terminalPaymentStrictEnabled` (encendido/apagado) + `terminalPaymentStrictSince` (el corte).
 * Van SEPARADAS a propósito: apagar conserva la fecha, así que reencender no desplaza el corte ni deja
 * descubierto el periodo que ya estaba protegido.
 *
 * 🔑 Lo que hace correcta esta composición: **el permisivo es un SUBCONJUNTO del estricto**. Todo
 * lo que bloquea hoy producción (`SLOT_HELD` = en vuelo + UNKNOWN) también lo bloquea la lista
 * blanca. Por eso el predicado combinado es «permisivo O (rama estricta del venue migrado)» y no
 * hace falta restar nada — si fueran conjuntos cruzados, encender el flag podría LIBERAR una fila
 * que hoy bloquea, que es justo la dirección que cuesta dinero.
 *
 * Estas pruebas fijan la equivalencia contra **Postgres real** en los DOS modos: una divergencia
 * entre el SQL y la función significa que el mismo cobro diría una cosa al admitir y otra al
 * consultar.
 */
import { randomUUID } from 'crypto'
import { Prisma, TerminalPaymentRequestStatus } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import {
  bloqueaLaRanura,
  fueSoltadaPorPolitica,
  predicadoDeBloqueo,
  terminalPaymentService,
  UNRESOLVED_FINANCIAL_OUTCOME,
} from '@/services/terminal-payment.service'
import { __resetVenuesEstrictosParaPruebas, invalidarVenuesEstrictos } from '@/services/terminal-payment-strictness'

const fixture = `strict-${randomUUID()}`
const venueMigrado = `${fixture}-mig`
const venueViejo = `${fixture}-old`

/** El corte: las filas de ANTES lo son «históricas» para el venue migrado. */
const CORTE = new Date('2026-09-20T00:00:00.000Z')
const ANTES = new Date('2026-09-19T23:59:59.000Z')
const DESPUES = new Date('2026-09-20T00:00:01.000Z')

type Caso = {
  nombre: string
  status: TerminalPaymentRequestStatus
  failureCode?: string | null
  cancelDisposition?: string | null
  paymentId?: string | null
  resultJson?: unknown
  /** ¿Bloquea con el predicado PERMISIVO (el que corre hoy en producción, HEAD 3000f3d0)? */
  permisivo: boolean
}

/**
 * Los casos elegidos son exactamente los que DIFERENCIAN los dos modos, más un par de controles.
 * Si los dos modos coincidieran en todo, el interruptor no tendría nada que interruptar.
 */
const CASOS: Caso[] = [
  // — Controles: bloquean SIEMPRE, en los dos modos (el permisivo es subconjunto del estricto) —
  { nombre: 'en vuelo PENDING', status: TerminalPaymentRequestStatus.PENDING, permisivo: true },
  { nombre: 'en vuelo SENT', status: TerminalPaymentRequestStatus.SENT, permisivo: true },
  { nombre: 'en vuelo CANCEL_REQUESTED', status: TerminalPaymentRequestStatus.CANCEL_REQUESTED, permisivo: true },
  { nombre: 'UNKNOWN', status: TerminalPaymentRequestStatus.UNKNOWN, permisivo: true },

  // — Las históricas de producción: HOY no bloquean; con el estricto SÍ —
  { nombre: 'TIMED_OUT sin código', status: TerminalPaymentRequestStatus.TIMED_OUT, permisivo: false },
  {
    nombre: 'TIMED_OUT/AUTO_RELEASED (lo que prod liberó por tiempo)',
    status: TerminalPaymentRequestStatus.TIMED_OUT,
    failureCode: 'AUTO_RELEASED',
    permisivo: false,
  },
  {
    nombre: 'CANCELLED sin disposición (la columna no existía en prod)',
    status: TerminalPaymentRequestStatus.CANCELLED,
    cancelDisposition: null,
    permisivo: false,
  },
  { nombre: 'CANCELLED con ACTIVE', status: TerminalPaymentRequestStatus.CANCELLED, cancelDisposition: 'ACTIVE', permisivo: false },
  { nombre: 'FAILED/TPV_ERROR', status: TerminalPaymentRequestStatus.FAILED, failureCode: 'TPV_ERROR', permisivo: false },
  { nombre: 'FAILED/ACK_TIMEOUT', status: TerminalPaymentRequestStatus.FAILED, failureCode: 'ACK_TIMEOUT', permisivo: false },
  { nombre: 'FAILED sin código', status: TerminalPaymentRequestStatus.FAILED, failureCode: null, permisivo: false },
  { nombre: 'FAILED/CODIGO_DESCONOCIDO', status: TerminalPaymentRequestStatus.FAILED, failureCode: 'CODIGO_DESCONOCIDO', permisivo: false },
  { nombre: 'COMPLETED sin Payment', status: TerminalPaymentRequestStatus.COMPLETED, paymentId: null, permisivo: false },

  // — Las que NO bloquean en NINGUNO de los dos modos: su desenlace está acreditado —
  { nombre: 'COMPLETED con Payment', status: TerminalPaymentRequestStatus.COMPLETED, paymentId: 'pay-strict', permisivo: false },
  { nombre: 'CANCELLED/ACCEPTED', status: TerminalPaymentRequestStatus.CANCELLED, cancelDisposition: 'ACCEPTED', permisivo: false },
  { nombre: 'lápida de admisión', status: TerminalPaymentRequestStatus.FAILED, failureCode: 'REJECTED_TERMINAL_BUSY', permisivo: false },
  { nombre: 'FAILED/TPV_NEVER_RECEIVED', status: TerminalPaymentRequestStatus.FAILED, failureCode: 'TPV_NEVER_RECEIVED', permisivo: false },
  {
    nombre: 'FAILED/TPV_CONFIRMED_NO_CHARGE con evidencia',
    status: TerminalPaymentRequestStatus.FAILED,
    failureCode: 'TPV_CONFIRMED_NO_CHARGE',
    resultJson: { outcomeEvidence: 'PROCESSOR_DECLINED' },
    permisivo: false,
  },

  // — Los contraejemplos de equivalencia que encontró Codex (P2-5, 11-sep). Nadie escribe hoy estos valores;
  //   están aquí porque la equivalencia función↔SQL es lo único que impide que el mismo cobro diga una cosa al
  //   admitir y otra al consultar, y una divergencia silenciosa ahí se paga con dinero.
  //   `constructor` y `__proto__` encontraban una propiedad HEREDADA del objeto de códigos y acreditaban un
  //   «no se cobró» inexistente; la cadena vacía en `paymentId` la leía JS como ausente y el SQL no.
  {
    nombre: 'FAILED con failureCode "constructor" (propiedad heredada)',
    status: TerminalPaymentRequestStatus.FAILED,
    failureCode: 'constructor',
    permisivo: false,
  },
  { nombre: 'FAILED con failureCode "__proto__"', status: TerminalPaymentRequestStatus.FAILED, failureCode: '__proto__', permisivo: false },
  { nombre: 'FAILED con failureCode "toString"', status: TerminalPaymentRequestStatus.FAILED, failureCode: 'toString', permisivo: false },
  { nombre: 'COMPLETED con paymentId cadena VACÍA', status: TerminalPaymentRequestStatus.COMPLETED, paymentId: '', permisivo: false },
]

/** requestId → fila sembrada, para poder mapear los resultados del SQL de vuelta al caso. */
type Sembrada = Caso & { requestId: string; venueId: string; createdAt: Date; terminalId: string }
const sembradas: Sembrada[] = []

let n = 0
for (const venue of [venueMigrado, venueViejo])
  for (const createdAt of [ANTES, DESPUES])
    for (const caso of CASOS) {
      n += 1
      sembradas.push({
        ...caso,
        requestId: `strict-${n}`,
        // El índice parcial ÚNICO de la ranura es por terminal: cada fila necesita la suya.
        terminalId: `strict-t${n}`,
        venueId: venue,
        createdAt,
      })
    }

beforeAll(async () => {
  const url = new URL(process.env.TEST_DATABASE_URL ?? '')
  expect(['localhost', '127.0.0.1']).toContain(url.hostname)

  await prisma.organization.create({ data: { id: fixture, name: fixture, email: `${fixture}@example.test`, phone: '5500000002' } })
  for (const venue of [venueMigrado, venueViejo]) {
    await prisma.venue.create({ data: { id: venue, organizationId: fixture, name: venue, slug: venue } })
  }
  const expiresAt = new Date(Date.now() + 3_600_000)
  for (let i = 0; i < sembradas.length; i += 500) {
    await prisma.terminalPaymentRequest.createMany({
      data: sembradas.slice(i, i + 500).map(f => ({
        requestId: f.requestId,
        venueId: f.venueId,
        terminalId: f.terminalId,
        status: f.status,
        amountCents: 100,
        failureCode: f.failureCode ?? null,
        cancelDisposition: f.cancelDisposition ?? null,
        // `?? null` y NO `|| null`: la cadena vacía es uno de los casos bajo prueba y `||` la convertiría en null.
        paymentId: f.paymentId ?? null,
        resultJson: f.resultJson === undefined || f.resultJson === null ? Prisma.DbNull : (f.resultJson as Prisma.InputJsonValue),
        expiresAt,
        createdAt: f.createdAt,
      })),
    })
  }
})

afterAll(async () => {
  await prisma.terminalPaymentRequest.deleteMany({ where: { venueId: { in: [venueMigrado, venueViejo] } } })
  await prisma.venue.deleteMany({ where: { id: { in: [venueMigrado, venueViejo] } } })
  await prisma.organization.deleteMany({ where: { id: fixture } })
})

/** Las filas que el SQL dice que bloquean, para un mapa de venues estrictos dado. */
async function bloqueadasEnSql(estrictos: ReadonlyMap<string, Date>): Promise<Set<string>> {
  const filas = await prisma.terminalPaymentRequest.findMany({
    where: { venueId: { in: [venueMigrado, venueViejo] }, ...predicadoDeBloqueo(estrictos) },
    select: { requestId: true },
  })
  return new Set(filas.map(f => f.requestId))
}

/** Las filas que la FUNCIÓN dice que bloquean, con el mismo mapa. */
function bloqueadasEnFuncion(estrictos: ReadonlyMap<string, Date>): Set<string> {
  return new Set(sembradas.filter(f => bloqueaLaRanura(f as never, estrictos)).map(f => f.requestId))
}

function comparar(estrictos: ReadonlyMap<string, Date>, enSql: Set<string>) {
  const enFuncion = bloqueadasEnFuncion(estrictos)
  const porFila = (id: string) => JSON.stringify(sembradas.find(f => f.requestId === id))
  return {
    sqlDeMenos: [...enFuncion].filter(id => !enSql.has(id)).map(porFila),
    sqlDeMas: [...enSql].filter(id => !enFuncion.has(id)).map(porFila),
  }
}

describe('interruptor por venue del predicado estricto', () => {
  const SIN_NADIE: ReadonlyMap<string, Date> = new Map()
  const SOLO_MIGRADO: ReadonlyMap<string, Date> = new Map([[venueMigrado, CORTE]])

  it('P1 APAGADO: bloquea EXACTAMENTE lo que bloquea producción hoy — en vuelo y UNKNOWN, nada más', async () => {
    const enSql = await bloqueadasEnSql(SIN_NADIE)

    const esperadas = new Set(sembradas.filter(f => f.permisivo).map(f => f.requestId))
    expect([...enSql].sort()).toEqual([...esperadas].sort())

    // Y ninguna de las históricas que hoy NO bloquean en producción queda atrapada.
    const historicas = sembradas.filter(f => !f.permisivo).map(f => f.requestId)
    expect(historicas.filter(id => enSql.has(id))).toEqual([])

    expect(comparar(SIN_NADIE, enSql)).toEqual({ sqlDeMenos: [], sqlDeMas: [] })
  })

  it('P1 ENCENDIDO: la lista blanca estricta rige SÓLO en el venue migrado y SÓLO desde el corte', async () => {
    const enSql = await bloqueadasEnSql(SOLO_MIGRADO)

    // El venue que no migró se comporta EXACTAMENTE como antes.
    const delViejo = sembradas.filter(f => f.venueId === venueViejo)
    expect(delViejo.filter(f => enSql.has(f.requestId) !== f.permisivo)).toEqual([])

    // En el migrado, las ANTERIORES al corte también se siguen juzgando con el predicado viejo:
    // ésa es la «migración acotada por fecha» — su verdad se concilia con B, no bloqueando.
    const migradoAntes = sembradas.filter(f => f.venueId === venueMigrado && f.createdAt === ANTES)
    expect(migradoAntes.filter(f => enSql.has(f.requestId) !== f.permisivo)).toEqual([])

    // Y desde el corte sí rige la lista blanca: TIMED_OUT, CANCELLED sin ACCEPTED, FAILED sin
    // acreditar y COMPLETED sin Payment pasan a bloquear.
    const debenBloquear = [
      'TIMED_OUT sin código',
      'CANCELLED sin disposición (la columna no existía en prod)',
      'CANCELLED con ACTIVE',
      'FAILED/TPV_ERROR',
      'FAILED/ACK_TIMEOUT',
      'FAILED sin código',
      'FAILED/CODIGO_DESCONOCIDO',
      'COMPLETED sin Payment',
      'COMPLETED con paymentId cadena VACÍA',
      'FAILED con failureCode "constructor" (propiedad heredada)',
      'FAILED con failureCode "__proto__"',
      'FAILED con failureCode "toString"',
    ]
    const migradoDespues = sembradas.filter(f => f.venueId === venueMigrado && f.createdAt === DESPUES)
    expect(migradoDespues.filter(f => debenBloquear.includes(f.nombre) && !enSql.has(f.requestId)).map(f => f.nombre)).toEqual([])

    // Lo acreditado NO bloquea ni siquiera en estricto (si no, el flag mataría terminales sanas).
    const acreditadas = [
      'COMPLETED con Payment',
      'CANCELLED/ACCEPTED',
      'lápida de admisión',
      'FAILED/TPV_NEVER_RECEIVED',
      'FAILED/TPV_CONFIRMED_NO_CHARGE con evidencia', // 🔴 Añadida el 12-sep: no ACREDITA el desenlace, pero SUELTA la ranura a propósito (ver `SOLTADA_POR_POLITICA`).
      'TIMED_OUT/AUTO_RELEASED (lo que prod liberó por tiempo)',
    ]
    expect(migradoDespues.filter(f => acreditadas.includes(f.nombre) && enSql.has(f.requestId)).map(f => f.nombre)).toEqual([])

    expect(comparar(SOLO_MIGRADO, enSql)).toEqual({ sqlDeMenos: [], sqlDeMas: [] })
  })

  // 🔴 LA RANURA Y LA VENTA SON DOS CANDADOS DISTINTOS (12-sep, tras la auditoría de Codex).
  //
  // Una fila que el servidor soltó DELIBERADAMENTE por tiempo (`AUTO_RELEASED`) o a mano
  // (`MANUAL_RELEASE`) libera la RANURA en los dos regímenes — si no, la terminal queda muerta
  // para siempre y ésa es la queja original del founder («lo que no puede pasar es que se trabe»).
  //
  // Y soltarla es SEGURO por una razón concreta, no por optimismo: el candado de la VENTA sigue
  // estricto SIEMPRE, así que esa venta no se puede recobrar ni en esta terminal ni en ninguna de
  // las otras 49 de la sucursal. Lo que entra después por esa ranura es OTRA venta, de otro
  // cliente: un resultado tardío del cobro viejo no la convierte en doble cobro (y si llega,
  // `closeRowFromPaymentTx` lo reconcilia y grita 🚨).
  //
  // 🔑 `TIMED_OUT` SIN código se queda bloqueando a propósito: eso no es una liberación
  // deliberada, es una fila histórica sin explicación. Sólo libera lo que alguien soltó a
  // sabiendas, con su código y su asiento en la bitácora.
  it('P1 una fila SOLTADA POR POLÍTICA libera la RANURA en los dos regímenes — y la VENTA sigue protegida', async () => {
    const soltadas = sembradas.filter(f => f.nombre === 'TIMED_OUT/AUTO_RELEASED (lo que prod liberó por tiempo)')
    expect(soltadas.length).toBeGreaterThan(0)

    // (a) La RANURA: libre con el flag apagado Y encendido, antes y después del corte.
    for (const estrictos of [SIN_NADIE, SOLO_MIGRADO]) {
      const enSql = await bloqueadasEnSql(estrictos)
      expect(soltadas.filter(f => enSql.has(f.requestId)).map(f => f.requestId)).toEqual([])
      // Y la función espejo dice lo mismo que el SQL (si divergieran, admitir y proyectar mentirían distinto).
      expect(comparar(estrictos, enSql)).toEqual({ sqlDeMenos: [], sqlDeMas: [] })
    }

    // (b) La VENTA: esa MISMA fila sigue con desenlace pendiente, o sea que su orden sigue cerrada
    //     a un cobro nuevo. Es lo único que hace seguro soltar la ranura.
    const requestIds = soltadas.map(f => f.requestId)
    const siguenPendientes = await prisma.terminalPaymentRequest.findMany({
      where: { requestId: { in: requestIds }, ...UNRESOLVED_FINANCIAL_OUTCOME },
      select: { requestId: true },
    })
    expect(siguenPendientes.map(f => f.requestId).sort()).toEqual([...requestIds].sort())
  })

  it('P1 encender NUNCA libera una fila que ya bloqueaba (el permisivo es subconjunto del estricto)', async () => {
    const apagado = await bloqueadasEnSql(SIN_NADIE)
    const encendido = await bloqueadasEnSql(SOLO_MIGRADO)

    // Ésta es la dirección que cuesta dinero: una fila que hoy retiene la ranura y que al encender
    // el flag dejara de retenerla permitiría un segundo cobro sobre un desenlace incierto.
    const liberadasAlEncender = [...apagado].filter(id => !encendido.has(id))
    expect(liberadasAlEncender.map(id => JSON.stringify(sembradas.find(f => f.requestId === id)))).toEqual([])
    expect(encendido.size).toBeGreaterThan(apagado.size)
  })

  it('con el flag ENCENDIDO y sin fecha de corte útil, el estricto es «pendiente de desenlace» MENOS lo soltado por política', async () => {
    // Corte en el pasado remoto ⇒ TODAS las filas del venue migrado se juzgan con la lista blanca.
    //
    // 🔴 Hasta el 12-sep esto se afirmaba como «idéntico a `UNRESOLVED_FINANCIAL_OUTCOME` a secas».
    // Ya no lo es, y el cambio es deliberado: una fila que el servidor SOLTÓ a sabiendas libera la
    // RANURA sin dejar de estar pendiente de desenlace (su VENTA sigue cerrada). La prueba nombra
    // ahora la diferencia EXACTA en vez de la igualdad — así el día que alguien reste algo más,
    // esto falla en lugar de aceptarlo en silencio.
    const desdeSiempre: ReadonlyMap<string, Date> = new Map([[venueMigrado, new Date('2000-01-01T00:00:00.000Z')]])
    const conFlag = await bloqueadasEnSql(desdeSiempre)

    const pendientes = await prisma.terminalPaymentRequest.findMany({
      where: { venueId: venueMigrado, ...UNRESOLVED_FINANCIAL_OUTCOME },
      select: { requestId: true, status: true, failureCode: true },
    })
    const esperadas = pendientes.filter(r => !fueSoltadaPorPolitica(r)).map(r => r.requestId)
    const soltadas = pendientes.filter(r => fueSoltadaPorPolitica(r)).map(r => r.requestId)

    // La diferencia existe de verdad (si no, la prueba pasaría sin ejercitar nada).
    expect(soltadas.length).toBeGreaterThan(0)

    const delMigrado = [...conFlag].filter(id => sembradas.find(f => f.requestId === id)?.venueId === venueMigrado)
    expect(delMigrado.sort()).toEqual([...esperadas].sort())
    // Y lo soltado NO está entre lo que bloquea, aunque siga pendiente de desenlace.
    expect(delMigrado.filter(id => soltadas.includes(id))).toEqual([])
    expect(comparar(desdeSiempre, conFlag)).toEqual({ sqlDeMenos: [], sqlDeMas: [] })
  })
})

/**
 * 🔴 El régimen APAGADO, por los MÉTODOS REALES y no por el predicado suelto (hallazgo P2-3 de la auditoría de
 * Fable, 11-sep). Las pruebas de arriba consultan `predicadoDeBloqueo` con un `findMany` directo; eso demuestra
 * que el SQL es correcto, no que los métodos que corren el día del despliegue lo usen. Y el día del despliegue
 * el flag va APAGADO en todos los venues: es el único régimen que producción va a ver al principio.
 */
describe('P1 régimen APAGADO a través de isTerminalBusy y getBusyTerminalIds', () => {
  beforeAll(async () => {
    __resetVenuesEstrictosParaPruebas()
    await invalidarVenuesEstrictos() // ningún venue de esta prueba está encendido
  })

  it('una terminal que sólo arrastra filas HISTÓRICAS se anuncia LIBRE — es lo que destraba los 386 aparatos', async () => {
    // `venueViejo` no está en la lista de estrictos: sus TIMED_OUT, CANCELLED sin aceptar y FAILED sin acreditar
    // no deben reservar nada. Si esto fallara, el despliegue dejaría las terminales muertas.
    const historicas = sembradas.filter(f => f.venueId === venueViejo && !f.permisivo)
    expect(historicas.length).toBeGreaterThan(0)
    for (const fila of historicas) {
      expect([fila.nombre, await terminalPaymentService.isTerminalBusy(fila.terminalId, venueViejo)]).toEqual([fila.nombre, false])
    }
    const ocupadas = await terminalPaymentService.getBusyTerminalIds(
      venueViejo,
      historicas.map(f => f.terminalId),
    )
    expect([...ocupadas]).toEqual([])
  })

  it('lo que bloquea HOY en producción (en vuelo y UNKNOWN) sigue bloqueando con el flag apagado', async () => {
    const enVuelo = sembradas.filter(f => f.venueId === venueViejo && f.permisivo)
    expect(enVuelo.length).toBeGreaterThan(0)
    for (const fila of enVuelo) {
      expect([fila.nombre, await terminalPaymentService.isTerminalBusy(fila.terminalId, venueViejo)]).toEqual([fila.nombre, true])
    }
  })

  it('P1 ENCENDIDO por los mismos métodos: la histórica pasa a reservar su terminal', async () => {
    await prisma.venue.update({
      where: { id: venueMigrado },
      data: { terminalPaymentStrictEnabled: true, terminalPaymentStrictSince: CORTE },
    })
    await invalidarVenuesEstrictos()
    try {
      // Del venue migrado y NACIDAS DESPUÉS del corte: ésas sí entran a la lista blanca.
      const tras = sembradas.filter(f => f.venueId === venueMigrado && f.createdAt === DESPUES && !f.permisivo)
      const deberian = tras.filter(
        f =>
          ![
            'COMPLETED con Payment',
            'CANCELLED/ACCEPTED',
            'lápida de admisión',
            'FAILED/TPV_NEVER_RECEIVED',
            'FAILED/TPV_CONFIRMED_NO_CHARGE con evidencia', // 🔴 Añadida el 12-sep: no ACREDITA el desenlace, pero SUELTA la ranura a propósito (ver `SOLTADA_POR_POLITICA`).
            'TIMED_OUT/AUTO_RELEASED (lo que prod liberó por tiempo)',
          ].includes(f.nombre),
      )
      expect(deberian.length).toBeGreaterThan(0)
      for (const fila of deberian) {
        expect([fila.nombre, await terminalPaymentService.isTerminalBusy(fila.terminalId, venueMigrado)]).toEqual([fila.nombre, true])
      }
      // Y las ANTERIORES al corte siguen libres: la «migración acotada por fecha», por el método real.
      const antes = sembradas.filter(f => f.venueId === venueMigrado && f.createdAt === ANTES && !f.permisivo)
      for (const fila of antes) {
        expect([fila.nombre, await terminalPaymentService.isTerminalBusy(fila.terminalId, venueMigrado)]).toEqual([fila.nombre, false])
      }
    } finally {
      await prisma.venue.update({ where: { id: venueMigrado }, data: { terminalPaymentStrictEnabled: false } })
      await invalidarVenuesEstrictos()
    }
  })
})
