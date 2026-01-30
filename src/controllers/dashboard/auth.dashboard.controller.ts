import { NextFunction, Request, Response } from 'express'
import jwt from 'jsonwebtoken'
import prisma from '../../utils/prismaClient' // Corrected import path
import { AuthenticationError } from '../../errors/AppError'
import { StaffRole, VenueStatus } from '@prisma/client'
import { UpdateAccountDto, RequestPasswordResetDto, ResetPasswordDto } from '../../schemas/dashboard/auth.schema'
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

    // Buscar staff con venues y organization (World-Class Pattern: Need org to detect OWNER during onboarding)
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
        createdAt: true,
        lastLoginAt: true,
        organizations: {
          where: { isPrimary: true, isActive: true },
          include: { organization: true },
          take: 1,
        },
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
                status: true, // Single source of truth for venue state
                kycStatus: true, // Include KYC status for access control
                // Contact & Address fields (needed for TPV purchase wizard pre-fill)
                address: true,
                city: true,
                state: true,
                zipCode: true,
                country: true,
                email: true,
                phone: true,
                // Organization info (needed for PlayTelecom white-label and multi-venue orgs)
                organizationId: true,
                organization: {
                  select: {
                    id: true,
                    name: true,
                    slug: true,
                  },
                },
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
                // Include modules for module-based access control (e.g., SERIALIZED_INVENTORY)
                venueModules: {
                  select: {
                    enabled: true,
                    config: true,
                    module: {
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
      // 🔐 Special handling for Master TOTP login (synthetic SUPERADMIN user)
      if (decoded.sub === 'MASTER_ADMIN') {
        logger.info('🔐 [AUTH STATUS] Master Admin session detected')

        // Fetch ALL venues for SUPERADMIN access
        const allVenues = await prisma.venue.findMany({
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            status: true,
            kycStatus: true,
            address: true,
            city: true,
            state: true,
            zipCode: true,
            country: true,
            email: true,
            phone: true,
            organizationId: true,
            organization: { select: { id: true, name: true } },
            features: {
              select: {
                active: true,
                feature: { select: { code: true, name: true } },
              },
            },
            venueModules: {
              select: {
                enabled: true,
                config: true,
                module: { select: { code: true, name: true } },
              },
            },
          },
        })

        const masterVenues = allVenues.map(venue => ({
          id: venue.id,
          name: venue.name,
          slug: venue.slug,
          logo: venue.logo,
          role: StaffRole.SUPERADMIN,
          status: venue.status,
          kycStatus: venue.kycStatus,
          features: venue.features,
          modules: venue.venueModules,
          address: venue.address,
          city: venue.city,
          state: venue.state,
          zipCode: venue.zipCode,
          country: venue.country,
          email: venue.email,
          phone: venue.phone,
          organizationId: venue.organizationId,
          organization: venue.organization,
          permissions: DEFAULT_PERMISSIONS[StaffRole.SUPERADMIN] || [],
        }))

        // Disable caching for sensitive auth status data
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
        res.setHeader('Pragma', 'no-cache')
        res.setHeader('Expires', '0')

        return res.status(200).json({
          authenticated: true,
          user: {
            id: 'MASTER_ADMIN',
            firstName: 'Master',
            lastName: 'Admin',
            email: process.env.MASTER_LOGIN_EMAIL || 'master@avoqado.io',
            emailVerified: true,
            photoUrl: null,
            phone: null,
            organizationId: null,
            role: StaffRole.SUPERADMIN, // Explicit role for frontend redirect
            isMasterLogin: true, // Flag for frontend to identify master session
            createdAt: new Date(),
            lastLogin: new Date(),
            venues: masterVenues,
          },
          allVenues: masterVenues,
        })
      }

      res.clearCookie('accessToken') // Nombre correcto
      return res.status(200).json({
        authenticated: false,
        user: null,
      })
    }

    // Define venue type with features, modules and role
    interface VenueWithFeatures {
      id: string
      name: string
      slug: string
      logo: string | null
      role?: any
      status?: VenueStatus // Single source of truth for venue state
      kycStatus?: string | null // Include KYC verification status
      features?: any[]
      modules?: any[] // VenueModule with Module data for module-based access control
      // Contact & Address fields (needed for TPV purchase wizard pre-fill)
      address?: string | null
      city?: string | null
      state?: string | null
      zipCode?: string | null
      country?: string | null
      email?: string | null
      phone?: string | null
      // Organization info (needed for VenuesSwitcher grouping)
      organizationId?: string
      organization?: { id: string; name: string } | null
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
      status: sv.venue.status, // Single source of truth
      kycStatus: sv.venue.kycStatus, // Include KYC status
      features: sv.venue.features, // Incluir las features
      modules: sv.venue.venueModules, // Include modules for module-based access control
      // Contact & Address fields (needed for TPV purchase wizard pre-fill)
      address: sv.venue.address,
      city: sv.venue.city,
      state: sv.venue.state,
      zipCode: sv.venue.zipCode,
      country: sv.venue.country,
      email: sv.venue.email,
      phone: sv.venue.phone,
      // Organization info (needed for PlayTelecom white-label and multi-venue orgs)
      organizationId: sv.venue.organizationId,
      organization: sv.venue.organization,
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

    // If SUPERADMIN, fetch ALL venues in the system (including suspended/closed for management)
    if (isSuperAdmin) {
      const allSystemVenues = await prisma.venue.findMany({
        // SUPERADMIN sees ALL venues - no status filter (they need to manage suspended venues too)
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          status: true, // Single source of truth
          kycStatus: true, // Include KYC status
          // Contact & Address fields (needed for TPV purchase wizard pre-fill)
          address: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          email: true,
          phone: true,
          // Organization info (needed for VenuesSwitcher grouping)
          organizationId: true,
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
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
          // Include modules for module-based access control (e.g., SERIALIZED_INVENTORY)
          venueModules: {
            select: {
              enabled: true,
              config: true,
              module: {
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
        status: venue.status, // Single source of truth
        kycStatus: venue.kycStatus, // Include KYC status
        features: venue.features,
        modules: venue.venueModules, // Include modules
        // Contact & Address fields (needed for TPV purchase wizard pre-fill)
        address: venue.address,
        city: venue.city,
        state: venue.state,
        zipCode: venue.zipCode,
        country: venue.country,
        email: venue.email,
        phone: venue.phone,
        // Organization info (needed for VenuesSwitcher grouping)
        organizationId: venue.organizationId,
        organization: venue.organization,
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
          organizationId: staff.organizations[0]?.organizationId!,
          active: true,
        },
        select: {
          id: true,
          name: true,
          slug: true,
          logo: true,
          status: true, // Single source of truth
          kycStatus: true, // Include KYC status
          // Contact & Address fields (needed for TPV purchase wizard pre-fill)
          address: true,
          city: true,
          state: true,
          zipCode: true,
          country: true,
          email: true,
          phone: true,
          // Organization info (needed for VenuesSwitcher grouping)
          organizationId: true,
          organization: {
            select: {
              id: true,
              name: true,
            },
          },
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
          // Include modules for module-based access control (e.g., SERIALIZED_INVENTORY)
          venueModules: {
            select: {
              enabled: true,
              config: true,
              module: {
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
        status: venue.status, // Single source of truth
        kycStatus: venue.kycStatus, // Include KYC status
        features: venue.features,
        modules: venue.venueModules, // Include modules
        // Contact & Address fields (needed for TPV purchase wizard pre-fill)
        address: venue.address,
        city: venue.city,
        state: venue.state,
        zipCode: venue.zipCode,
        country: venue.country,
        email: venue.email,
        phone: venue.phone,
        // Organization info (needed for VenuesSwitcher grouping)
        organizationId: venue.organizationId,
        organization: venue.organization,
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

    // Determine highest role (World-Class Pattern: Detect OWNER even without venues during onboarding)
    let highestRole = staff.venues.length > 0 ? staff.venues[0].role : null
    if (isSuperAdmin) {
      highestRole = StaffRole.SUPERADMIN
    } else if (staff.venues.some(sv => sv.role === StaffRole.OWNER)) {
      highestRole = StaffRole.OWNER
    } else if (staff.venues.length === 0) {
      // Check if staff is primary OWNER during onboarding (Stripe/Shopify pattern)
      const primaryOrg = staff.organizations[0]?.organization
      const isPrimaryOwner = primaryOrg ? staff.email === primaryOrg.email : false
      const onboardingIncomplete = primaryOrg ? !primaryOrg.onboardingCompletedAt : false

      if (isPrimaryOwner && onboardingIncomplete) {
        highestRole = StaffRole.OWNER
      }
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
      organizationId: staff.organizations[0]?.organizationId ?? null,
      role: highestRole, // Add explicit role field
      createdAt: staff.createdAt,
      lastLogin: staff.lastLoginAt,
      venues: enrichedVenues, // Use enriched venues with permissions
    }

    // Disable caching for sensitive auth status data
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
    res.setHeader('Pragma', 'no-cache')
    res.setHeader('Expires', '0')

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
    const rememberMe = loginData.rememberMe === true

    // Llamar al servicio
    const { accessToken, refreshToken, staff } = await authService.loginStaff(loginData)

    // Cookie maxAge must match JWT expiration to prevent premature logout
    // JWT expires in: 24h (normal) or 30 days (rememberMe)
    const accessTokenMaxAge = rememberMe ? 30 * 24 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000
    const refreshTokenMaxAge = rememberMe ? 90 * 24 * 60 * 60 * 1000 : 7 * 24 * 60 * 60 * 1000

    // Establecer cookies
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: accessTokenMaxAge,
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: refreshTokenMaxAge,
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    // Respuesta exitosa
    // Include tokens in body for mobile apps (iOS/Android) that can't read httpOnly cookies
    // Web dashboard uses the cookies, mobile apps use the body tokens
    res.status(200).json({
      success: true,
      message: 'Login exitoso',
      user: staff, // Ya viene sanitizado del servicio
      accessToken, // For mobile apps (stored in Keychain/SecureStorage)
      refreshToken, // For mobile apps
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

    // Cookie maxAge must match JWT expiration (24h default since no rememberMe context here)
    const accessTokenMaxAge = 24 * 60 * 60 * 1000 // 24 hours
    const refreshTokenMaxAge = 7 * 24 * 60 * 60 * 1000 // 7 days

    // Establecer las nuevas cookies, sobrescribiendo las anteriores
    res.cookie('accessToken', accessToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: accessTokenMaxAge,
      path: '/',
      // No domain specified for cross-domain deployment (Cloudflare + Render)
    })

    res.cookie('refreshToken', refreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging',
      sameSite: process.env.NODE_ENV === 'production' || process.env.NODE_ENV === 'staging' ? 'none' : 'lax', // Use 'none' for cross-domain in production and staging
      maxAge: refreshTokenMaxAge,
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

/**
 * Request password reset
 * PUBLIC endpoint - no authentication required
 * @param req - Request with email in body
 * @param res - Response
 * @param next - Next function
 */
export const requestPasswordReset = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data: RequestPasswordResetDto = req.body

    const result = await authService.requestPasswordReset(data)

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error in requestPasswordReset controller:', error)
    next(error)
  }
}

/**
 * Validate reset token
 * PUBLIC endpoint - no authentication required
 * @param req - Request with token in params
 * @param res - Response
 * @param next - Next function
 */
export const validateResetToken = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token } = req.params

    if (!token) {
      return res.status(400).json({
        success: false,
        message: 'Token no proporcionado.',
      })
    }

    const result = await authService.validateResetToken(token)

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error in validateResetToken controller:', error)
    next(error)
  }
}

/**
 * Reset password with token
 * PUBLIC endpoint - no authentication required
 * @param req - Request with token and newPassword in body
 * @param res - Response
 * @param next - Next function
 */
export const resetPassword = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const data: ResetPasswordDto = req.body

    const result = await authService.resetPassword(data)

    res.status(200).json({
      success: true,
      ...result,
    })
  } catch (error) {
    logger.error('Error in resetPassword controller:', error)
    next(error)
  }
}
