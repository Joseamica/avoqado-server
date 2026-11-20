---
title: Mover o unir las cuentas de las mesas en el POS Android
description: Pasa la cuenta de una mesa a otra libre, o junta en una las cuentas de varias mesas, desde Mesas en el POS Android.
product: android
category: mesas
task: mover-o-unir-cuentas
requiredPermissions:
  - tables:read
featureCode: TABLE_SERVICE
gateKind: FEATURE
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - mover mesa
  - cambiar de mesa
  - unir mesas
  - juntar cuentas
  - pasar la cuenta a otra mesa
---

## Antes de empezar

*Mesas* sale cuando el aparato está en el modo *Mesas*; si el plan no incluye el servicio de mesas, al entrar dice «Esta función es parte del plan …».

## Pasos

1. En *Mesas*, toca *Acciones*.
2. Toca las mesas ocupadas que vas a mover o unir para marcarlas.
3. Para pasar una cuenta a otra mesa (necesitas el permiso de editar mesas), deja marcada sólo esa mesa, toca *Mover* y elige la mesa libre.
4. Para juntar cuentas (necesitas el permiso de unir cuentas), marca dos o más mesas, toca *Unir* y elige la mesa que se queda con la cuenta.

## Problemas frecuentes

- *Mover* sólo se prende con una mesa marcada, y *Unir* con dos o más.
- Si al mover sale «No hay mesas libres.», primero libera una mesa.
- Para salir sin hacer nada, toca *Listo*.

## Sin internet

- Sin conexión, mover y unir quedan guardados en el aparato y salen igual «Cuenta movida» o «Cuentas unidas en la mesa …»; se envían cuando vuelva la red: no los repitas.
