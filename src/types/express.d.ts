// src/types/express.d.ts
import { AuthContext } from '../security'
import { SDKContext } from '../middlewares/sdk-auth.middleware'
import { ResolvedUserRole } from '../middlewares/checkPermission.middleware'
import type { BoundTpvCommandTarget } from '../middlewares/bindTpvCommandTarget.middleware'

declare global {
  namespace Express {
    export interface Request {
      authContext?: AuthContext
      correlationId?: string
      authenticated?: boolean
      sdkContext?: SDKContext
      /**
       * Memo POR PETICIÓN de `resolveUserRoleForVenue`. Vive aquí y no en un caché global
       * a propósito: muere con el request, así que dar de baja a un empleado o cambiarle
       * el PermissionSet surte efecto en la siguiente petición, no cuando expire un TTL.
       * Existe porque la resolución del rol se consulta hasta 3 veces en la misma cadena
       * (validateVenueAccess → checkPermission → checkTableOwnership).
       */
      __avqRoleCache?: Map<string, ResolvedUserRole>
      /** Canonical target resolved before venue permission checks on command routes. */
      tpvCommandTarget?: BoundTpvCommandTarget
      partnerContext?: {
        partnerId: string
        partnerName: string
        organizationId: string
        sandboxMode: boolean
      }
    }
  }
}

export {}
