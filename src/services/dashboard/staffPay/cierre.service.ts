import { Prisma, ServicePayPeriod } from '@prisma/client'
import { formatInTimeZone } from 'date-fns-tz'
import prisma from '../../../utils/prismaClient'
import { BadRequestError, ConflictError } from '../../../errors/AppError'
import { writeLegacyActivityAuditTx } from '../../activityAudit.service'
import { exigirPermisoEnSedes, sedesConPermiso, sedesConServicePay } from './acceso'
import { ampliarAlcance, asegurarPeriodo, bloquearPeriodo, lockPeriodosDeOrganizacion, periodoQueContieneFecha } from './periodosGuardados'
import { transaccionConPresupuesto } from '../../../utils/esperaDeCandados'
import { alcanceDelPeriodo, bloquearSedesDeLaOrganizacion, sedesConVentana } from './participacion'
import { dbDateComoFecha } from './periodos'
import { ClaseValorada, ReglaDeClase } from './valoracion'
import { alcanceDe, alcanceDeVentas, Bloqueo, bloqueosDe, textoSedeActivaSinPlan } from './cierre.alcance'
import {
  ajustesDelPeriodo,
  comisionesPorRevisar,
  idsHuerfanas,
  LOTE_CIERRE,
  organizacionDe,
  recibosGuardados,
  recorrer,
  sinDuenoDe,
} from './cierre.recorrido'
import { previewCierre } from './cierre.preview'

export type { Bloqueo } from './cierre.alcance'
// B12: la vista previa vive en `cierre.preview.ts` y el recorrido en `cierre.recorrido.ts`; se re-exportan para sus llamadores.
export { previewCierre } from './cierre.preview'
export type { PreviewCierre } from './cierre.preview'
export { consultaIdsDelLote, LOTE_CIERRE } from './cierre.recorrido'

type Tx = Prisma.TransactionClient
type Db = Tx | typeof prisma

/**
 * Medido 2026-10-03 (A13, ronda 1), 50,000 clases: 9.0 s EN FRÍO (primer cierre: devengos y anclas vacíos y sin
 * estadísticas) y 9.2 s CON HISTORIAL. Antes del arreglo (lectura de todo el resto en cada lote y escrituras entre lotes):
 * 66 s con historial y en frío no terminaba. Fase 3 (B7, 2026-10-06, Mac con carga 13-20 en 10 núcleos), con el código
 * actual: 50,000 clases + 50,000 comisiones + 50,000 propinas: 34.5 s CON HISTORIAL (julio cerrado con otras 50,000 ventas,
 * con `plan_cache_mode = force_custom_plan`) y 38.1 s EN FRÍO (medido antes de ese ajuste). El peor por dos da ~76 s, que al
 * minuto son 120 s (con el mínimo de 60 s). `TIMEOUT_CIERRE_MS` acota UN intento: con reintentos de SSI o un HUELLA_CAMBIO,
 * la petición completa puede tardar más. Mientras dura, activar, propinas, periodicidad, ajustes, liquidaciones y
 * marcar pagado esperan su candado (el de la organización o la fila del periodo) con su presupuesto de espera (6 s,
 * `PresupuestoDeEspera`) y contestan 409 CIERRE_EN_CURSO (B7 r1-r2, B9). El cierre mismo espera hasta 30 s (B9: ya no sin
 * tope). No se baja sin volver a medir (spec §6.3 punto 3; fase 3 §6.5):
 * `tests/integration/staffPay/cierre.carga.test.ts`, con y sin MEDIR_EN_FRIO=1.
 */
// B9 (ronda 1, F5): el margen. El cálculo medido es ~76 s en el peor caso (el peor por dos de lo medido arriba); el
// presupuesto de espera de candados del cierre es de 30 s (`PresupuestoDeEspera.para(TIMEOUT_CIERRE_MS)`), así que
// 76 + 30 < 120. Y aunque el cálculo tarde más, ninguna espera empuja la transacción más allá de su timeout: el presupuesto
// se acota también por el reloj de la transacción menos 1 s (F3, `esperaDeCandados.ts`) y contesta 409 en vez del P2028.
export const TIMEOUT_CIERRE_MS = 120_000
const BLOQUE_ESCRITURA = 1000

export interface ResultadoCierre {
  periodId: string
  start: string
  end: string
  venueIds: string[]
  personas: number
  total: string
  huella: string
  yaCerrado: boolean
}

export function descriptorDeClase(
  c: Pick<ClaseValorada, 'productName' | 'fechaLocal' | 'startsAt' | 'staffName'> & { regla?: ReglaDeClase | null },
  sede: { nombre: string; tz: string },
): Prisma.InputJsonObject {
  return {
    clase: c.productName,
    fecha: c.fechaLocal,
    hora: formatInTimeZone(c.startsAt, sede.tz, 'HH:mm'),
    sede: sede.nombre,
    coach: c.staffName,
    // La regla de clase que movió el monto (spec fase 3 §6.6): el recibo cerrado la dice aunque después cambie la tabla.
    ...(c.regla ? { regla: c.regla } : {}),
  }
}

/**
 * Ancla de una vez (spec §5.4): nunca pisa un ancla existente. `updatedAt` en UTC, como lo escribe Prisma. Devuelve cuántas
 * clases quedaron ancladas (las que ya lo estaban no cuentan).
 */
export async function anclarClases(
  tx: Tx,
  periodId: string,
  filas: Array<{ classSessionId: string; fechaValoracion: string; tableVersionId: string | null }>,
): Promise<number> {
  if (!filas.length) return 0
  return tx.$executeRaw`
    INSERT INTO "ClassSessionPayState" ("classSessionId", "originPeriodId", "valuationDate", "valuationVersionId", "payExcluded", "updatedAt")
    SELECT x.cid, ${periodId}, x.fecha::date, x.ver, false, (NOW() AT TIME ZONE 'UTC')
    FROM unnest(${filas.map(f => f.classSessionId)}::text[], ${filas.map(f => f.fechaValoracion)}::text[],
                ${filas.map(f => f.tableVersionId)}::text[]) AS x(cid, fecha, ver)
    ON CONFLICT ("classSessionId") DO UPDATE SET
      "originPeriodId" = EXCLUDED."originPeriodId",
      "valuationDate" = EXCLUDED."valuationDate",
      "valuationVersionId" = EXCLUDED."valuationVersionId",
      "updatedAt" = (NOW() AT TIME ZONE 'UTC')
    WHERE "ClassSessionPayState"."originPeriodId" IS NULL`
}

async function resultadoGuardado(db: Db, p: ServicePayPeriod, yaCerrado: boolean): Promise<ResultadoCierre> {
  const g = await recibosGuardados(db, p.organizationId, p.id)
  return {
    periodId: p.id,
    start: dbDateComoFecha(p.periodStart),
    end: dbDateComoFecha(p.periodEnd),
    venueIds: p.venueIds,
    personas: g.personas,
    total: g.total.toFixed(2),
    huella: p.closeFingerprint ?? '',
    yaCerrado,
  }
}

/** Centinela: la huella cambió. Se convierte en `ConflictError HUELLA_CAMBIO` FUERA de la transacción (ya revertida). */
class HuellaCambio extends Error {}

export async function cerrarPeriodo(input: {
  userId: string
  venueId: string
  fecha: string
  huellaEsperada: string
  confirmarHuerfanas: boolean
  ahora?: Date
  tamLote?: number
  alTerminarLote?: (n: number) => void
}): Promise<ResultadoCierre> {
  const organizationId = await organizacionDe(input.venueId)
  const ahora = input.ahora ?? new Date()
  const tamLote = input.tamLote ?? LOTE_CIERRE
  // Módulos y permisos con el cliente GLOBAL, ANTES de la transacción: dentro retendrían su conexión mientras piden otra
  // (la familia de Codex R4-Nuevo 1). Candidatas: el alcance del periodo como está ahora ∪ las sedes con el módulo ∪ las
  // sedes con alguna ventana (B11, r4.4: su historia las mete al alcance). Dentro sólo se COMPARA contra lo resuelto; una
  // sede que entró al alcance entretanto no tiene permiso resuelto y se niega.
  const activas = await sedesConServicePay(organizationId)
  const conVentana = await sedesConVentana(prisma, organizationId)
  const filaAntes = await periodoQueContieneFecha(prisma, organizationId, input.fecha)
  const candidatas = [...(filaAntes?.venueIds ?? []), ...activas, ...conVentana]
  const permitidas = new Set(await sedesConPermiso(input.userId, candidatas, 'staffpay:close'))
  try {
    return await transaccionConPresupuesto(
      async (tx, presupuesto) => {
        // B-D3: el candado de la ORGANIZACIÓN primero (mismo orden que `asegurarPeriodo`: organización → periodo). Dos
        // cierres de periodos DISTINTOS pueden barrer la MISMA venta tardía de un periodo ya cerrado: con el candado el
        // segundo espera al primero. Lo que lo hace correcto es SSI, no el candado: SERIALIZABLE toma la foto en la primera
        // sentencia —ésta, ANTES de esperar—, así que el segundo, al congelar lo que el primero ya congeló, aborta con 40001
        // y el reintento ve la huella nueva (HUELLA_CAMBIO). También ordena el cierre con activar y con las propinas.
        // B9: con el presupuesto del cierre (30 s de sus 120 s), compartido con la fila del periodo y las de las sedes. Antes
        // esperaba sin tope (B7 r1) y un segundo o tercer cierre simultáneo acababa en P2028; ahora contesta 409.
        await lockPeriodosDeOrganizacion(tx, organizationId, presupuesto)
        // B7 r2: los lotes reusan el MISMO statement preparado con otro cursor, y desde la sexta ejecución Postgres le pone un
        // plan GENÉRICO que no conoce el cursor y vuelve a recorrer todo el resto del rango en cada lote. Medido: los 100 lotes
        // de propinas, 11.7 s con el genérico y 3.3 s con el personalizado. Va DESPUÉS del candado: SET no toma la foto de
        // SERIALIZABLE, pero así la primera sentencia sigue siendo el candado, como dice el comentario de arriba.
        await tx.$executeRawUnsafe('SET LOCAL plan_cache_mode = force_custom_plan')
        const fila = await asegurarPeriodo(tx, organizationId, input.fecha, presupuesto, activas)
        let p = await bloquearPeriodo(tx, fila.id, presupuesto)
        const sinPermiso = 'Para cerrar necesitas el permiso de cerrar periodos en todas las sedes del periodo'
        // Permiso también ANTES del retorno idempotente (Codex R1-8): un «ya estaba cerrado» no regala los totales.
        if (p.status === 'CLOSED') {
          exigirPermisoEnSedes(permitidas, p.venueIds, sinPermiso)
          return resultadoGuardado(tx, p, true)
        }
        // B11 (revisión de B10 #1): las ventanas de TODA la organización, leídas DENTRO de esta transacción SERIALIZABLE. Es lo
        // que le da a SSI el ciclo con una escritura de ventana concurrente (`activarSede`/`desactivarSede` leen el último
        // cerrado; este cierre lee sus ventanas): una de las dos se repite y nunca queda una ventana dentro de un periodo ya
        // cerrado. Si cambiaron desde lo resuelto antes, el dueño vuelve a ver la vista previa (HUELLA_CAMBIO).
        if ((await sedesConVentana(tx, organizationId)).join('|') !== conVentana.join('|')) throw new HuellaCambio()
        // D2 + B11 (r5.2): el alcance del periodo abierto —guardadas ∪ con el plan, y desde el inicio de pago al personal ∪ las
        // sedes con ventana (sin pedirles el plan)—, con permiso en cada una (`ampliarAlcance`). Un periodo que termina antes del
        // inicio no se amplía ni se persiste por historia.
        const org = await tx.organization.findUniqueOrThrow({ where: { id: organizationId }, select: { staffPayStartDate: true } })
        const alcance = alcanceDelPeriodo({
          periodo: { start: dbDateComoFecha(p.periodStart), end: dbDateComoFecha(p.periodEnd), estado: p.status },
          guardadas: p.venueIds,
          activas,
          conVentana,
          startDate: org.staffPayStartDate ? dbDateComoFecha(org.staffPayStartDate) : null,
        })
        p = await ampliarAlcance(tx, p, alcance, input.userId, { exigirModulo: false, permitidas })
        exigirPermisoEnSedes(permitidas, p.venueIds, sinPermiso)
        const a = await alcanceDe(tx, p)
        const bloqueos = await bloqueosDe(tx, a, ahora, activas)
        const b = (codigo: Bloqueo['codigo']) => bloqueos.find(x => x.codigo === codigo)
        if (b('NO_HA_TERMINADO'))
          throw new BadRequestError(`El periodo termina el ${a.periodo.end}: todavía no se puede cerrar`, 'PERIODO_NO_TERMINA')
        const enCurso = b('CLASES_EN_CURSO') as { n: number } | undefined
        if (enCurso) throw new BadRequestError(`Hay ${enCurso.n} clase(s) en curso: espera a que terminen`, 'CLASES_EN_CURSO')
        const exc = b('EXCEPCIONES') as { n: number } | undefined
        if (exc)
          throw new BadRequestError(
            `Quedan ${exc.n} clase(s) que no se pueden pagar todavía: resuélvelas antes de cerrar`,
            'HAY_EXCEPCIONES',
          )
        const sinPlan = b('SEDE_ACTIVA_SIN_PLAN') as Extract<Bloqueo, { codigo: 'SEDE_ACTIVA_SIN_PLAN' }> | undefined
        if (sinPlan) {
          const nombres = sinPlan.venueIds.map(v => a.sedes.find(x => x.venueId === v)?.nombre ?? v)
          throw new ConflictError(textoSedeActivaSinPlan(nombres, sinPlan.otrasConPlan), 'SEDE_ACTIVA_SIN_PLAN', {
            venueIds: sinPlan.venueIds,
            otrasConPlan: sinPlan.otrasConPlan,
          })
        }
        const huerfanas = await idsHuerfanas(tx, a, ahora)
        if (huerfanas.length && !input.confirmarHuerfanas) {
          throw new BadRequestError(
            `Confirma que las ${huerfanas.length} reserva(s) de clase sin horario no cuentan para ningún pago`,
            'HUERFANAS_SIN_CONFIRMAR',
          )
        }

        // Los ajustes se LEEN antes de escribir los SERVICE y se hashean después de las clases, igual que en el preview.
        const ajustes = await ajustesDelPeriodo(tx, organizationId, p.id)
        // A13: LEER todo y DESPUÉS escribir. Si cada lote escribiera sus SERVICE y sus anclas, la lectura del siguiente
        // tocaría filas sin confirmar que nadie puede analizar, y en el primer cierre (tablas vacías) el plan se degrada lote
        // tras lote. Aquí se guarda sólo lo que se va a escribir.
        // ponytail: memoria O(clases), ~1-2 KB por clase (pico +78/+103 MB con 50,000). Si hiciera falta bajarla, los SERVICE
        // pueden escribirse por lote (la lectura en vivo ya no toca ServiceEarning) y dejar sólo las anclas para el final.
        const alcanceVentas = await alcanceDeVentas(tx, a)
        const servicios: Prisma.ServiceEarningCreateManyInput[] = []
        const ventas: Prisma.ServiceEarningCreateManyInput[] = []
        const anclas: Parameters<typeof anclarClases>[2] = []
        let lotes = 0
        const r = await recorrer(tx, a, ahora, {
          tamLote,
          ajustes,
          huerfanas,
          ventas: alcanceVentas,
          // ponytail: memoria O(ventas), ~1.5 KB por línea medido en B7 (pico del cierre +224/+263 MB con 50,000 clases y 100,000
          // líneas, contra +78/+103 MB sólo con las clases). Si hiciera falta, escribir por lote.
          alVentas: lote => {
            for (const l of lote) {
              ventas.push({
                organizationId,
                venueId: l.venueId,
                periodId: p.id,
                staffId: l.staffId,
                concept: l.concepto,
                sourceType: l.fuente,
                sourceId: l.sourceId,
                occurredAt: l.instante,
                amount: l.monto,
                descriptor: { ...l.descriptor },
                createdById: input.userId,
              })
            }
          },
          alLote: async (lote, sede) => {
            for (const c of lote) {
              anclas.push({ classSessionId: c.classSessionId, fechaValoracion: c.fechaValoracion, tableVersionId: c.tableVersionId })
              if (c.estado !== 'OK' || !c.staffId || c.monto === null) continue
              servicios.push({
                organizationId,
                venueId: c.venueId,
                periodId: p.id,
                staffId: c.staffId,
                concept: 'SERVICE',
                sourceType: 'CLASS_SESSION',
                sourceId: c.classSessionId,
                occurredAt: c.startsAt,
                payLevelId: c.payLevelId,
                payLevelName: c.payLevelName,
                tableVersionId: c.tableVersionId,
                countMode: c.countMode,
                count: c.conteo,
                amount: new Prisma.Decimal(c.monto),
                descriptor: descriptorDeClase(c, sede),
                createdById: input.userId,
              })
            }
            input.alTerminarLote?.(++lotes)
          },
        })
        // Antes de escribir: si la huella cambió, se aborta sin haber tocado nada (el resultado es el mismo que abortar después).
        if (r.huella !== input.huellaEsperada) throw new HuellaCambio()
        // Ningún índice impide congelar una venta dos veces: `ServiceEarning_service_unico` (y el de RECONCILE de venta)
        // incluyen `staffId`, así que la misma propina a otra persona (la orden cambió de quien la atiende) sí entraría. Lo
        // que lo impide es el anti-join por fuente + `sourceId` de fuentesVenta, más SSI: un cierre concurrente que ya la
        // congeló hace abortar a éste con 40001 y su reintento ya no la ve.
        // B9 (r7.1): antes de escribir, la fila de CADA sede que recibe devengos en `FOR KEY SHARE` (periodo → sede) y que
        // siga siendo de la organización. Sólo las sedes de las filas que se insertan: una del alcance sin dinero no
        // necesita protegerse, y una demo sin datos borrada a tiempo no tumba el cierre.
        await bloquearSedesDeLaOrganizacion(
          tx,
          organizationId,
          [...servicios, ...ventas].map(f => f.venueId),
          presupuesto,
        )
        for (const filas of [servicios, ventas])
          for (let i = 0; i < filas.length; i += BLOQUE_ESCRITURA)
            await tx.serviceEarning.createMany({ data: filas.slice(i, i + BLOQUE_ESCRITURA) })
        for (let i = 0; i < anclas.length; i += BLOQUE_ESCRITURA) await anclarClases(tx, p.id, anclas.slice(i, i + BLOQUE_ESCRITURA))

        // Recibos: suma de lo YA ESCRITO del periodo (clases, ventas y ajustes), uno por persona — quien sólo tiene un bono o sólo
        // vende también.
        const sumas = await tx.serviceEarning.groupBy({
          by: ['staffId'],
          where: { organizationId, periodId: p.id },
          _sum: { amount: true },
        })
        if (sumas.length) {
          await tx.staffPayStatement.createMany({
            data: sumas.map(s => ({ periodId: p.id, staffId: s.staffId, total: s._sum.amount ?? new Prisma.Decimal(0) })),
          })
        }
        const cerrado = await tx.servicePayPeriod.updateMany({
          where: { id: p.id, status: 'OPEN' },
          data: { status: 'CLOSED', closedAt: new Date(), closedById: input.userId, closeFingerprint: r.huella },
        })
        if (cerrado.count !== 1) throw new ConflictError('El periodo cambió mientras se cerraba: revisa de nuevo')
        const total = sumas.reduce((acc, s) => acc.plus(s._sum.amount ?? 0), new Prisma.Decimal(0))
        const sinDueno = await sinDuenoDe(tx, alcanceVentas)
        await writeLegacyActivityAuditTx(tx, {
          staffId: input.userId,
          venueId: input.venueId,
          action: 'SERVICE_PAY_PERIOD_CLOSED',
          entity: 'ServicePayPeriod',
          entityId: p.id,
          data: {
            periodo: { start: a.periodo.start, end: a.periodo.end },
            venueIds: a.venueIds,
            clases: r.clases,
            excluidas: r.excluidas,
            comisiones: r.comisiones,
            propinas: r.propinas,
            reversos: r.reversos,
            totalVentas: r.totalVentas.toFixed(2),
            propinasSinDueno: { n: sinDueno.n, total: sinDueno.total.toFixed(2) },
            comisionesPorRevisar: await comisionesPorRevisar(tx, alcanceVentas),
            personas: sumas.length,
            total: total.toFixed(2),
            huella: r.huella,
            huerfanas,
          },
        })
        return {
          periodId: p.id,
          start: a.periodo.start,
          end: a.periodo.end,
          venueIds: a.venueIds,
          personas: sumas.length,
          total: total.toFixed(2),
          huella: r.huella,
          yaCerrado: false,
        }
      },
      { timeoutMs: TIMEOUT_CIERRE_MS },
    )
  } catch (e) {
    if (!(e instanceof HuellaCambio)) throw e
    // Fuera de la transacción (ya revertida y sin el candado del periodo): el preview nuevo muestra el estado real de la
    // base, que es lo que el usuario tiene que volver a revisar.
    throw new ConflictError('Los números cambiaron desde que los revisaste: revisa el cierre de nuevo', 'HUELLA_CAMBIO', {
      preview: await previewCierre({ userId: input.userId, venueId: input.venueId, fecha: input.fecha, ahora, tamLote }),
    })
  }
}
