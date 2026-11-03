import { moduleService, MODULE_CODES } from '../modules/module.service'

/** El interruptor del número de vinculación (sólo PlayTelecom): SERIALIZED_INVENTORY prendido en la organización y `features.linkingNumber`. */
export async function isLinkingNumberEnabledForOrg(orgId: string): Promise<boolean> {
  const mod = (await moduleService.getOrganizationModules(orgId)).find(m => m.code === MODULE_CODES.SERIALIZED_INVENTORY)
  const features = mod?.config.features as { linkingNumber?: unknown } | undefined
  return !!mod?.enabled && features?.linkingNumber === true
}
