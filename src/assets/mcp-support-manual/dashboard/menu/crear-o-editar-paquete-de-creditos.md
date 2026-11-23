---
title: Crear o editar un paquete de créditos en el panel
description: Arma un paquete con su precio y los productos o servicios que incluye (con cantidad o Ilimitado), o cambia uno, desde Paquetes de Créditos en el panel.
product: dashboard
category: menu
task: crear-o-editar-paquete-de-creditos
requiredPermissions:
  - menu:read
  - creditPacks:read
sourceRepo: avoqado-web-dashboard
sourceRef: 0910a27a6665667fd0f7001f8b822bf933ff6ef8
keywords:
  - crear paquete de clases
  - paquete de créditos
  - vender paquete
  - editar paquete
  - ilimitado
  - clases ilimitadas
  - membresía mensual
  - reservar para una amiga con mi ilimitado
  - no puedo cambiar mi nombre
---

## Antes de empezar

*Paquetes de Créditos* sale en el menú de tu catálogo si tienes permiso para ver paquetes. Para crear uno necesitas permiso para crear paquetes, y para cambiarlo, permiso para editar paquetes.

## Pasos

1. En la barra lateral, abre el menú de tu catálogo (su nombre cambia según tu giro, por ejemplo *Menú* o *Catálogo*), entra a *Paquetes de Créditos* y toca *Crear Paquete*.
2. Escribe el *Nombre del Paquete* y el *Precio*; si quieres, también *Días de Validez* y *Máximo por Cliente*.
3. En *Items del Paquete*, elige el *Producto* y escribe la *Cantidad*. Con *Agregar Item* sumas otro.
4. Toca *Guardar Cambios*: sale «Paquete de créditos creado exitosamente».
5. Para cambiar uno, en la lista toca ⋯ › *Editar*, haz el cambio y toca *Guardar Cambios*.

## Cómo funciona un paquete Ilimitado

- Para un paquete de clases sin límite (como una membresía mensual), en el renglón del producto prende *Ilimitado*: la cantidad desaparece. Un paquete con un renglón Ilimitado necesita *Días de Validez*.
- La clienta ve «Ilimitado · vence el …» en su cuenta, en el panel y en el POS, nunca un número de créditos. En la pestaña *Compras* (abre la compra con la flecha) y en la ficha de la clienta ves «Ilimitado · vence el … · usó N» (cuántas veces lo ha usado) o, si se reembolsó, «Ilimitado · reembolsado».
- Es personal: cubre un lugar por clase, a su nombre. Aunque escriba otro nombre o teléfono al reservar, la reserva queda con los datos de su ficha. Los lugares de más (por ejemplo, para una amiga) se pagan aparte.
- Sólo sirve para clases que empiezan antes de que venza, también al cambiar de horario.
- Puede reservar las clases que quiera, sin máximo por día.
- Si cancela, no se le descuenta nada. Si cancela tarde o no llega, se cuenta como falta en su compra («Faltas: N sin llegar · N cancelaciones tardías»), sin castigo.
- Mientras su Ilimitado esté vigente, ella no puede cambiar su nombre desde su cuenta; lo corriges tú desde la ficha de la clienta en *Clientes*.

## Problemas frecuentes

- Debajo del campo sale lo que falta: «El nombre es requerido», «El precio es requerido» o «El producto es requerido».
- «Un paquete Ilimitado necesita días de vigencia»: sale debajo de *Días de Validez*; escríbelos antes de guardar.
- «Este paquete tiene un renglón Ilimitado: cambia sus productos desde el panel actualizado.»: el paquete se está editando desde una versión vieja del panel o de la app del POS. Recarga el panel (o actualiza la app) y vuelve a hacer el cambio.
- Mensajes que puede ver la clienta con su Ilimitado:
  - «Tu Ilimitado es personal: cubre 1 lugar por clase a tu nombre. Los demás lugares se pagan aparte.»: pidió más de un lugar.
  - «Ya tienes un lugar en esta clase con tu Ilimitado.»: ya tiene esa clase reservada.
  - «Tu Ilimitado vence el …; esta clase es después.»: la clase es después del vencimiento; puede comprar otro paquete.
  - «Tu nombre está ligado a tu Ilimitado. Para corregirlo, pídeselo al estudio.»: quiso cambiar su nombre en su cuenta.
- «Esta reserva se pagó con un Ilimitado y va a nombre de su titular: no se le puede cambiar el nombre ni el contacto.»: sale al editar esa reserva en el panel; las notas sí se pueden cambiar.
- En un Ilimitado no aparece *Ajustar Balance*: no tiene saldo que ajustar (desde una versión vieja sale «Un paquete Ilimitado no tiene saldo que ajustar.»). Si hace falta, reembolsa la compra o vende otra.
- Si sale «Error», el aviso trae la razón; si no la trae, dice «Ocurrió un error». Si salió al crear el paquete, no lo vuelvas a crear: pudo quedar creado en un primer intento. Pide que lo revise una persona del equipo de Avoqado.
