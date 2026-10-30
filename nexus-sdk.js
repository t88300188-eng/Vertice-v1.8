/*!
 * NEXUS PLAY SDK v1.0.0
 * Conecta un juego HTML con la sala de NEXUS PLAY donde se está ejecutando.
 *
 *   <script src="nexus-sdk.js"></script>
 *   const nexus = await NexusPlay.connect();
 *   nexus.on('state', (id, estado) => { remotos[id] = estado; });
 *   nexus.setState({ x, y });          // tu estado (se envía a los demás, máx. ~20 veces por segundo)
 *   nexus.send('disparo', { x, y });   // evento puntual a todos (o a uno: { to: id })
 *
 * El juego corre aislado dentro de un iframe y NO tiene acceso a tokens ni al servidor:
 * todo viaja por postMessage hacia el panel de NEXUS PLAY, que valida y reenvía.
 * Documentación completa: docs/SDK_GUIDE.md. La API v1 se mantiene compatible.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.NexusPlay = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '1.0.0';
  var MAGIC = 1; // versión del canal postMessage
  var EVENT_NAME = /^[A-Za-z0-9_.:-]{1,32}$/;
  var KEY_NAME = /^[A-Za-z0-9_.-]{1,32}$/;
  var MAX_JSON = 7000;

  function NexusError(code, message) {
    var e = new Error(message);
    e.name = 'NexusError';
    e.code = code;
    return e;
  }

  function jsonSize(v) {
    try { var s = JSON.stringify(v); return s === undefined ? 0 : s.length; } catch (e) { return -1; }
  }

  function isObj(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }

  function Client(win, opts) {
    opts = opts || {};
    this._win = win;
    this._handlers = {};
    this._listener = null;
    this._ready = null;
    this._closed = false;
    this._stateIntervalMs = opts.stateIntervalMs === undefined ? 50 : opts.stateIntervalMs;
    this._lastStateAt = 0;
    this._pendingState = null;
    this._stateTimer = null;
    this._pings = {};
    this._pingSeq = 0;
    this.version = VERSION;
    this.me = null;
    this.room = null;
    this.players = [];
    this.connection = 'connecting';
    this._states = {};
    this._shared = {};
  }

  // ---------- Eventos ----------
  Client.prototype.on = function (name, fn) {
    if (typeof fn !== 'function') throw NexusError('bad_argument', 'on(nombre, función): falta la función.');
    (this._handlers[name] = this._handlers[name] || []).push(fn);
    var self = this;
    return function () { self.off(name, fn); };
  };
  Client.prototype.off = function (name, fn) {
    var l = this._handlers[name];
    if (!l) return;
    this._handlers[name] = l.filter(function (f) { return f !== fn; });
  };
  Client.prototype.once = function (name, fn) {
    var self = this;
    var off = this.on(name, function () { off(); fn.apply(self, arguments); });
    return off;
  };
  Client.prototype._emit = function (name) {
    var args = Array.prototype.slice.call(arguments, 1);
    var l = this._handlers[name];
    if (!l) return;
    l.slice().forEach(function (fn) {
      try { fn.apply(null, args); } catch (e) {
        if (typeof console !== 'undefined') console.error('[NexusPlay] error en un manejador de "' + name + '":', e);
      }
    });
  };

  // ---------- Lectura ----------
  Object.defineProperty(Client.prototype, 'isHost', { get: function () { return !!(this.me && this.me.host); } });
  Object.defineProperty(Client.prototype, 'connected', { get: function () { return this.connection === 'connected'; } });
  Client.prototype.getPlayer = function (id) {
    for (var i = 0; i < this.players.length; i++) if (this.players[i].id === id) return this.players[i];
    return null;
  };
  Client.prototype.getStates = function () { return Object.assign({}, this._states); };
  Client.prototype.getShared = function () { return Object.assign({}, this._shared); };

  // ---------- Conexión con el panel ----------
  Client.prototype._post = function (msg) {
    msg.nexus = MAGIC;
    try { this._win.parent.postMessage(msg, '*'); return true; } catch (e) { return false; }
  };

  Client.prototype.connect = function (opts) {
    if (this._ready) return this._ready;
    opts = opts || {};
    var self = this;
    var win = this._win;
    var timeoutMs = opts.timeout === undefined ? 5000 : opts.timeout;
    this._ready = new Promise(function (resolve, reject) {
      if (!win.parent || win.parent === win) {
        reject(NexusError('not_embedded', 'Este juego no se está ejecutando dentro de una sala de NEXUS PLAY.'));
        return;
      }
      var retry = null;
      var timer = null;
      var settled = false;
      function done(err) {
        if (settled) return;
        settled = true;
        clearInterval(retry);
        clearTimeout(timer);
        if (err) { self._cleanup(); reject(err); } else resolve(self);
      }
      self._listener = function (ev) {
        if (ev.source !== win.parent) return;
        var m = ev.data;
        if (!isObj(m) || m.nexus !== MAGIC || typeof m.type !== 'string') return;
        if (m.type === 'init') {
          self._applyInit(m);
          done();
          return;
        }
        if (!settled) return;
        self._onMessage(m);
      };
      win.addEventListener('message', self._listener);
      function hello() { self._post({ type: 'hello', sdk: VERSION }); }
      hello();
      retry = setInterval(hello, 400);
      timer = setTimeout(function () {
        done(NexusError('timeout', 'No hubo respuesta de NEXUS PLAY. ¿Estás dentro de una sala?'));
      }, timeoutMs);
    });
    return this._ready;
  };

  Client.prototype._applyInit = function (m) {
    this.room = m.room || null;
    this.players = Array.isArray(m.players) ? m.players : [];
    this._states = isObj(m.states) ? m.states : {};
    this._shared = isObj(m.shared) ? m.shared : {};
    this.connection = m.connection || 'connected';
    this.me = this.getPlayer(m.meId) || { id: m.meId, name: '', host: false, online: true };
  };

  Client.prototype._onMessage = function (m) {
    switch (m.type) {
      case 'event':
        if (typeof m.name !== 'string') return;
        this._emit('event', m.name, m.data, this.getPlayer(m.from) || { id: m.from });
        this._emit('event:' + m.name, m.data, this.getPlayer(m.from) || { id: m.from });
        break;
      case 'state':
        if (typeof m.from !== 'string' || !isObj(m.data)) return;
        this._states[m.from] = m.data;
        this._emit('state', m.from, m.data, this.getPlayer(m.from));
        break;
      case 'players': {
        if (!Array.isArray(m.list)) return;
        var before = this.players;
        this.players = m.list;
        this.me = this.getPlayer(this.me && this.me.id) || this.me;
        var ch = isObj(m.change) ? m.change : {};
        var p = this.getPlayer(ch.id) || before.filter(function (x) { return x.id === ch.id; })[0] || { id: ch.id };
        if (ch.type === 'join') this._emit('player:join', p);
        else if (ch.type === 'leave' || ch.type === 'kick') { delete this._states[ch.id]; this._emit('player:leave', p); }
        else if (ch.type === 'online') this._emit('player:online', p);
        else if (ch.type === 'offline') this._emit('player:offline', p);
        this._emit('players', this.players, ch);
        break;
      }
      case 'room': {
        var prev = this.room;
        this.room = m.room || this.room;
        if (Array.isArray(m.players)) { this.players = m.players; this.me = this.getPlayer(this.me && this.me.id) || this.me; }
        this._emit('room', this.room);
        if (!prev || prev.state !== this.room.state) this._emit('room:state', this.room.state, prev && prev.state);
        break;
      }
      case 'shared':
        if (typeof m.key !== 'string') return;
        if (m.value === null) delete this._shared[m.key]; else this._shared[m.key] = m.value;
        this._emit('shared', m.key, m.value === undefined ? null : m.value);
        break;
      case 'connection':
        this.connection = m.status;
        this._emit('connection', m.status, m);
        break;
      case 'pong': {
        var cb = this._pings[m.id];
        if (cb) { delete this._pings[m.id]; cb(m.rtt); }
        break;
      }
      case 'error':
        this._emit('error', NexusError(String(m.code || 'error'), String(m.message || 'Error')));
        break;
      case 'closed':
        this.connection = 'closed';
        this._emit('closed', m.reason || 'room_closed');
        this._cleanup();
        break;
      default:
        break;
    }
  };

  // ---------- Envío ----------
  Client.prototype._assertLive = function () {
    if (this._closed) throw NexusError('closed', 'Ya saliste de la sala.');
    if (!this.me) throw NexusError('not_connected', 'Llama primero a NexusPlay.connect() y espera su resultado.');
  };

  /** Evento puntual para los demás jugadores (o uno solo con { to: id }). */
  Client.prototype.send = function (name, data, opts) {
    this._assertLive();
    if (typeof name !== 'string' || !EVENT_NAME.test(name)) throw NexusError('bad_event_name', 'Nombre de evento no válido (1-32 caracteres: letras, números, _ . : -).');
    var size = jsonSize(data);
    if (size < 0) throw NexusError('bad_data', 'Los datos del evento no se pueden convertir a JSON.');
    if (size > MAX_JSON) throw NexusError('too_large', 'Los datos del evento son demasiado grandes (máx. ~7 KB).');
    var msg = { type: 'send', name: name, data: data === undefined ? null : data };
    if (opts && opts.to) msg.to = String(opts.to);
    return this._post(msg);
  };

  /** Publica TU estado (objeto simple). Se agrupa para no superar ~20 envíos por segundo. */
  Client.prototype.setState = function (state) {
    this._assertLive();
    if (!isObj(state)) throw NexusError('bad_state', 'El estado debe ser un objeto, por ejemplo { x: 10, y: 20 }.');
    var size = jsonSize(state);
    if (size < 0 || size > 1800) throw NexusError('too_large', 'El estado es demasiado grande (máx. ~2 KB).');
    this._states[this.me.id] = state;
    this._pendingState = state;
    this._flushState(false);
  };

  Client.prototype._flushState = function (fromTimer) {
    if (!this._pendingState) return;
    var now = Date.now();
    var wait = this._stateIntervalMs - (now - this._lastStateAt);
    if (wait <= 0 || fromTimer) {
      var s = this._pendingState;
      this._pendingState = null;
      this._lastStateAt = now;
      this._stateTimer = null;
      this._post({ type: 'state', data: s });
    } else if (!this._stateTimer) {
      var self = this;
      this._stateTimer = setTimeout(function () { self._stateTimer = null; self._flushState(true); }, wait);
    }
  };

  /** Solo el anfitrión: guarda un valor visible para todos (null lo borra). */
  Client.prototype.setShared = function (key, value) {
    this._assertLive();
    if (!this.isHost) throw NexusError('forbidden', 'Solo el anfitrión puede modificar el estado compartido.');
    if (typeof key !== 'string' || !KEY_NAME.test(key)) throw NexusError('bad_key', 'Clave no válida (1-32 caracteres: letras, números, _ . -).');
    var size = jsonSize(value === undefined ? null : value);
    if (size < 0 || size > 3500) throw NexusError('too_large', 'El valor compartido es demasiado grande (máx. ~3.5 KB).');
    return this._post({ type: 'shared', key: key, value: value === undefined ? null : value });
  };

  /** Mide la latencia (ms) hasta el servidor de NEXUS PLAY. */
  Client.prototype.ping = function (timeoutMs) {
    this._assertLive();
    var self = this;
    return new Promise(function (resolve, reject) {
      var id = ++self._pingSeq;
      var t = setTimeout(function () { delete self._pings[id]; reject(NexusError('timeout', 'Sin respuesta del servidor.')); }, timeoutMs || 3000);
      self._pings[id] = function (rtt) { clearTimeout(t); resolve(rtt); };
      self._post({ type: 'ping', id: id });
    });
  };

  /** Avisa al panel de que el juego terminó de cargar (acelera el inicio de la partida). */
  Client.prototype.ready = function () {
    this._assertLive();
    return this._post({ type: 'ready' });
  };

  /** Sale de la sala. */
  Client.prototype.leave = function () {
    if (this._closed) return;
    this._post({ type: 'leave' });
    this._cleanup();
  };

  Client.prototype._cleanup = function () {
    this._closed = true;
    clearTimeout(this._stateTimer);
    if (this._listener) this._win.removeEventListener('message', this._listener);
    this._listener = null;
  };

  // ---------- API pública ----------
  var shared = typeof WeakMap === 'function' ? new WeakMap() : null;

  function isEmbedded(win) {
    win = win || (typeof self !== 'undefined' ? self : null);
    return !!(win && win.parent && win.parent !== win);
  }

  /**
   * Conecta con la sala. Devuelve una promesa con el cliente.
   * Llamadas repetidas desde la misma página devuelven el mismo cliente.
   */
  function connect(opts) {
    opts = opts || {};
    var win = opts.window || (typeof self !== 'undefined' ? self : null);
    if (!win) return Promise.reject(NexusError('no_window', 'No hay ventana disponible.'));
    var c = shared && shared.get(win);
    if (!c || c._closed) {
      c = new Client(win, opts);
      if (shared) shared.set(win, c);
    }
    var p = c.connect(opts);
    p.catch(function () { if (shared && shared.get(win) === c) shared.delete(win); });
    return p;
  }

  return { version: VERSION, protocol: MAGIC, connect: connect, isEmbedded: isEmbedded, NexusError: NexusError, Client: Client };
});
