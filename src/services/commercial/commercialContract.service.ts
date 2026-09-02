import Ajv, { type ErrorObject } from 'ajv'
import commercialContractSchema from '@/contracts/commercial/commercial-contract-v1.schema.json'
import { ConflictError } from '@/errors/AppError'

const validateV1 = new Ajv({ allErrors: true, jsonPointers: true }).compile(commercialContractSchema)

export interface CommercialContractValidation {
  valid: boolean
  errors: Array<{ path: string; keyword: string; message: string }>
}

function publicErrors(errors: ErrorObject[] | null | undefined): CommercialContractValidation['errors'] {
  return (errors ?? []).map(issue => ({
    path: issue.dataPath || '/',
    keyword: issue.keyword,
    message: issue.message ?? 'Valor inválido',
  }))
}

export function validateCommercialContractV1(value: unknown): CommercialContractValidation {
  const valid = validateV1(value) === true
  return { valid, errors: valid ? [] : publicErrors(validateV1.errors) }
}

export function assertCommercialContractV1(value: unknown): void {
  const result = validateCommercialContractV1(value)
  if (!result.valid) {
    throw new ConflictError(
      'El snapshot final no cumple el contrato comercial v1 y no puede publicarse ni activarse.',
      'COMMERCIAL_CONTRACT_INVALID',
      { errors: result.errors },
    )
  }
}
