/**
 * S7 (tienda híbrida, P2-1): cómo ENTRA la clienta con la sesión única de S6.
 *
 * - La ficha es `Customer`, una por negocio. Se encuentra por el contacto que se acaba de PROBAR (teléfono canónico o correo), nunca
 *   por el `Consumer` ligado: ese vínculo no prueba el contacto de hoy y S6 rechazaría la sesión.
 * - Sin ficha, la tienda pregunta «¿ya eres cliente?»: el contacto probado viaja como `pruebaPendiente` (JWT de 15 min). Si dice que
 *   sí, prueba su otro contacto y el primero se liga a ESA ficha (`ligarContacto`): llena un campo vacío, nunca pisa uno lleno y nunca
 *   junta dos fichas; si el contacto es de otra, avisa con el contacto tapado (`otraFicha`).
 * - Una sesión sólo lleva contactos que su ficha tiene (contrato S6): el que se rechazó no entra al token.
 */
import jwt from 'jsonwebtoken'
import { Prisma, type Customer, type PrismaClient } from '@prisma/client'
import { withDeadlockRetry, type TxConReintento } from '@/utils/serializableRetry'
import { BadRequestError, ConflictError, UnauthorizedError } from '@/errors/AppError'
import { generateCustomerSession, type ContactoProbado } from '@/jwt.service'
import { normalizeEmail } from '@/lib/otp'
import logger from '@/config/logger'
import { phonesMatch, phoneLast10, normalizarTelefonoMx, formaLegadaDeTelefonoMx } from '@/utils/phone'
import { ponerNombreSiFalta, splitName } from '@/services/customer/customerName'
import { enmascararDestino } from '@/services/giftCards/giftCardEntrega'

type Db = PrismaClient | Prisma.TransactionClient
type Llave = { phone?: string; email?: string }

export type AvisoDeFicha = 'FICHA_CON_OTRO_TELEFONO' | 'FICHA_CON_OTRO_CORREO'
export interface OtraFicha {
  contacto: 'PHONE' | 'EMAIL'
  enmascarado: string
}
/** La respuesta de toda entrada (OTP, Google, ficha nueva): la usan S8 y W2. */
export interface SesionEmitida {
  token: string
  customer: { id: string; firstName: string | null; lastName: string | null; email: string | null; phone: string | null }
  contactos: ContactoProbado[]
  avisos?: AvisoDeFicha[]
  otraFicha?: OtraFicha | null
}
export interface FichaNueva {
  fichaNueva: true
  pruebaPendiente: string
}
export interface OpcionesDeEntrada {
  alNoEncontrar?: 'PREGUNTAR'
  /** El contacto ya probado de la PRIMERA prueba (`vincular`), verificado antes de abrir la transacción. */
  vinculo?: ContactoProbado | null
  firstName?: string | null
}
export type Entrada =
  | { nueva: true }
  | { nueva: false; ficha: Customer; contactos: ContactoProbado[]; avisos: AvisoDeFicha[]; otraFicha: OtraFicha | null }

// ---- Prueba pendiente ----

const TIPO_DE_PRUEBA = 'customer_contact_proof'
const QUINCE_MINUTOS = 15 * 60
const METODOS: Record<ContactoProbado['tipo'], ContactoProbado['metodo'][]> = {
  PHONE: ['WHATSAPP'],
  EMAIL: ['EMAIL_CODE', 'GOOGLE'],
}

function pruebaInvalida(): BadRequestError {
  return new BadRequestError('Tu verificación ya no sirve. Pide un código nuevo.', 'CUSTOMER_PROOF_INVALID')
}

/** La forma en que se guarda un contacto probado: la misma que da el reto (`destinoDelReto`). */
function contactoNormalizado(c: ContactoProbado): string {
  return c.tipo === 'PHONE' ? normalizarTelefonoMx(c.valor) : normalizeEmail(c.valor)
}

export function firmarPruebaPendiente(venueId: string, contacto: ContactoProbado): string {
  return jwt.sign({ type: TIPO_DE_PRUEBA, venueId, contacto }, process.env.ACCESS_TOKEN_SECRET!, {
    expiresIn: QUINCE_MINUTOS,
    algorithm: 'HS256',
  })
}

/**
 * La prueba acredita SÓLO el contacto que lleva firmado, en el negocio de la URL. Vencida, de otro negocio, de otro tipo (una sesión,
 * un id en claro) o con un contacto mal formado: 400. No se guarda en ningún lado: el reto OTP ya fue de un solo uso.
 */
export function verificarPruebaPendiente(token: string, venueId: string): ContactoProbado {
  let p: jwt.JwtPayload | string
  try {
    p = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!, { algorithms: ['HS256'] })
  } catch {
    throw pruebaInvalida()
  }
  const c = typeof p === 'string' ? null : (p.contacto as ContactoProbado | undefined)
  if (
    typeof p === 'string' ||
    p.type !== TIPO_DE_PRUEBA ||
    p.venueId !== venueId ||
    !Number.isFinite(p.exp) ||
    !c ||
    (c.tipo !== 'PHONE' && c.tipo !== 'EMAIL') ||
    typeof c.valor !== 'string' ||
    !c.valor ||
    contactoNormalizado(c) !== c.valor ||
    !METODOS[c.tipo].includes(c.metodo) ||
    !Number.isFinite(c.probadoEn) ||
    c.probadoEn < 0
  ) {
    throw pruebaInvalida()
  }
  return { tipo: c.tipo, valor: c.valor, metodo: c.metodo, probadoEn: c.probadoEn }
}

// ---- Encontrar la ficha ----

const llaveDe = (c: ContactoProbado): Llave => (c.tipo === 'PHONE' ? { phone: c.valor } : { email: c.valor })

function mismoValor(c: ContactoProbado, guardado: string | null | undefined): boolean {
  if (!guardado) return false
  return c.tipo === 'PHONE' ? phonesMatch(c.valor, guardado) : guardado.trim().toLowerCase() === c.valor
}

/**
 * La ficha de ESTE negocio con ese contacto: exacto primero (el índice único), luego el teléfono guardado en otro formato
 * (`findCustomerIdByPhone`, misma consulta) o el correo sin distinguir mayúsculas. `excepto` busca la de OTRA ficha.
 */
export async function fichaConContacto(
  db: Db,
  venueId: string,
  c: ContactoProbado,
  excepto?: string,
  soloActivas = false,
): Promise<Customer | null> {
  // `soloActivas` (codex-s7-r2): una ficha desactivada no puede tapar a otra activa con el mismo contacto en otro formato.
  const otra = { ...(excepto ? { id: { not: excepto } } : {}), ...(soloActivas ? { active: true } : {}) }
  if (c.tipo === 'EMAIL') {
    // R6 (codex-s7-r1 #4): la coincidencia EXACTA gana; sólo sin ella, la misma dirección con otras mayúsculas (la más antigua).
    return (
      (await db.customer.findFirst({ where: { venueId, ...otra, email: c.valor } })) ??
      db.customer.findFirst({
        where: { venueId, ...otra, email: { equals: c.valor, mode: 'insensitive' } },
        orderBy: { createdAt: 'asc' },
      })
    )
  }
  const exacta = await db.customer.findFirst({ where: { venueId, ...otra, phone: c.valor } })
  if (exacta) return exacta
  const last10 = phoneLast10(c.valor)
  if (!last10) return null
  const candidatos = await db.$queryRaw<{ id: string; phone: string | null }[]>`
    SELECT "id", "phone"
    FROM "Customer"
    WHERE "venueId" = ${venueId}
      AND "id" <> ${excepto ?? ''}
      AND (${!soloActivas} OR "active" = true)
      AND "phone" IS NOT NULL
      AND right(regexp_replace("phone", '[^0-9]', '', 'g'), 10) = ${last10}
    ORDER BY "createdAt" ASC
    LIMIT 20
  `
  const elegido = candidatos.find(k => phonesMatch(k.phone, c.valor))
  return elegido ? db.customer.findUnique({ where: { id: elegido.id } }) : null
}

/** Se tapa el contacto que la clienta PROBÓ (no cómo lo guarda la otra ficha): no se le enseña nada de una ficha ajena. */
function tapar(c: ContactoProbado): OtraFicha {
  const enmascarado =
    c.tipo === 'PHONE'
      ? enmascararDestino({ deliveryChannel: 'WHATSAPP', recipientPhone: c.valor, recipientEmail: null })
      : enmascararDestino({ deliveryChannel: 'EMAIL', recipientPhone: null, recipientEmail: c.valor })
  return { contacto: c.tipo, enmascarado: enmascarado ?? '•••' }
}

/** La primera OTRA ficha activa del negocio que tiene uno de esos contactos probados, tapada. */
export async function otraFichaDe(db: Db, venueId: string, customerId: string, contactos: ContactoProbado[]): Promise<OtraFicha | null> {
  for (const c of contactos) {
    if (await fichaConContacto(db, venueId, c, customerId, true)) return tapar(c)
  }
  return null
}

// ---- Crear la ficha como hoy ----

/** El Consumer (identidad global) de ese contacto, o uno nuevo. Mismo orden y mismas formas que el OTP de hoy. */
export async function consumerDelContacto(tx: Prisma.TransactionClient, key: Llave) {
  if (key.phone) {
    // Un cliente que entró con el OTP viejo tiene su Consumer SIN lada (`+5543453965`). Se busca también esa forma para no
    // crearle un segundo Consumer; si existen las dos, gana la más antigua (lo mismo que ya pasaba con dos del mismo teléfono).
    const legado = formaLegadaDeTelefonoMx(key.phone)
    const matches = await tx.consumer.findMany({
      where: { phone: legado ? { in: [key.phone, legado] } : key.phone },
      orderBy: { createdAt: 'asc' },
      take: 2,
    })
    if (matches.length > 1) logger.warn(`[OTP] multiple Consumers share phone ${key.phone}; using oldest ${matches[0].id}`)
    return matches[0] ?? (await tx.consumer.create({ data: { phone: key.phone } }))
  }
  return (await tx.consumer.findFirst({ where: { email: key.email } })) ?? (await tx.consumer.create({ data: { email: key.email } }))
}

// Look up a name from this identity's most recent past guest reservation, so a
// returning guest who booked without ever registering doesn't land on a blank
// "Hola" after their first WhatsApp login. Matching is canonical (phonesMatch)
// for phone; exact for email. Bounded to the venue + a small recent window.
async function findGuestNameFromPastReservations(
  tx: Prisma.TransactionClient,
  venueId: string,
  key: Llave,
): Promise<{ firstName?: string; lastName?: string }> {
  if (key.email) {
    const r = await tx.reservation.findFirst({
      where: { venueId, guestEmail: key.email, guestName: { not: null } },
      orderBy: { createdAt: 'desc' },
      select: { guestName: true },
    })
    return splitName(r?.guestName)
  }
  if (key.phone) {
    const last10 = phoneLast10(key.phone)
    if (!last10) return {}
    // Coarse prefilter by trailing 10 digits, normalizing the STORED column in
    // SQL (strip non-digits, take last 10) so guest-typed formatting
    // ("55 9999 0001") still matches — a Prisma `endsWith` compares the raw
    // string and would miss it. phonesMatch below is the canonical verify.
    const candidates = await tx.$queryRaw<{ guestName: string | null; guestPhone: string | null }[]>`
      SELECT "guestName", "guestPhone"
      FROM "Reservation"
      WHERE "venueId" = ${venueId}
        AND "guestName" IS NOT NULL
        AND right(regexp_replace("guestPhone", '[^0-9]', '', 'g'), 10) = ${last10}
      ORDER BY "createdAt" DESC
      LIMIT 20
    `
    const match = candidates.find(c => phonesMatch(c.guestPhone, key.phone))
    return splitName(match?.guestName)
  }
  return {}
}

/** La ficha nueva de hoy: el contacto, el Consumer y, si existe, el nombre de su última reserva de invitada. */
export async function crearFichaConConsumer(tx: TxConReintento, venueId: string, consumerId: string, key: Llave): Promise<Customer> {
  const seededName = await findGuestNameFromPastReservations(tx, venueId, key)
  return tx.customer.create({
    data: {
      venueId,
      consumerId,
      provider: 'PHONE',
      ...(key.phone ? { phone: key.phone } : { email: key.email }),
      ...(seededName.firstName ? { firstName: seededName.firstName } : {}),
      ...(seededName.lastName ? { lastName: seededName.lastName } : {}),
    },
  })
}

// ---- Ligar un contacto probado a una ficha ----

/**
 * Agrega a `ficha` un contacto que la clienta acaba de probar. Campo vacío ⇒ lo llena (CAS sobre el campo vacío, así una petición
 * que lo llenó entre la lectura y la escritura no se pisa) y deja `CUSTOMER_CONTACT_LINKED`. Con otro valor ⇒ no lo pisa: aviso.
 * Si el contacto ya es de OTRA ficha ⇒ no mueve nada: `otraFicha`. Si el índice único choca a la vez, Postgres aborta la Tx entera:
 * quien abrió la Tx la repite (`repetirSiChoca`) y esta búsqueda ve a la ganadora.
 */
export async function ligarContacto(
  tx: TxConReintento,
  venueId: string,
  ficha: Customer,
  c: ContactoProbado,
): Promise<{ ficha: Customer; ligado: boolean; aviso?: AvisoDeFicha; otraFicha?: OtraFicha }> {
  const campo = c.tipo === 'PHONE' ? 'phone' : 'email'
  const aviso: AvisoDeFicha = c.tipo === 'PHONE' ? 'FICHA_CON_OTRO_TELEFONO' : 'FICHA_CON_OTRO_CORREO'
  if (mismoValor(c, ficha[campo])) return { ficha, ligado: true }

  const duena = await fichaConContacto(tx, venueId, c, ficha.id)
  if (duena) {
    return { ficha, ligado: false, ...(ficha[campo] ? { aviso } : {}), ...(duena.active !== false ? { otraFicha: tapar(c) } : {}) }
  }
  if (ficha[campo]) return { ficha, ligado: false, aviso }

  const escrito = await tx.customer.updateMany({
    where: { id: ficha.id, venueId, OR: [{ [campo]: null }, { [campo]: '' }] },
    data: { [campo]: c.valor },
  })
  const releida = await tx.customer.findUniqueOrThrow({ where: { id: ficha.id } })
  if (escrito.count === 1) {
    await tx.activityLog.create({
      data: {
        action: 'CUSTOMER_CONTACT_LINKED',
        entity: 'Customer',
        entityId: ficha.id,
        venueId,
        data: { contacto: c.tipo, metodo: c.metodo, valor: c.valor },
      },
    })
    return { ficha: releida, ligado: true }
  }
  return mismoValor(c, releida[campo]) ? { ficha: releida, ligado: true } : { ficha: releida, ligado: false, aviso }
}

// ---- Entrar ----

/**
 * codex-s7-r1 #1: la ficha que se encontró por el contacto queda con candado de fila hasta el commit (el panel que la edite espera)
 * y se relee: lo que esta entrada escriba (ligar un contacto, el nombre) y la sesión que firme corresponden a ESTA versión.
 */
async function bloquearFicha(tx: TxConReintento, venueId: string, id: string): Promise<Customer> {
  await tx.$queryRaw`SELECT "id" FROM "Customer" WHERE "id" = ${id} AND "venueId" = ${venueId} FOR NO KEY UPDATE`
  return tx.customer.findUniqueOrThrow({ where: { id } })
}

/**
 * El cuerpo común de toda entrada, DENTRO de la Tx de quien la abre (el reto OTP se consume en esa misma Tx). Sin ficha y con
 * «¿ya eres cliente?», no escribe nada. Sin ficha y sin pregunta, la crea como hoy. Nunca activa reservas (S6 lo hace al reservar).
 */
export async function entrarConContacto(
  tx: TxConReintento,
  venueId: string,
  c: ContactoProbado,
  opciones: OpcionesDeEntrada,
): Promise<Entrada> {
  const encontrada = await fichaConContacto(tx, venueId, c)
  let ficha = encontrada && (await bloquearFicha(tx, venueId, encontrada.id))
  // El panel le cambió ese contacto entre la búsqueda y el candado: no se escribe nada ni se firma una sesión que S6 rechazaría.
  // El rollback deja el reto sin consumir: el mismo código sirve al reintentar.
  if (ficha && !mismoValor(c, c.tipo === 'PHONE' ? ficha.phone : ficha.email)) {
    throw new ConflictError('Tus datos cambiaron mientras entrabas. Intenta otra vez.', 'CUSTOMER_CONTACT_CHANGED')
  }
  const creada = !ficha
  if (!ficha) {
    if (opciones.alNoEncontrar === 'PREGUNTAR') return { nueva: true }
    const consumer = await consumerDelContacto(tx, llaveDe(c))
    ficha = await crearFichaConConsumer(tx, venueId, consumer.id, llaveDe(c))
  } else if (ficha.active === false) {
    // `=== false`, como el OTP de hoy: un registro sin el campo no se vuelve inactivo. El rollback deja el reto sin consumir.
    throw new UnauthorizedError('Esta cuenta está desactivada', 'CUSTOMER_INACTIVE')
  } else if (!ficha.consumerId) {
    const consumer = await consumerDelContacto(tx, llaveDe(c))
    ficha = await tx.customer.update({ where: { id: ficha.id }, data: { consumerId: consumer.id } })
  }
  ficha = await ponerNombreSiFalta(tx, ficha, opciones.firstName)

  const contactos = [c]
  const avisos: AvisoDeFicha[] = []
  let otraFicha: OtraFicha | null = null
  // R3: el vínculo sólo se aplica a una ficha que YA existía; una ficha recién creada nace con el contacto de hoy.
  const v = opciones.vinculo
  if (v && !creada && !(v.tipo === c.tipo && v.valor === c.valor)) {
    const r = await ligarContacto(tx, venueId, ficha, v)
    ficha = r.ficha
    if (r.ligado) contactos.push(v)
    if (r.aviso) avisos.push(r.aviso)
    otraFicha = r.otraFicha ?? null
    // El vínculo rechazado también avisa si otra ficha ACTIVA lo tiene (aunque quien lo bloqueó fuera una desactivada).
    if (!r.ligado) otraFicha ??= await otraFichaDe(tx, venueId, ficha.id, [v])
  }
  otraFicha ??= await otraFichaDe(tx, venueId, ficha.id, contactos)
  return { nueva: false, ficha, contactos, avisos, otraFicha }
}

/** Después del commit: la sesión firmada (versión de la ficha, sólo contactos que la ficha tiene) o la prueba pendiente. */
export function respuestaDeEntrada(venueId: string, c: ContactoProbado, e: Entrada): SesionEmitida | FichaNueva {
  if (e.nueva) return { fichaNueva: true, pruebaPendiente: firmarPruebaPendiente(venueId, c) }
  const { ficha } = e
  return {
    token: generateCustomerSession({ sub: ficha.id, venueId, v: ficha.versionDeSesion, contactos: e.contactos }),
    customer: { id: ficha.id, firstName: ficha.firstName, lastName: ficha.lastName, email: ficha.email, phone: ficha.phone },
    contactos: e.contactos,
    ...(e.avisos.length ? { avisos: e.avisos } : {}),
    otraFicha: e.otraFicha,
  }
}

/** El modelo cuyo índice único chocó (`Customer` venue + contacto, o `Consumer.email`), o `null` si no es un choque de identidad. */
function choqueDeIdentidad(error: unknown): string | null {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') return null
  const modelo = (error.meta as { modelName?: string } | undefined)?.modelName ?? 'Customer'
  return modelo === 'Customer' || modelo === 'Consumer' ? modelo : null
}

/**
 * R2: el índice único de `Customer` (venue + teléfono o correo) o el de `Consumer.email` choca cuando dos entradas escriben el mismo
 * contacto a la vez; Postgres aborta la Tx entera (no se puede seguir consultando en ella). Se repite UNA vez desde afuera: la búsqueda
 * previa ya ve a la ganadora.
 */
export async function repetirSiChoca<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    const modelo = choqueDeIdentidad(error)
    if (!modelo) throw error
    logger.warn(`[sesionDeCliente] choque del único de ${modelo}: se repite una vez`)
    return fn()
  }
}

/** POST /venues/:venueSlug/auth/session/nueva-ficha: «no, soy nueva». Crea la ficha como hoy con el contacto que se probó. */
export async function crearFichaConPrueba(venueId: string, prueba: string, firstName?: string | null): Promise<SesionEmitida> {
  const contacto = verificarPruebaPendiente(prueba, venueId)
  const entrada = await repetirSiChoca(() =>
    withDeadlockRetry(tx => entrarConContacto(tx, venueId, contacto, { firstName }), { etiqueta: 'crearFichaConPrueba' }),
  )
  return respuestaDeEntrada(venueId, contacto, entrada) as SesionEmitida
}
