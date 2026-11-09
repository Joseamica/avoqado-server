/**
 * Códigos por persona (App de campo, bloque 1): el supervisor genera un código de 6 caracteres por promotor, que vale
 * 7 días y se gasta al vincular su celular. Un código por persona: generar otro reemplaza al anterior.
 */
import { Prisma } from '@prisma/client'
import prisma from '@/utils/prismaClient'
import { logAction } from '@/services/dashboard/activity-log.service'
import { generateSecureCode } from '@/services/dashboard/terminal-activation.service'
import { esPromotorDeCampo, sucursalesConCampo, sucursalesDeLaPersona } from './personasDeCampo'

export const VIGENCIA_DEL_CODIGO_MS = 7 * 24 * 60 * 60 * 1000
export const INTENTOS_DEL_CODIGO = 5
const TOPE_POR_LLAMADA = 200
const REINTENTOS_POR_CHOQUE = 3

export type CodigoGenerado = { staffId: string; nombre: string; telefono: string | null; codigo: string; expiraAt: string }
export type GenerarCodigosParams = { organizationId: string; generadoPor: string; staffIds?: string[]; todosLosSinCelular?: boolean }
type Persona = { id: string; firstName: string; lastName: string; phone: string | null }

async function generarUno(organizationId: string, generadoPor: string, persona: Persona): Promise<CodigoGenerado> {
  const expiraAt = new Date(Date.now() + VIGENCIA_DEL_CODIGO_MS)
  for (let intento = 1; ; intento++) {
    const codigo = generateSecureCode(6)
    const datos = { codigo, expiraAt, intentos: 0, generadoPor, usadoAt: null, usadoPorAparatoId: null, anuladoAt: null }
    try {
      await prisma.codigoDeCelular.upsert({
        where: { organizationId_staffId: { organizationId, staffId: persona.id } },
        create: { organizationId, staffId: persona.id, ...datos },
        update: datos,
      })
    } catch (e) {
      // El único de `codigo` chocó con el de otra persona: se saca otro.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002' && intento < REINTENTOS_POR_CHOQUE) continue
      throw e
    }
    const sucursales = await sucursalesDeLaPersona(persona.id, organizationId)
    // Sin el código: la bitácora no guarda secretos.
    void logAction({
      staffId: generadoPor,
      venueId: sucursales[0]?.venueId ?? null,
      organizationId,
      action: 'CAMPO_CODIGO_GENERADO',
      entity: 'Staff',
      entityId: persona.id,
      data: { expiraAt: expiraAt.toISOString() },
    })
    return {
      staffId: persona.id,
      nombre: `${persona.firstName} ${persona.lastName}`.trim(),
      telefono: persona.phone,
      codigo,
      expiraAt: expiraAt.toISOString(),
    }
  }
}

/** Promotores de la org sin celular vinculado y sin código vivo. */
async function promotoresSinCelular(organizationId: string): Promise<Persona[]> {
  const venueIds = await sucursalesConCampo(organizationId)
  if (venueIds.length === 0) return []
  const [personas, vinculados, conCodigoVivo] = await Promise.all([
    prisma.staff.findMany({
      where: { active: true, venues: { some: { active: true, role: { in: ['WAITER', 'CASHIER'] }, venueId: { in: venueIds } } } },
      select: { id: true, firstName: true, lastName: true, phone: true },
      orderBy: { id: 'asc' },
    }),
    prisma.celularDeCampo.findMany({ where: { organizationId, staffIdVinculado: { not: null } }, select: { staffId: true } }),
    prisma.codigoDeCelular.findMany({
      where: { organizationId, usadoAt: null, anuladoAt: null, expiraAt: { gt: new Date() } },
      select: { staffId: true },
    }),
  ])
  const fuera = new Set([...vinculados, ...conCodigoVivo].map(f => f.staffId))
  return personas.filter(p => !fuera.has(p.id))
}

export async function generarCodigos(p: GenerarCodigosParams) {
  const generados: CodigoGenerado[] = []
  const omitidos: { staffId: string; motivo: 'NO_ES_PROMOTOR' }[] = []
  let restantes = 0

  if (p.todosLosSinCelular) {
    const todos = await promotoresSinCelular(p.organizationId)
    for (const persona of todos.slice(0, TOPE_POR_LLAMADA)) generados.push(await generarUno(p.organizationId, p.generadoPor, persona))
    restantes = Math.max(0, todos.length - TOPE_POR_LLAMADA)
  } else {
    for (const staffId of p.staffIds ?? []) {
      const persona = (await esPromotorDeCampo(staffId, p.organizationId))
        ? await prisma.staff.findUnique({ where: { id: staffId }, select: { id: true, firstName: true, lastName: true, phone: true } })
        : null
      if (!persona) omitidos.push({ staffId, motivo: 'NO_ES_PROMOTOR' })
      else generados.push(await generarUno(p.organizationId, p.generadoPor, persona))
    }
  }
  return { generados, omitidos, restantes }
}
