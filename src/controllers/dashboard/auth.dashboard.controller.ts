import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../../utils/prismaClient' // Corrected import path
import { AuthenticationError } from '../../errors/AppError'
import { StaffRole } from '@prisma/client'
import { UpdateAccountDto } from '../../schemas/dashboard/auth.schema'
import logger from '../../config/logger'
import * as authService from '../../services/dashboard/auth.service'
import bcrypt from 'bcrypt'
import { DEFAULT_PERMISSIONS } from '../../lib/permissions'

/**
 * Endpoint para verificar el estado de autenticación de un usuario.
 * Adaptado para el nuevo schema de Avoqado con Staff y StaffVenue.
 *
 * @param {Request} req - El objeto de la solicitud de Express.
 * @param {Response} res - El objeto de la respuesta de Express.
 */
export const getAuthStatus = async (req: Request, res: Response) => {
  const token = req.cookies?.accessToken // Consistente con el login

  if (!token) {
    return res.status(200).json({
      authenticated: false,
      user: null,
    })
  }

  try {
    const decoded = jwt.verify(token, process.env.ACCESS_TOKEN_SECRET!) as any

    // Buscar staff con venues
    const staff = await prisma.staff.findUnique({
      where: { id: decoded.sub },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        emailVerified: true,
        photoUrl: true,
        phone: true,
        organizationId: true,
        createdAt: true,
        lastLoginAt: true,
        venues: {
          where: { active: true },
          select: {
            role: true,
            venue: {
              select: {
                id: true,
                name: true,
                slug: true,
                logo: true,
                isOnboardingDemo: true,
                kycStatus: true, // Include KYC status for access control
                features: {
                  select: {
                    active: true,
                    feature: {
                      select: {
                        code: true,
                        name: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!staff) {
      res.clearCookie('accessToken') // Nombre correcto
      return res.status(200).json({
        authenticated: false,
        user: null,
      })
    }

    // Define venue type with features and role
    interface VenueWithFeatures {
      id: string
      name: string
      slug: string
      logo: string | null
      role?: any
      isOnboardingDemo?: boolean
      kycStatus?: string | null // Include KYC verification status
      features?: any[]
    }

    // Check if user is a SUPERADMIN in any venue
    const isSuperAdmin = staff.venues.some(sv => sv.role === StaffRole.SUPERADMIN)
    const isOwner = staff.venues.some(sv => sv.role === StaffRole.OWNER)
    let allVenues: VenueWithFeatures[] = []
    const directVenues: VenueWithFeatures[] = staff.venues.map(sv => ({
      id: sv.venue.id,
      name: sv.venue.name,
      slug: sv.venue.slug,
      logo: sv.venue.logo,
      role: sv.role,
      isOnboardingDemo: sv.venue.isOnboardingDemo,
      kycStatus: sv.venue.kycStatus, // Include KYC status
      features: sv.venue.features, // Incluir las features
    }))

    // Create a map of venue IDs that user already has a direct relationship with
    const directVenueIds = new Set(directVenues.map(v => v.id))

    // Fetch custom role permissions for direct venues
    const venueIds = staff.venues.map(sv => sv.venue.id)
    const customRolePermissions = await prisma.venueRolePermission.findMany({
      where: {
        venueId: { in: venueIds },
      },
      select: {
        venueId: true,
        role: true,
        permissions: true,
      },
    })

    // If SUPERADMIN, fetch all venues in the system
    if (isSuperAdmin) {
      const allSystemVenues = await prisma.venue.findMany({
        where: { active: true },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          isOnboardingDemo: true,
          kycStatus: true, // Include KYC status
          features: {
            select: {
              active: true,
              feature: {
                select: {
                  code: true,
                  name: true,
                },
              },
            },
          },
        },
      })

      allVenues = allSystemVenues.map(venue => ({
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        isOnboardingDemo: venue.isOnboardingDemo,
        kycStatus: venue.kycStatus, // Include KYC status
        features: venue.features,
      }))

      // Add all system venues to user's venues array (if not already there)
      // with SUPERADMIN role
      for (const venue of allVenues) {
        if (!directVenueIds.has(venue.id)) {
          directVenues.push({
            ...venue,
            role: StaffRole.SUPERADMIN,
          })
        }
      }
    } else if (isOwner) {
      // For OWNER, fetch all venues in their organization
      const orgVenues = await prisma.venue.findMany({
        where: {
          organizationId: staff.organizationId,
          active: true,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          isOnboardingDemo: true,
          kycStatus: true, // Include KYC status
          features: {
            select: {
              active: true,
              feature: {
                select: {
                  code: true,
                  name: true,
                },
              },
            },
          },
        },
      })

      allVenues = orgVenues.map(venue => ({
        id: venue.id,
        name: venue.name,
        slug: venue.slug,
        logo: venue.logo,
        isOnboardingDemo: venue.isOnboardingDemo,
        kycStatus: venue.kycStatus, // Include KYC status
        features: venue.features,
      }))

      // Add all organization venues to user's venues array (if not already there)
      // with OWNER role
      for (const venue of allVenues) {
        if (!directVenueIds.has(venue.id)) {
          directVenues.push({
            ...venue,
            role: StaffRole.OWNER,
          })
        }
      }
    }

    // Determine highest role
    let highestRole = staff.venues.length > 0 ? staff.venues[0].role : null
    if (isSuperAdmin) {
      highestRole = StaffRole.SUPERADMIN
    } else if (staff.venues.some(sv => sv.role === StaffRole.OWNER)) {
      highestRole = StaffRole.OWNER
    }

    // Enrich all venues with custom role permissions
    const enrichedVenues = directVenues.map(venue => {
      const customPerms = customRolePermissions.find(crp => crp.venueId === venue.id && crp.role === venue.role)

      // If custom permissions exist, use them; otherwise use defaults
      const permissions = customPerms ? (customPerms.permissions as string[]) : DEFAULT_PERMISSIONS[venue.role as StaffRole] || []

      return {
        ...venue,
        permissions, // Add permissions to each venue
      }
    })

    // Formatear respuesta
    const userPayload = {
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      email: staff.email,
      emailVerified: staff.emailVerified, // Changed from isVerified to emailVerified for frontend compatibility
      photoUrl: staff.photoUrl,
      phone: staff.phone,
      organizationId: staff.organizationId,
      role: highestRole, // Add explicit role field
      createdAt: staff.createdAt,
      lastLogin: staff.lastLoginAt,
      venues: enrichedVenues, // Use enriched venues with permissions
    }

    return res.status(200).json({
      authenticated: true,
      user: userPayload,
      allVenues: isSuperAdmin || highestRole === StaffRole.OWNER ? allVenues : [], // Provide all venues for SUPERADMIN and OWNER
    })
  } catch (error) {
    res.clearCookie('accessToken')

    if (error instanceof jwt.TokenExpiredError) {
      return res.status(200).json({
        authenticated: false,
        user: null,
        message: 'Token expired',
      })
    }

    return res.status(200).json({
      authenticated: false,
      user: null,
    })
  }
}

export async function dashboardLoginController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const loginData = req.body

    // Llamar al servicio
    const { accessToken, refreshToken, staff } = await authService.loginStaff(loginData)

    // Establecer cookies
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: 15 * 60 * 1000, // 15 minutos
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    // Respuesta exitosa
    res.status(200).json({
      success: true,
      message: 'Login exitoso',
      user: staff, // Ya viene sanitizado del servicio
    })
  } catch (error) {
    next(error)
  }
}

export const dashboardLogoutController = async (req: Request, res: Response) => {
  try {
    // Limpiar cookies con las mismas opciones
    res.clearCookie('accessToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    // Destruir sesión si existe
    if (req.session) {
      req.session.destroy(err => {
        if (err) {
          logger.error('Error al destruir sesión:', err)
        }
      })
    }

    res.status(200).json({
      success: true,
      message: 'Logout exitoso',
    })
  } catch (error) {
    logger.error('Error en logout:', error)
    throw new AuthenticationError('Error al cerrar sesión')
  }
}

export async function switchVenueController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const { venueId: targetVenueId } = req.body
    const staffId = req.authContext?.userId
    const orgId = req.authContext?.orgId

    if (!staffId || !orgId) {
      // Este error no debería ocurrir si el middleware de autenticación funciona
      throw new AuthenticationError('Contexto de autenticación inválido.')
    }

    // Llamar al servicio para realizar la lógica y obtener los nuevos tokens
    const { accessToken, refreshToken } = await authService.switchVenueForStaff(staffId, orgId, targetVenueId)

    // Establecer las nuevas cookies, sobrescribiendo las anteriores
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: 15 * 60 * 1000, // 15 minutos
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
      path: '/', // Ajusta el path si tu ruta de refresh es específica
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    res.status(200).json({ success: true, message: 'Contexto de venue actualizado correctamente.' })
  } catch (error) {
    next(error)
  }
}

export async function updateAccountController(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const updateData = req.body as UpdateAccountDto
    const staffId = req.authContext?.userId

    if (!staffId) {
      throw new AuthenticationError('Usuario no autenticado.')
    }

    // Buscar el staff actual
    const currentStaff = await prisma.staff.findUnique({
      where: { id: staffId },
      select: { password: true, email: true },
    })

    if (!currentStaff) {
      throw new AuthenticationError('Usuario no encontrado.')
    }

    // Preparar datos de actualización
    const updateFields: any = {}

    // Actualizar campos básicos si se proporcionan
    if (updateData.firstName) updateFields.firstName = updateData.firstName
    if (updateData.lastName) updateFields.lastName = updateData.lastName
    if (updateData.phone) updateFields.phone = updateData.phone
    if (updateData.email && updateData.email !== currentStaff.email) {
      // Verificar que el nuevo email no esté en uso
      const existingStaff = await prisma.staff.findUnique({
        where: { email: updateData.email },
      })
      if (existingStaff && existingStaff.id !== staffId) {
        res.status(400).json({
          success: false,
          message: 'El correo electrónico ya está en uso por otro usuario.',
        })
        return
      }
      updateFields.email = updateData.email
    }

    // Manejar cambio de contraseña
    if (updateData.password && updateData.old_password) {
      // Verificar contraseña actual
      const isValidPassword = await bcrypt.compare(updateData.old_password, currentStaff.password || '')
      if (!isValidPassword) {
        res.status(400).json({
          success: false,
          message: 'La contraseña actual es incorrecta.',
        })
        return
      }

      // Hashear nueva contraseña
      const saltRounds = 10
      const hashedPassword = await bcrypt.hash(updateData.password, saltRounds)
      updateFields.password = hashedPassword
    }

    // Actualizar el staff
    const updatedStaff = await prisma.staff.update({
      where: { id: staffId },
      data: updateFields,
      select: {
        id: true,
        firstName: true,
        lastName: true,
        email: true,
        phone: true,
        emailVerified: true,
        photoUrl: true,
        createdAt: true,
        updatedAt: true,
      },
    })

    logger.info(`Staff profile updated successfully`, {
      staffId,
      updatedFields: Object.keys(updateFields),
    })

    res.status(200).json({
      success: true,
      message: 'Perfil actualizado correctamente.',
      user: updatedStaff,
    })
  } catch (error) {
    logger.error('Error updating staff profile:', error)
    next(error)
  }
}
