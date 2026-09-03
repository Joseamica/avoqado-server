import { DateTime } from 'luxon'
import { Prisma, BirthdayAutomationStatus, CustomerCampaignDeliveryStatus } from '@prisma/client'

import prisma from '@/utils/prismaClient'
import logger from '@/config/logger'
import { venueHasFeatureAccess } from '@/services/access/basePlan.service'
import { fechasPendientes, cumpleanosAFelicitar, aniversarioNormalizado } from './birthdaySchedule'

/**
 * Barrido del cumpleaños automático: encola las felicitaciones que tocan hoy.
 *
 * NO manda correos — sólo pone deliveries `PENDING` en la MISMA cola que las campañas
 * puntuales. El carril de envío (scheduler + sender de la fase 1A) las recoge igual,
 * con su reparto justo, su cuota y su backoff. Reusar esa cola es lo que hace que el
 * cumpleaños herede toda la robustez que ya se probó ahí.
 *
 * 🔴 Tres candados, y ninguno es opcional:
 *
 *  1. **Advisory lock por venue** (`pg_advisory_xact_lock`, el patrón del repo): dos
 *     workers no evalúan la misma fecha del mismo negocio.
 *  2. **CAS sobre el cursor**: sólo avanza si nadie lo movió mientras tanto. El lock por
 *     sí solo no basta si el proceso muere entre leer y escribir.
 *  3. **Se revalida el PLAN en cada barrido**, no sólo al encender: un negocio que dejó
 *     de pagar deja de mandar correos ese mismo día, sin que nadie tenga que apagarlo.
 */

/** Feature de plan (PRO) que habilita las campañas de correo, cumpleaños incluido. */
const FEATURE = 'CUSTOMER_CAMPAIGNS'

export interface ResultadoBarrido {
  automatizacionesRevisadas: number
  encoladas: number
  /** Venues saltados, con su porqué — se reporta, nunca se descarta en silencio. */
  saltados: { venueId: string; motivo: string }[]
}

/** La fecha civil de HOY en la zona del venue. `null` si la zona no es utilizable. */
export function hoyEnElVenue(timezone: string | null | undefined, ahora: Date): string | null {
  // 🔴 Sin zona válida NO se adivina. Caer a México en silencio felicitaría el día
  // equivocado en un venue de Tijuana o de Cancún, y nadie se enteraría: el correo
  // saldría, sólo que el día que no era.
  if (!timezone) return null
  const dt = DateTime.fromJSDate(ahora, { zone: timezone })
  return dt.isValid ? dt.toFormat('yyyy-MM-dd') : null
}

/**
 * `dedupeKey` de una felicitación. El año del ANIVERSARIO, no el año en curso: una
 * felicitación adelantada en diciembre para un cumpleaños de enero pertenece al año
 * siguiente, y usar el año en curso la duplicaría al cruzar el 31 de diciembre.
 */
export function claveDeDedupe(automationId: string, customerId: string, anniversaryYear: number): string {
  return `birthday:${automationId}:${customerId}:${anniversaryYear}`
}

export async function barrerCumpleanos(ahora: Date = new Date()): Promise<ResultadoBarrido> {
  const automatizaciones = await prisma.birthdayAutomation.findMany({
    where: { status: BirthdayAutomationStatus.ACTIVE },
    select: {
      id: true,
      venueId: true,
      daysBefore: true,
      lastEvaluatedLocalDate: true,
      venue: { select: { timezone: true, status: true } },
    },
  })

  const resultado: ResultadoBarrido = { automatizacionesRevisadas: automatizaciones.length, encoladas: 0, saltados: [] }

  for (const auto of automatizaciones) {
    try {
      const encoladas = await procesarUna(auto, ahora, resultado)
      resultado.encoladas += encoladas
    } catch (error: any) {
      // Un venue que falla no puede dejar sin felicitación a los demás.
      logger.error('Fallo el barrido de cumpleaños de un venue', { venueId: auto.venueId, error: error?.message })
      resultado.saltados.push({ venueId: auto.venueId, motivo: `error: ${error?.message ?? 'desconocido'}` })
    }
  }

  return resultado
}

type AutomatizacionDelBarrido = {
  id: string
  venueId: string
  daysBefore: number
  lastEvaluatedLocalDate: string | null
  venue: { timezone: string | null; status: string } | null
}

async function procesarUna(auto: AutomatizacionDelBarrido, ahora: Date, resultado: ResultadoBarrido): Promise<number> {
  const saltar = (motivo: string) => {
    resultado.saltados.push({ venueId: auto.venueId, motivo })
    return 0
  }

  if (auto.venue?.status !== 'ACTIVE') return saltar(`el venue no está ACTIVE (${auto.venue?.status ?? 'sin venue'})`)

  const hoy = hoyEnElVenue(auto.venue?.timezone, ahora)
  if (!hoy) return saltar('el venue no tiene una zona horaria utilizable')

  // 🔴 El PLAN se revalida en CADA barrido, no sólo al encender: quien dejó de pagar deja
  // de mandar hoy mismo.
  if (!(await venueHasFeatureAccess(auto.venueId, FEATURE))) return saltar('el venue ya no tiene el plan que incluye campañas')

  const fechas = fechasPendientes({ desde: auto.lastEvaluatedLocalDate, hoy, daysBefore: auto.daysBefore })
  if (fechas.length === 0) return 0

  return prisma.$transaction(async tx => {
    // Candado 1: nadie más evalúa este venue a la vez.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`h1a:birthday-sweep:${auto.venueId}`}, 0))`

    let encoladas = 0
    for (const fecha of fechas) {
      encoladas += await encolarFecha(tx, auto, fecha)
    }

    // Candado 2: CAS — sólo avanza si el cursor sigue donde lo dejamos. El lock protege
    // dentro de la transacción; esto protege de un proceso que murió a medias antes.
    const ultima = fechas[fechas.length - 1]
    const movido = await tx.birthdayAutomation.updateMany({
      where: { id: auto.id, lastEvaluatedLocalDate: auto.lastEvaluatedLocalDate },
      data: { lastEvaluatedLocalDate: ultima },
    })
    if (movido.count === 0) {
      // Otro worker ya lo avanzó: sus deliveries y las nuestras coinciden por dedupeKey,
      // así que no hay duplicados — pero se reporta, porque significa que dos barridos
      // corrieron juntos y eso conviene verlo.
      logger.warn('El cursor del cumpleaños ya lo había movido otro barrido', { venueId: auto.venueId })
    }
    return encoladas
  })
}

async function encolarFecha(tx: Prisma.TransactionClient, auto: AutomatizacionDelBarrido, fecha: string): Promise<number> {
  const objetivo = cumpleanosAFelicitar(fecha, auto.daysBefore)
  const [añoStr, mesStr, diaStr] = objetivo.split('-')
  const año = Number(añoStr)
  const mes = Number(mesStr)
  const dia = Number(diaStr)

  // Quien cumple años ese día. 🔴 Si el objetivo es 28-feb en un año NO bisiesto, también
  // entran los nacidos el 29 — su aniversario se normaliza a ese día (ver birthdaySchedule).
  const esFebrero28NoBisiesto = mes === 2 && dia === 28 && !DateTime.fromObject({ year: año }).isInLeapYear
  const dias = esFebrero28NoBisiesto ? [28, 29] : [dia]

  const candidatos = await tx.$queryRaw<{ id: string; birthDate: Date }[]>`
    SELECT c."id", c."birthDate"
    FROM "Customer" c
    WHERE c."venueId" = ${auto.venueId}
      AND c."active" = true
      AND c."marketingConsent" = true
      AND c."birthDate" IS NOT NULL
      AND EXTRACT(MONTH FROM c."birthDate") = ${mes}
      AND EXTRACT(DAY FROM c."birthDate") = ANY(${dias})
      -- 🔴 Consentimiento DEMOSTRABLE: no basta la casilla en Customer, tiene que existir
      -- el evento que lo registró. Es el mismo candado que usa el encolado de las campañas
      -- puntuales; sin él, un marketingConsent en true heredado de datos viejos bastaría.
      AND EXISTS (
        SELECT 1 FROM "ConsentEvent" ce
        WHERE ce."customerId" = c."id" AND ce."venueId" = ${auto.venueId} AND ce."action" = 'GRANTED'
      )
      -- Y nunca a quien rebotó o se quejó: la supresión es GLOBAL, entre venues.
      AND NOT EXISTS (
        SELECT 1 FROM "EmailSuppression" s WHERE lower(s."email") = lower(c."email")
      )
      AND c."email" IS NOT NULL AND c."email" <> ''
    LIMIT 5000
  `

  if (candidatos.length === 0) return 0

  const filas = candidatos.map(c => ({
    automationId: auto.id,
    customerId: c.id,
    venueId: auto.venueId,
    // El año del ANIVERSARIO, no el actual: una felicitación adelantada en diciembre para
    // un cumpleaños de enero pertenece al año siguiente.
    dedupeKey: claveDeDedupe(auto.id, c.id, año),
    status: CustomerCampaignDeliveryStatus.PENDING,
  }))

  // `skipDuplicates` sobre el unique de `dedupeKey`: el barrido es idempotente, así que
  // repetirlo el mismo día no vuelve a felicitar a nadie.
  const creadas = await tx.customerCampaignDelivery.createMany({ data: filas, skipDuplicates: true })
  return creadas.count
}
