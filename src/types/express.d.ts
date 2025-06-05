// src/types/express.d.ts
import { AuthContext } from '../security'

declare global {
  namespace Express {
    export interface Request {
      authContext?: AuthContext
      correlationId?: string
    }
  }
}

export {}
