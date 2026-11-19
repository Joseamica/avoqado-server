---
title: Crear o editar un cupón en el panel
description: Crea un código de cupón ligado a un descuento, con sus límites y vigencia, o cámbialo, desde Promociones en el panel.
product: dashboard
category: promociones
task: crear-o-editar-cupon
requiredPermissions:
  - coupons:read
featureCode: PROMOTIONS
gateKind: FEATURE
sourceRepo: avoqado-web-dashboard
sourceRef: 1fe15c5cd61ffe8386b239114ea6c8eb6f5e006a
keywords:
  - crear cupón
  - código de descuento
  - cupón nuevo
  - editar cupón
---

## Antes de empezar

Los cupones son para los negocios que tienen incluidas las promociones. Cada cupón va ligado a un descuento que ya existe: el cupón es el código y el descuento dice cuánto se rebaja. Para crear uno necesitas permiso para crear cupones y para ver los descuentos (y para crear descuentos, si lo armas con *Crear Descuento*); para cambiarlo, permiso para editar cupones.

## Pasos

1. En *Promociones* › *Códigos de Cupón*, toca *Crear Cupón*.
2. En *Descuento Padre*, elige el descuento que va a dar el cupón. Si no existe, al final de la lista toca *Crear Descuento*.
3. Revisa el *Código de Cupón*: viene uno al azar y puedes escribir el tuyo.
4. Si quieres, llena *Usos Máximos*, *Usos Máximos por Cliente*, *Monto Mínimo de Compra*, *Válido Desde* y *Válido Hasta*.
5. Toca *Guardar Cambios*: sale «Cupón creado exitosamente».
6. Para cambiar uno, en la lista toca ⋯ › *Editar*, haz el cambio y toca *Guardar Cambios*. El *Descuento Padre* ya no se puede cambiar.

## Problemas frecuentes

- Si sale «Se requiere un descuento padre», elige uno en *Descuento Padre*. Si la lista dice «Sin descuentos», crea uno con *Crear Descuento*, al final de la misma lista.
- El código lleva de 3 a 30 letras, números, guiones o guiones bajos; si no, sale el aviso debajo del campo.
- Si sale «Error», el aviso trae la razón; si no la trae, dice «Ocurrió un error».
- Si al crear sale «Error», aunque diga que ese código ya existe, no lo vuelvas a crear, tampoco con otro código: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
