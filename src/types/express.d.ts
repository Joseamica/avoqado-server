// src/types/express.d.ts
import { AuthContext } from '../security'
import { SDKContext } from '../middlewares/sdk-auth.middleware'

declare global {
  namespace Express {
    export interface Request {
      authContext?: AuthContext
      correlationId?: string
      authenticated?: boolean
      sdkContext?: SDKContext
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
