import { createHash } from 'node:crypto'
import { Prisma } from '@prisma/client'

import {
  COMMERCIAL_WRITER_ADVISORY_LOCK_KEY,
  createCommercialWriterTransactionRunner,
} from '@/services/commercial/commercialWriterTransaction.service'

function deriveSignedBigInt64(domain: string): bigint {
  return createHash('sha256').update(domain, 'utf8').digest().readBigInt64BE(0)
}

describe('Commercial Catalog/Offer serialized writer transaction', () => {
  describe('behavior', () => {
    it('sets the local timeout and takes the shared transaction lock before domain work', async () => {
      const events: string[] = []
      const tx = {
        $executeRawUnsafe: jest.fn(async () => events.push('timeout')),
        $queryRawUnsafe: jest.fn(async () => events.push('lock')),
      }
      const host = {
        $transaction: jest.fn(async (operation: (value: typeof tx) => Promise<string>) => operation(tx)),
      }
      const runner = createCommercialWriterTransactionRunner({
        host: host as any,
        sleep: jest.fn(),
        random: () => 0.5,
      })

      await expect(
        runner.run(async () => {
          events.push('domain')
          return 'committed'
        }),
      ).resolves.toBe('committed')

      expect(events).toEqual(['timeout', 'lock', 'domain'])
      expect(host.$transaction).toHaveBeenCalledWith(expect.any(Function), {
        maxWait: 5_000,
        timeout: 30_000,
        isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      })
      expect(tx.$executeRawUnsafe).toHaveBeenCalledWith("SET LOCAL lock_timeout = '2000ms'")
      expect(tx.$queryRawUnsafe).toHaveBeenCalledWith(
        'SELECT pg_advisory_xact_lock($1::bigint)::text AS lock_result',
        '-2896351599520032041',
      )
      expect(deriveSignedBigInt64('avoqado:commercial:catalog-offer-publication:v1')).toBe(-2896351599520032041n)
      expect(COMMERCIAL_WRITER_ADVISORY_LOCK_KEY).toBe(-2896351599520032041n)
    })
  })

  describe('regression', () => {
    it('retries one lock timeout with injected 50–150 ms jitter and then commits once', async () => {
      const sleep = jest.fn().mockResolvedValue(undefined)
      let attempt = 0
      const host = {
        $transaction: jest.fn(async (operation: (tx: any) => Promise<string>) => {
          attempt += 1
          const tx = {
            $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
            $queryRawUnsafe: jest.fn(async () => {
              if (attempt === 1) throw { code: 'P2010', meta: { code: '55P03' } }
              return []
            }),
          }
          return operation(tx)
        }),
      }
      const domain = jest.fn().mockResolvedValue('committed')
      const runner = createCommercialWriterTransactionRunner({ host: host as any, sleep, random: () => 0.5 })

      await expect(runner.run(domain)).resolves.toBe('committed')
      expect(host.$transaction).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledWith(100)
      expect(domain).toHaveBeenCalledTimes(1)
    })

    it.each([
      [0, 50],
      [0.5, 100],
      [1, 150],
    ])('keeps injected retry jitter inside the closed 50–150 ms range for sample %s', async (sample, expected) => {
      const sleep = jest.fn().mockResolvedValue(undefined)
      let attempt = 0
      const host = {
        $transaction: jest.fn(async (operation: (tx: any) => Promise<string>) => {
          attempt += 1
          return operation({
            $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
            $queryRawUnsafe: jest.fn(async () => {
              if (attempt === 1) throw { code: '55P03' }
              return []
            }),
          })
        }),
      }
      const runner = createCommercialWriterTransactionRunner({ host: host as any, sleep, random: () => sample })

      await runner.run(async () => 'committed')
      expect(sleep).toHaveBeenCalledWith(expected)
    })

    it('exposes a stable retryable conflict after the second lock timeout and performs no domain work', async () => {
      const sleep = jest.fn().mockResolvedValue(undefined)
      const host = {
        $transaction: jest.fn(async (operation: (tx: any) => Promise<unknown>) =>
          operation({
            $executeRawUnsafe: jest.fn().mockResolvedValue(undefined),
            $queryRawUnsafe: jest.fn().mockRejectedValue({ code: 'P2010', meta: { code: '55P03' } }),
          }),
        ),
      }
      const domain = jest.fn()
      const runner = createCommercialWriterTransactionRunner({ host: host as any, sleep, random: () => 0 })

      await expect(runner.run(domain)).rejects.toMatchObject({
        statusCode: 409,
        code: 'COMMERCIAL_WRITER_LOCK_TIMEOUT',
        details: { retryable: true, attempts: 2 },
      })
      expect(host.$transaction).toHaveBeenCalledTimes(2)
      expect(sleep).toHaveBeenCalledTimes(1)
      expect(domain).not.toHaveBeenCalled()
    })

    it('does not retry an unrelated transaction failure', async () => {
      const failure = new Error('DATABASE_UNAVAILABLE')
      const sleep = jest.fn().mockResolvedValue(undefined)
      const host = { $transaction: jest.fn().mockRejectedValue(failure) }
      const runner = createCommercialWriterTransactionRunner({ host: host as any, sleep, random: () => 0 })

      await expect(runner.run(async () => 'never')).rejects.toBe(failure)
      expect(host.$transaction).toHaveBeenCalledTimes(1)
      expect(sleep).not.toHaveBeenCalled()
    })
  })
})
