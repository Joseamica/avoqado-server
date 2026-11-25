---
title: Prender las tarjetas de regalo desde Cobrar en el POS Windows
description: Si las tarjetas de regalo están apagadas, el administrador o el dueño las prende desde Cobrar aceptando sus reglas, sin ir al panel.
product: windows
category: tarjetas-de-regalo
task: prender-tarjetas-de-regalo
requiredPermissions:
  - giftCards:enable
featureCode: GIFT_CARDS
gateKind: FEATURE
versionMin: 2.25.29
sourceRepo: avoqado-android
sourceRef: 78e5372f37ed7791d86fc1fe621d4a073e5a09ff
keywords:
  - prender tarjetas de regalo
  - activar tarjetas de regalo
  - las tarjetas de regalo están apagadas
  - no puedo vender tarjeta de regalo
  - vender tarjeta sale apagado
---

## Antes de empezar

*Prender tarjetas de regalo* sólo sale cuando el negocio las tiene apagadas, su plan las incluye y quien está en la caja es administrador o dueño (o tiene el permiso para prenderlas). Se prenden igual que en el panel, en *Configuración* › *Tarjetas de regalo*.

## Pasos

1. En *Cobrar*, en la pestaña *Atajos*, toca *Tarjeta de regalo*.
2. Toca *Prender tarjetas de regalo*.
3. Lee las reglas, marca «Acepto los Términos y Condiciones y el Aviso de Privacidad» y toca *Prender*.
4. Sale «¡Tarjetas de regalo prendidas!» y *Vender tarjeta* queda activo en la misma hoja.

## Problemas frecuentes

- Si *Vender tarjeta* dice «Las tarjetas de regalo están apagadas. Pídele a un administrador o al dueño que las prenda.», quien está en la caja no puede prenderlas: que entre un administrador o el dueño, o que las prenda en el panel.
- Si sale «No tienes permiso para prender las tarjetas de regalo. Pídeselo a un administrador o al dueño.», tu usuario no tiene ese permiso.
- Si sale «No se prendieron las tarjetas de regalo. Inténtalo de nuevo.», vuelve a tocar *Prender*.
- Si *Vender tarjeta* sale apagado con la etiqueta *Pro*, el plan del negocio no incluye tarjetas de regalo.

## Sin internet

- Si aparece «Sin conexión: las tarjetas de regalo necesitan internet», no se pueden prender hasta que vuelva la conexión.
- Si sale «No pudimos confirmar si se prendieron. Revisa tu conexión e inténtalo de nuevo.», revisa la conexión y vuelve a tocar *Prender*.
