import prisma from '@/utils/prismaClient'
import {
  CommercialReleasePreflightError,
  commercialReleasePreflightService,
} from '@/services/commercial/commercialReleasePreflight.service'
import { CommercialOfferReleasePreflightError } from '@/services/commercial/offers/commercialOfferReleasePreflight.service'

async function main(): Promise<void> {
  try {
    const receipt = await commercialReleasePreflightService.run()
    process.stdout.write(`${JSON.stringify(receipt)}\n`)
  } catch (error) {
    const failure =
      error instanceof CommercialReleasePreflightError
        ? { code: error.code, reason: error.reason }
        : error instanceof CommercialOfferReleasePreflightError
          ? { code: error.code, references: error.references }
          : { code: 'COMMERCIAL_RELEASE_PREFLIGHT_UNAVAILABLE' }
    process.stderr.write(`${JSON.stringify(failure)}\n`)
    process.exitCode = 1
  } finally {
    await prisma.$disconnect()
  }
}

void main()
