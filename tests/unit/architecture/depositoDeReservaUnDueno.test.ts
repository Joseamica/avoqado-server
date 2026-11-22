/**
 * Candado estático (D681): el depósito de una reserva tiene UN dueño, `src/services/reservation/depositoDeReserva.ts`.
 *
 * En las rondas 1 y 2 de Codex siete escritores del estado de la reserva y de su depósito chocaban entre sí (cancelar, el aviso
 * de pago o de vencida de Stripe, el barrido por reloj, la consulta a Stripe, el regreso de la app de clientes, crear o «pagar
 * de nuevo» la liga), y cada parche abría otra esquina. Ahora todos llaman al dueño, que decide con UNA tabla y escribe con CAS.
 *
 * Este test falla si alguien vuelve a escribir un campo del depósito fuera del dueño (Prisma `create`/`update`/`updateMany`/
 * `upsert`/`updateManyAndReturn` o SQL crudo). Al crear, los campos entran con `...depositoAlCrear(...)`, que es del dueño.
 *
 * Y congela el inventario de quienes cambian el `status` de una reserva: confirmar a mano, llegada, terminar, no-show,
 * reagendar, agregadores y cancelar siguen en su máquina de estados (no tocan el depósito; el dueño escribe con el status que
 * leyó en su `where`, así que una carrera con ellos sólo lo hace volver a leer). Un escritor NUEVO del status falla aquí hasta
 * que alguien revise si debe pasar por el dueño.
 */
import * as fs from 'fs'
import * as path from 'path'

const RAIZ = path.resolve(__dirname, '../../..')
const DUENO = 'src/services/reservation/depositoDeReserva.ts'
const CAMPOS_DEL_DEPOSITO = [
  'depositStatus',
  'checkoutSessionId',
  'depositExpiresAt',
  'depositPaidAt',
  'depositProcessorRef',
  'depositRefundedAt',
]
const LLAMADA = /\.\s*reservation\s*\.\s*(update|updateMany|upsert|create|createMany|updateManyAndReturn|createManyAndReturn)\s*\(/g

/** Quienes escriben `status` de una reserva (llamadas por archivo). Sólo se revisa a mano; ver el encabezado. */
const ESCRITORES_DE_STATUS: Record<string, number> = {
  'src/controllers/public/reservation.public.controller.ts': 1, // alta de clase
  'src/services/aggregators/core/bookingIngestion.service.ts': 2, // reservas de pases
  'src/services/consumer/reservation.consumer.service.ts': 1, // alta de clase desde la app
  'src/services/dashboard/classSession.dashboard.service.ts': 2, // cancelar la clase entera · alta desde el panel
  'src/services/dashboard/reservation.dashboard.service.ts': 2, // alta · máquina de estados `transitionReservation` (dinámica)
  'src/services/demo/negociosDemo.service.ts': 1, // datos de los negocios demo
  'src/services/reservation/checkIn.service.ts': 2, // llegada
  'src/services/reservation/depositoDeReserva.ts': 1, // el dueño (dinámica: lo que decide la tabla)
  'src/services/reservation/undoNoShow.service.ts': 1, // «Sí llegó»
}

function archivosTs(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? archivosTs(p) : e.name.endsWith('.ts') && !e.name.endsWith('.d.ts') ? [p] : []
  })
}

/** El texto entre el `(` de la llamada y su `)` balanceado. */
function argumento(src: string, desde: number): string {
  let profundidad = 1
  let i = desde
  while (i < src.length && profundidad > 0) {
    if (src[i] === '(') profundidad++
    else if (src[i] === ')') profundidad--
    i++
  }
  return src.slice(desde, i - 1)
}

/** Los objetos que ESCRIBE la llamada (`data`, `create`, `update`); `dinamico` si alguno no es un literal. */
export function loQueEscribe(arg: string): { texto: string; dinamico: boolean } {
  let texto = ''
  let dinamico = false
  for (const m of arg.matchAll(/(?<![\w.])(data|create|update)\s*:\s*/g)) {
    const inicio = m.index! + m[0].length
    const abre = arg[inicio]
    if (abre !== '{' && abre !== '[') {
      dinamico = true
      continue
    }
    const cierra = abre === '{' ? '}' : ']'
    let profundidad = 0
    let i = inicio
    do {
      if (arg[i] === abre) profundidad++
      else if (arg[i] === cierra) profundidad--
      i++
    } while (i < arg.length && profundidad > 0)
    texto += arg.slice(inicio, i) + '\n'
  }
  return { texto, dinamico }
}

export function camposEscritos(texto: string, campos: string[]): string[] {
  return campos.filter(c => new RegExp(`(?<![\\w.])${c}\\s*(:|,|\\n|\\})`).test(texto))
}

function escrituras() {
  const out: { archivo: string; linea: number; deposito: string[]; status: boolean; dinamico: boolean }[] = []
  for (const abs of archivosTs(path.join(RAIZ, 'src'))) {
    const archivo = path.relative(RAIZ, abs).split(path.sep).join('/')
    const src = fs.readFileSync(abs, 'utf8')
    for (const m of src.matchAll(LLAMADA)) {
      const { texto, dinamico } = loQueEscribe(argumento(src, m.index! + m[0].length))
      out.push({
        archivo,
        linea: src.slice(0, m.index!).split('\n').length,
        deposito: camposEscritos(texto, CAMPOS_DEL_DEPOSITO),
        status: camposEscritos(texto, ['status']).length > 0 || dinamico,
        dinamico,
      })
    }
  }
  return out
}

describe('D681 · el depósito de una reserva tiene UN dueño', () => {
  const todas = escrituras()

  it('nadie fuera del dueño escribe un campo del depósito (Prisma)', () => {
    const fuera = todas
      .filter(e => e.archivo !== DUENO && e.deposito.length > 0)
      .map(e => `${e.archivo}:${e.linea} → ${e.deposito.join(', ')}`)
    expect(fuera).toEqual([])
  })

  it('nadie fuera del dueño escribe un campo del depósito con SQL crudo', () => {
    const fuera: string[] = []
    for (const abs of archivosTs(path.join(RAIZ, 'src'))) {
      const archivo = path.relative(RAIZ, abs).split(path.sep).join('/')
      if (archivo === DUENO) continue
      const src = fs.readFileSync(abs, 'utf8')
      for (const m of src.matchAll(/(UPDATE|INSERT\s+INTO)\s+"Reservation"[\s\S]{0,600}/gi)) {
        if (CAMPOS_DEL_DEPOSITO.some(c => m[0].includes(`"${c}"`))) fuera.push(`${archivo}:${src.slice(0, m.index!).split('\n').length}`)
      }
    }
    expect(fuera).toEqual([])
  })

  it('el barrido no está ciego: ve las escrituras de reservas, también la del dueño', () => {
    expect(todas.length).toBeGreaterThan(20)
    expect(todas.some(e => e.archivo === DUENO && e.dinamico)).toBe(true)
  })

  it('el inventario de quienes cambian el status de una reserva no crece sin revisión', () => {
    const conteo: Record<string, number> = {}
    for (const e of todas.filter(x => x.status)) conteo[e.archivo] = (conteo[e.archivo] ?? 0) + 1
    expect(conteo).toEqual(ESCRITORES_DE_STATUS)
  })

  it('el lector detecta un campo del depósito escrito a mano, también en forma corta', () => {
    expect(
      camposEscritos(loQueEscribe(`{ where: { id }, data: { status: 'X', depositStatus: 'PAID' } }`).texto, CAMPOS_DEL_DEPOSITO),
    ).toEqual(['depositStatus'])
    expect(camposEscritos(loQueEscribe(`{ data: { venueId, depositExpiresAt, x: 1 } }`).texto, CAMPOS_DEL_DEPOSITO)).toEqual([
      'depositExpiresAt',
    ])
    // Leer o filtrar por el depósito sí se vale.
    expect(
      camposEscritos(loQueEscribe(`{ where: { depositStatus: 'PENDING' }, data: { notes: 'x' } }`).texto, CAMPOS_DEL_DEPOSITO),
    ).toEqual([])
    expect(loQueEscribe(`{ where: { id }, data: updateData as any }`).dinamico).toBe(true)
  })
})
