import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { withSerializableRetry } from '../../../utils/serializableRetry'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { contarClasesQueCambian } from './efecto'
import { dbDateComoFecha, fechaComoDbDate } from './periodos'

export interface CeldaInput {
  payLevelId: string
  count: number
  amount: number
}

type CountMode = 'BOOKED' | 'ATTENDED'

const MAX_TECHO = 500
const MAX_MONTO = 1_000_000

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

interface VersionInput {
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
  const niveles = [...new Set(input.cells.map(c => c.payLevelId))]
  if (niveles.length) {
    const validos = await tx.staffPayLevel.count({ where: { id: { in: niveles }, organizationId: input.organizationId } })
    if (validos !== niveles.length) throw new NotFoundError('Nivel no encontrado')
  }
  // Fase 2: rechazar effectiveFrom dentro de un periodo cerrado (spec §5.3).
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
      createdById: input.actorId,
    },
    select: { id: true, revision: true },
  })
  if (input.cells.length) {
    await tx.servicePayTableCell.createMany({
      data: input.cells.map(c => ({ versionId: v.id, payLevelId: c.payLevelId, count: c.count, amount: new Prisma.Decimal(c.amount) })),
    })
  }
  return v
}

export async function publicarVersion(input: VersionInput & { soloSimular: boolean }) {
  try {
    const clasesQueCambian = await contarClasesQueCambian(input.organizationId, [input.venueId], async tx => {
      await validarYCrearVersion(tx, input)
    })
    if (input.soloSimular) return { clasesQueCambian }
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
          clasesQueCambian,
        },
      })
      return creada
    })
    return { clasesQueCambian, versionId: v.id, revision: v.revision }
  } catch (e) {
    // Dos publicaciones simultáneas del mismo día calcularon la misma revisión (doble clic en «Guardar»).
    if (esP2002(e)) throw new ConflictError('Se publicó otra versión de esta tabla al mismo tiempo; revisa la tabla y vuelve a intentarlo')
    throw e
  }
}

export async function archivarTabla(input: { venueId: string; tableId: string; archivedFrom: string; actorId: string }) {
  const archivedFrom = fechaComoDbDate(input.archivedFrom)
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
    select: { id: true, effectiveFrom: true, revision: true, maxCount: true, countMode: true, createdAt: true },
    take: 100,
  })
  return vs.map(v => ({ ...v, effectiveFrom: dbDateComoFecha(v.effectiveFrom) }))
}
