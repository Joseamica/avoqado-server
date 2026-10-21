/**
 * «Duplicar con cambios» que REEMPLAZA al original (fase 3 de Pago al personal, FT-GRAVES S-REPLACE; decisión del founder del
 * 8-oct: el esquema nuevo reemplaza al original, nunca pagan los dos a la vez).
 *
 * Antes el dashboard lo hacía con dos llamadas (copiar y luego desactivar). Entre las dos pagaban los dos, y si fallaban los
 * niveles o las excepciones, el nuevo se quedaba activo junto al original. Ahora todo va en UNA transacción, y si algo falla no
 * queda nada a medias:
 * - nace el esquema nuevo con los cambios;
 * - se le copian del original sus niveles (si el nuevo es por niveles), sus excepciones por persona activas y «a quién aplica»;
 *   lo que el cuerpo no cambia queda igual;
 * - el original se desactiva;
 * - queda un ActivityLog de cada cosa, con quién lo hizo.
 *
 * El original tiene que ser de ESTA sede (nunca de otro negocio ni de la organización, que se cambia desde la organización),
 * estar activo y no borrado. El candado de su fila serializa dos reemplazos simultáneos: el segundo recibe 409, no un tercer
 * esquema activo.
 */
import { Prisma } from '@prisma/client'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError, NotFoundError } from '../../../errors/AppError'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { validarTasasDelEsquema } from './tasasDelEsquema'
import { personasElegidasAGuardar } from './personasElegidas'
import { validateAttendanceRule, type CreateCommissionConfigInput } from './commission-config.service'
import { soloCamposDelEsquema } from './cambiosConComisiones'
import { asegurarIdsDelNegocio } from './idsDelNegocio'
import { nivelesAlPasarANiveles, nivelesParaGuardar } from './nivelesDelEsquema'

type Cambios = Partial<Omit<CreateCommissionConfigInput, 'orgId'>> & { description?: string | null }

/** Margen para el reloj del navegador: «hoy a esta hora» puede llegar unos segundos adelantado. */
const TOLERANCIA_DEL_RELOJ_MS = 5 * 60_000

const quedaIgual = <T>(cambio: T | undefined, original: T): T => (cambio === undefined ? original : cambio)

function fecha(valor: unknown, que: string): Date {
  const d = valor instanceof Date ? valor : new Date(String(valor))
  if (Number.isNaN(d.getTime())) throw new BadRequestError(`${que} no es una fecha válida.`)
  return d
}

export async function reemplazarEsquema(venueId: string, originalId: string, cuerpo: Record<string, unknown>, actorId: string) {
  // La lista blanca de la sede (`cambiosConComisiones.ts`): sede, organización, autor e ids nunca vienen del cliente.
  const cambios = soloCamposDelEsquema(cuerpo) as Cambios
  if (typeof cambios.name === 'string') cambios.name = cambios.name.trim() || undefined

  return prisma.$transaction(
    async tx => {
      // El candado de la fila del original, filtrado por la sede: un id de otro negocio (o de la organización) es un 404.
      const fila = await tx.$queryRaw<Array<{ id: string }>>(
        Prisma.sql`SELECT id FROM "CommissionConfig" WHERE id = ${originalId} AND "venueId" = ${venueId} AND "deletedAt" IS NULL FOR UPDATE`,
      )
      if (fila.length === 0) throw new NotFoundError('No encontré ese esquema de comisión en este negocio.')
      const original = await tx.commissionConfig.findUniqueOrThrow({
        where: { id: originalId },
        include: { tiers: { where: { active: true }, orderBy: { tierLevel: 'asc' } }, overrides: { where: { active: true } } },
      })
      if (!original.active) {
        throw new ConflictError(
          'Este esquema ya está desactivado: otro cambio ya lo reemplazó o alguien lo apagó. Recarga la página para ver el vigente.',
          'ESQUEMA_YA_INACTIVO',
        )
      }

      // Lo que QUEDA en el esquema nuevo pasa las mismas reglas que crear y actualizar.
      validarTasasDelEsquema(cambios, original)
      const elegidos = await personasElegidasAGuardar(cambios, { venueId }, original)
      await asegurarIdsDelNegocio({ venueId }, { categoryIds: cambios.categoryIds }, tx) // de ESTA sede (T1-hermanos)
      const castigo = quedaIgual(
        cambios.attendanceLatePenaltyRate,
        original.attendanceLatePenaltyRate === null ? null : Number(original.attendanceLatePenaltyRate),
      )
      const asistencia = quedaIgual(cambios.attendanceLinked, original.attendanceLinked)
      validateAttendanceRule({ attendanceLinked: asistencia, attendanceLatePenaltyRate: castigo })
      const minimo = quedaIgual(cambios.minAmount, original.minAmount === null ? undefined : Number(original.minAmount))
      const maximo = quedaIgual(cambios.maxAmount, original.maxAmount === null ? undefined : Number(original.maxAmount))
      if (minimo != null && maximo != null && minimo > maximo) {
        throw new BadRequestError('La comisión mínima no puede ser mayor que la máxima.')
      }

      // Empieza AL GUARDAR (o en la fecha que mande el dashboard, ya pasada): una fecha futura dejaría un hueco en el que no
      // paga ninguno de los dos, porque el original se apaga ahora.
      const ahora = new Date()
      const desde = cambios.effectiveFrom ? fecha(cambios.effectiveFrom, 'La fecha de inicio') : ahora
      if (desde.getTime() > ahora.getTime() + TOLERANCIA_DEL_RELOJ_MS) {
        throw new BadRequestError(
          'El esquema que reemplaza a otro empieza a contar al guardarlo: su fecha de inicio no puede ser futura. ' +
            'Para programar un cambio, crea el esquema nuevo con su fecha y desactiva el actual ese día.',
        )
      }
      const hastaCrudo = quedaIgual<unknown>(cambios.effectiveTo, original.effectiveTo)
      const hasta = hastaCrudo == null ? null : fecha(hastaCrudo, 'La fecha de fin')
      if (hasta && hasta <= desde) throw new BadRequestError('La fecha de fin tiene que ser después de la de inicio.')

      const calcType = cambios.calcType ?? original.calcType
      // Pasar a niveles desde un esquema plano: los niveles llegan aquí mismo (FT-GRAVES); si ya era TIERED, se copian los suyos.
      const nivelesNuevos = nivelesAlPasarANiveles(
        calcType,
        original.calcType,
        cuerpo?.tiers,
        cambios.useGoalAsTier ?? original.useGoalAsTier,
      )
      const roleRates = cambios.roleRates !== undefined ? cambios.roleRates : original.roleRates
      const nuevo = await tx.commissionConfig.create({
        data: {
          venueId,
          orgId: original.orgId,
          name: cambios.name ?? original.name,
          description: quedaIgual(cambios.description, original.description),
          priority: cambios.priority ?? original.priority,
          recipient: cambios.recipient ?? original.recipient,
          trigger: cambios.trigger ?? original.trigger,
          calcType,
          defaultRate: cambios.defaultRate ?? original.defaultRate,
          minAmount: minimo ?? null,
          maxAmount: maximo ?? null,
          includeTips: cambios.includeTips ?? original.includeTips,
          includeDiscount: cambios.includeDiscount ?? original.includeDiscount,
          includeTax: cambios.includeTax ?? original.includeTax,
          roleRates: (roleRates as Prisma.InputJsonValue | null) ?? Prisma.JsonNull,
          filterByCategories: cambios.filterByCategories ?? original.filterByCategories,
          categoryIds: cambios.categoryIds ?? original.categoryIds,
          filterByStaff: elegidos.filterByStaff ?? original.filterByStaff,
          staffIds: elegidos.staffIds ?? original.staffIds,
          useGoalAsTier: cambios.useGoalAsTier ?? original.useGoalAsTier,
          goalBonusRate: quedaIgual(cambios.goalBonusRate, original.goalBonusRate === null ? null : Number(original.goalBonusRate)),
          attendanceLinked: asistencia,
          attendanceLatePenaltyRate: castigo,
          aggregationPeriod: original.aggregationPeriod,
          effectiveFrom: desde,
          effectiveTo: hasta,
          createdById: actorId,
        },
      })
      // Los niveles sólo significan algo en un esquema por niveles; las excepciones (tasa propia o excluir) siempre.
      if (nivelesNuevos?.length) await tx.commissionTier.createMany({ data: nivelesParaGuardar(nuevo.id, nivelesNuevos) })
      const niveles = calcType === 'TIERED' && !nivelesNuevos ? original.tiers : []
      if (niveles.length > 0) {
        await tx.commissionTier.createMany({
          data: niveles.map(t => ({
            configId: nuevo.id,
            tierLevel: t.tierLevel,
            tierName: t.tierName,
            tierType: t.tierType,
            tierPeriod: t.tierPeriod,
            minThreshold: t.minThreshold,
            maxThreshold: t.maxThreshold,
            minThresholdType: t.minThresholdType,
            maxThresholdType: t.maxThresholdType,
            rate: t.rate,
          })),
        })
      }
      if (original.overrides.length > 0) {
        await tx.commissionOverride.createMany({
          data: original.overrides.map(o => ({
            configId: nuevo.id,
            venueId,
            staffId: o.staffId,
            customRate: o.customRate,
            reason: o.reason,
            notes: o.notes,
            effectiveFrom: o.effectiveFrom,
            effectiveTo: o.effectiveTo,
            excludeFromCommissions: o.excludeFromCommissions,
            createdById: actorId,
          })),
        })
      }
      await tx.commissionConfig.update({ where: { id: originalId }, data: { active: false } })

      await writeLegacyActivityAuditTx(tx, {
        staffId: actorId,
        venueId,
        action: 'COMMISSION_CONFIG_CREATED',
        entity: 'CommissionConfig',
        entityId: nuevo.id,
        data: {
          name: nuevo.name,
          calcType,
          defaultRate: nuevo.defaultRate.toString(),
          reemplazaA: originalId,
          niveles: niveles.length,
          excepciones: original.overrides.length,
        },
      })
      await writeLegacyActivityAuditTx(tx, {
        staffId: actorId,
        venueId,
        action: 'COMMISSION_CONFIG_UPDATED',
        entity: 'CommissionConfig',
        entityId: originalId,
        data: { changes: ['active'], active: false, reemplazadoPor: nuevo.id },
      })

      return { ...nuevo, reemplazado: { id: originalId, active: false } }
    },
    { maxWait: 10_000, timeout: 30_000 },
  )
}
