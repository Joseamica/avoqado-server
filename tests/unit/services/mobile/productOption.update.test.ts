import { prismaMock } from '@tests/__helpers__/setup'
import { logAction } from '@/services/dashboard/activity-log.service'
import { createProductOption, deleteProductOption, updateProductOption } from '@/services/mobile/product-option.mobile.service'

const opcion = { id: 'o1', venueId: 'v1', name: 'Talla', createdAt: new Date('2026-10-14T00:00:00Z') }

describe('updateProductOption (auditoría R7: validar antes de borrar)', () => {
  // clearAllMocks no vacía la cola de `mockResolvedValueOnce`: una lectura que no se consumió se pasaría a la prueba siguiente.
  beforeEach(() => {
    prismaMock.productOption.findFirst.mockReset()
    prismaMock.$queryRaw.mockResolvedValue([{ id: 'o1' }]) // el candado de la opción (SELECT … FOR UPDATE)
  })

  it('🔴 con `values` inválido no borra nada', async () => {
    prismaMock.productOption.findFirst.mockResolvedValueOnce(opcion)
    await expect(updateProductOption({ venueId: 'v1', staffId: 's1', optionId: 'o1', values: 'x' as any })).rejects.toMatchObject({
      statusCode: 400,
    })
    expect(prismaMock.productOptionValue.deleteMany).not.toHaveBeenCalled()
  })

  it('renombrar sólo la opción (sin `values`) no borra ni falla', async () => {
    // 1ª lectura: la opción; 2ª: el chequeo de nombre repetido (no hay otra con ese nombre).
    prismaMock.productOption.findFirst.mockResolvedValueOnce(opcion).mockResolvedValueOnce(null)
    prismaMock.productOption.update.mockResolvedValue({ ...opcion, name: 'Tallas', values: [] })
    prismaMock.productOption.findUniqueOrThrow.mockResolvedValue({ ...opcion, name: 'Tallas', values: [] })
    await expect(updateProductOption({ venueId: 'v1', staffId: 's1', optionId: 'o1', name: 'Tallas' })).resolves.toBeTruthy()
    expect(prismaMock.productOptionValue.deleteMany).not.toHaveBeenCalled()
  })

  it('reemplaza los valores dentro de una transacción, con el formato de objetos del POS ({ name })', async () => {
    prismaMock.productOption.findFirst.mockResolvedValueOnce(opcion)
    prismaMock.productOption.findUniqueOrThrow.mockResolvedValue({ ...opcion, values: [{ id: 'x', value: 'S', sortOrder: 0 }] })
    await updateProductOption({ venueId: 'v1', staffId: 's1', optionId: 'o1', values: [{ name: ' S ' } as any, '  ' as any] })
    expect(prismaMock.$transaction).toHaveBeenCalled()
    expect(prismaMock.productOptionValue.deleteMany).toHaveBeenCalledWith({ where: { optionId: 'o1' } })
    expect(prismaMock.productOptionValue.createMany).toHaveBeenCalledWith({ data: [{ optionId: 'o1', value: 'S', sortOrder: 0 }] })
  })

  it('🔴 I-6: la bitácora dice de dónde vino el cambio: DASHBOARD si lo pide el dashboard; MOBILE por defecto (el POS)', async () => {
    const fuente = () => (logAction as jest.Mock).mock.calls.at(-1)[0].data.source
    prismaMock.productOption.findFirst.mockResolvedValue(null) // crear: sin otra con ese nombre
    prismaMock.productOption.create.mockResolvedValue({ ...opcion, values: [] })
    await createProductOption({ venueId: 'v1', staffId: 's1', name: 'Talla', values: ['S'] as any, source: 'DASHBOARD' })
    expect(fuente()).toBe('DASHBOARD')
    await createProductOption({ venueId: 'v1', staffId: 's1', name: 'Talla', values: ['S'] as any })
    expect(fuente()).toBe('MOBILE')

    prismaMock.productOption.findFirst.mockReset()
    prismaMock.productOption.findFirst.mockResolvedValueOnce(opcion).mockResolvedValueOnce(null)
    prismaMock.productOption.findUniqueOrThrow.mockResolvedValue({ ...opcion, name: 'Tallas', values: [] })
    await updateProductOption({ venueId: 'v1', staffId: 's1', optionId: 'o1', name: 'Tallas', source: 'DASHBOARD' })
    expect(fuente()).toBe('DASHBOARD')

    prismaMock.productOption.findFirst.mockResolvedValueOnce(opcion)
    await deleteProductOption('o1', 'v1', 's1', 'DASHBOARD')
    expect(fuente()).toBe('DASHBOARD')
    prismaMock.productOption.findFirst.mockResolvedValueOnce(opcion)
    await deleteProductOption('o1', 'v1', 's1')
    expect(fuente()).toBe('MOBILE')
  })
})
