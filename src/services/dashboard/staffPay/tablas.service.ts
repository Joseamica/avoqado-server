import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { EfectoDelCambio, efectoDelCambio } from './efecto'
import { dbDateComoFecha, fechaComoDbDate } from './periodos'
import { assertFechaEnRango, assertFechaNoCerrada, hoyDeLaSede, rangoDeVigencia } from './periodosGuardados'
import { MAX_HORAS_REGLA } from './valoracion'

export interface CeldaInput {
  payLevelId: string
  count: number
  amount: number
}

type CountMode = 'BOOKED' | 'ATTENDED'

/** Reglas de clase de una versión (spec fase 3 §6.6). `undefined` = hereda la de la versión que rige; `null` = apagada. */
export interface ReglasInput {
  coverBonusHours?: number | null
  coverBonusAmount?: number | null
  lateCancelHours?: number | null
}
type Reglas = { coverBonusHours: number | null; coverBonusAmount: number | null; lateCancelHours: number | null }

const MAX_TECHO = 500
const MAX_MONTO = 1_000_000
const MAX_BONO = 100_000

const vigenteEn = (fecha: Date) => ({ OR: [{ archivedFrom: null }, { archivedFrom: { gt: fecha } }] })

const esP2002 = (e: unknown) => e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002'

export async function listarTablas(venueId: string, fecha: string) {
  const f = fechaComoDbDate(fecha)
  const tablas = await prisma.servicePayTable.findMany({
    where: { venueId, ...vigenteEn(f) },
    select: {
      id: true,
      name: true,
      productIds: true,
      archivedFrom: true,
      versions: {
        where: { effectiveFrom: { lte: f } },
        orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
        take: 1,
        select: {
          id: true,
          effectiveFrom: true,
          revision: true,
          countMode: true,
          maxCount: true,
          coverBonusHours: true,
          coverBonusAmount: true,
          lateCancelHours: true,
          cells: {
            select: { payLevelId: true, count: true, amount: true },
            orderBy: [{ payLevelId: 'asc' }, { count: 'asc' }],
            take: 50_000,
          },
        },
      },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
  })
  return tablas.map(t => {
    const v = t.versions[0]
    return {
      id: t.id,
      name: t.name,
      productIds: t.productIds,
      archivedFrom: t.archivedFrom ? dbDateComoFecha(t.archivedFrom) : null,
      vigente: v
        ? {
            id: v.id,
            effectiveFrom: dbDateComoFecha(v.effectiveFrom),
            revision: v.revision,
            countMode: v.countMode,
            maxCount: v.maxCount,
            cells: v.cells.map(c => ({ payLevelId: c.payLevelId, count: c.count, amount: Number(c.amount) })),
            // Reglas de clase (spec fase 3 §6.6), pesos 1:1 como las celdas.
            reglas: {
              coverBonusHours: v.coverBonusHours,
              coverBonusAmount: v.coverBonusAmount === null ? null : Number(v.coverBonusAmount),
              lateCancelHours: v.lateCancelHours,
            },
          }
        : null,
    }
  })
}

/** Mismo alcance = las dos son «todas las clases», o comparten algún producto. Específica vs «todas» no empata: gana la específica. */
const mismoAlcance = (productIds: string[]): Prisma.ServicePayTableWhereInput =>
  productIds.length === 0 ? { productIds: { isEmpty: true } } : { productIds: { hasSome: productIds } }

/**
 * Empates (spec §5.3): una tabla aplica en [su primera versión, archivedFrom). Dos tablas del mismo alcance no pueden
 * traslaparse en ese intervalo, o la precedencia de la valoración no tendría un ganador único.
 */
async function assertSinEmpate(
  tx: Prisma.TransactionClient,
  t: { id: string; venueId: string; productIds: string[]; desde: Date | null; hasta: Date | null },
) {
  if (!t.desde || (t.hasta && t.hasta <= t.desde)) return
  const otras = await tx.servicePayTable.findMany({
    where: { venueId: t.venueId, id: { not: t.id }, ...mismoAlcance(t.productIds), ...vigenteEn(t.desde) },
    select: { name: true, archivedFrom: true, versions: { orderBy: { effectiveFrom: 'asc' }, take: 1, select: { effectiveFrom: true } } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    take: 100,
  })
  for (const o of otras) {
    const desdeO = o.versions[0]?.effectiveFrom
    if (!desdeO) continue // sin versión no compite (spec §5.3)
    if (o.archivedFrom && o.archivedFrom <= desdeO) continue // nunca aplicó
    if (t.hasta && desdeO >= t.hasta) continue
    const choque = desdeO > t.desde ? desdeO : t.desde
    throw new ConflictError(
      `Esta tabla chocaría con «${o.name}»: las dos aplicarían a las mismas clases desde el ${dbDateComoFecha(choque)}. ` +
        'Archiva la otra antes de esa fecha o publica desde que la otra deja de valer.',
    )
  }
}

export async function crearTabla(input: { venueId: string; organizationId: string; name: string; productIds: string[]; actorId: string }) {
  const productIds = [...new Set(input.productIds)]
  const name = input.name.trim()
  if (!name) throw new BadRequestError('Escribe un nombre')
  return withSerializableRetry(async tx => {
    const venue = await tx.venue.findFirst({ where: { id: input.venueId, organizationId: input.organizationId }, select: { id: true } })
    if (!venue) throw new NotFoundError('Sede no encontrada')
    if (productIds.length) {
      const productos = await tx.product.count({ where: { id: { in: productIds }, venueId: input.venueId, type: 'CLASS' } })
      if (productos !== productIds.length) throw new BadRequestError('Algún producto no es una clase de esta sede')
    }
    // Aviso temprano: una tabla sin archivar del mismo alcance siempre acabaría empatando. Las archivadas (aunque sea a
    // futuro) sí permiten crear su reemplazo; el traslape exacto se revisa al publicar (assertSinEmpate).
    const abiertas = await tx.servicePayTable.findMany({
      where: { venueId: input.venueId, archivedFrom: null, ...mismoAlcance(productIds) },
      select: { name: true, productIds: true },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 100,
    })
    if (productIds.length === 0 && abiertas.length) throw new ConflictError('Ya existe una tabla para todas las clases de esta sede')
    if (abiertas.length) throw new ConflictError(`Una de esas clases ya tiene una tabla («${abiertas[0].name}»)`)
    const t = await tx.servicePayTable.create({
      data: { venueId: input.venueId, name, productIds, createdById: input.actorId },
      select: { id: true },
    })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_TABLE_CREATED',
      entity: 'ServicePayTable',
      entityId: t.id,
      data: { name, productIds },
    })
    return t
  })
}

const NO_EMPIEZA = 'la tabla no puede empezar'

interface VersionInput extends ReglasInput {
  venueId: string
  organizationId: string
  tableId: string
  effectiveFrom: string
  countMode: CountMode
  maxCount: number
  cells: CeldaInput[]
  actorId: string
}

/** Reglas que no necesitan base: también las aplica el service porque el MCP no pasa por el Zod de la ruta. */
function validarForma(input: VersionInput) {
  if (input.countMode === 'ATTENDED') throw new BadRequestError('«Sólo quien llegó» todavía no está disponible; usa «quien reservó»')
  if (input.countMode !== 'BOOKED') throw new BadRequestError('Modo de conteo inválido')
  if (!Number.isInteger(input.maxCount) || input.maxCount < 0 || input.maxCount > MAX_TECHO)
    throw new BadRequestError(`El techo debe ser un número entero de 0 a ${MAX_TECHO}: Máximo ${MAX_TECHO} lugares`)
  const vistas = new Set<string>()
  for (const c of input.cells) {
    if (!Number.isInteger(c.count) || c.count < 0 || c.count > input.maxCount)
      throw new BadRequestError(`El conteo ${c.count} está fuera de la tabla (0 a ${input.maxCount})`)
    if (!Number.isFinite(c.amount) || c.amount < 0) throw new BadRequestError('El monto no puede ser negativo')
    if (c.amount > MAX_MONTO) throw new BadRequestError('Monto demasiado grande')
    const k = `${c.payLevelId}:${c.count}`
    if (vistas.has(k)) throw new BadRequestError(`Celda repetida para ${c.count} lugares`)
    vistas.add(k)
  }
}

/**
 * Lo que no se manda se hereda de la versión que rige en `effectiveFrom` (decisión D-5 del Bloque D): una pantalla vieja que
 * sólo edita celdas no apaga en silencio el bono de nadie.
 */
async function reglasDeLaVersion(tx: Prisma.TransactionClient, tableId: string, effectiveFrom: Date, input: ReglasInput): Promise<Reglas> {
  const falta = input.coverBonusHours === undefined || input.coverBonusAmount === undefined || input.lateCancelHours === undefined
  const previa = falta
    ? await tx.servicePayTableVersion.findFirst({
        where: { tableId, effectiveFrom: { lte: effectiveFrom } },
        orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
        select: { coverBonusHours: true, coverBonusAmount: true, lateCancelHours: true },
      })
    : null
  return {
    coverBonusHours: input.coverBonusHours !== undefined ? input.coverBonusHours : (previa?.coverBonusHours ?? null),
    coverBonusAmount:
      input.coverBonusAmount !== undefined
        ? input.coverBonusAmount
        : previa?.coverBonusAmount != null
          ? previa.coverBonusAmount.toNumber()
          : null,
    lateCancelHours: input.lateCancelHours !== undefined ? input.lateCancelHours : (previa?.lateCancelHours ?? null),
  }
}

/** La misma regla que el CHECK de la base (spec fase 3 §7.3), con el mensaje en español (el MCP no pasa por Zod). */
function validarReglas(r: Reglas) {
  const horas = (h: number | null, que: string) => {
    if (h !== null && (typeof h !== 'number' || !Number.isInteger(h) || h < 1 || h > MAX_HORAS_REGLA))
      throw new BadRequestError(`${que}: escribe horas enteras de 1 a ${MAX_HORAS_REGLA}`)
  }
  horas(r.coverBonusHours, 'Suplencia con poco aviso')
  horas(r.lateCancelHours, 'Cancelación tardía')
  const m = r.coverBonusAmount
  if (m !== null && (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > MAX_BONO))
    throw new BadRequestError('El bono de suplencia debe ser mayor a $0 y de hasta $100,000')
  if (m !== null && new Prisma.Decimal(m).decimalPlaces() > 2) throw new BadRequestError('El bono de suplencia admite hasta 2 decimales')
  if ((r.coverBonusHours === null) !== (m === null))
    throw new BadRequestError('La suplencia con poco aviso necesita las horas y el bono (o ninguno de los dos)')
}

async function validarYCrearVersion(tx: Prisma.TransactionClient, input: VersionInput) {
  validarForma(input)
  const effectiveFrom = fechaComoDbDate(input.effectiveFrom)
  const tabla = await tx.servicePayTable.findFirst({
    where: { id: input.tableId, venueId: input.venueId },
    select: {
      id: true,
      productIds: true,
      archivedFrom: true,
      versions: { orderBy: { effectiveFrom: 'asc' }, take: 1, select: { effectiveFrom: true } },
    },
  })
  if (!tabla) throw new NotFoundError('Tabla no encontrada')
  const reglas = await reglasDeLaVersion(tx, tabla.id, effectiveFrom, input)
  validarReglas(reglas)
  const niveles = [...new Set(input.cells.map(c => c.payLevelId))]
  if (niveles.length) {
    const validos = await tx.staffPayLevel.count({ where: { id: { in: niveles }, organizationId: input.organizationId } })
    if (validos !== niveles.length) throw new NotFoundError('Nivel no encontrado')
  }
  await assertFechaNoCerrada(tx, input.organizationId, input.effectiveFrom, NO_EMPIEZA)
  const primera = tabla.versions[0]?.effectiveFrom
  await assertSinEmpate(tx, {
    id: tabla.id,
    venueId: input.venueId,
    productIds: tabla.productIds,
    desde: primera && primera < effectiveFrom ? primera : effectiveFrom,
    hasta: tabla.archivedFrom,
  })
  const ultima = await tx.servicePayTableVersion.findFirst({
    where: { tableId: tabla.id, effectiveFrom },
    orderBy: { revision: 'desc' },
    select: { revision: true },
  })
  const v = await tx.servicePayTableVersion.create({
    data: {
      tableId: tabla.id,
      effectiveFrom,
      revision: (ultima?.revision ?? 0) + 1,
      countMode: input.countMode,
      maxCount: input.maxCount,
      coverBonusHours: reglas.coverBonusHours,
      coverBonusAmount: reglas.coverBonusAmount === null ? null : new Prisma.Decimal(reglas.coverBonusAmount),
      lateCancelHours: reglas.lateCancelHours,
      createdById: input.actorId,
    },
    select: { id: true, revision: true },
  })
  if (input.cells.length) {
    await tx.servicePayTableCell.createMany({
      data: input.cells.map(c => ({ versionId: v.id, payLevelId: c.payLevelId, count: c.count, amount: new Prisma.Decimal(c.amount) })),
    })
  }
  return { ...v, reglas }
}

/** `ahora`: sólo pruebas, el «hoy» de la simulación (la ruta no lo pasa). */
export async function publicarVersion(
  input: VersionInput & { soloSimular: boolean; ahora?: Date },
): Promise<EfectoDelCambio & { versionId?: string; revision?: number }> {
  try {
    // Antes de simular: una fecha fuera de rango (full-testing A11) o dentro de un periodo cerrado (revisión final, I-2) se
    // explica sin valorar nada. Primero el rango; dentro de él, un periodo cerrado gana.
    assertFechaEnRango(input.effectiveFrom, rangoDeVigencia(await hoyDeLaSede(input.venueId, input.ahora)), 'La fecha de inicio')
    await assertFechaNoCerrada(prisma, input.organizationId, input.effectiveFrom, NO_EMPIEZA)
    const efecto = await efectoDelCambio(
      input.organizationId,
      [input.venueId],
      input.effectiveFrom,
      async tx => {
        await validarYCrearVersion(tx, input)
      },
      input.ahora,
    )
    const { clasesQueCambian } = efecto
    if (input.soloSimular) return efecto
    const v = await withSerializableRetry(async tx => {
      const creada = await validarYCrearVersion(tx, input)
      await writeLegacyActivityAuditTx(tx, {
        staffId: input.actorId,
        venueId: input.venueId,
        action: 'SERVICE_PAY_TABLE_VERSION_PUBLISHED',
        entity: 'ServicePayTableVersion',
        entityId: creada.id,
        data: {
          tableId: input.tableId,
          effectiveFrom: input.effectiveFrom,
          revision: creada.revision,
          countMode: input.countMode,
          maxCount: input.maxCount,
          celdas: input.cells.length,
          reglas: {
            ...creada.reglas,
            coverBonusAmount:
              creada.reglas.coverBonusAmount === null ? null : new Prisma.Decimal(creada.reglas.coverBonusAmount).toFixed(2),
          },
          clasesQueCambian,
        },
      })
      return creada
    })
    return { ...efecto, versionId: v.id, revision: v.revision }
  } catch (e) {
    // Dos publicaciones simultáneas del mismo día calcularon la misma revisión (doble clic en «Guardar»).
    if (esP2002(e)) throw new ConflictError('Se publicó otra versión de esta tabla al mismo tiempo; revisa la tabla y vuelve a intentarlo')
    throw e
  }
}

/** `ahora`: sólo pruebas, el «hoy» del rango de fechas (la ruta no lo pasa). */
export async function archivarTabla(input: { venueId: string; tableId: string; archivedFrom: string; actorId: string; ahora?: Date }) {
  const archivedFrom = fechaComoDbDate(input.archivedFrom)
  assertFechaEnRango(input.archivedFrom, rangoDeVigencia(await hoyDeLaSede(input.venueId, input.ahora)), 'La fecha de archivo')
  return withSerializableRetry(async tx => {
    const t = await tx.servicePayTable.findFirst({
      where: { id: input.tableId, venueId: input.venueId },
      select: {
        id: true,
        productIds: true,
        archivedFrom: true,
        versions: { orderBy: { effectiveFrom: 'asc' }, take: 1, select: { effectiveFrom: true } },
      },
    })
    if (!t) throw new NotFoundError('Tabla no encontrada')
    const sede = await tx.venue.findUniqueOrThrow({ where: { id: input.venueId }, select: { organizationId: true } })
    await assertFechaNoCerrada(tx, sede.organizationId, input.archivedFrom, 'la tabla no puede archivarse')
    // Mover un archivo que ya cae dentro de un periodo cerrado cambia lo congelado (spec §5.3): también se revisa la fecha vieja.
    if (t.archivedFrom) await assertFechaNoCerrada(tx, sede.organizationId, dbDateComoFecha(t.archivedFrom))
    // Mover el archivo a una fecha posterior alarga la vigencia: puede traslaparse con su reemplazo.
    await assertSinEmpate(tx, {
      id: t.id,
      venueId: input.venueId,
      productIds: t.productIds,
      desde: t.versions[0]?.effectiveFrom ?? null,
      hasta: archivedFrom,
    })
    const r = await tx.servicePayTable.update({ where: { id: t.id }, data: { archivedFrom }, select: { id: true } })
    await writeLegacyActivityAuditTx(tx, {
      staffId: input.actorId,
      venueId: input.venueId,
      action: 'SERVICE_PAY_TABLE_ARCHIVED',
      entity: 'ServicePayTable',
      entityId: t.id,
      data: { antes: t.archivedFrom ? dbDateComoFecha(t.archivedFrom) : null, archivedFrom: input.archivedFrom },
    })
    return r
  })
}

export async function historialDeTabla(venueId: string, tableId: string) {
  const t = await prisma.servicePayTable.findFirst({ where: { id: tableId, venueId }, select: { id: true } })
  if (!t) throw new NotFoundError('Tabla no encontrada')
  const vs = await prisma.servicePayTableVersion.findMany({
    where: { tableId },
    orderBy: [{ effectiveFrom: 'desc' }, { revision: 'desc' }],
    select: {
      id: true,
      effectiveFrom: true,
      revision: true,
      maxCount: true,
      countMode: true,
      createdAt: true,
      coverBonusHours: true,
      coverBonusAmount: true,
      lateCancelHours: true,
    },
    take: 100,
  })
  return vs.map(v => ({
    ...v,
    effectiveFrom: dbDateComoFecha(v.effectiveFrom),
    coverBonusAmount: v.coverBonusAmount === null ? null : Number(v.coverBonusAmount),
  }))
}
