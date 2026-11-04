/**
 * 🔴 El medidor del cupo de la cuenta de Resend (promesa `docs/audit/2026-11-03-cupo-de-resend/promesa.md`).
 *
 * Seguimos en el plan gratis (100 correos al día y 3,000 al mes, y cuentan también los recibidos), y TODO el correo del
 * servidor sale por esa cuenta: login, recibos, avisos y las campañas del CRM. Resend dice en cada respuesta cuánto lleva
 * (`x-resend-daily-quota`, sólo a planes gratis; `x-resend-monthly-quota`) y contesta 429 `daily_quota_exceeded` /
 * `monthly_quota_exceeded` al agotarse. El SDK 6.3.0 tira las cabeceras de la respuesta, por eso el medidor envuelve el `fetch`
 * global: los cuatro clientes de Resend del servidor pasan por él.
 *
 *  - 🔴 El día es el de Resend: UTC. Su cupo diario se reinicia a la medianoche UTC, las 18:00 de Ciudad de México (no hay
 *    horario de verano desde 2022). El mes, el mes UTC (Resend no publica cuándo reinicia el suyo).
 *  - Al 80 % del día o del mes, o con un 429 de cupo: `logger.error('[Resend] …')` (lo ve Better Stack) y un correo a
 *    jose@avoqado.io con una llave por aviso. La fila `EmailQuotaAlert` se ANOTA después del log y del correo: si el proceso
 *    muere antes, el siguiente vuelve a avisar y la llave hace que Resend no lo mande dos veces. Con el cupo agotado el
 *    correo no puede salir: sólo queda el log.
 *  - Con el 80 % del día, o un 429 de cupo, se pausan SÓLO las campañas del CRM (`campanasPausadasPorCupo`) hasta que Resend
 *    reinicia el día (`reinicioDelCupoDiario`). El 429 del mes también: al día siguiente sale un correo de prueba y, si Resend
 *    vuelve a decir 429, se pausa otra vez. El login y los recibos nunca se frenan.
 *  - Nunca cambia la petición ni la respuesta y nunca lanza: un fallo del medidor jamás tumba un correo.
 *
 * Sin efectos al importarse: el `fetch` se envuelve sólo con `instalarMedidorDeCupoResend()`, que llama `server.ts`.
 *
 * ponytail: la pausa vive en la memoria del proceso (una sola instancia, `.claude/rules/una-sola-instancia.md`). Tras un
 * reinicio se rearma con la primera respuesta de Resend, así que puede salir UNA campaña de más por reinicio; si estorba, que
 * arranque leyendo `EmailQuotaAlert.dailyAlertDay`.
 */
import type { Prisma } from '@prisma/client'
import logger from '../../config/logger'
import prisma from '../../utils/prismaClient'
import { puedeMandarFueraDeProduccion } from '../crm/email/testAllowlist'
import emailService from '../email.service'

const HOST = 'api.resend.com'
const AVISAR_A = 'jose@avoqado.io'
const FILA = 'resend'
const MARCA = Symbol.for('avoqado.medidorDeCupoResend')
/** Plan gratis de Resend. Con otro plan: `RESEND_DAILY_QUOTA` / `RESEND_MONTHLY_QUOTA`. */
const CUOTA_DIARIA = 100
const CUOTA_MENSUAL = 3000

type Aviso = 'diario' | 'mensual' | 'agotado'
type ErrorDeCupo = 'daily_quota_exceeded' | 'monthly_quota_exceeded'
const COLUMNA = { diario: 'dailyAlertDay', mensual: 'monthlyAlertMonth', agotado: 'exhaustedAlertDay' } as const

/** El día de Resend (UTC), `YYYY-MM-DD` (el mes son sus primeros 7). */
const diaDe = (fecha: Date) => fecha.toISOString().slice(0, 10)

/** Cuando Resend reinicia el cupo del día: la medianoche UTC siguiente (las 18:00 de CDMX). Ahí vuelven las campañas. */
export const reinicioDelCupoDiario = (ahora: Date) =>
  new Date(Date.UTC(ahora.getUTCFullYear(), ahora.getUTCMonth(), ahora.getUTCDate() + 1))

// ── Lo que este proceso ya vio ──
/** Lo más alto que Resend dijo en el día y en el mes. */
let visto = { dia: '', usadoDia: 0, mes: '', usadoMes: 0 }
/** El día en que Resend contestó «se acabó el cupo» (del día o del mes). */
let agotadoDia = ''
/**
 * El último aviso de cada tipo en este proceso: su clave y desde cuándo se puede reintentar. `Infinity` = en vuelo o ya dado
 * (el correo del aviso, que también pasa por aquí, no avisa otra vez); un correo que no salió deja `ahora + REINTENTO_MS`.
 */
const intento: Record<Aviso, { clave: string; reintentarDesde: number }> = {
  diario: { clave: '', reintentarDesde: 0 },
  mensual: { clave: '', reintentarDesde: 0 },
  agotado: { clave: '', reintentarDesde: 0 },
}
/** La clave del último aviso de cada tipo que ya quedó en el log de este proceso: un reintento del correo no lo repite. */
const logueado: Record<Aviso, string> = { diario: '', mensual: '', agotado: '' }
const REINTENTO_MS = 10 * 60_000
let dijoDePago = false
const cuotasMalEscritas = new Set<string>()

/** El código con que `sendEmailWithResult` devuelve una campaña que frenó su `antesDeMandar` por la pausa del cupo. */
export const CUPO_EN_PAUSA = 'cupo_en_pausa'

export const esErrorDeCupo = (name: string | undefined): name is ErrorDeCupo =>
  name === 'daily_quota_exceeded' || name === 'monthly_quota_exceeded'

/** La cuota del plan, validada al usarla: una mal escrita vale la del plan gratis y nunca tumba nada. */
function cuota(nombre: 'RESEND_DAILY_QUOTA' | 'RESEND_MONTHLY_QUOTA', plan: number): number {
  const valor = process.env[nombre]?.trim()
  if (!valor) return plan
  const n = Number(valor)
  if (Number.isInteger(n) && n > 0) return n
  if (!cuotasMalEscritas.has(nombre)) {
    cuotasMalEscritas.add(nombre)
    logger.warn(`[Resend] ${nombre}=«${valor}» no es un entero mayor que 0: se usa ${plan}, el del plan gratis`)
  }
  return plan
}
/** El 80 %, en enteros (100 → 80, 3,000 → 2,400). */
const umbral = (c: number) => Math.floor((c * 4) / 5)
const cuotaDiaria = () => cuota('RESEND_DAILY_QUOTA', CUOTA_DIARIA)
const cuotaMensual = () => cuota('RESEND_MONTHLY_QUOTA', CUOTA_MENSUAL)

/**
 * ¿Se pausan HOY (día de Resend, UTC) las campañas del CRM? Sí si hoy Resend ya dijo 80 % o más del día, o si hoy contestó «se
 * acabó el cupo» (del día o del mes). Sólo mira la memoria: nunca toca la red ni la base.
 */
export function campanasPausadasPorCupo(ahora = new Date()): boolean {
  const hoy = diaDe(ahora)
  return (visto.dia === hoy && visto.usadoDia >= umbral(cuotaDiaria())) || agotadoDia === hoy
}

/** Envuelve el `fetch` global UNA vez (idempotente). */
export function instalarMedidorDeCupoResend(): void {
  const original = globalThis.fetch
  if (typeof original !== 'function' || (original as unknown as Record<symbol, unknown>)[MARCA]) return
  const medido = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const respuesta = await original(input, init)
    try {
      await medir(input, respuesta)
    } catch (error) {
      logger.warn('[Resend] El medidor del cupo falló; el correo siguió igual', {
        error: error instanceof Error ? error.message : String(error),
      })
    }
    return respuesta
  }
  Object.defineProperty(medido, MARCA, { value: true })
  globalThis.fetch = medido as typeof fetch
}

function hostDe(input: unknown): string | null {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request).url
    return new URL(url).hostname
  } catch {
    return null
  }
}

const numero = (valor: string | null): number | null => {
  if (valor === null || valor.trim() === '') return null
  const n = Number(valor)
  return Number.isInteger(n) && n >= 0 ? n : null
}

/** El `name` de un 429, de una COPIA de la respuesta: el SDK lee el original después. */
async function errorDeCupo(respuesta: Response): Promise<ErrorDeCupo | undefined> {
  try {
    const { name } = (await respuesta.clone().json()) as { name?: string }
    return esErrorDeCupo(name) ? name : undefined
  } catch {
    return undefined
  }
}

/**
 * El día en que Resend contó: su cabecera `Date`. Una respuesta de las 23:59:59 UTC que llega pasada la medianoche es del día
 * viejo; contarla en el nuevo pausaría las campañas todo el día con el cupo ya renovado. Sin cabecera, la hora de aquí.
 */
function diaDeLaRespuesta(respuesta: Response): string {
  const fecha = new Date(respuesta.headers.get('date') ?? '')
  return diaDe(Number.isNaN(fecha.getTime()) ? new Date() : fecha)
}

async function medir(input: unknown, respuesta: Response): Promise<void> {
  if (hostDe(input) !== HOST) return
  const hoy = diaDeLaRespuesta(respuesta)
  const mes = hoy.slice(0, 7)
  const diario = numero(respuesta.headers.get('x-resend-daily-quota'))
  const mensual = numero(respuesta.headers.get('x-resend-monthly-quota'))
  // Se espera ANTES de devolver la respuesta: así la pausa ya está puesta cuando el remitente pregunta por el siguiente correo.
  const agotado = respuesta.status === 429 ? await errorDeCupo(respuesta) : undefined

  // Una respuesta de un día ya pasado (llegó tarde) no se mezcla con el día que ya se está viendo.
  if (diario !== null) {
    if (hoy >= visto.dia) visto = { ...visto, dia: hoy, usadoDia: visto.dia === hoy ? Math.max(visto.usadoDia, diario) : diario }
  } else if (respuesta.ok && !dijoDePago) {
    dijoDePago = true
    logger.info('[Resend] La respuesta no trae x-resend-daily-quota: la cuenta es de pago, sin pausa diaria de campañas')
  }
  if (mensual !== null && mes >= visto.mes) {
    visto = { ...visto, mes, usadoMes: visto.mes === mes ? Math.max(visto.usadoMes, mensual) : mensual }
  }
  if (agotado && hoy >= agotadoDia) agotadoDia = hoy

  // Los avisos no detienen el correo que los disparó: corren aparte y nunca lanzan.
  if (agotado && tocaIntentar('agotado', hoy)) {
    const delDia = agotado === 'daily_quota_exceeded'
    void avisar('agotado', hoy, {
      asunto: `Resend: se acabó el cupo ${delDia ? 'del día' : 'del mes'}`,
      cuerpo:
        `Resend contestó que se acabó el cupo ${delDia ? 'del día' : 'del mes'} (${agotado}). No sale ningún correo del servidor, ` +
        'tampoco el login ni los recibos, hasta que Resend reinicie el cupo. Sube de plan en Resend para que vuelvan a salir.',
      datos: { error: agotado, diario, mensual },
    })
  }
  // 🔴 El asunto y el cuerpo llevan el UMBRAL, nunca el número del momento: un reintento con la misma llave debe llevar el mismo
  // contenido, o Resend contesta 409 y el aviso nunca se anota. El número del momento va en el log.
  const cDia = cuotaDiaria()
  if (diario !== null && diario >= umbral(cDia) && tocaIntentar('diario', hoy)) {
    void avisar('diario', hoy, {
      asunto: `Resend: el correo de hoy llegó a ${umbral(cDia)} de ${cDia}`,
      cuerpo:
        `La cuenta de Resend llegó a ${umbral(cDia)} de ${cDia} correos de hoy (cuentan también los recibidos). Las campañas del ` +
        'CRM se pausaron hasta las 18:00 de Ciudad de México, cuando Resend reinicia el cupo del día, para dejar lugar al login y ' +
        'a los recibos, que siguen saliendo. Si pasa seguido, conviene subir de plan en Resend.',
      datos: { usado: diario, cuota: cDia, dia: hoy },
    })
  }
  const cMes = cuotaMensual()
  if (mensual !== null && mensual >= umbral(cMes) && tocaIntentar('mensual', mes)) {
    void avisar('mensual', mes, {
      asunto: `Resend: el correo del mes llegó a ${umbral(cMes)} de ${cMes}`,
      cuerpo:
        `La cuenta de Resend llegó a ${umbral(cMes)} de ${cMes} correos del mes. Al llegar a ${cMes}, Resend deja de mandar todo ` +
        '(también el login y los recibos) hasta que reinicie el cupo. Conviene subir de plan en Resend.',
      datos: { usado: mensual, cuota: cMes, mes },
    })
  }
}

/** ¿Toca intentar este aviso? Queda «en vuelo» ANTES de avisar: el correo del aviso vuelve a pasar por aquí. */
function tocaIntentar(tipo: Aviso, clave: string): boolean {
  if (intento[tipo].clave === clave && Date.now() < intento[tipo].reintentarDesde) return false
  intento[tipo] = { clave, reintentarDesde: Number.POSITIVE_INFINITY }
  return true
}

/** ¿Este aviso ya se dio por completo (log y correo)? Se anota sólo después de darlo. */
async function yaAvisado(tipo: Aviso, clave: string): Promise<boolean> {
  try {
    const fila = await prisma.emailQuotaAlert.findUnique({ where: { id: FILA }, select: { [COLUMNA[tipo]]: true } })
    return (fila as Record<string, string | null> | null)?.[COLUMNA[tipo]] === clave
  } catch (error) {
    // Sin la fila no se sabe si otro ya avisó: mejor un aviso de más que uno perdido.
    logger.warn('[Resend] No se pudo leer el aviso del cupo en la base; se avisa igual', {
      tipo,
      error: error instanceof Error ? error.message : String(error),
    })
    return false
  }
}

async function anotarAviso(tipo: Aviso, clave: string): Promise<void> {
  const dato = { [COLUMNA[tipo]]: clave }
  try {
    await prisma.emailQuotaAlert.upsert({
      where: { id: FILA },
      create: { id: FILA, ...dato } as Prisma.EmailQuotaAlertCreateInput,
      update: dato,
    })
  } catch (error) {
    // Sin anotarlo, el siguiente proceso vuelve a avisar: el correo lleva la misma llave y Resend no lo manda dos veces.
    logger.warn('[Resend] No se pudo anotar el aviso del cupo', { tipo, error: error instanceof Error ? error.message : String(error) })
  }
}

/**
 * Leer → log → correo → anotar. Si el proceso muere antes de anotar, el siguiente vuelve a avisar: un log de más y el mismo
 * correo, que Resend no repite por su llave (`cupo-resend-<tipo>-<clave>`, 24 h, con el mismo contenido). Dos procesos a la
 * vez, igual. Un correo que no salió se reintenta con la siguiente respuesta de Resend pasados `REINTENTO_MS`, sin repetir el
 * log. Con el cupo agotado el correo no puede salir: queda el log (Better Stack) y se anota sin intentarlo.
 * ponytail: tras 24 h la llave vence; sólo el aviso del mes podría salir dos veces, y sólo si el proceso muere en esa ventana.
 */
async function avisar(
  tipo: Aviso,
  clave: string,
  aviso: { asunto: string; cuerpo: string; datos: Record<string, unknown> },
): Promise<void> {
  if (await yaAvisado(tipo, clave)) return
  // 🔴 Primero el log: si el correo no sale, el aviso ya quedó en Better Stack. Una vez por clave en este proceso.
  if (logueado[tipo] !== clave) {
    logueado[tipo] = clave
    logger.error(`[Resend] ${aviso.asunto}`, aviso.datos)
  }
  if (agotadoDia !== diaDe(new Date()) && puedeMandarFueraDeProduccion(AVISAR_A)) {
    let salio = false
    try {
      salio = await emailService.sendEmail({
        to: AVISAR_A,
        subject: aviso.asunto,
        html: `<p>${aviso.cuerpo}</p>`,
        text: aviso.cuerpo,
        idempotencyKey: `cupo-resend-${tipo}-${clave}`,
      })
    } catch (error) {
      logger.warn('[Resend] No salió el correo del aviso del cupo', { tipo, error: error instanceof Error ? error.message : String(error) })
    }
    // Sin el correo no se anota: se reintenta (aquí, pasados REINTENTO_MS, o en el siguiente proceso) con la misma llave.
    if (!salio) {
      // Sólo si sigue siendo el aviso vigente: uno de ayer que falla al cambiar el día no pisa el de hoy.
      if (intento[tipo].clave === clave) intento[tipo] = { clave, reintentarDesde: Date.now() + REINTENTO_MS }
      return
    }
  }
  await anotarAviso(tipo, clave)
}
