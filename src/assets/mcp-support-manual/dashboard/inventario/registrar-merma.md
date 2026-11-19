---
title: Registrar una merma de un ingrediente en el panel
description: Registra con su motivo la merma de un ingrediente desde Inventario › Ingredientes en el panel, para que se descuente de sus existencias.
product: dashboard
category: inventario
task: registrar-merma
requiredPermissions:
  - inventory:read
  - inventory:adjust
featureCode: INVENTORY_TRACKING
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - registrar merma
  - se echó a perder
  - desperdicio
  - producto caducado
  - pérdida de inventario
---

## Antes de empezar

El inventario es para los negocios que tienen incluida la función de inventario. Necesitas permiso para ver el inventario y para ajustar existencias.

## Pasos

1. En *Inventario* › *Ingredientes*, en el renglón del ingrediente toca el botón ⋯ y luego *Registrar merma*.
2. Elige el *Motivo de la merma*.
3. Escribe la *Cantidad mermada*. Arriba ves el *Stock Actual* y cómo queda *Después de la merma*.
4. Si quieres, escribe una *Nota*.
5. Toca *Registrar merma*: sale «Merma registrada».

## Problemas frecuentes

- *Registrar merma* se queda apagado hasta que eliges un motivo.
- Si la cantidad es mayor que lo que hay, sale «Sólo hay … en existencia…»: se descuenta lo que hay y el resto queda registrado como «sin existencia».
- Si sale «No pudimos confirmar si la merma se registró.», no la registres de nuevo: pide que lo revise una persona del equipo de Avoqado.
- Las mermas registradas se ven en *Inventario* › *Mermas*.
