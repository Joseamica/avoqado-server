/**
 * La gracia de 24 h y «por revisar» (App de campo, bloque 1, Tarea 7, regla A5/A6).
 *
 * Un celular desvinculado puede seguir subiendo, por `POST /tpv/campo/gracia`, lo que tenía por subir al desvincularse: lo
 * que trae una huella de su último latido, dentro de 24 h, de una persona activa y con permiso, se aplica a su nombre. Lo
 * demás se RETIENE (`EnvioRetenidoDeCampo`) para que un supervisor lo aplique o lo descarte desde el panel.
 *
 * El retenido es una máquina de estados con CAS (`updateMany` condicionado por estado):
 *   PENDIENTE → APLICANDO → APLICADO, o PENDIENTE → DESCARTADO. Desde APLICANDO ya no se descarta: «Aplicar» pudo dejar
 *   efecto y se termina tocando «Aplicar» otra vez (los servicios son idempotentes por su llave o por estado).
 */
import { CelularDeCampo, EnvioRetenidoDeCampo, Prisma } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@/errors/AppError'
import { staffHasPermissionInVenue } from '@/middlewares/checkPermission.middleware'
import { logAction } from '@/services/dashboard/activity-log.service'
import prisma from '@/utils/prismaClient'
import { aplicarEnvio, huellaDelEnvio, permisosDelEnvio, Rechazo, ResultadoDelEnvio, TipoDeEnvio } from './envioDeCampo'
import { sucursalesDeLaPersona } from './personasDeCampo'

const GRACIA_MS = 24 * 60 * 60 * 1000

export type EstadoDelRetenido = 'PENDIENTE' | 'APLICANDO' | 'APLICADO' | 'DESCARTADO'
export type MotivoDeRetencion =
  | 'NO_REPORTADA'
  | 'FUERA_DE_PLAZO'
  | 'PERSONA_DADA_DE_BAJA'
  | 'SIN_PERMISO'
  | 'RECHAZADO'
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

/** Lo que contesta la gracia por un retenido que ya existe (sea cual sea el estado del celular hoy). */
function desenlaceDelRetenido(r: EnvioRetenidoDeCampo): { status: number; body: unknown } {
  if (r.estado === 'APLICADO') return { status: 200, body: { resuelto: 'APLICADO', resultado: r.resultado } }
  if (r.estado === 'DESCARTADO') return { status: 200, body: { resuelto: 'DESCARTADO', nota: r.nota } }
  return { status: 202, body: { retenido: true, motivo: r.motivo, repetida: true } }
}

export async function recibirEnGracia(
  celular: CelularDeCampo,
  e: { tipo: TipoDeEnvio; venueId: string; cuerpoJson: string },
): Promise<{ status: number; body: unknown }> {
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

  // 2. Lo ya retenido contesta su desenlace (R2-6).
  const huella = huellaDelEnvio(e.tipo, e.venueId, e.cuerpoJson)
  const previo = await prisma.envioRetenidoDeCampo.findUnique({ where: { celularId_huella: { celularId: celular.id, huella } } })
  if (previo) return desenlaceDelRetenido(previo)

  // 3. Vinculado y activo: lo suyo va por su sesión.
  const sucursales = await sucursalesDeLaPersona(celular.staffId, celular.organizationId)
  const dadaDeBaja = sucursales.length === 0
  if (celular.staffIdVinculado && !dadaDeBaja) {
    throw new ConflictError('Este celular sigue vinculado: sube con tu sesión.', 'USA_TU_SESION')
  }

  // 4 y 5.
  const motivo = await motivoParaRetener(
    celular,
    e,
    huella,
    dadaDeBaja,
    sucursales.map(s => s.venueId),
  )
  if (motivo) return retener(celular, e, huella, motivo, null)

  const r = await aplicarEnvio(
    { venueId: e.venueId, orgId: celular.organizationId, staffId: celular.staffId, celularId: celular.id },
    e.tipo,
    cuerpo,
  )
  // La custodia aceptada en parte YA tiene efecto: queda APLICADA con las filas fallidas, igual que en «Aplicar».
  if (r.tipo === 'RECHAZADO' && !aceptadaEnParte(e.tipo, r)) return retener(celular, e, huella, 'RECHAZADO', r.rechazo)
  const resultado = r.tipo === 'APLICADO' ? r.body : r.rechazo.detalle
  // Su desenlace queda guardado por huella: un reintento (aun pasadas las 24 h o tras una baja) recibe lo mismo.
  const guardado = await guardar(celular, e, huella, {
    motivo: 'APLICADO_EN_GRACIA',
    estado: 'APLICADO',
    resultado: comoJson(resultado),
    resueltoAt: new Date(),
    ...(r.tipo === 'RECHAZADO' && { rechazo: comoJson(r.rechazo) }),
  })
  if (guardado) return guardado
  void logAction({
    staffId: celular.staffId,
    venueId: e.venueId,
    organizationId: celular.organizationId,
    action: 'CAMPO_GRACIA_APLICADA',
    entity: 'CelularDeCampo',
    entityId: celular.id,
    data: { tipo: e.tipo, huella, celularId: celular.id },
  })
  if (r.tipo === 'RECHAZADO') return { status: 200, body: { resuelto: 'APLICADO', resultado: comoJson(resultado) } }
  return { status: r.status, body: { ...(r.body as object), aplicadoEnGracia: true } }
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

async function retener(
  celular: CelularDeCampo,
  e: { tipo: TipoDeEnvio; venueId: string; cuerpoJson: string },
  huella: string,
  motivo: MotivoDeRetencion,
  rechazo: Rechazo | null,
): Promise<{ status: number; body: unknown }> {
  return (
    (await guardar(celular, e, huella, { motivo, ...(rechazo && { rechazo: comoJson(rechazo) }) })) ?? {
      status: 202,
      body: { retenido: true, motivo },
    }
  )
}

/** Inserta la fila de esta huella; si otra subida con la misma huella le ganó (P2002), devuelve el desenlace de ésa. */
async function guardar(
  celular: CelularDeCampo,
  e: { tipo: TipoDeEnvio; venueId: string; cuerpoJson: string },
  huella: string,
  datos: {
    motivo: MotivoDeRetencion
    rechazo?: Prisma.InputJsonValue
    estado?: 'APLICADO'
    resultado?: Prisma.InputJsonValue
    resueltoAt?: Date
  },
): Promise<{ status: number; body: unknown } | null> {
  try {
    await prisma.envioRetenidoDeCampo.create({
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
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')) throw error
    // Otra subida con la misma huella le ganó: se contesta lo de ésa.
    const previo = await prisma.envioRetenidoDeCampo.findUnique({ where: { celularId_huella: { celularId: celular.id, huella } } })
    if (!previo) throw error
    return desenlaceDelRetenido(previo)
  }
  return null
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

export async function listarRetenidos(
  organizationId: string,
  f: { staffId?: string; venueId?: string; estado?: EstadoDelRetenido | EstadoDelRetenido[]; page: number; pageSize: number },
): Promise<{ items: RetenidoDeCampo[]; total: number }> {
  const estados = f.estado === undefined ? undefined : Array.isArray(f.estado) ? f.estado : [f.estado]
  const where: Prisma.EnvioRetenidoDeCampoWhereInput = {
    organizationId,
    ...(f.staffId && { staffId: f.staffId }),
    ...(f.venueId && { venueId: f.venueId }),
    ...(estados && { estado: { in: estados } }),
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
    }),
    prisma.venue.findMany({
      where: { id: { in: [...new Set(filas.map(x => x.venueId))] } },
      select: { id: true, name: true, timezone: true },
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
async function segunComoQuedo(p: { retenidoId: string; organizationId: string; accion: 'APLICAR' | 'DESCARTAR' }) {
  const r = await prisma.envioRetenidoDeCampo.findFirst({ where: { id: p.retenidoId, organizationId: p.organizationId } })
  if (!r) throw new NotFoundError('No encontramos ese envío.', 'RETENIDO_NO_ENCONTRADO')
  if (r.estado === 'APLICADO') {
    if (p.accion === 'APLICAR') return { estado: 'APLICADO' as const, resultado: r.resultado, repetida: true }
    throw new ConflictError('Este envío ya se aplicó.', 'YA_APLICADO')
  }
  if (r.estado === 'DESCARTADO') {
    if (p.accion === 'DESCARTAR') return { estado: 'DESCARTADO' as const, repetida: true }
    throw new ConflictError('Este envío ya se descartó.', 'YA_RESUELTO')
  }
  if (p.accion === 'DESCARTAR' && r.estado === 'APLICANDO') {
    throw new ConflictError('Aplicar se quedó a medias. Vuelve a tocar Aplicar para terminarla.', 'APLICACION_A_MEDIAS')
  }
  return r // PENDIENTE o APLICANDO: «Aplicar» sigue
}

export async function resolverRetenido(p: {
  retenidoId: string
  organizationId: string
  accion: 'APLICAR' | 'DESCARTAR'
  nota?: string
  porStaffId: string
}): Promise<{ estado: 'APLICADO' | 'DESCARTADO'; resultado?: unknown; repetida: boolean }> {
  const { retenidoId: id, organizationId } = p
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

  if (p.accion === 'DESCARTAR') {
    const { count } = await prisma.envioRetenidoDeCampo.updateMany({
      where: { id, organizationId, estado: 'PENDIENTE' },
      data: { estado: 'DESCARTADO', resueltoAt: new Date(), resueltoPor: p.porStaffId, nota: p.nota ?? null },
    })
    if (count === 0) {
      const ya = await segunComoQuedo(p)
      // Un «Aplicar» simultáneo lo regresó a PENDIENTE entre el CAS y la relectura: nunca se contesta la fila cruda.
      if ('organizationId' in ya) throw enProceso()
      return ya
    }
    const r = await prisma.envioRetenidoDeCampo.findFirst({ where: { id, organizationId } })
    if (r) bitacora(r, 'CAMPO_RETENIDO_DESCARTADO')
    return { estado: 'DESCARTADO', repetida: false }
  }

  // APLICAR
  const leido = await segunComoQuedo(p)
  if (!('organizationId' in leido)) return leido
  const r = leido

  // Antes de tocar nada (R3-5): la sucursal sigue siendo de la organización y la persona está asignada ahí, para TODO tipo.
  const venue = await prisma.venue.findUnique({ where: { id: r.venueId }, select: { organizationId: true } })
  if (venue?.organizationId !== organizationId) throw noSePudo({ motivo: 'OTRA_ORGANIZACION' })
  const asignada = (await sucursalesDeLaPersona(r.staffId, organizationId)).some(s => s.venueId === r.venueId)
  if (!asignada) throw noSePudo({ motivo: 'PERSONA_SIN_ASIGNACION' })

  const { count } = await prisma.envioRetenidoDeCampo.updateMany({
    where: { id, organizationId, estado: { in: ['PENDIENTE', 'APLICANDO'] } },
    data: { estado: 'APLICANDO' },
  })
  if (count === 0) {
    const otra = await segunComoQuedo(p)
    if (!('organizationId' in otra)) return otra
    // Cambió entre la lectura y el CAS y no quedó resuelto: nunca se aplica sin haberlo tomado (APLICANDO).
    throw enProceso()
  }

  // Desde aquí ya no se descarta. A nombre de la persona y de SU celular, sin revisar sus permisos (lo autoriza el
  // supervisor), con todas las reglas de los servicios. Lo reintentable se lanza y deja el retenido en APLICANDO.
  const res = await aplicarEnvio(
    { venueId: r.venueId, orgId: organizationId, staffId: r.staffId, celularId: r.celularId },
    r.tipo as TipoDeEnvio,
    leerJson(r.cuerpoJson),
  )

  if (res.tipo === 'APLICADO' || aceptadaEnParte(r.tipo, res)) {
    const resultado = comoJson(res.tipo === 'APLICADO' ? res.body : res.rechazo.detalle)
    // Lo aplicado gana sobre cualquier otro estado: si otro «Aplicar» simultáneo lo regresó a PENDIENTE (o alguien lo
    // descartó en ese hueco), la fila no puede quedar sin decir que ya tiene efecto.
    await prisma.envioRetenidoDeCampo.updateMany({
      where: { id, estado: { in: ['APLICANDO', 'PENDIENTE', 'DESCARTADO'] } },
      data: {
        estado: 'APLICADO',
        resultado,
        resueltoAt: new Date(),
        resueltoPor: p.porStaffId,
        ...(p.nota !== undefined && { nota: p.nota }),
      },
    })
    bitacora(r, 'CAMPO_RETENIDO_APLICADO')
    return { estado: 'APLICADO', resultado, repetida: false }
  }

  // Rechazo definitivo: no dejó efecto (la venta cancela su cuenta, la checada es una transacción). Vuelve a PENDIENTE.
  const rechazo = comoJson(res.rechazo)
  const vuelta = await prisma.envioRetenidoDeCampo.updateMany({
    where: { id, estado: 'APLICANDO' },
    data: { estado: 'PENDIENTE', rechazo },
  })
  if (vuelta.count === 0) {
    // Otro «Aplicar» simultáneo ya lo resolvió (p. ej. APLICADO): se contesta eso, no un falso 422.
    const otra = await segunComoQuedo(p)
    if (!('organizationId' in otra)) return otra
  }
  throw noSePudo({ rechazo })
}
