// tests/unit/services/online-ordering/schema.test.ts
import fs from 'node:fs'
import path from 'node:path'
import { OnlineOrderPaymentMode, OnlineOrderRejectReason, OnlineOrderStatus } from '@prisma/client'
import { prismaMock } from '@tests/__helpers__/setup'

describe('esquema de pedidos en línea', () => {
  it('expone los estados de la v1 (los de la fase 2 se agregan después: es aditivo)', () => {
    expect(Object.values(OnlineOrderStatus).sort()).toEqual([
      'ACCEPTED',
      'CANCELLED_BY_CUSTOMER',
      'CANCELLED_BY_STAFF',
      'COMPLETED',
      'EXPIRED',
      'PENDING_ACCEPTANCE',
      'READY',
      'REJECTED',
    ])
  })

  it('sólo pagar al recoger, y los motivos de rechazo', () => {
    expect(Object.values(OnlineOrderPaymentMode)).toEqual(['PAY_AT_PICKUP'])
    expect(Object.values(OnlineOrderRejectReason).sort()).toEqual(['CLOSED', 'OTHER', 'OUT_OF_ITEMS', 'TOO_BUSY'])
  })

  it('el mock global de Prisma conoce los modelos nuevos (R21: es una lista fija)', () => {
    expect(prismaMock.onlineOrderingSettings.findUnique).toEqual(expect.any(Function))
    expect(prismaMock.onlineOrder.updateMany).toEqual(expect.any(Function))
  })

  it('A2 (P1-10): la migración va en DOS: tablas nuevas sin tocar Product; después SÓLO la columna de Product, en su propio commit', () => {
    const leer = (carpeta: string) =>
      fs.readFileSync(path.resolve(__dirname, '../../../../prisma/migrations', carpeta, 'migration.sql'), 'utf8')
    const sentencias = (sql: string) =>
      sql
        .replace(/--[^\n]*/g, '')
        .split(';')
        .map(x => x.trim())
        .filter(Boolean)
    const tablas = leer('20261017120000_pedidos_en_linea_fase_1')
    expect(tablas).not.toMatch(/"Product"/) // nada retiene el candado exclusivo de Product mientras se crean llaves foráneas
    expect(tablas).toMatch(/"requestHash" TEXT,/) // A1: la huella de la solicitud, nula
    expect(sentencias(leer('20261017120100_pedidos_en_linea_producto_en_linea'))).toEqual([
      'ALTER TABLE "Product" ADD COLUMN     "availableOnline" BOOLEAN NOT NULL DEFAULT false',
    ])
  })
})
