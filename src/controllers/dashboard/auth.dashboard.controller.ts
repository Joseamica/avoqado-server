import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../../utils/prismaClient' // Corrected import path
import { AuthenticationError, InternalServerError } from '../../errors/AppError'
import { StaffRole } from '@prisma/client'
import { LoginDto } from '../../schemas/dashboard/auth.schema'
import logger from '../../config/logger'
import * as authService from '../../services/dashboard/auth.service'

// Define la estructura del payload que esperas en tu JWT
interface JwtPayload {
  id: string
  // Puedes añadir otros campos que incluyas en el token, como 'version' o 'type'
}

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
        organizationId: true,
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

    // Define venue type interface
    interface SimpleVenue {
      id: string
      name: string
      slug: string
      logo: string | null
    }

    // Define venue type with features and role
    interface VenueWithFeatures {
      id: string
      name: string
      slug: string
      logo: string | null
      role?: any
      features?: any[]
    }

    // Check if user is a SUPERADMIN in any venue
    const isSuperAdmin = staff.venues.some(sv => sv.role === StaffRole.SUPERADMIN)
    const isOwner = staff.venues.some(sv => sv.role === StaffRole.OWNER)
    let allVenues: VenueWithFeatures[] = []
    let directVenues: VenueWithFeatures[] = staff.venues.map(sv => ({
      id: sv.venue.id,
      name: sv.venue.name,
      slug: sv.venue.slug,
      logo: sv.venue.logo,
      role: sv.role,
      features: sv.venue.features, // Incluir las features
    }))

    // Create a map of venue IDs that user already has a direct relationship with
    const directVenueIds = new Set(directVenues.map(v => v.id))

    // If SUPERADMIN, fetch all venues in the system
    if (isSuperAdmin) {
      const allSystemVenues = await prisma.venue.findMany({
        where: { active: true },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
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

    // Formatear respuesta
    const userPayload = {
      id: staff.id,
      firstName: staff.firstName,
      lastName: staff.lastName,
      email: staff.email,
      isVerified: staff.emailVerified,
      photoUrl: staff.photoUrl,
      organizationId: staff.organizationId,
      role: highestRole, // Add explicit role field
      venues: directVenues, // Use our enhanced directVenues array with all accessible venues
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
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutos
      path: '/',
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
      path: '/',
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
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      path: '/',
    })

    res.clearCookie('refreshToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      path: '/',
    })

    // Destruir sesión si existe
    if (req.session) {
      req.session.destroy(err => {
        if (err) {
          console.error('Error al destruir sesión:', err)
        }
      })
    }

    res.status(200).json({
      success: true,
      message: 'Logout exitoso',
    })
  } catch (error) {
    console.error('Error en logout:', error)
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
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 15 * 60 * 1000, // 15 minutos
      path: '/',
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: process.env.NODE_ENV === 'production' ? 'strict' : 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 días
      path: '/', // Ajusta el path si tu ruta de refresh es específica
    })

    res.status(200).json({ success: true, message: 'Contexto de venue actualizado correctamente.' })
  } catch (error) {
    next(error)
  }
}
