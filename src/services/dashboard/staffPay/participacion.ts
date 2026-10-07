import { Prisma } from '@prisma/client'
import { ConflictError } from '../../../errors/AppError'
import { PresupuestoDeEspera, tomarCandado } from '../../../utils/esperaDeCandados'

/**
 * Participación por sede (fase 3, B9; diseño r7.1 + r6.3): el dueño activa «Pago al personal» POR SEDE y elige desde qué
 * día (`StaffPayVenueWindow`). Aquí viven los candados de FILA de la sede y la historia de pago al personal.
 *
 * Dos lados sobre la MISMA fila de `Venue`:
 * - **Escritores** (los únicos que insertan `ServiceEarning` —cierre, ajuste manual, liquidación— y las escrituras de
 *   ventanas): `FOR KEY SHARE` de cada sede a la que le van a escribir, una por una por id, y revalidan bajo el candado que
 *   sigue siendo de la organización. `FOR KEY SHARE` no estorba a un cambio normal de la sede (nombre, horario): sólo a
 *   los cambios de una columna LLAVE de `Venue` —`organizationId` (índice único `Venue(id, organizationId)`), y también
 *   `slug`, `liveDemoSessionId` y `stripeCustomerId`, que son únicos (p. ej. el UPDATE condicional de
 *   `stripe.service.ts:133`)— y al DELETE. Esos cambios esperan al escritor (que toma las sedes al final, justo antes de
 *   escribir); y uno CONFIRMADO después de la foto de un escritor SERIALIZABLE (el cierre) le da 40001 al tomar la fila: el
 *   escritor se repite entero con `withSerializableRetry`. Es correcto y raro.
 * - **Exclusivos** (traslado, `deleteVenue`, limpieza de demos): `FOR UPDATE` de la sede ANTES de mirar la historia, y la
 *   historia es OTRA sentencia, después: en READ COMMITTED ve lo que confirmó el escritor al que esperó.
 *
 * Orden de candados (sin ciclos, Codex r7 #23): cierre y ajuste, periodo → Venue; liquidación, periodo destino → clase →
 * Venue; escrituras de ventanas, candado de periodos de la organización → fila de `Organization` → Venue; traslado,
 * `Organization` (por id) → Venue. Todos con el presupuesto ÚNICO de su transacción (`PresupuestoDeEspera`).
 *
 * Todavía NINGÚN lector de dinero usa las ventanas (eso llega en B11-B13).
 */

type Tx = Prisma.TransactionClient

/**
 * La fila de la organización, `FOR NO KEY UPDATE` (r5.3 paso 2): la toman las escrituras de ventanas y el traslado (éste las
 * dos organizaciones, por id), así que activar y trasladar se ordenan aquí y nunca se cruzan en la sede.
 */
export async function bloquearOrganizacion(tx: Tx, organizationId: string, presupuesto: PresupuestoDeEspera): Promise<void> {
  await tomarCandado(
    tx,
    () => tx.$queryRaw(Prisma.sql`SELECT id FROM "Organization" WHERE id = ${organizationId} FOR NO KEY UPDATE /* B9:organizacion */`),
    { presupuesto },
  )
}

/**
 * Lado ESCRITOR (r7.1): `FOR KEY SHARE` de cada sede a la que se le va a escribir historia de pago al personal (devengos o
 * ventanas), UNA POR UNA por id ascendente —nunca un solo `SELECT … ANY …`: `lock_timeout` vale por adquisición y varias
 * esperas en una sentencia se suman (Codex r7 #24)—, con el presupuesto de la transacción. Bajo el candado revalida que la
 * sede existe y sigue siendo de `organizationId`, también si ya está en el alcance del periodo: si no, 409
 * `SEDE_EN_OTRA_ORGANIZACION` y no se escribe nada.
 */
export async function bloquearSedesDeLaOrganizacion(
  tx: Tx,
  organizationId: string,
  venueIds: Iterable<string>,
  presupuesto: PresupuestoDeEspera,
): Promise<void> {
  for (const venueId of [...new Set(venueIds)].sort()) {
    const [fila] = await tomarCandado(
      tx,
      () =>
        tx.$queryRaw<Array<{ id: string; organizationId: string; name: string }>>(
          Prisma.sql`SELECT id, "organizationId", name FROM "Venue" WHERE id = ${venueId} FOR KEY SHARE /* B9:sede:escritor */`,
        ),
      { presupuesto },
    )
    if (!fila || fila.organizationId !== organizationId) {
      throw new ConflictError(`La sede ${fila?.name ?? venueId} ya no pertenece a esta organización`, 'SEDE_EN_OTRA_ORGANIZACION')
    }
  }
}

/**
 * Lado EXCLUSIVO (r7.1): `FOR UPDATE` de la sede, ANTES de mirar su historia. Devuelve su organización, o null si ya no
 * existe. Quien lo llama compara y luego pregunta `historiaDeSede` en otra sentencia.
 */
export async function bloquearSedeExclusiva(
  tx: Tx,
  venueId: string,
  presupuesto: PresupuestoDeEspera,
): Promise<{ organizationId: string } | null> {
  const [fila] = await tomarCandado(
    tx,
    () =>
      tx.$queryRaw<Array<{ organizationId: string }>>(
        Prisma.sql`SELECT "organizationId" FROM "Venue" WHERE id = ${venueId} FOR UPDATE /* B9:sede:exclusivo */`,
      ),
    { presupuesto },
  )
  return fila ?? null
}

/**
 * ¿La sede tiene historia de pago al personal? Alguna ventana (activa o ya cerrada) o algún devengo. Va SIEMPRE después del
 * `FOR UPDATE` de la sede, en otra sentencia. Con historia, la sede no se traslada ni se borra, y la limpieza de demos la
 * omite completa.
 */
export async function historiaDeSede(tx: Tx, venueId: string): Promise<boolean> {
  const [r] = await tx.$queryRaw<Array<{ hay: boolean }>>(Prisma.sql`
    SELECT (EXISTS (SELECT 1 FROM "StaffPayVenueWindow" WHERE "venueId" = ${venueId})
         OR EXISTS (SELECT 1 FROM "ServiceEarning" WHERE "venueId" = ${venueId})) AS hay`)
  return r?.hay === true
}

/** 409 de la barrera: una sede con historia de pago al personal no se traslada ni se borra (r5.3, r6.7). */
export function sedeConPagoAlPersonalError(accion: 'trasladar' | 'borrar'): ConflictError {
  const que = accion === 'trasladar' ? 'trasladar a otra organización' : 'borrar'
  return new ConflictError(`Esta sede tiene historial de pago al personal; no se puede ${que}`, 'SEDE_CON_PAGO_AL_PERSONAL')
}

/** La limpieza de demos omite completa una demo con historia de pago al personal (la transacción se revierte entera). */
export const LIVE_DEMO_CON_PAGO_AL_PERSONAL = 'LIVE_DEMO_CON_PAGO_AL_PERSONAL'
export const demoConPagoAlPersonalError = (): ConflictError =>
  new ConflictError('Esta sucursal demo tiene historial de pago al personal: la limpieza la omite completa', LIVE_DEMO_CON_PAGO_AL_PERSONAL)
