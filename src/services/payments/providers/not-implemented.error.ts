import { BadRequestError } from '@/errors/AppError'

export class ProviderCapabilityError extends BadRequestError {
  constructor(providerCode: string, capability: string) {
    super(`El proveedor ${providerCode} no soporta la capacidad requerida: ${capability}`)
  }
}
