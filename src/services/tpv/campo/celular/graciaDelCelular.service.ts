/**
 * La gracia de 24 h y «por revisar» (App de campo, bloque 1, Tarea 7, regla A5/A6).
 *
 * Un celular desvinculado puede seguir subiendo, por `POST /tpv/campo/gracia`, lo que tenía por subir al desvincularse: lo
 * que trae una huella de su último latido, dentro de 24 h, de una persona activa y con permiso, se aplica a su nombre. Lo
 * demás se RETIENE (`EnvioRetenidoDeCampo`) para que un supervisor lo aplique o lo descarte desde el panel.
 *
 * El retenido es una máquina de estados con CAS (`updateMany` condicionado). La tocan dos actores: la gracia del celular
 * (nacer, reintentar, aplicar) y el panel o el MCP («Aplicar», «Descartar»). Cuatro invariantes valen en TODOS los caminos
 * (arreglo final 4, tras tres rondas de la misma familia de errores):
 *
 *   I1 · Lo que pasó manda. Nada deja una fila en «no se hizo» (nacer PENDIENTE, volver a PENDIENTE, DESCARTADO), ni se lo
 *        contesta al celular o al supervisor, ni ejecuta, sin preguntar ANTES `efectoYaHecho` por ese cuerpo: hecho →
 *        APLICADO con su resultado; a medias → APLICANDO (no se descarta); nada → lo que corresponda.
 *   I2 · Nadie le quita la fila a quien la está aplicando. APLICANDO tocada hace menos de `VENTANA_EN_VUELO_MS` está «en
 *        vuelo»: otro actor no cambia su estado y recibe 409 APLICACION_EN_CURSO. Tomarla para ejecutar es un CAS
 *        (PENDIENTE, o APLICANDO vencida) que deja APLICANDO con `updatedAt` = la marca de quien la tomó.
 *   I3 · APLICANDO sólo vuelve a PENDIENTE por quien la tiene (su marca sigue en `updatedAt`), o, vencida, por quien ya vio que
 *        no hay efecto ni nada a medias.
 *   I4 · El que aplicó gana: lo aplicado deja la fila APLICADO desde cualquier estado; si pisa un DESCARTADO, la bitácora dice
 *        quién lo había descartado (CAMPO_RETENIDO_DESCARTE_REVERTIDO).
 *
 * Quien termina sin dueño (se lanzó algo reintentable, o la venta quedó a medias) la SUELTA: deja `updatedAt` ya vencido, así
 * el siguiente no espera la ventana. Si el proceso muere, la ventana la suelta sola.
 * ponytail: `updatedAt` hace de candado (no hay schema nuevo); con una columna `tomadaAt` propia ya no habría que «vencerlo».
 * Lo que la gracia aplica sola deja su fila ANTES del efecto (APLICANDO, motivo APLICADO_EN_GRACIA, S1).
 */
import { CelularDeCampo, EnvioRetenidoDeCampo, Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import { staffHasPermissionInVenue } from '@/middlewares/checkPermission.middleware'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import {
  aplicarEnvio,
  cuerpoValido,
  EfectoDelEnvio,
  efectoYaHecho,
  estaAMedias,
  huellaDelEnvio,
  permisosDelEnvio,
  ResultadoDelEnvio,
  TipoDeEnvio,
} from './envioDeCampo'
import { sucursalesDeCampoDeLaPersona, sucursalesDeLaPersona } from './personasDeCampo'

const GRACIA_MS = 24 * 60 * 60 * 1000

export type EstadoDelRetenido = 'PENDIENTE' | 'APLICANDO' | 'APLICADO' | 'DESCARTADO'
export type MotivoDeRetencion =
  | 'NO_REPORTADA'
  | 'FUERA_DE_PLAZO'
  | 'PERSONA_DADA_DE_BAJA'
  | 'SIN_PERMISO'
  | 'RECHAZADO'
  /** El celular se desvinculó como perdido o robado (S8): nada de lo que mande se aplica solo. */
  | 'CELULAR_PERDIDO'
  /** No se retuvo: la gracia lo aplicó sola. La fila guarda su desenlace por huella (un reintento lo recibe igual). */
  | 'APLICADO_EN_GRACIA'
export type RetenidoDeCampo = {
  id: string
  staffId: string
  nombre: string
  venueId: string
  sucursal: string
  tipo: TipoDeEnvio
  motivo: MotivoDeRetencion
  rechazo: { code: string; message: string; detalle?: unknown } | null
  resumen: string
  createdAt: Date
  estado: EstadoDelRetenido
}

/** Para guardar en una columna Json lo mismo que después se devuelve (sin Decimals ni Dates vivos). */
const comoJson = (x: unknown): Prisma.InputJsonValue => JSON.parse(JSON.stringify(x ?? null))

// ------------------------------------------------------------------------------------------------------------------------
// La gracia
// ------------------------------------------------------------------------------------------------------------------------

/** Tope de envíos por revisar (PENDIENTE o APLICANDO) por celular (S7): el siguiente es 409 y el celular lo conserva. */
const TOPE_DE_RETENIDOS = 500

/** Lo que contesta la gracia por un retenido que ya existe (sea cual sea el estado del celular hoy). */
function desenlaceDelRetenido(r: EnvioRetenidoDeCampo): { status: number; body: unknown } {
  if (r.estado === 'APLICADO') return { status: 200, body: { resuelto: 'APLICADO', resultado: r.resultado } }
  if (r.estado === 'DESCARTADO') return { status: 200, body: { resuelto: 'DESCARTADO', nota: r.nota } }
  return { status: 202, body: { retenido: true, motivo: r.motivo, repetida: true } }
}

// --- I2: quién la está aplicando --------------------------------------------------------------------------------------

/** Más que lo que dura una petición: una APLICANDO tocada hace menos la está aplicando alguien. */
export const VENTANA_EN_VUELO_MS = 5 * 60 * 1000
const corte = () => new Date(Date.now() - VENTANA_EN_VUELO_MS)
/** El `updatedAt` de una APLICANDO que nadie está aplicando (a medias o soltada): ya vencido. */
const sinDueno = () => new Date(Date.now() - VENTANA_EN_VUELO_MS - 1000)
const enVuelo = (r: EnvioRetenidoDeCampo) => r.estado === 'APLICANDO' && r.updatedAt > corte()
const enCurso = () => new ConflictError('Se está aplicando en este momento. Vuelve a intentar en unos minutos.', 'APLICACION_EN_CURSO')
const aMediasError = () => new ConflictError('Aplicar se quedó a medias. Vuelve a tocar Aplicar para terminarla.', 'APLICACION_A_MEDIAS')

/** Tomar la fila para ejecutarla (CAS): PENDIENTE o APLICANDO vencida → APLICANDO con la marca. null si otro la tiene. */
async function tomar(id: string, extra: Prisma.EnvioRetenidoDeCampoWhereInput = {}): Promise<Date | null> {
  const marca = new Date()
  const { count } = await prisma.envioRetenidoDeCampo.updateMany({
    where: { id, ...extra, OR: [{ estado: 'PENDIENTE' }, { estado: 'APLICANDO', updatedAt: { lt: corte() } }] },
    data: { estado: 'APLICANDO', updatedAt: marca },
  })
  return count ? marca : null
}

/** I3: la fila sigue siendo de quien la tomó (nadie la retomó tras la ventana). */
const deQuienLaTomo = (id: string, marca: Date): Prisma.EnvioRetenidoDeCampoWhereInput => ({ id, estado: 'APLICANDO', updatedAt: marca })

/** Quien la tomó termina sin dueño (reintentable o a medias): sigue APLICANDO (no se descarta) y ya vencida. */
async function soltar(id: string, marca: Date, data: Prisma.EnvioRetenidoDeCampoUpdateManyMutationInput = {}): Promise<number> {
  const { count } = await prisma.envioRetenidoDeCampo.updateMany({
    where: deQuienLaTomo(id, marca),
    data: { ...data, updatedAt: sinDueno() },
  })
  return count
}

/** I1: una PENDIENTE con la venta a medias pasa a APLICANDO sin dueño: ya no se descarta, «Aplicar» la termina. */
const aMediasSinDueno = (id: string) =>
  prisma.envioRetenidoDeCampo.updateMany({ where: { id, estado: 'PENDIENTE' }, data: { estado: 'APLICANDO', updatedAt: sinDueno() } })

/**
 * I4: lo aplicado (o el efecto que ya existía) deja la fila APLICADO desde cualquier otro estado. Si pisa un DESCARTADO, la
 * bitácora dice quién lo había descartado. false: ya estaba APLICADO (otro la terminó).
 */
async function marcarHecho(
  fila: EnvioRetenidoDeCampo,
  data: { resultado: Prisma.InputJsonValue; resueltoPor: string | null; rechazo?: Prisma.InputJsonValue; nota?: string },
  quien: string,
): Promise<boolean> {
  const aplicada = { estado: 'APLICADO', resueltoAt: new Date(), ...data }
  const { count } = await prisma.envioRetenidoDeCampo.updateMany({
    where: { id: fila.id, estado: { in: ['PENDIENTE', 'APLICANDO'] } },
    data: aplicada,
  })
  if (count) return true
  const hoy = await prisma.envioRetenidoDeCampo.findUnique({ where: { id: fila.id } })
  if (hoy?.estado !== 'DESCARTADO') return false
  const revertida = await prisma.envioRetenidoDeCampo.updateMany({ where: { id: fila.id, estado: 'DESCARTADO' }, data: aplicada })
  if (!revertida.count) return false
  void logAction({
    staffId: quien,
    venueId: fila.venueId,
    organizationId: fila.organizationId,
    action: 'CAMPO_RETENIDO_DESCARTE_REVERTIDO',
    entity: 'EnvioRetenidoDeCampo',
    entityId: fila.id,
    data: {
      tipo: fila.tipo,
      celularId: fila.celularId,
      personaId: fila.staffId,
      descartadoPor: hoy.resueltoPor,
      descartadoAt: hoy.resueltoAt,
      notaDelDescarte: hoy.nota,
    },
  })
  return true
}

// --- La gracia --------------------------------------------------------------------------------------------------------

/** Lo que la gracia empezó a aplicar sola (APLICANDO, APLICADO_EN_GRACIA): el reintento lo evalúa otra vez. */
const deLaGracia = (r: EnvioRetenidoDeCampo) => r.estado === 'APLICANDO' && r.motivo === 'APLICADO_EN_GRACIA'

type Envio = { tipo: TipoDeEnvio; venueId: string; cuerpoJson: string }

export async function recibirEnGracia(celular: CelularDeCampo, e: Envio): Promise<{ status: number; body: unknown }> {
  // 1. Nada de otra organización se retiene (Codex r1 P5).
  const venue = await prisma.venue.findUnique({ where: { id: e.venueId }, select: { organizationId: true } })
  if (venue?.organizationId !== celular.organizationId) {
    throw new ForbiddenError('Esa sucursal no es de tu organización.', 'OTRA_ORGANIZACION')
  }
  let cuerpo: unknown
  try {
    cuerpo = JSON.parse(e.cuerpoJson)
  } catch {
    throw new BadRequestError('Lo que mandó el celular no es JSON.', 'CUERPO_INVALIDO')
  }
  // S7: lo que su ruta rechazaría tampoco se retiene (nadie podría aplicarlo).
  if (!cuerpoValido(e.tipo, cuerpo)) {
    throw new BadRequestError('Lo que mandó el celular no es válido para esta acción.', 'CUERPO_INVALIDO')
  }

  // 2. Lo ya retenido contesta su desenlace (R2-6); lo que la gracia dejó a medias se evalúa otra vez (T2).
  const huella = huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson)
  const previo = await prisma.envioRetenidoDeCampo.findUnique({ where: { celularId_huella: { celularId: celular.id, huella } } })
  return previo ? contestarPrevio(celular, e, cuerpo, huella, previo) : evaluar(celular, e, cuerpo, huella, null)
}

/** La fila de esta huella ya existe. I2: si alguien la está aplicando, 409 (el celular la vuelve a mandar). I1 antes de contestar. */
async function contestarPrevio(celular: CelularDeCampo, e: Envio, cuerpo: unknown, huella: string, previo: EnvioRetenidoDeCampo) {
  if (enVuelo(previo)) throw enCurso()
  if (previo.estado === 'APLICADO') return desenlaceDelRetenido(previo)
  if (deLaGracia(previo)) return evaluar(celular, e, cuerpo, huella, previo)
  // PENDIENTE, DESCARTADO o a medias del panel: nada se contesta como «no se hizo» sin ver el efecto.
  const ya = await efectoYaHecho(e.tipo, ctxDe(celular, e), cuerpo, previo.createdAt)
  if (ya.hecho) return terminarEnGracia(celular, e, previo, comoJson(ya.resultado), { recuperado: true })
  if (previo.estado === 'PENDIENTE' && estaAMedias(ya)) await aMediasSinDueno(previo.id)
  return desenlaceDelRetenido(previo)
}

const ctxDe = (celular: CelularDeCampo, e: Envio) => ({
  venueId: e.venueId,
  orgId: celular.organizationId,
  staffId: celular.staffId,
  celularId: celular.id,
})

const bitacoraDeGracia = (celular: CelularDeCampo, e: Envio, huella: string, recuperado?: true) =>
  void logAction({
    staffId: celular.staffId,
    venueId: e.venueId,
    organizationId: celular.organizationId,
    action: 'CAMPO_GRACIA_APLICADA',
    entity: 'CelularDeCampo',
    entityId: celular.id,
    data: { tipo: e.tipo, huella, celularId: celular.id, ...(recuperado ? { recuperado: true } : {}) },
  })

/** `previo`: la fila que la gracia dejó a medias (APLICANDO vencida); null para una pieza nueva. */
async function evaluar(
  celular: CelularDeCampo,
  e: Envio,
  cuerpo: unknown,
  huella: string,
  previo: EnvioRetenidoDeCampo | null,
): Promise<{ status: number; body: unknown }> {
  const ctx = ctxDe(celular, e)
  // I1: reanudar empieza por preguntar si el efecto ya ocurrió (aun pasadas las 24 h o tras una baja: ya es un hecho).
  let ya: EfectoDelEnvio | null = null
  if (previo) {
    ya = await efectoYaHecho(e.tipo, ctx, cuerpo, previo.createdAt)
    if (ya.hecho) return terminarEnGracia(celular, e, previo, comoJson(ya.resultado), { recuperado: true })
  }

  // 3. Vinculado y activo: lo suyo va por su sesión. «Dada de baja» con las sucursales de CAMPO, como el latido (T7).
  const sucursales = await sucursalesDeCampoDeLaPersona(celular.staffId, celular.organizationId)
  const dadaDeBaja = sucursales.length === 0
  if (celular.staffIdVinculado && !dadaDeBaja) {
    throw new ConflictError('Este celular sigue vinculado: sube con tu sesión.', 'USA_TU_SESION')
  }

  // 4 y 5. Lo que ya no procede no se ejecuta (R2-2).
  const motivo = await motivoParaRetener(
    celular,
    e,
    huella,
    dadaDeBaja,
    sucursales.map(s => s.venueId),
  )
  if (previo) {
    if (motivo) {
      // I3: sólo la fila vencida, sin efecto, vuelve a PENDIENTE con su motivo; a medias se queda APLICANDO sin dueño.
      const { count } = await prisma.envioRetenidoDeCampo.updateMany({
        where: { id: previo.id, estado: 'APLICANDO', updatedAt: { lt: corte() } },
        data: estaAMedias(ya) ? { motivo, updatedAt: sinDueno() } : { estado: 'PENDIENTE', motivo },
      })
      return count === 0 ? comoQuedo(previo.id) : { status: 202, body: { retenido: true, motivo } }
    }
    const marca = await tomar(previo.id)
    return marca ? aplicarEnGracia(celular, e, cuerpo, previo, marca) : comoQuedo(previo.id)
  }

  // T5: el tope va ANTES de crear cualquier fila (también la que se aplica sola y puede acabar PENDIENTE).
  // ponytail: contar y crear no son atómicos; dos subidas a la vez pueden pasar el tope por una. Basta como freno.
  const porRevisar = await prisma.envioRetenidoDeCampo.count({
    where: { celularId: celular.id, estado: { in: ['PENDIENTE', 'APLICANDO'] } },
  })
  if (porRevisar >= TOPE_DE_RETENIDOS) {
    throw new ConflictError(
      'Este celular ya tiene demasiados envíos esperando revisión. Se quedan guardados en el celular y se vuelven a mandar cuando tu supervisor los revise.',
      'RETENIDOS_LLENOS',
    )
  }

  // I1 al nacer (R3-1), para todos los tipos: lo que ya hizo la ruta normal (respuesta perdida) nace APLICADO y no se
  // ejecuta otra vez; lo que quedó a medias nace APLICANDO sin dueño (no se descarta).
  ya = await efectoYaHecho(e.tipo, ctx, cuerpo, new Date())
  if (ya.hecho) {
    const resultado = comoJson(ya.resultado)
    const datos = { motivo: motivo ?? 'APLICADO_EN_GRACIA', estado: 'APLICADO' as const, resultado, resueltoAt: new Date() }
    const { fila, nueva } = await crearOLeer(celular, e, huella, datos)
    if (!nueva) return contestarPrevio(celular, e, cuerpo, huella, fila)
    bitacoraDeGracia(celular, e, huella, true)
    return { status: 200, body: { resuelto: 'APLICADO', resultado } }
  }
  if (motivo) {
    const aMedias = estaAMedias(ya) ? { estado: 'APLICANDO' as const, updatedAt: sinDueno() } : {}
    const { fila, nueva } = await crearOLeer(celular, e, huella, { motivo, ...aMedias })
    return nueva ? { status: 202, body: { retenido: true, motivo } } : contestarPrevio(celular, e, cuerpo, huella, fila)
  }

  // S1: la fila va ANTES que el efecto, ya tomada por esta subida (I2).
  const marca = new Date()
  const { fila, nueva } = await crearOLeer(celular, e, huella, { motivo: 'APLICADO_EN_GRACIA', estado: 'APLICANDO', updatedAt: marca })
  return nueva ? aplicarEnGracia(celular, e, cuerpo, fila, marca) : contestarPrevio(celular, e, cuerpo, huella, fila)
}

async function comoQuedo(id: string) {
  const hoy = await prisma.envioRetenidoDeCampo.findUnique({ where: { id } })
  if (!hoy) throw new NotFoundError('No encontramos ese envío.', 'RETENIDO_NO_ENCONTRADO')
  if (enVuelo(hoy)) throw enCurso()
  return desenlaceDelRetenido(hoy)
}

/**
 * El efecto existe (I4): la fila queda APLICADA con su resultado desde cualquier estado (un reintento, aun pasadas las 24 h o
 * tras una baja, recibe lo mismo). Contesta `{ resuelto: APLICADO, resultado }`, o `respuesta` si se da (lo de la ruta).
 */
async function terminarEnGracia(
  celular: CelularDeCampo,
  e: Envio,
  fila: EnvioRetenidoDeCampo,
  resultado: Prisma.InputJsonValue,
  extra: { recuperado?: true; rechazo?: Prisma.InputJsonValue; respuesta?: { status: number; body: unknown } } = {},
): Promise<{ status: number; body: unknown }> {
  const marcada = await marcarHecho(
    fila,
    { resultado, resueltoPor: null, ...(extra.rechazo !== undefined && { rechazo: extra.rechazo }) },
    celular.staffId,
  )
  if (!marcada) return comoQuedo(fila.id) // otro (un supervisor con «Aplicar») la terminó mientras tanto
  bitacoraDeGracia(celular, e, fila.huella, extra.recuperado)
  return extra.respuesta ?? { status: 200, body: { resuelto: 'APLICADO', resultado } }
}

/** Ejecuta la fila que ESTA subida tomó (`marca`). I1 ya se preguntó antes de tomarla. */
async function aplicarEnGracia(
  celular: CelularDeCampo,
  e: Envio,
  cuerpo: unknown,
  fila: EnvioRetenidoDeCampo,
  marca: Date,
): Promise<{ status: number; body: unknown }> {
  let r: ResultadoDelEnvio
  try {
    r = await aplicarEnvio(ctxDe(celular, e), e.tipo, cuerpo)
  } catch (error) {
    // Lo reintentable se lanza: la fila sigue APLICANDO (no descartable) y se suelta; el siguiente intento la evalúa otra vez.
    await soltar(fila.id, marca)
    throw error
  }
  if (r.tipo === 'APLICADO') {
    const respuesta = { status: r.status, body: { ...(r.body as object), aplicadoEnGracia: true } }
    return terminarEnGracia(celular, e, fila, comoJson(r.body), { respuesta })
  }
  // La custodia aceptada en parte YA tiene efecto: queda APLICADA con las filas fallidas, igual que en «Aplicar».
  const rechazo = comoJson(r.rechazo)
  if (aceptadaEnParte(e.tipo, r)) return terminarEnGracia(celular, e, fila, comoJson(r.rechazo.detalle), { rechazo })
  // I1: un rechazo no se cree a ciegas: ¿el efecto ya ocurrió (p. ej. por la ruta normal)?
  const ya = await efectoYaHecho(e.tipo, ctxDe(celular, e), cuerpo, fila.createdAt)
  if (ya.hecho) return terminarEnGracia(celular, e, fila, comoJson(ya.resultado), { recuperado: true, rechazo })
  if (estaAMedias(ya)) {
    // U2: la venta quedó a medias: sigue APLICANDO (no descartable) con su rechazo, sin dueño; la termina el reintento o «Aplicar».
    const n = await soltar(fila.id, marca, { rechazo })
    return n === 0 ? comoQuedo(fila.id) : { status: 202, body: { retenido: true, motivo: 'RECHAZADO', aMedias: true } }
  }
  // I3: rechazo definitivo sin efecto: queda por revisar, sólo si sigue siendo suya.
  const { count } = await prisma.envioRetenidoDeCampo.updateMany({
    where: deQuienLaTomo(fila.id, marca),
    data: { estado: 'PENDIENTE', motivo: 'RECHAZADO', rechazo },
  })
  return count === 0 ? comoQuedo(fila.id) : { status: 202, body: { retenido: true, motivo: 'RECHAZADO' } }
}

/** Una custodia aceptada en parte: el servicio la rechaza (CUSTODIA_INCOMPLETA), pero algunas SIMs sí quedaron aceptadas. */
const aceptadaEnParte = (tipo: string, r: ResultadoDelEnvio) =>
  r.tipo === 'RECHAZADO' && tipo === 'CUSTODIA_ACEPTAR' && (r.rechazo.detalle as any)?.summary?.succeeded > 0

async function motivoParaRetener(
  celular: CelularDeCampo,
  e: { tipo: TipoDeEnvio; venueId: string },
  huella: string,
  dadaDeBaja: boolean,
  sucursales: string[],
): Promise<MotivoDeRetencion | null> {
  if (celular.sinGracia) return 'CELULAR_PERDIDO' // S8: perdido o robado, nada se aplica solo
  if (dadaDeBaja) return 'PERSONA_DADA_DE_BAJA' // A6
  const desde = celular.desvinculadoAt
  if (!desde || Date.now() > desde.getTime() + GRACIA_MS) return 'FUERA_DE_PLAZO'
  // La evidencia no necesita huella: depende de una venta que ya pasó estas reglas y no crea nada por sí sola (R2-4).
  const reportada = celular.huellasPorSubir.includes(huella) && !(celular.huellasReportadasAt && celular.huellasReportadasAt > desde)
  if (e.tipo !== 'EVIDENCIA' && !reportada) return 'NO_REPORTADA'
  if (!sucursales.includes(e.venueId)) return 'SIN_PERMISO'
  for (const permission of permisosDelEnvio(e.tipo)) {
    if (!(await staffHasPermissionInVenue({ staffId: celular.staffId, venueId: e.venueId, permission }))) return 'SIN_PERMISO'
  }
  return null
}

/** Inserta la fila de esta huella; si otra subida con la misma huella le ganó (P2002), devuelve ésa. */
async function crearOLeer(
  celular: CelularDeCampo,
  e: Envio,
  huella: string,
  datos: {
    motivo: MotivoDeRetencion
    estado?: 'APLICANDO' | 'APLICADO'
    updatedAt?: Date
    resultado?: Prisma.InputJsonValue
    resueltoAt?: Date
  },
): Promise<{ fila: EnvioRetenidoDeCampo; nueva: boolean }> {
  try {
    const fila = await prisma.envioRetenidoDeCampo.create({
      data: {
        organizationId: celular.organizationId,
        celularId: celular.id,
        staffId: celular.staffId,
        venueId: e.venueId,
        tipo: e.tipo,
        huella,
        cuerpoJson: e.cuerpoJson,
        ...datos,
      },
    })
    return { fila, nueva: true }
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    const previo = await prisma.envioRetenidoDeCampo.findUnique({ where: { celularId_huella: { celularId: celular.id, huella } } })
    if (!previo) throw error
    return { fila: previo, nueva: false }
  }
}

// ------------------------------------------------------------------------------------------------------------------------
// «Por revisar» (el panel)
// ------------------------------------------------------------------------------------------------------------------------

const leerJson = (texto: string): any => {
  try {
    return JSON.parse(texto)
  } catch {
    return null
  }
}

function resumenDe(r: EnvioRetenidoDeCampo, zona: string): string {
  const c = leerJson(r.cuerpoJson)
  if (!c || typeof c !== 'object') return ''
  switch (r.tipo) {
    case 'VENTA':
      return `SIM ${c.serialNumber ?? '?'} · $${Number(c.precioVisto ?? 0).toFixed(2)}`
    case 'ENTRADA':
    case 'SALIDA': {
      const hora = c.ocurrioAt ? new Date(c.ocurrioAt) : r.createdAt
      if (isNaN(hora.getTime())) return r.tipo === 'ENTRADA' ? 'Entrada' : 'Salida'
      const [hhmm, dia, mes] = formatInTimeZone(hora, zona, 'HH:mm|d|M').split('|')
      const MESES = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic']
      return `${r.tipo === 'ENTRADA' ? 'Entrada' : 'Salida'} a las ${hhmm} del ${dia}-${MESES[Number(mes) - 1]}`
    }
    case 'CUSTODIA_ACEPTAR':
      return `SIMs ${(Array.isArray(c.sims) ? c.sims : []).map((s: any) => s?.serialNumber).join(', ')}`
    case 'CUSTODIA_RECHAZAR':
      return `SIM ${c.serialNumber ?? '?'}`
    case 'EVIDENCIA': {
      const n = Array.isArray(c.photoUrls) ? c.photoUrls.length : 0
      return `${n} ${n === 1 ? 'foto' : 'fotos'}`
    }
    default:
      return ''
  }
}

/** El alcance de quien pregunta (el MCP, S3): sólo retenidos de esas sucursales. El panel no lo pasa (toda la org, A7). */
const enElAlcance = (venueIds?: string[]): Prisma.EnvioRetenidoDeCampoWhereInput =>
  venueIds ? { AND: [{ venueId: { in: venueIds } }] } : {}

export async function listarRetenidos(
  organizationId: string,
  f: { staffId?: string; venueId?: string; estado?: EstadoDelRetenido | EstadoDelRetenido[]; page: number; pageSize: number },
  venueIds?: string[],
): Promise<{ items: RetenidoDeCampo[]; total: number }> {
  const estados = f.estado === undefined ? undefined : Array.isArray(f.estado) ? f.estado : [f.estado]
  const where: Prisma.EnvioRetenidoDeCampoWhereInput = {
    organizationId,
    ...(f.staffId && { staffId: f.staffId }),
    ...(f.venueId && { venueId: f.venueId }),
    ...(estados && { estado: { in: estados } }),
    ...enElAlcance(venueIds),
  }
  const [filas, total] = await Promise.all([
    prisma.envioRetenidoDeCampo.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      skip: (f.page - 1) * f.pageSize,
      take: f.pageSize,
    }),
    prisma.envioRetenidoDeCampo.count({ where }),
  ])
  const [personas, sucursales] = await Promise.all([
    prisma.staff.findMany({
      where: { id: { in: [...new Set(filas.map(x => x.staffId))] } },
      select: { id: true, firstName: true, lastName: true },
      take: f.pageSize, // los de UNA página de retenidos
    }),
    prisma.venue.findMany({
      where: { id: { in: [...new Set(filas.map(x => x.venueId))] } },
      select: { id: true, name: true, timezone: true },
      take: f.pageSize,
    }),
  ])
  const persona = new Map(personas.map(p => [p.id, `${p.firstName ?? ''} ${p.lastName ?? ''}`.trim()]))
  const sucursal = new Map(sucursales.map(v => [v.id, v]))
  return {
    total,
    items: filas.map(r => {
      const rechazo = r.rechazo as { code?: string; message?: string; detalle?: unknown } | null
      const v = sucursal.get(r.venueId)
      return {
        id: r.id,
        staffId: r.staffId,
        nombre: persona.get(r.staffId) ?? '',
        venueId: r.venueId,
        sucursal: v?.name ?? '',
        tipo: r.tipo as TipoDeEnvio,
        motivo: r.motivo as MotivoDeRetencion,
        rechazo: rechazo
          ? {
              code: String(rechazo.code ?? ''),
              message: String(rechazo.message ?? ''),
              ...(rechazo.detalle !== undefined && { detalle: rechazo.detalle }),
            }
          : null,
        resumen: resumenDe(r, v?.timezone ?? 'America/Mexico_City'),
        createdAt: r.createdAt,
        estado: r.estado as EstadoDelRetenido,
      }
    }),
  }
}

const enProceso = () => new ConflictError('Este envío cambió mientras lo revisabas. Vuelve a intentar.', 'RETENIDO_EN_PROCESO')

const noSePudo = (detalle: Record<string, unknown>) =>
  new ValidationError('No se pudo aplicar. Revisa el motivo y vuelve a intentar.', 'NO_SE_PUDO_APLICAR', detalle)

/** Un CAS que no tocó nada: se relee y se contesta según dónde quedó el retenido. */
async function segunComoQuedo(p: { retenidoId: string; organizationId: string; accion: 'APLICAR' | 'DESCARTAR'; venueIds?: string[] }) {
  const r = await prisma.envioRetenidoDeCampo.findFirst({
    where: { id: p.retenidoId, organizationId: p.organizationId, ...enElAlcance(p.venueIds) },
  })
  if (!r) throw new NotFoundError('No encontramos ese envío.', 'RETENIDO_NO_ENCONTRADO')
  if (enVuelo(r)) throw enCurso() // I2
  if (r.estado === 'APLICADO') {
    if (p.accion === 'APLICAR') return { estado: 'APLICADO' as const, resultado: r.resultado, repetida: true }
    throw new ConflictError('Este envío ya se aplicó.', 'YA_APLICADO')
  }
  if (r.estado === 'DESCARTADO') {
    if (p.accion === 'DESCARTAR') return { estado: 'DESCARTADO' as const, repetida: true }
    throw new ConflictError('Este envío ya se descartó.', 'YA_RESUELTO')
  }
  if (p.accion === 'DESCARTAR' && r.estado === 'APLICANDO') throw aMediasError()
  return r // PENDIENTE o APLICANDO sin dueño: «Aplicar» sigue
}

export async function resolverRetenido(p: {
  retenidoId: string
  organizationId: string
  accion: 'APLICAR' | 'DESCARTAR'
  nota?: string
  porStaffId: string
  /** El alcance de quien resuelve (el MCP, S3): uno de otra sucursal no se encuentra. El panel no lo pasa. */
  venueIds?: string[]
}): Promise<{ estado: 'APLICADO' | 'DESCARTADO'; resultado?: unknown; repetida: boolean; yaEstabaHecho?: true }> {
  const { retenidoId: id, organizationId } = p
  const alcance = enElAlcance(p.venueIds)
  const bitacora = (r: EnvioRetenidoDeCampo, action: string, extra: object = {}) =>
    void logAction({
      staffId: p.porStaffId,
      venueId: r.venueId,
      organizationId,
      action,
      entity: 'EnvioRetenidoDeCampo',
      entityId: r.id,
      data: { tipo: r.tipo, celularId: r.celularId, personaId: r.staffId, nota: p.nota ?? null, ...extra },
    })

  const r = await prisma.envioRetenidoDeCampo.findFirst({ where: { id, organizationId, ...alcance } })
  if (!r) throw new NotFoundError('No encontramos ese envío.', 'RETENIDO_NO_ENCONTRADO')
  if (enVuelo(r)) throw enCurso() // I2: alguien la está aplicando
  if (r.estado === 'APLICADO') {
    if (p.accion === 'APLICAR') return { estado: 'APLICADO', resultado: r.resultado, repetida: true }
    throw new ConflictError('Este envío ya se aplicó.', 'YA_APLICADO')
  }
  const ctx = { venueId: r.venueId, orgId: organizationId, staffId: r.staffId, celularId: r.celularId }
  const cuerpo = leerJson(r.cuerpoJson)
  const tipo = r.tipo as TipoDeEnvio

  // I4: lo aplicado gana sobre cualquier otro estado (también un DESCARTADO en el hueco), con la bitácora.
  const marcarAplicado = async (resultado: Prisma.InputJsonValue, recuperado: boolean, extra: { yaEstabaHecho?: true } = {}) => {
    const datos = { resultado, resueltoPor: p.porStaffId, ...(p.nota !== undefined && { nota: p.nota }) }
    if (!(await marcarHecho(r, datos, p.porStaffId))) {
      // Otro la terminó primero: lo suyo.
      const hoy = await prisma.envioRetenidoDeCampo.findFirst({ where: { id, organizationId } })
      return { estado: 'APLICADO' as const, resultado: hoy?.resultado, repetida: true, ...extra }
    }
    bitacora(r, 'CAMPO_RETENIDO_APLICADO', recuperado ? { recuperado: true, ...(extra.yaEstabaHecho && { alDescartar: true }) } : {})
    return { estado: 'APLICADO' as const, resultado, repetida: false, ...extra }
  }

  // I1: lo que pasó manda, antes de descartar, de ejecutar o de contestar «ya se descartó». Recuperar no pide asignación.
  const ya = await efectoYaHecho(tipo, ctx, cuerpo, r.createdAt)
  if (ya.hecho) return marcarAplicado(comoJson(ya.resultado), true, p.accion === 'DESCARTAR' ? { yaEstabaHecho: true } : {})
  if (r.estado === 'DESCARTADO') {
    if (p.accion === 'DESCARTAR') return { estado: 'DESCARTADO', repetida: true }
    throw new ConflictError('Este envío ya se descartó.', 'YA_RESUELTO')
  }

  if (p.accion === 'DESCARTAR') {
    // Sin dueño y sin efecto: no se descarta, «Aplicar» la termina. Una PENDIENTE con la venta a medias, igual (I1).
    if (r.estado === 'APLICANDO') throw aMediasError()
    if (estaAMedias(ya)) {
      await aMediasSinDueno(id)
      throw aMediasError()
    }
    const { count } = await prisma.envioRetenidoDeCampo.updateMany({
      where: { id, organizationId, estado: 'PENDIENTE', ...alcance },
      data: { estado: 'DESCARTADO', resueltoAt: new Date(), resueltoPor: p.porStaffId, nota: p.nota ?? null },
    })
    if (count === 0) {
      const otra = await segunComoQuedo(p)
      // Un «Aplicar» simultáneo lo regresó a PENDIENTE entre el CAS y la relectura: nunca se contesta la fila cruda.
      if ('organizationId' in otra) throw enProceso()
      return otra
    }
    bitacora(r, 'CAMPO_RETENIDO_DESCARTADO')
    return { estado: 'DESCARTADO', repetida: false }
  }

  // APLICAR. Antes de ejecutar (R3-5, A6): la sucursal sigue siendo de la organización y la persona está asignada ahí.
  const venue = await prisma.venue.findUnique({ where: { id: r.venueId }, select: { organizationId: true } })
  if (venue?.organizationId !== organizationId) throw noSePudo({ motivo: 'OTRA_ORGANIZACION' })
  const asignada = (await sucursalesDeLaPersona(r.staffId, organizationId)).some(s => s.venueId === r.venueId)
  if (!asignada) {
    // S10: el porqué queda en la fila, así «Por revisar» lo dice aunque se recargue. Sin tocar su updatedAt (I2: no la toma).
    const rechazo = {
      code: 'PERSONA_SIN_ASIGNACION',
      message: 'La persona ya no tiene asignación activa en esa sucursal: reactívala en esa sucursal o descártalo.',
    }
    await prisma.envioRetenidoDeCampo.updateMany({
      where: { id, organizationId, estado: r.estado, updatedAt: r.updatedAt },
      data: { rechazo, updatedAt: r.updatedAt },
    })
    throw noSePudo({ motivo: 'PERSONA_SIN_ASIGNACION', rechazo })
  }

  const marca = await tomar(id, { organizationId, ...alcance })
  if (!marca) {
    const otra = await segunComoQuedo(p)
    if (!('organizationId' in otra)) return otra
    // Cambió entre la lectura y el CAS y no quedó resuelto: nunca se aplica sin haberlo tomado.
    throw enProceso()
  }

  // Desde aquí ya no se descarta. A nombre de la persona y de SU celular, sin revisar sus permisos (lo autoriza el
  // supervisor), con todas las reglas de los servicios. Lo reintentable se lanza y la fila queda APLICANDO, soltada.
  let res: ResultadoDelEnvio
  try {
    res = await aplicarEnvio(ctx, tipo, cuerpo)
  } catch (error) {
    await soltar(id, marca)
    throw error
  }
  if (res.tipo === 'APLICADO') return marcarAplicado(comoJson(res.body), false)
  if (aceptadaEnParte(r.tipo, res)) return marcarAplicado(comoJson(res.rechazo.detalle), false)
  // I1: el rechazo de CUALQUIER intento no se cree a ciegas.
  const despues = await efectoYaHecho(tipo, ctx, cuerpo, r.createdAt)
  if (despues.hecho) return marcarAplicado(comoJson(despues.resultado), true)
  const rechazo = comoJson(res.rechazo)
  if (estaAMedias(despues)) {
    // U2: la venta quedó a medias: sigue APLICANDO (no se descarta) con su rechazo, soltada; tocar «Aplicar» otra vez la termina.
    await soltar(id, marca, { rechazo })
    throw noSePudo({ rechazo, aMedias: true })
  }

  // I3: rechazo definitivo sin efecto: vuelve a PENDIENTE, sólo si sigue siendo suya.
  const vuelta = await prisma.envioRetenidoDeCampo.updateMany({ where: deQuienLaTomo(id, marca), data: { estado: 'PENDIENTE', rechazo } })
  if (vuelta.count === 0) {
    // Otro ya la resolvió (p. ej. APLICADO) o la retomó tras la ventana: se contesta eso, no un falso 422.
    const otra = await segunComoQuedo(p)
    if (!('organizationId' in otra)) return otra
  }
  throw noSePudo({ rechazo })
}
