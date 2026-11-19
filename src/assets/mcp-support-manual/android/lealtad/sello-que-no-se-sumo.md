---
title: Cuando una venta no suma el sello del cliente en el POS Android
description: Qué significa lo que dice el cobro terminado sobre el sello de la venta, y cuándo se puede agregar ahí el cliente que faltó, en el POS Android.
product: android
category: lealtad
task: sello-que-no-se-sumo
requiredPermissions: []
featureCode: LOYALTY_PROGRAM
gateKind: FEATURE
versionMin: 2.25.7
sourceRepo: avoqado-android
sourceRef: 843c15ae06bf68dd0d9c755525a9971e701052b7
keywords:
  - no le cayó el sello
  - no sumó el sello
  - no le sumé puntos
  - agregar cliente después de cobrar
  - olvidé poner el cliente
  - tarjeta de sellos
---

## Antes de empezar

Para sumar sello, la venta necesita un cliente, y el negocio su programa de sellos con un plan que incluye la lealtad. Lo de abajo se hace en la pantalla que sale al terminar el cobro, la que arriba dice *Venta nueva*: no la cierres antes. Agregar el cliente ahí pide el permiso de ver clientes y el de cobrar. Agregarlo ahí sólo sirve si el cobro llegó directo a esa pantalla (abajo, cuándo no).

## Pasos

1. Si a la venta le faltó el cliente, toca *Agregar cliente*, arriba a la derecha de esa pantalla.
2. Búscalo y tócalo. Si queda ligado, sale «Cliente agregado: …» y su nombre queda en lugar de *Agregar cliente*.
3. Revisa lo que dice esa pantalla sobre el sello (abajo, lo que significa cada mensaje). Luego toca *Venta nueva*.

## Problemas frecuentes

- Si aparece en esa venta, antes de terminar, «Cobro sin confirmar», «Cancelando el cobro…», «Cancelación pendiente», «¿Se cobró …?» o «La terminal sí cobró este pago…», o alguien declaró que no se cobró, no agregues el cliente desde esa pantalla ni lo intentes otra vez: una persona tiene que revisarlo. En ese caso, «Cliente agregado: …» y el sello no prueban a qué venta se ligó.
- Si aparece «✓ +1 sello» o la tarjeta «+1 sello», el sello se sumó (en el caso de arriba, no prueba que fue en esta venta).
- Si aparece «Ya recibió su sello de hoy», ese cliente ya tiene los sellos que el negocio da por día: esta venta no suma.
- Si aparece «Esta venta ya sumó su sello a otro cliente», el sello de esa venta ya es de otra persona.
- Si aparece «Pasaron más de 24 h: esta venta no suma sello», ya no se suma con esta venta.
- Si aparece «Esta venta no está pagada completa: no suma sello», la venta no está pagada completa o se devolvió.
- Si ya cerraste esa pantalla, o la venta debía sumar y no sumó, pide a un gerente que revise los sellos del cliente.

## Sin internet

- Si aparece «Sin conexión: agrégalo cuando vuelva la red. Tienes 24 h para que sume el sello.», vuelve a tocar *Agregar cliente* cuando regrese la conexión.
- Si aparece «Esta venta aún no se sincroniza. Agrega el cliente cuando aparezca «Venta sincronizada».», espera a que esa pantalla diga «Venta sincronizada» y vuelve a tocar *Agregar cliente*.
- Si aparece «El sello se suma al sincronizar», la venta se cobró sin internet y ya lleva a su cliente: no hace falta agregarlo otra vez.
