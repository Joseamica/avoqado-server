/**
 * Un celular de campo VINCULADO con su sesión viva, para las pruebas de integración de las rutas `/tpv/campo/venues/*`
 * (que desde el bloque 1 sólo aceptan la sesión del celular). Usa la `crearSesionDeCelular` real: la `Session`
 * `celular:<id>`, su refresh y la `sesionId` quedan en la base igual que al entrar con el PIN.
 *
 * La persona tiene UN celular vinculado (el único de `staffIdVinculado`): si ya tenía uno, se desvincula y su sesión muere.
 * Limpieza de quien llama: `celularDeCampo`, `refreshGrant` y `session` de la persona.
 */
import { CelularDeCampo, StaffRole } from '@prisma/client'
import { randomBytes } from 'crypto'
import { newCommandCredential } from '@/services/tpv/command-credential.service'
import { crearSesionDeCelular, revocarSesionesDelCelular } from '@/services/tpv/campo/celular/sesionDeCelular'
import prisma from '@/utils/prismaClient'

export async function crearCelularConSesion(p: {
  staffId: string
  organizationId: string
  venueId: string
  role: StaffRole
}): Promise<{ celular: CelularDeCampo; credencial: string; token: string }> {
  const anteriores = await prisma.celularDeCampo.findMany({ where: { staffIdVinculado: p.staffId }, select: { id: true } })
  for (const a of anteriores) {
    await prisma.celularDeCampo.update({
      where: { id: a.id },
      data: { staffIdVinculado: null, sesionId: null, desvinculadoAt: new Date(), motivoDesvinculo: 'CELULAR_NUEVO' },
    })
    await revocarSesionesDelCelular(a.id, 'prueba_celular_nuevo')
  }

  const { token: credencial, hash } = newCommandCredential()
  const creado = await prisma.celularDeCampo.create({
    data: {
      organizationId: p.organizationId,
      staffId: p.staffId,
      staffIdVinculado: p.staffId,
      credencialHash: hash,
      pinSal: randomBytes(16).toString('base64'),
      aparatoId: `aparato-de-prueba-${randomBytes(6).toString('hex')}`,
    },
  })
  const sesion = await crearSesionDeCelular(creado, { venueId: p.venueId, role: p.role })
  const celular = await prisma.celularDeCampo.findUniqueOrThrow({ where: { id: creado.id } })
  return { celular, credencial, token: sesion.accessToken }
}
