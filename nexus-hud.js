/*!
 * NEXUS PLAY HUD — indicador de sala opcional (jugadores y conexión).
 * Lo añade el asistente de integración. Para quitarlo, borra la línea <script src="nexus-hud.js">.
 * Requiere nexus-sdk.js cargado antes. Si el juego no está dentro de una sala, no hace nada.
 */
(function () {
  'use strict';
  if (typeof NexusPlay === 'undefined' || !NexusPlay.isEmbedded()) return;

  function start() {
    NexusPlay.connect().then(function (nexus) {
      var box = document.createElement('div');
      box.setAttribute('data-nexus-hud', '');
      box.style.cssText = 'position:fixed;top:6px;right:6px;z-index:2147483647;font:12px/1.3 system-ui,sans-serif;' +
        'background:rgba(10,10,11,.82);color:#f2f2f3;border:1px solid #26262a;border-radius:10px;padding:6px 10px;' +
        'max-width:46vw;pointer-events:none;backdrop-filter:blur(4px)';
      var head = document.createElement('div');
      var dot = document.createElement('span');
      dot.style.cssText = 'display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;background:#19c37d';
      var title = document.createElement('b');
      head.appendChild(dot);
      head.appendChild(title);
      var list = document.createElement('div');
      list.style.cssText = 'color:#b4b4bd;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis';
      box.appendChild(head);
      box.appendChild(list);
      document.body.appendChild(box);

      function paint() {
        var online = nexus.players.filter(function (p) { return p.online; }).length;
        title.textContent = (nexus.room && nexus.room.name ? nexus.room.name : 'Sala') + ' · ' + online + '/' + nexus.players.length;
        list.textContent = nexus.players.map(function (p) { return (p.online ? '' : '○ ') + p.name + (p.host ? ' ★' : ''); }).join(', ');
        dot.style.background = nexus.connection === 'connected' ? '#19c37d' : nexus.connection === 'reconnecting' ? '#f0a410' : '#ef4444';
      }
      nexus.on('players', paint);
      nexus.on('room', paint);
      nexus.on('connection', paint);
      paint();
    }).catch(function () { /* sin sala: no se muestra nada */ });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
