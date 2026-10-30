# VÉRTICE · Modo libre cooperativo + Modo historia (Torre Mirador)

Sube este ZIP a NEXUS PLAY (Subir juego → ZIP). Hay dos páginas:
- **index.html** — el modo libre cooperativo de siempre (mapa abierto). En su menú hay un botón **📖 Modo historia**.
- **historia.html** — el modo historia: Torre Mirador de 20 pisos, prólogo en el piso 17, misiones, final con la moto. Su menú tiene el botón **🌲 Modo libre** para volver.

El multijugador (vertice-mp.js + nexus-sdk.js) está en las dos páginas. En el modo historia funciona igual que en el libre:
avatares con skin y color, infectados compartidos (los simula el anfitrión, también en los pisos), disparos y ruido, hora del día.
Los infectados eligen al jugador más cercano contando el desnivel (un piso de diferencia pesa como ~10 m).

## Límites
- La historia (misiones, notas, construcciones), puertas, botín y coches NO se sincronizan: cada jugador avanza la suya.
- Al cambiar de página (libre ↔ historia) la sala se reconecta; cada jugador debe cambiar de modo en su dispositivo.
- Sin guardado dentro de NEXUS PLAY (el aislamiento bloquea localStorage).

## Estado de pruebas
Probado con un cliente simulado de NEXUS PLAY (anfitrión e invitado) en Chromium: el invitado ve infectados y avatares en el piso correcto,
el anfitrión envía instantáneas y envuelve a los infectados. NO probado en una sala real de NEXUS PLAY, ni con celulares, ni con más de 2 jugadores.

## Novedades v1.5 (modo libre)
- La zanja sin fondo del centro del asentamiento ahora es un **pequeño río** (0,4 m de profundidad): se vadea, hay agua animada y dos puentes bajos.
- **Campo de pruebas** rehecho (oeste): bloques de salto, parkour, túneles de agacharse y arrastre, escalera, muros, charco, tres colinas (11°/22°/33°), trampolín y slalom, con carteles (E). Pickup, moto y bici junto al puente sur.
- **Vehículos**: siguen el relieve (cabeceo y balanceo), suben montañas y cuestas (límite por tipo de vehículo), saltan en crestas y trampolines, vadean agua baja y salen por las puertas a la selva. Los ríos hondos y los riscos los frenan.
- El modo historia (historia.html) no cambia.
