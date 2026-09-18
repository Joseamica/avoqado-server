/**
 * S10 — «Activar cobros»: lo que salió del alta corta y ahora se captura después
 * (spec 2026-09-17 § 4.2).
 *
 * 🔴 LA PIEZA QUE NO SE PUEDE OLVIDAR, y por eso está primero: **`venueAddress` es la ÚNICA
 * captura de la dirección del local que queda en todo el producto** una vez que el alta corta
 * la retira. Las cuatro columnas son nulables, así que nada revienta si falta: simplemente
 * ningún local nacido por el flujo corto tendría dirección jamás, y su ticket saldría sin ella.
 *
 * 🔴 Y la segunda: la CLABE se ESPEJA en `step8_paymentInfo`, que es de donde la lee la revisión
 * de KYC. Hoy la CLABE capturada en V2 no llega nunca a esa revisión — es un defecto existente.
 */
import { EntityType, Prisma } from '@prisma/client'
import prisma from '../../utils/prismaClient'
import { BadRequestError, ForbiddenError, NotFoundError } from '../../errors/AppError'
import { getBankNameFromCLABE, validateCLABE } from '../../utils/clabeValidator'
import { logAction } from './activity-log.service'

/** RFC de persona física (13) o moral (12), en mayúsculas. */
const RFC_RE = /^[A-ZÑ&]{3,4}\d{6}[A-Z0-9]{3}$/
const CURP_RE = /^[A-Z]{4}\d{6}[HM][A-Z]{5}[A-Z0-9]\d$/

export interface PaymentActivationProfileInput {
  entity?: { entityType: string; entitySubType?: string | null; commercialName?: string | null }
  identity?: {
    legalFirstName: string
    legalLastName: string
    rfc?: string | null
    curp?: string | null
    birthdate?: string | null
    personalPhone?: string | null
    legalAddress?: string | null
    legalCity?: string | null
    legalState?: string | null
    legalCountry?: string | null
    legalZipCode?: string | null
  }
  /** La dirección del LOCAL (§4.2). Es lo que el alta corta ya no pide. */
  venueAddress?: { address: string; city: string; state: string; zipCode: string; country?: string | null }
  bank?: { clabe: string; accountHolder: string; accountType?: string | null; bankName?: string | null }
}

/**
 * OWNER o ADMIN activo de ESE local, o SUPERADMIN. La misma regla que `venueKyc.service.ts`:
 * no se estrena un nombre de permiso, así que no hay nada que espejear en el dashboard.
 */
export async function assertPaymentActivationAccess(venueId: string, staffId: string, role?: string): Promise<{ organizationId: string }> {
  const venue = await prisma.venue.findUnique({ where: { id: venueId }, select: { id: true, organizationId: true } })
  if (!venue) throw new NotFoundError('No encontramos este negocio')
  if (role === 'SUPERADMIN') return { organizationId: venue.organizationId }

  const asignacion = await prisma.staffVenue.findFirst({
    where: { venueId, staffId, active: true, role: { in: ['OWNER', 'ADMIN'] } },
    select: { id: true },
  })
  if (!asignacion) throw new ForbiddenError('Solo el dueño o un administrador de este negocio puede activar los cobros')
  return { organizationId: venue.organizationId }
}

/**
 * El nombre del banco que acompaña a la cuenta.
 *
 * 🔴 POR QUÉ EXISTE: `kycReview.service.ts:227` hace `bankName: paymentInfo?.bankName || null`, y
 * eso es lo que viaja a la hoja de Blumon. Sin este dato, TODO local nacido del alta corta llega a
 * la revisión con el banco vacío — y este endpoint existe justamente para que nada se pierda
 * cuando el alta corta retira los pasos 7 y 8 (§4.2).
 *
 * Dos reglas, en este orden:
 *  1. **Manda lo que escribió la persona.** En el `BankAccountStep` el campo es editable, así que
 *     un nombre tecleado es una corrección deliberada y no se pisa.
 *  2. **Si no mandó nada, se DERIVA de los tres primeros dígitos de la CLABE**, que por
 *     definición de Banxico SON el código del banco. Fuera del catálogo se devuelve `null` y no
 *     el literal `'Unknown'` del utilitario: un hueco es honesto, un texto inventado en inglés
 *     dentro de un documento que lee una persona, no.
 */
function nombreDelBanco(bank: { clabe: string; bankName?: string | null }): string | null {
  const declarado = bank.bankName?.trim()
  if (declarado) return declarado
  const derivado = getBankNameFromCLABE(bank.clabe.replace(/\s/g, ''))
  return derivado === 'Unknown' ? null : derivado
}

/** Enmascara un RFC dejando los 3 primeros y los 3 últimos: `XAXX••••••00X`. */
function enmascararRfc(rfc: string | null): string | null {
  if (!rfc) return null
  if (rfc.length <= 6) return '•'.repeat(rfc.length)
  return `${rfc.slice(0, 3)}${'•'.repeat(rfc.length - 6)}${rfc.slice(-3)}`
}

export async function getPaymentActivation(venueId: string) {
  const venue = await prisma.venue.findUnique({
    where: { id: venueId },
    select: {
      id: true,
      organizationId: true,
      kycStatus: true,
      entityType: true,
      legalName: true,
      rfc: true,
      address: true,
      city: true,
      state: true,
      zipCode: true,
      idDocumentUrl: true,
      rfcDocumentUrl: true,
      comprobanteDomicilioUrl: true,
      caratulaBancariaUrl: true,
      actaDocumentUrl: true,
      poderLegalUrl: true,
    },
  })
  if (!venue) throw new NotFoundError('No encontramos este negocio')

  const progress = await prisma.onboardingProgress.findUnique({
    where: { organizationId: venue.organizationId },
    select: { v2SetupData: true, step8_paymentInfo: true },
  })
  const v2 = (progress?.v2SetupData ?? {}) as Record<string, Record<string, unknown> | undefined>
  const identidad = (v2.step5 ?? {}) as Record<string, unknown>
  const banco = (v2.step7 ?? (progress?.step8_paymentInfo as Record<string, unknown> | null) ?? {}) as Record<string, unknown>

  const clabe = typeof banco.clabe === 'string' ? banco.clabe : null
  const legalAddressPresent = typeof identidad.legalAddress === 'string' && identidad.legalAddress.trim().length > 0
  const direccionDelLocal = Boolean(venue.address && venue.city && venue.state && venue.zipCode)

  const [terminalsCount, ecommerce] = await Promise.all([
    prisma.terminal.count({ where: { venueId } }),
    // «Cobros en línea listos» = hay un comerciante de ecommerce con su alta COMPLETADA. Es la
    // misma señal que ya usa el checklist del Home del dashboard.
    prisma.ecommerceMerchant.findFirst({ where: { venueId, onboardingStatus: 'COMPLETED' }, select: { id: true } }),
  ])

  const complete = Boolean(venue.entityType && venue.legalName && venue.rfc && legalAddressPresent && clabe && direccionDelLocal)

  return {
    kycStatus: venue.kycStatus,
    entityType: venue.entityType,
    profile: {
      entityType: venue.entityType,
      legalName: venue.legalName,
      // 🔴 Nunca el RFC entero ni la CLABE entera: esta respuesta la lee el navegador (§7.8).
      rfcMasked: enmascararRfc(venue.rfc),
      curpPresent: typeof identidad.curp === 'string' && identidad.curp.length > 0,
      legalAddressPresent,
      venueAddressPresent: direccionDelLocal,
      clabeLast4: clabe ? clabe.slice(-4) : null,
      bankName: typeof banco.bankName === 'string' ? banco.bankName : null,
      complete,
    },
    documents: {
      required: ['ine', 'rfc', 'comprobanteDomicilio', 'caratulaBancaria'],
      uploaded: [
        venue.idDocumentUrl ? 'ine' : null,
        venue.rfcDocumentUrl ? 'rfc' : null,
        venue.comprobanteDomicilioUrl ? 'comprobanteDomicilio' : null,
        venue.caratulaBancariaUrl ? 'caratulaBancaria' : null,
        venue.actaDocumentUrl ? 'actaConstitutiva' : null,
        venue.poderLegalUrl ? 'poderLegal' : null,
      ].filter((x): x is string => x !== null),
    },
    terminalsCount,
    onlinePaymentsConnected: Boolean(ecommerce),
  }
}

export async function updatePaymentActivationProfile(
  venueId: string,
  organizationId: string,
  input: PaymentActivationProfileInput,
  staffId: string,
) {
  const secciones: string[] = []

  // ---- Validación, toda ANTES de escribir nada ----
  if (input.entity) {
    if (!Object.values(EntityType).includes(input.entity.entityType as EntityType)) {
      throw new BadRequestError('El tipo de persona no es válido', 'INVALID_ENTITY_TYPE')
    }
    secciones.push('entity')
  }
  if (input.identity) {
    const rfc = input.identity.rfc?.trim().toUpperCase()
    if (rfc && !RFC_RE.test(rfc)) throw new BadRequestError('El RFC no tiene un formato válido', 'INVALID_RFC')
    const curp = input.identity.curp?.trim().toUpperCase()
    if (curp && !CURP_RE.test(curp)) throw new BadRequestError('La CURP no tiene un formato válido', 'INVALID_CURP')
    secciones.push('identity')
  }
  if (input.venueAddress) {
    const { address, city, state, zipCode } = input.venueAddress
    if (!address?.trim() || !city?.trim() || !state?.trim() || !zipCode?.trim()) {
      throw new BadRequestError('La dirección del negocio necesita calle, ciudad, estado y código postal', 'INVALID_VENUE_ADDRESS')
    }
    secciones.push('venueAddress')
  }
  if (input.bank) {
    // 🔴 `validateCLABE` comprueba el DÍGITO VERIFICADOR, no sólo el largo: una CLABE con un
    // dedazo pasa cualquier `length === 18` y el depósito se pierde.
    // ⚠️ `validateCLABE` devuelve un BOOLEANO, no un objeto `{isValid}`. Escribirlo como objeto
    // compila (un booleano no tiene `.isValid`, pero TypeScript lo deja pasar en un `!r.isValid`
    // sobre `any`) y rechaza TODA CLABE, incluidas las buenas. Lo cazó la prueba de esta misma
    // tanda con una CLABE válida de verdad.
    if (!validateCLABE(input.bank.clabe)) {
      throw new BadRequestError('La CLABE no es válida: revisa el número', 'INVALID_CLABE')
    }
    if (!input.bank.accountHolder?.trim()) throw new BadRequestError('Falta el titular de la cuenta', 'INVALID_ACCOUNT_HOLDER')
    secciones.push('bank')
  }
  if (secciones.length === 0) throw new BadRequestError('No mandaste nada que guardar', 'NOTHING_TO_UPDATE')

  const progress = await prisma.onboardingProgress.findUnique({
    where: { organizationId },
    select: { v2SetupData: true, step8_paymentInfo: true },
  })
  const v2 = (progress?.v2SetupData ?? {}) as Record<string, unknown> as Record<string, Record<string, unknown>>

  // 🔴 Se FUSIONA por sección y NO se tocan `currentStep` ni `completedSteps`: este checklist
  // vive DESPUÉS del alta, y mover el puntero del asistente mandaría a alguien que ya terminó
  // de vuelta a una pantalla del alta.
  const v2Nuevo: Record<string, unknown> = { ...v2 }
  if (input.entity) v2Nuevo.step4 = { ...(v2.step4 ?? {}), ...input.entity }
  if (input.identity) v2Nuevo.step5 = { ...(v2.step5 ?? {}), ...input.identity }
  if (input.bank) v2Nuevo.step7 = { ...(v2.step7 ?? {}), ...input.bank, bankName: nombreDelBanco(input.bank) }

  const bancoActual = (progress?.step8_paymentInfo ?? {}) as Record<string, unknown>

  await prisma.$transaction(async tx => {
    if (input.entity || input.identity || input.venueAddress) {
      const data: Prisma.VenueUpdateInput = {}
      if (input.entity) data.entityType = input.entity.entityType as EntityType
      if (input.identity) {
        if (input.identity.rfc) data.rfc = input.identity.rfc.trim().toUpperCase()
        // La misma regla del alta: el nombre comercial manda, y si no hay, nombre + apellidos.
        const legal = input.entity?.commercialName?.trim() || `${input.identity.legalFirstName} ${input.identity.legalLastName}`.trim()
        if (legal) data.legalName = legal
      }
      if (input.venueAddress) {
        data.address = input.venueAddress.address.trim()
        data.city = input.venueAddress.city.trim()
        data.state = input.venueAddress.state.trim()
        data.zipCode = input.venueAddress.zipCode.trim()
      }
      if (Object.keys(data).length > 0) await tx.venue.update({ where: { id: venueId }, data })
    }

    await tx.onboardingProgress.update({
      where: { organizationId },
      data: {
        v2SetupData: v2Nuevo as Prisma.InputJsonValue,
        // 🔴 EL ESPEJO. `step8_paymentInfo` es lo que lee la revisión de KYC; sin esta línea, la
        // CLABE capturada aquí no llega nunca a quien la necesita para dar de alta la cuenta.
        ...(input.bank
          ? {
              step8_paymentInfo: {
                ...bancoActual,
                clabe: input.bank.clabe,
                accountHolder: input.bank.accountHolder,
                // 🔴 SIEMPRE se escribe, incluso `null`: este espejo describe la cuenta de HOY.
                // Dejar el banco anterior cuando la CLABE cambió le pondría al revisor el nombre
                // de OTRO banco encima de la cuenta nueva, que es peor que un hueco.
                bankName: nombreDelBanco(input.bank),
                ...(input.bank.accountType ? { accountType: input.bank.accountType } : {}),
              } as Prisma.InputJsonValue,
            }
          : {}),
      },
    })
  })

  // 🔴 La bitácora registra QUÉ SECCIONES se tocaron, nunca los valores: son datos fiscales.
  await logAction({
    staffId,
    venueId,
    organizationId,
    action: 'PAYMENT_ACTIVATION_PROFILE_UPDATED',
    entity: 'Venue',
    entityId: venueId,
    data: { sections: secciones },
  })

  return getPaymentActivation(venueId)
}
