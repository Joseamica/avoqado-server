/**
 * C2 · Ficha editable (plan 2026-11-06): los datos del negocio y sus personas, cambiados desde la ficha (o por el MCP del
 * superadmin) sin pisar nunca lo que otra persona cambió mientras se veía.
 *
 * El orden es el mismo en cada escritor (pasada de la familia tras Codex r2, §c): (1) el candado de la fila
 * (`lockEditableTx`: 404 si no la ve, 403 si la ve y no la edita); (2) «¿ya está hecho esto mismo?» → éxito sin escribir,
 * sin evento, sin ActivityLog y sin toque; (3) comparar `vio` (lo que la pantalla enseñaba) con lo guardado → 409
 * `CRM_CAMBIO_AL_EDITAR` con `ahora`; (4) escribir. Ningún evento ni ActivityLog lleva datos de personas.
 */
import { Prisma } from '@prisma/client'
import { ConflictError } from '../../errors/AppError'
import { canonicalPhoneE164 } from '../../utils/phone'
import prisma from '../../utils/prismaClient'
import { logAction } from '../dashboard/activity-log.service'
import { normalizeEmail } from '../marketing/emailSuppression.service'
import type { CrmAccess } from './access.service'
import { findDuplicates, lockEditableTx, touchNoEarlierTx } from './accounts.service'
import { escribirConsentimientoDelEquipoTx } from './consent.service'
import { cambioAlEditar, mismoTexto } from './loQueSeVio'
import { addEvent } from './timeline.service'

// ── Datos del negocio ─────────────────────────────────────────────────────────────────────────────────────────────────

export const CAMPOS_DEL_NEGOCIO = ['name', 'giro', 'ventasRango', 'sucursales', 'modulos', 'referidoPor'] as const
export type CampoDelNegocio = (typeof CAMPOS_DEL_NEGOCIO)[number]
export type DatosDelNegocio = {
  name: string
  giro: string | null
  ventasRango: string | null
  sucursales: number | null
  modulos: string[]
  referidoPor: string | null
}

/** Los que califican: cambiarlos fija `qualifiedAt` (una entrada vieja de la landing ya no los pisa) y son los únicos con valores en la Historia. */
const CALIFICAN: ReadonlySet<CampoDelNegocio> = new Set(['giro', 'ventasRango', 'sucursales', 'modulos'])

/** Una lista como se guarda: recortada, sin vacíos ni repetidos, en el mismo orden. */
export const listaLimpia = (lista?: readonly string[] | null): string[] => [
  ...new Set((lista ?? []).map(item => item.trim()).filter(Boolean)),
]

const textoOnull = (valor?: string | null) => (valor ?? '').trim() || null

/** El valor como se guarda. */
function limpio(campo: CampoDelNegocio, valor: unknown): unknown {
  if (campo === 'modulos') return listaLimpia(valor as string[] | null)
  if (campo === 'sucursales') return valor ?? null
  if (campo === 'name') return (valor as string).trim()
  return textoOnull(valor as string | null)
}

function igual(campo: CampoDelNegocio, a: unknown, b: unknown): boolean {
  if (campo === 'modulos') {
    const [x, y] = [listaLimpia(a as string[] | null), listaLimpia(b as string[] | null)]
    return x.length === y.length && x.every((item, i) => item === y[i])
  }
  if (campo === 'sucursales') return (a ?? null) === (b ?? null)
  return mismoTexto(a as string | null, b as string | null)
}

/**
 * Cambia los datos del negocio (nombre, giro, ventas, sucursales, módulos, «Lo recomendó»). Sólo se comparan con `vio` los
 * campos que de verdad cambian; pedir lo que ya está guardado es un no-op (`cambiados: []`) aunque `vio` sea viejo.
 */
export async function updateAccount(
  access: CrmAccess,
  accountId: string,
  input: { cambios: Partial<DatosDelNegocio>; vio: Partial<DatosDelNegocio> },
): Promise<{ accountId: string; cambiados: CampoDelNegocio[] }> {
  const now = new Date()
  const { cambiados, organizationId } = await prisma.$transaction(async tx => {
    await lockEditableTx(tx, access, accountId)
    const guardado = await tx.crmAccount.findUniqueOrThrow({
      where: { id: accountId },
      select: { name: true, giro: true, ventasRango: true, sucursales: true, modulos: true, referidoPor: true, organizationId: true },
    })
    const cambiados = CAMPOS_DEL_NEGOCIO.filter(campo => campo in input.cambios && !igual(campo, input.cambios[campo], guardado[campo]))
    if (!cambiados.length) return { cambiados, organizationId: guardado.organizationId }

    const viejos = cambiados.filter(campo => !igual(campo, input.vio[campo], guardado[campo]))
    if (viejos.length) throw cambioAlEditar(Object.fromEntries(viejos.map(campo => [campo, guardado[campo]])))

    const data: Prisma.CrmAccountUpdateInput = Object.fromEntries(cambiados.map(campo => [campo, limpio(campo, input.cambios[campo])]))
    // Como el alta a mano y la landing: una calificación nueva gana a una entrada vieja reparada tarde (ruling 65 e).
    if (cambiados.some(campo => CALIFICAN.has(campo))) Object.assign(data, { qualifiedAt: now, qualificationAvailable: true })
    await touchNoEarlierTx(tx, accountId, now)
    await tx.crmAccount.update({ where: { id: accountId }, data, select: { id: true } })
    for (const campo of cambiados) {
      // El nombre del negocio y «Lo recomendó» pueden ser nombres de personas: la Historia sólo dice que cambiaron (Duda 1).
      const valores = CALIFICAN.has(campo)
        ? { de: guardado[campo] as Prisma.InputJsonValue | null, a: limpio(campo, input.cambios[campo]) as Prisma.InputJsonValue | null }
        : {}
      await addEvent(tx, { accountId, kind: 'ACCOUNT_EDIT', actorStaffId: access.staffId, data: { campo, ...valores } })
    }
    return { cambiados, organizationId: guardado.organizationId }
  })
  if (cambiados.length) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId,
      action: 'CRM_ACCOUNT_UPDATED',
      entity: 'CrmAccount',
      entityId: accountId,
      data: { campos: cambiados },
    })
  }
  return { accountId, cambiados }
}

// ── Personas ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Una persona tal como la enseña la ficha: lo que viaja en `vio` y en `ahora`. */
export interface PersonaVista {
  name: string
  phoneE164: string | null
  email: string | null
  role: string | null
  isPrimary: boolean
}

const PERSONA_SELECT = { id: true, name: true, phoneE164: true, email: true, role: true, isPrimary: true } as const

const vista = ({ name, phoneE164, email, role, isPrimary }: PersonaVista): PersonaVista => ({ name, phoneE164, email, role, isPrimary })
const correo = (email?: string | null) => (email?.trim() ? normalizeEmail(email) : null)
const telefono = (phone?: string | null) => (phone?.trim() ? canonicalPhoneE164(phone) : null)

/** ¿Este correo ya tiene su fila de permiso? */
async function tienePermisoTx(tx: Prisma.TransactionClient, email: string | null): Promise<boolean> {
  if (!email) return false
  return !!(await tx.crmEmailConsent.findUnique({ where: { email }, select: { id: true } }))
}

/** Otra persona de ESTE negocio con ese correo o ese teléfono (nunca dos en una cuenta, ruling 65 b). */
async function personaDelNegocioTx(
  tx: Prisma.TransactionClient,
  accountId: string,
  datos: { email: string | null; phoneE164: string | null },
  exceptoId?: string,
) {
  const por: Prisma.CrmContactWhereInput[] = []
  if (datos.email) por.push({ email: { equals: datos.email, mode: 'insensitive' } })
  if (datos.phoneE164) por.push({ phoneE164: datos.phoneE164 })
  if (!por.length) return null
  return tx.crmContact.findFirst({
    where: { accountId, OR: por, ...(exceptoId ? { id: { not: exceptoId } } : {}) },
    select: { id: true },
  })
}

/** Las dos reglas de duplicados, sólo para el correo o teléfono que se escribe: del mismo negocio, y de otro. */
async function revisarDuplicadosTx(
  tx: Prisma.TransactionClient,
  access: CrmAccess,
  accountId: string,
  datos: { email: string | null; phoneE164: string | null },
  opts: { esOtroNegocio?: boolean; exceptoId?: string },
) {
  const misma = await personaDelNegocioTx(tx, accountId, datos, opts.exceptoId)
  if (misma) throw new ConflictError('Esa persona ya está en este negocio', 'CRM_PERSONA_YA_ESTA', { contactId: misma.id })
  if (opts.esOtroNegocio || (!datos.email && !datos.phoneE164)) return
  const duplicates = await findDuplicates(access, { phone: datos.phoneE164, email: datos.email }, { exceptAccountId: accountId })
  if (duplicates.length) throw new ConflictError('Ya hay un negocio con ese teléfono o correo', 'CRM_POSIBLE_DUPLICADO', { duplicates })
}

/** La casilla «Aceptó recibir correos»: sólo para ESE correo, sin pisar uno que ya había (ni uno eliminado por D7). */
async function casillaTx(tx: Prisma.TransactionClient, access: CrmAccess, accountId: string, email: string, at: Date) {
  return escribirConsentimientoDelEquipoTx(tx, { emails: [email], accountId, source: 'MANUAL', staffId: access.staffId, at })
}

function registrarPermiso(access: CrmAccess, accountId: string, organizationId: string | null, personas: number) {
  if (personas <= 0) return
  void logAction({
    staffId: access.staffId,
    venueId: null,
    organizationId,
    action: 'CRM_EMAIL_CONSENT_RECORDED',
    entity: 'CrmAccount',
    entityId: accountId,
    data: { source: 'MANUAL', personas },
  })
}

const organizacionTx = async (tx: Prisma.TransactionClient, accountId: string) =>
  (await tx.crmAccount.findUniqueOrThrow({ where: { id: accountId }, select: { organizationId: true } })).organizationId

export interface AgregarPersonaInput {
  name: string
  phone?: string | null
  email?: string | null
  role?: string | null
  isPrimary?: boolean
  aceptaCorreos?: boolean
  esOtroNegocio?: boolean
  /** Llave opaca (UUID) por CONTENIDO, como Stripe: el reintento del mismo contenido la reusa; otro contenido, otra llave. */
  clientRequestId: string
}

/**
 * «+ Agregar persona». Una llave ya usada se compara con lo que esa llave creó, leído HOY: igual → éxito `repetido` sin
 * escribir; distinto → 409 `CRM_LLAVE_CON_OTRO_CONTENIDO`; lo creado ya no está → 409 `CRM_LLAVE_YA_NO_ESTA`. Una llave
 * nueva nunca mira altas viejas: agregar → quitar → agregar el mismo correo crea otra vez.
 */
export async function addContact(
  access: CrmAccess,
  accountId: string,
  input: AgregarPersonaInput,
): Promise<{ contactId: string; permisoDelCorreo: boolean; consentimientoRegistrado: boolean; repetido: boolean }> {
  const now = new Date()
  const pedido = {
    name: input.name.trim(),
    phoneE164: telefono(input.phone),
    email: correo(input.email),
    role: (input.role ?? '').trim() || null,
  }
  const casilla = input.aceptaCorreos === true && !!pedido.email
  const sourceKey = `contacto:${accountId}:${input.clientRequestId}`

  const r = await prisma.$transaction(async tx => {
    await lockEditableTx(tx, access, accountId)

    const previo = await tx.crmTimelineEvent.findUnique({ where: { sourceKey }, select: { data: true } })
    if (previo) {
      const data = (previo.data ?? {}) as { contactId?: string; casilla?: boolean; consentimiento?: boolean }
      const hoy = data.contactId
        ? await tx.crmContact.findFirst({ where: { id: data.contactId, accountId }, select: PERSONA_SELECT })
        : null
      if (!hoy) throw new ConflictError('Lo que guardaste con este intento ya no está: alguien lo quitó', 'CRM_LLAVE_YA_NO_ESTA')
      const permiso = await tienePermisoTx(tx, hoy.email)
      const mismo =
        mismoTexto(hoy.name, pedido.name) &&
        hoy.phoneE164 === pedido.phoneE164 &&
        hoy.email === pedido.email &&
        mismoTexto(hoy.role, pedido.role) &&
        (input.isPrimary !== true || hoy.isPrimary) &&
        (data.casilla ?? false) === casilla &&
        // Con la casilla, el permiso sigue ahí — salvo que no se pudo escribir (correo eliminado por D7).
        (!casilla || permiso || data.consentimiento === false)
      if (!mismo) {
        throw new ConflictError('Ese intento guardó otra cosa: revisa y guarda otra vez', 'CRM_LLAVE_CON_OTRO_CONTENIDO', {
          ahora: vista(hoy),
        })
      }
      return { contactId: hoy.id, permiso, escritas: 0, repetido: true, organizationId: null }
    }

    await revisarDuplicadosTx(tx, access, accountId, pedido, { esOtroNegocio: input.esOtroNegocio })
    const hayOtras = (await tx.crmContact.count({ where: { accountId } })) > 0
    const principal = input.isPrimary === true || !hayOtras
    if (principal && hayOtras) await tx.crmContact.updateMany({ where: { accountId, isPrimary: true }, data: { isPrimary: false } })
    const { id: contactId } = await tx.crmContact.create({
      data: { accountId, ...pedido, isPrimary: principal },
      select: { id: true },
    })
    const escritas = casilla ? await casillaTx(tx, access, accountId, pedido.email!, now) : 0
    const permiso = await tienePermisoTx(tx, pedido.email)
    await touchNoEarlierTx(tx, accountId, now)
    await addEvent(tx, {
      accountId,
      kind: 'CONTACT_ADDED',
      actorStaffId: access.staffId,
      sourceKey,
      data: { contactId, principal, casilla, consentimiento: casilla && permiso },
    })
    return { contactId, permiso, escritas, repetido: false, organizationId: await organizacionTx(tx, accountId) }
  })

  if (!r.repetido) {
    void logAction({
      staffId: access.staffId,
      venueId: null,
      organizationId: r.organizationId,
      action: 'CRM_CONTACT_ADDED',
      entity: 'CrmContact',
      entityId: r.contactId,
      data: {
        accountId,
        contactId: r.contactId,
        campos: Object.keys(pedido).filter(k => pedido[k as keyof typeof pedido] !== null),
        consentimiento: casilla,
      },
    })
    registrarPermiso(access, accountId, r.organizationId, r.escritas)
  }
  return { contactId: r.contactId, permisoDelCorreo: r.permiso, consentimientoRegistrado: r.escritas > 0, repetido: r.repetido }
}
