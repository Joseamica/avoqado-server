import { ActionDefinition } from '../types'
import * as pricingService from '../../pricing.service'

export const pricingActions: ActionDefinition[] = [
  // ---------------------------------------------------------------------------
  // pricing.applySuggestedPrice
  // ---------------------------------------------------------------------------
  {
    actionType: 'pricing.applySuggestedPrice',
    entity: 'Product',
    operation: 'custom',
    permission: 'menu:update',
    dangerLevel: 'medium',
    service: 'pricingService',
    method: 'applySuggestedPrice',
    description: 'Aplica el precio sugerido al producto basado en el costo de la receta y la estrategia de pricing',
    examples: [
      'aplica el precio sugerido de la hamburguesa',
      'pon el precio calculado en la pizza',
      'aplica el precio recomendado al café americano',
      'usa el precio sugerido para los tacos de pollo',
      'actualiza el precio de la pizza margarita con el precio calculado',
    ],
    fields: {
      name: {
        type: 'string',
        required: true,
        prompt: '¿A qué producto quieres aplicar el precio sugerido?',
      },
    },
    entityResolution: {
      searchField: 'name',
      scope: 'venueId',
      fuzzyMatch: true,
      multipleMatchBehavior: 'ask',
    },
    serviceAdapter: async (params, context) => {
      const { entityId } = params as any

      return pricingService.applySuggestedPrice(context.venueId, entityId as string, context.userId)
    },
    previewTemplate: {
      title: 'Aplicar precio sugerido: {{name}}',
      summary:
        'Se aplicará el precio sugerido calculado al producto "{{name}}" basado en el costo de su receta y la estrategia de pricing.',
      showDiff: true,
      showImpact: true,
    },
  },
]
