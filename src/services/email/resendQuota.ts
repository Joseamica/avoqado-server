/**
 * 🔴 El medidor del cupo de la cuenta de Resend (promesa `docs/audit/2026-11-03-cupo-de-resend/promesa.md`).
 *
 * Seguimos en el plan gratis (100 correos al día y 3,000 al mes, y cuentan también los recibidos), y TODO el correo del
 * servidor sale por esa cuenta: login, recibos, avisos y las campañas del CRM. Resend dice en cada respuesta cuánto lleva
 * (`x-resend-daily-quota`, sólo a planes gratis; `x-resend-monthly-quota`) y contesta 429 `daily_quota_exceeded` /
 * `monthly_quota_exceeded` al agotarse. El SDK 6.3.0 tira las cabeceras de la respuesta, por eso el medidor envuelve el `fetch`
 * global: los cuatro clientes de Resend del servidor pasan por él.
 *
 *  - Al 80 % del día o del mes, o con un 429 de cupo: `logger.error('[Resend] …')` (lo ve Better Stack) y un correo a
 *    jose@avoqado.io. Una vez por día por tipo (el del mes, una vez por mes) aunque el servidor se reinicie: CAS sobre la fila
 *    `EmailQuotaAlert`.
 *  - Con el 80 % del día, o un 429 de cupo, se pausan SÓLO las campañas del CRM (`campanasPausadasPorCupo`) hasta el día
 *    siguiente de CDMX (el 429 del mes, hasta el mes siguiente). El login y los recibos nunca se frenan.
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

/** El día de Ciudad de México, `YYYY-MM-DD` (el mes son sus primeros 7). */
const FORMATO_DIA = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Mexico_City', year: 'numeric', month: '2-digit', day: '2-digit' })
const diaDe = (fecha: Date) => FORMATO_DIA.format(fecha)

// ── Lo que este proceso ya vio ──
/** Lo más alto que Resend dijo en el día y en el mes. */
let visto = { dia: '', usadoDia: 0, mes: '', usadoMes: 0 }
/** El día (o el mes) en que Resend contestó «se acabó el cupo». */
let agotadoDia = ''
let agotadoMes = ''
/** La clave del último aviso de cada tipo que este proceso ya intentó: el correo del aviso, que también pasa por aquí, no avisa otra vez. */
const intentado: Record<Aviso, string> = { diario: '', mensual: '', agotado: '' }
let dijoDePago = false
const cuotasMalEscritas = new Set<string>()

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
 * ¿Se pausan HOY (CDMX) las campañas del CRM? Sí si hoy Resend ya dijo 80 % o más del día, si hoy contestó «se acabó el cupo
 * del día» o si este mes contestó «se acabó el cupo del mes». Sólo mira la memoria: nunca toca la red ni la base.
 */
export function campanasPausadasPorCupo(ahora = new Date()): boolean {
  const hoy = diaDe(ahora)
  return (visto.dia === hoy && visto.usadoDia >= umbral(cuotaDiaria())) || agotadoDia === hoy || agotadoMes === hoy.slice(0, 7)
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

async function medir(input: unknown, respuesta: Response): Promise<void> {
  if (hostDe(input) !== HOST) return
  const hoy = diaDe(new Date())
  const mes = hoy.slice(0, 7)
  const diario = numero(respuesta.headers.get('x-resend-daily-quota'))
  const mensual = numero(respuesta.headers.get('x-resend-monthly-quota'))
  // Se espera ANTES de devolver la respuesta: así la pausa ya está puesta cuando el remitente pregunta por el siguiente correo.
  const agotado = respuesta.status === 429 ? await errorDeCupo(respuesta) : undefined

  if (diario !== null) {
    visto = { ...visto, dia: hoy, usadoDia: visto.dia === hoy ? Math.max(visto.usadoDia, diario) : diario }
  } else if (respuesta.ok && !dijoDePago) {
    dijoDePago = true
    logger.info('[Resend] La respuesta no trae x-resend-daily-quota: la cuenta es de pago, sin pausa diaria de campañas')
  }
  if (mensual !== null) {
    visto = { ...visto, mes, usadoMes: visto.mes === mes ? Math.max(visto.usadoMes, mensual) : mensual }
  }
  if (agotado === 'daily_quota_exceeded') agotadoDia = hoy
  if (agotado === 'monthly_quota_exceeded') agotadoMes = mes

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
  const cDia = cuotaDiaria()
  if (diario !== null && diario >= umbral(cDia) && tocaIntentar('diario', hoy)) {
    void avisar('diario', hoy, {
      asunto: `Resend: van ${diario} de ${cDia} correos hoy`,
      cuerpo:
        `La cuenta de Resend lleva ${diario} de ${cDia} correos de hoy (cuentan también los recibidos). Las campañas del CRM se ` +
        'pausaron hasta la medianoche de Ciudad de México para dejar lugar al login y a los recibos, que siguen saliendo. Si pasa ' +
        'seguido, conviene subir de plan en Resend.',
      datos: { usado: diario, cuota: cDia, dia: hoy },
    })
  }
  const cMes = cuotaMensual()
  if (mensual !== null && mensual >= umbral(cMes) && tocaIntentar('mensual', mes)) {
    void avisar('mensual', mes, {
      asunto: `Resend: van ${mensual} de ${cMes} correos este mes`,
      cuerpo:
        `La cuenta de Resend lleva ${mensual} de ${cMes} correos del mes. Al llegar a ${cMes}, Resend deja de mandar todo (también ` +
        'el login y los recibos) hasta que reinicie el cupo. Conviene subir de plan en Resend.',
      datos: { usado: mensual, cuota: cMes, mes },
    })
  }
}

/** Una vez por clave en este proceso. Se marca ANTES de avisar: el correo del aviso vuelve a pasar por aquí. */
function tocaIntentar(tipo: Aviso, clave: string): boolean {
  if (intentado[tipo] === clave) return false
  intentado[tipo] = clave
  return true
}

/** ¿Este proceso gana el aviso? CAS sobre la fila: sólo uno la mueve a `clave`, aunque crucen dos a la vez o tras un reinicio. */
async function reclamarAviso(tipo: Aviso, clave: string): Promise<boolean> {
  const columna = COLUMNA[tipo]
  await prisma.emailQuotaAlert.createMany({ data: [{ id: FILA }], skipDuplicates: true })
  const { count } = await prisma.emailQuotaAlert.updateMany({
    where: { id: FILA, OR: [{ [columna]: null }, { [columna]: { not: clave } }] } as Prisma.EmailQuotaAlertWhereInput,
    data: { [columna]: clave },
  })
  return count === 1
}

async function avisar(
  tipo: Aviso,
  clave: string,
  aviso: { asunto: string; cuerpo: string; datos: Record<string, unknown> },
): Promise<void> {
  let gano = true
  try {
    gano = await reclamarAviso(tipo, clave)
  } catch (error) {
    // Sin la fila no se sabe si otro ya avisó: mejor un aviso de más que uno perdido.
    logger.warn('[Resend] No se pudo reclamar el aviso del cupo en la base; se avisa igual', {
      tipo,
      error: error instanceof Error ? error.message : String(error),
    })
  }
  if (!gano) return
  // 🔴 Primero el log: si el correo no sale (con el cupo agotado no puede), el aviso ya quedó en Better Stack.
  logger.error(`[Resend] ${aviso.asunto}`, aviso.datos)
  if (!puedeMandarFueraDeProduccion(AVISAR_A)) return
  try {
    await emailService.sendEmail({ to: AVISAR_A, subject: aviso.asunto, html: `<p>${aviso.cuerpo}</p>`, text: aviso.cuerpo })
  } catch (error) {
    logger.warn('[Resend] No salió el correo del aviso del cupo', { tipo, error: error instanceof Error ? error.message : String(error) })
  }
}
