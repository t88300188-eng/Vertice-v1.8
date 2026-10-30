/*!
 * VÉRTICE · Cooperativo para NEXUS PLAY  (vertice-mp.js, v1)
 *
 * Añade multijugador cooperativo a VÉRTICE SIN modificar su código: se engancha a `window.VERTICE`
 * (el estado compartido que el propio juego expone) y al SDK de NEXUS PLAY.
 *
 *  - Avatares: cada jugador ve a los demás (nombre, arma, animación de caminar, agachado/tumbado, coche).
 *  - Infectados compartidos: el ANFITRIÓN simula a los infectados; los invitados reciben una copia
 *    (posición, animación, vida, muerte) y sus golpes/disparos se aplican en el anfitrión.
 *  - Los infectados persiguen y atacan al jugador más cercano (anfitrión o invitado).
 *  - Disparos de los demás: trazador, destello y sonido posicional; avisan a los infectados del anfitrión.
 *  - Hora del día y clima sincronizados con el anfitrión.
 *
 * Fuera de una sala de NEXUS PLAY no hace nada (el juego sigue siendo individual).
 * Límites conocidos (ver README del juego): puertas, botín, coches, granadas y misiones NO se sincronizan.
 */
(function () {
  'use strict';
  var G = window.VERTICE, THREE = window.THREE;
  if (!G || !THREE || !window.NexusPlay) return;

  var TYPES = ['walker', 'runner', 'crawler', 'bloater', 'spitter', 'giant'];
  var SNAP_MS = 125, STATE_MS = 80, FLUSH_MS = 100, STALE_MS = 4000, MAX_SNAP = 70, SNAP_RANGE = 110;
  var nx = null;
  var remote = new Map();   // userId -> { st, t, av, pl, ... }
  var proxies = new Map();  // id de infectado (anfitrión) -> Enemy local (copia)
  var fxShots = [], fxHits = [];
  var role = null;          // 'host' | 'guest'
  var origDirUpdate = null, origHurtPlayer = null;
  var tracers = [];
  var snapSeq = 0;

  var r1 = function (v) { return Math.round(v * 10) / 10; };
  var r2 = function (v) { return Math.round(v * 100) / 100; };
  var angLerp = function (a, b, k) { var d = Math.atan2(Math.sin(b - a), Math.cos(b - a)); return a + d * k; };
  var toast = function (m, k) { try { G.ui.toast(m, k || 'info', 3500); } catch (e) { /* sin UI */ } };

  NexusPlay.connect({ timeout: 2500 }).then(start, function () { /* no está en una sala: modo individual */ });


  // ======================================================================== skins (personaje + color de ropa)
  var SKINS = [
    { n: 'Original', c: null }, { n: 'Rojo', c: 0xb02a24 }, { n: 'Azul', c: 0x2457a6 }, { n: 'Verde', c: 0x2f7d3a },
    { n: 'Naranja', c: 0xc9792a }, { n: 'Morado', c: 0x6a3fa0 }, { n: 'Blanco', c: 0xd9d4c8 }, { n: 'Amarillo', c: 0xd4b82a },
  ];
  var mySkin = 0;
  var clamp = function (v, a, b) { return Math.max(a, Math.min(b, v)); };
  var lerp = function (a, b, t) { return a + (b - a) * t; };
  var smooth = function (a, b, x) { var t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

  // Pinta la chaqueta/sudadera (y las mangas de Lena) con el color elegido; "Original" restaura el del juego.
  function applySkin(model, charId, idx) {
    if (!model || !model.g) return;
    var c = G.CH && G.CH[charId]; if (!c) return;
    var want = [c.jacket, c.panel].filter(function (v) { return v != null; });
    var tint = SKINS[idx] ? SKINS[idx].c : null;
    model.g.traverse(function (o) {
      if (!o.material) return;
      (Array.isArray(o.material) ? o.material : [o.material]).forEach(function (m) {
        if (!m.color) return;
        if (m.userData._skin0 == null) { if (want.indexOf(m.color.getHex()) < 0) return; m.userData._skin0 = m.color.getHex(); }
        m.color.setHex(tint == null ? m.userData._skin0 : tint);
      });
    });
  }

  function buildSkinPicker() {
    var rows = document.querySelectorAll('.chars');
    if (!rows.length) return;
    rows.forEach(function (row) {
      if (row.nextSibling && row.nextSibling.className === 'mpskin') return;
      var box = document.createElement('div'); box.className = 'mpskin';
      box.style.cssText = 'display:flex;align-items:center;gap:7px;margin:8px 0 2px;font-size:12px;color:#9aa0a6;flex-wrap:wrap';
      var lab = document.createElement('span'); lab.textContent = 'Color de ropa (lo ven los demás):'; box.appendChild(lab);
      SKINS.forEach(function (sk, i) {
        var b = document.createElement('button'); b.type = 'button'; b.title = sk.n; b.dataset.skin = String(i);
        b.style.cssText = 'width:22px;height:22px;border-radius:50%;border:2px solid #ffffff33;cursor:pointer;padding:0;background:' + (sk.c == null ? 'linear-gradient(135deg,#555,#999)' : '#' + ('000000' + sk.c.toString(16)).slice(-6));
        b.addEventListener('click', function () { setMySkin(i); });
        box.appendChild(b);
      });
      row.parentNode.insertBefore(box, row.nextSibling);
    });
    markPicker();
  }

  function markPicker() {
    document.querySelectorAll('.mpskin button').forEach(function (b) { b.style.borderColor = +b.dataset.skin === mySkin ? '#e0a84a' : '#ffffff33'; });
  }

  function setMySkin(i) {
    mySkin = i; markPicker();
    try { var ch = G.Chars; if (ch && ch.cur) applySkin(ch.cur, ch.id, mySkin); } catch (e) { /* sin modelo todavía */ }
    publishState();
  }

  function reapplyMine() { try { var ch = G.Chars; if (ch && ch.cur) applySkin(ch.cur, ch.id, mySkin); } catch (e) { /* nada */ } }

  // ======================================================================== arranque
  function start(client) {
    nx = client;
    setRole();
    nx.on('players', function () { setRole(); prune(); });
    nx.on('player:join', function (p) { toast(p.name + ' se unió a la sala'); });
    nx.on('player:leave', function (p) { toast((p.name || 'Un jugador') + ' salió'); dropRemote(p.id); });
    nx.on('state', function (id, d) { onRemoteState(id, d); });
    nx.on('event:zs', function (d) { if (role === 'guest') applySnapshot(d); });
    nx.on('event:zh', function (d, from) { if (role === 'host') applyHits(d, from); });
    nx.on('event:fx', function (d, from) { onFx(d, from); });
    nx.on('event:hurt', function (d) { onHurtMe(d); });
    var states = nx.getStates();
    Object.keys(states).forEach(function (id) { onRemoteState(id, states[id]); });

    buildSkinPicker();
    document.addEventListener('click', function (ev) { if (ev.target && ev.target.closest && ev.target.closest('.chc')) setTimeout(function () { reapplyMine(); publishState(); }, 50); });
    patchAudio();
    patchHurtPlayer();
    setInterval(publishState, STATE_MS);
    setInterval(flushFx, FLUSH_MS);
    setInterval(function () { if (role === 'host') sendSnapshot(); }, SNAP_MS);
    requestAnimationFrame(loop);
    nx.ready();
    window.VERTICE_MP = { dbg: dbg, role: function () { return role; }, remote: remote, proxies: proxies, nx: nx };
    toast('Modo cooperativo activo · ' + (role === 'host' ? 'eres el anfitrión: los infectados corren en tu dispositivo' : 'te conectas al mundo del anfitrión'));
  }

  function hostId() {
    var h = nx.players.filter(function (p) { return p.host; })[0];
    return h ? h.id : null;
  }

  function setRole() {
    var now = nx.isHost ? 'host' : 'guest';
    if (now === role) return;
    var first = role === null;
    role = now;
    if (role === 'guest') becomeGuest(); else becomeHost(!first);
  }

  // ---- el invitado no simula infectados: solo dibuja copias de los del anfitrión
  function becomeGuest() {
    var dir = G.dir;
    if (!origDirUpdate) origDirUpdate = dir.update;
    dir.update = function (dt) {
      for (var i = 0; i < this.enemies.length; i++) { var e = this.enemies[i]; if (e._px) e.update(dt); }
    };
    purgeLocalEnemies();
  }

  function becomeHost(switched) {
    var dir = G.dir;
    if (origDirUpdate) { dir.update = origDirUpdate; origDirUpdate = null; }
    if (switched) {
      // El anfitrión anterior se fue: este dispositivo pasa a simular el mundo (los infectados se reinician)
      clearProxies();
      purgeLocalEnemies(true);
      try { dir.initial(); } catch (e) { /* ya inicializado */ }
      toast('Ahora eres el anfitrión: los infectados se reiniciaron', 'warn');
    }
  }

  function purgeLocalEnemies(all) {
    var list = G.dir.enemies;
    for (var i = list.length - 1; i >= 0; i--) {
      if (all || !list[i]._px) { try { list[i].dispose(); } catch (e) { /* nada */ } list.splice(i, 1); }
    }
    G.dir.giant = null;
  }

  function clearProxies() {
    proxies.forEach(function (e) { try { e.dispose(); } catch (x) { /* nada */ } var i = G.dir.enemies.indexOf(e); if (i >= 0) G.dir.enemies.splice(i, 1); });
    proxies.clear();
  }

  // ======================================================================== estado propio
  function playing() { return G.state === 'play' && G.ps && G.ps.alive; }

  var dbg = { pubCalls: 0, pubSent: 0, pubErr: '', notConn: 0 };
  function publishState() {
    dbg.pubCalls++;
    if (!nx || !nx.connected) { dbg.notConn++; return; }
    var s;
    if (!playing()) { s = { p: 0, k: (G.Chars && G.Chars.id) || 'vertice', q: mySkin }; }
    else {
      var p = G.ctrl.pos, v = G.ctrl.vel;
      s = {
        p: 1, x: r2(p.x), y: r2(p.y), z: r2(p.z), a: r2(G.look.yaw), b: r2(G.look.pitch),
        s: G.ctrl.stance | 0, w: G.Arms && G.Arms.cur || '', m: r1(Math.hypot(v.x, v.z)),
        h: Math.round(G.ps.hp), v: r2(G.player.visibility == null ? 1 : G.player.visibility), t: G.atk ? 1 : 0,
        k: (G.Chars && G.Chars.id) || 'vertice', q: mySkin, nm: String(G.charName || '').slice(0, 14),
      };
      if (G.veh) s.c = [r1(G.veh.x), r1(G.veh.z), r2(G.veh.yaw), G.veh.type || 'car'];
    }
    try { nx.setState(s); dbg.pubSent++; } catch (e) { dbg.pubErr = String(e && e.message); }
  }

  // ======================================================================== jugadores remotos
  function onRemoteState(id, d) {
    if (!nx.me || id === nx.me.id || !d) return;
    var r = remote.get(id);
    if (!r) { r = { id: id, st: null, t: 0, av: null, pos: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, speed: 0, phase: 0, init: false,
      pl: { pos: { x: 0, y: 0, z: 0 }, h: 1.8, visibility: 1, moving: false, crouch: false } }; remote.set(id, r); }
    r.st = d; r.t = performance.now();
  }

  function dropRemote(id) {
    var r = remote.get(id);
    if (r && r.av) { G.scene.remove(r.av.root); disposeAvatar(r.av); }
    remote.delete(id);
  }

  function prune() {
    var ids = {}; nx.players.forEach(function (p) { ids[p.id] = true; });
    Array.from(remote.keys()).forEach(function (id) { if (!ids[id]) dropRemote(id); });
  }

  function nameOf(id) { var p = nx.getPlayer(id); return (p && p.name) || 'Jugador'; }

  function hueOf(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0; return h % 360; }

  // ---- avatares: modelo 3D real del personaje elegido, o muñeco de cajas si no está disponible
  function box(w, h, d, mat, x, y, z) { var m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat); m.position.set(x, y, z); return m; }

  function makeLabel(name, col) {
    var cv = document.createElement('canvas'); cv.width = 256; cv.height = 64; var c = cv.getContext('2d');
    c.font = 'bold 30px sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillStyle = 'rgba(0,0,0,.55)'; c.fillRect(8, 8, 240, 48);
    c.fillStyle = '#' + col.getHexString(); c.fillText(String(name).slice(0, 14), 128, 33);
    var label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), transparent: true, depthTest: false, depthWrite: false, fog: false }));
    label.scale.set(1.6, 0.4, 1); label.position.set(0, 2.2, 0); label.renderOrder = 999;
    return label;
  }

  function carGroup(col) {
    var carG = new THREE.Group(), carM = new THREE.MeshStandardMaterial({ color: col, roughness: 0.6 });
    carG.add(box(1.9, 0.7, 4.2, carM, 0, 0.65, 0));
    carG.add(box(1.7, 0.6, 2.0, new THREE.MeshStandardMaterial({ color: 0x20262c, roughness: 0.3 }), 0, 1.25, 0.2));
    carG.visible = false;
    return carG;
  }

  // Muñeco sencillo (respaldo si el juego no expone buildChar)
  function buildAvatar(id, name) {
    var hue = hueOf(id), col = new THREE.Color().setHSL(hue / 360, 0.65, 0.5), dark = new THREE.Color().setHSL(hue / 360, 0.5, 0.25);
    var skin = new THREE.MeshStandardMaterial({ color: 0xd9b08c, roughness: 0.8 });
    var shirt = new THREE.MeshStandardMaterial({ color: col, roughness: 0.85, emissive: col, emissiveIntensity: 0.12 });
    var pants = new THREE.MeshStandardMaterial({ color: dark, roughness: 0.9 });
    var gunM = new THREE.MeshStandardMaterial({ color: 0x1b1b1f, roughness: 0.5, metalness: 0.4 });
    var blade = new THREE.MeshStandardMaterial({ color: 0x9aa3ab, roughness: 0.4, metalness: 0.6 });
    var root = new THREE.Group(), body = new THREE.Group(); root.add(body);
    root.name = 'mp-avatar-' + id;
    var torso = box(0.5, 0.62, 0.26, shirt, 0, 1.18, 0);
    var head = new THREE.Group(); head.position.set(0, 1.58, 0);
    head.add(box(0.26, 0.28, 0.26, skin, 0, 0.14, 0)); head.add(box(0.28, 0.08, 0.3, shirt, 0, 0.3, 0));
    function limb(w, h, d, mat, x, y) { var g = new THREE.Group(); g.position.set(x, y, 0); g.add(box(w, h, d, mat, 0, -h / 2, 0)); return g; }
    var legL = limb(0.2, 0.84, 0.22, pants, -0.14, 0.86), legR = limb(0.2, 0.84, 0.22, pants, 0.14, 0.86);
    var armL = limb(0.14, 0.62, 0.16, shirt, -0.34, 1.46), armR = limb(0.14, 0.62, 0.16, shirt, 0.34, 1.46);
    var hand = new THREE.Group(); hand.position.set(0, -0.62, 0); armR.add(hand);
    var wpn = new THREE.Group(); hand.add(wpn);
    var melee = new THREE.Group(); melee.add(box(0.05, 0.62, 0.06, blade, 0, -0.1, -0.08)); wpn.add(melee);
    var pistol = new THREE.Group(); pistol.add(box(0.07, 0.1, 0.28, gunM, 0, 0.0, -0.12)); wpn.add(pistol);
    var longGun = new THREE.Group(); longGun.add(box(0.08, 0.1, 0.8, gunM, 0, 0.0, -0.3)); wpn.add(longGun);
    var flash = new THREE.Mesh(new THREE.SphereGeometry(0.14, 8, 6), new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0, depthWrite: false, fog: false }));
    flash.position.set(0, 0, -0.75); hand.add(flash);
    body.add(torso, head, legL, legR, armL, armR);
    var label = makeLabel(name, col); root.add(label);
    var carG = carGroup(col); root.add(carG);
    return { real: false, root: root, bodyNode: body, body: body, head: head, legL: legL, legR: legR, armL: armL, armR: armR, melee: melee, pistol: pistol, longGun: longGun, flash: flash, label: label, carG: carG, name: name, flashT: 0 };
  }

  // Modelo 3D real del personaje elegido (Vértice, Lena o Alejandro). Una instancia por jugador:
  // dos jugadores con el mismo personaje se ven los dos, cada uno con el suyo.
  function buildRealAvatar(id, name, charId, skinIdx) {
    var hue = hueOf(id), col = new THREE.Color().setHSL(hue / 360, 0.65, 0.6);
    var m = G.buildChar(charId);
    var root = new THREE.Group(); root.name = 'mp-avatar-' + id;
    root.add(m.g); m.g.visible = true;
    applySkin(m, charId, skinIdx);
    var label = makeLabel(name, col); root.add(label);
    var carG = carGroup(col); root.add(carG);
    return { real: true, m: m, root: root, bodyNode: m.g, label: label, carG: carG, name: name, flashT: 0, h: G.CH[charId].h / 1.78, lean: 0 };
  }

  function animateReal(av, r, st, dt, now) {
    var m = av.m, sp = r.speed, pit = r.pitch, stn = st.s | 0, pr = stn === 2, cr = stn === 1 ? 1 : 0;
    var kind = weaponKind(st.w), gun = kind !== 'melee', ex = function (t) { return 1 - Math.exp(-t * dt); };
    var spN = smooth(1, 6.5, sp), mv = smooth(0.15, 1.3, sp), A0 = lerp(0.32, 0.95, spN) * (cr ? 0.6 : 1), A = A0 * mv, kb = lerp(0.65, 1.5, spN);
    var om = sp > 0.2 ? Math.min(22, Math.PI * sp / (2 * (0.9 - 0.25 * cr) * Math.sin(A0))) : 0;
    r.cph = (r.cph || 0) + om * dt;
    var s = Math.sin(r.cph), cs = Math.cos(r.cph), hipY = 0;
    m.legs.forEach(function (L, i) {
      var sd = i ? -1 : 1, th = cr * 0.95 + s * sd * A, kn = -cr * 1.6 - Math.max(0, cs * sd) * kb * mv;
      L.hip.rotation.x += (th - L.hip.rotation.x) * ex(32); L.kn.rotation.x += (kn - L.kn.rotation.x) * ex(32);
      hipY = Math.max(hipY, 0.45 * Math.cos(L.hip.rotation.x) + 0.45 * Math.cos(L.hip.rotation.x + L.kn.rotation.x));
    });
    var sprint = sp > 5.2;
    av.lean += ((sprint ? 0.2 : 0.07) * smooth(0.5, 3, sp) - av.lean) * ex(8);
    m.pel.position.y = hipY; m.pel.rotation.x = -av.lean - cr * 0.3;
    var sA = s * mv, sw = 0.3 + 0.35 * spN, aL = m.arms[0], aR = m.arms[1], br = Math.sin(now / 520) * (1 - mv), twist = 0;
    if (pr) { aL.sh.rotation.set(2.9, 0, 0); aR.sh.rotation.set(2.9, 0, 0); aL.el.rotation.x = aR.el.rotation.x = 0.1; }
    else if (gun) { aL.sh.rotation.set(1.3 + pit, 0, 0.5); aL.el.rotation.x = 0.5; aR.sh.rotation.set(1.45 + pit, 0, -0.04); aR.el.rotation.x = 0.12; }
    else {
      aL.sh.rotation.set(-sA * sw * 1.3 + br * 0.03, 0, 0.06); aL.el.rotation.x = 0.15 + Math.abs(sA) * 0.25;
      if (st.t) {   // golpe: ciclo de 0,4 s mientras dure el ataque
        var kk = (now % 400) / 400, w = smooth(0, 0.25, kk), q = smooth(0.25, 0.7, kk);
        aR.sh.rotation.set(0.35 + 2.35 * w - 2.2 * q, 0, -0.08); aR.el.rotation.x = 0.8 - 0.5 * w + 0.5 * q; twist = 0.3 * w - 0.35 * q;
      } else { aR.sh.rotation.set(0.4 + sA * sw * 0.9, 0, -0.06); aR.el.rotation.x = 0.8; }
    }
    m.tor.rotation.y += (twist - s * 0.13 * mv * (gun || pr ? 0.25 : 1) - m.tor.rotation.y) * ex(22);
    m.hd.rotation.x = clamp(pit * 0.7, -0.8, 0.8) + (pr ? 1.25 : 0) - m.pel.rotation.x * 0.7;
    var has = Object.prototype.hasOwnProperty.call(m.pv, st.w);
    for (var n in m.pv) m.pv[n].visible = has ? n === st.w : n === 'machete';
    m.flash.visible = gun && av.flashT > 0; m.flash.position.z = 0.55;
    var kr = ex(10), tx = pr ? -1.45 : 0, ty = pr ? 0.2 : 0, tz = pr ? 0.85 : 0;
    m.rig.rotation.x += (tx - m.rig.rotation.x) * kr; m.rig.position.y += (ty - m.rig.position.y) * kr; m.rig.position.z += (tz - m.rig.position.z) * kr;
    m.g.rotation.y = r.yaw; m.g.position.set(0, 0, 0);
    av.label.position.set(0, (pr ? 0.9 : cr ? 1.7 : 2.15) * av.h + 0.15, 0);
  }

  function disposeAvatar(av) {
    if (av.real) {   // los materiales y texturas del personaje pertenecen al juego: solo se libera la etiqueta
      av.root.traverse(function (o) { if (o.isSprite && o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
      return;
    }
    av.root.traverse(function (o) { if (o.geometry) o.geometry.dispose(); if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); } });
  }

  function weaponKind(id) {
    var W = G.WEAPONS && G.WEAPONS[id];
    if (!id || (W && W.melee)) return 'melee';
    if (id === 'pistola' || id === 'revolver') return 'pistol';
    return 'long';
  }

  function updateRemote(r, dt, now) {
    var st = r.st;
    var show = st && st.p === 1 && now - r.t < STALE_MS && G.state !== 'menu';
    if (!show) { if (r.av) r.av.root.visible = false; r.pl.pos.y = -999; r.active = false; return; }
    r.active = true;
    var tag = String(st.nm || nameOf(r.id)).slice(0, 14), key = (st.k || '') + ':' + (st.q | 0) + ':' + tag;
    if (r.av && r.key !== key) { G.scene.remove(r.av.root); disposeAvatar(r.av); r.av = null; }
    if (!r.av) {
      var canReal = G.buildChar && G.CH && G.CH[st.k];
      try { r.av = canReal ? buildRealAvatar(r.id, tag, st.k, st.q | 0) : buildAvatar(r.id, tag); }
      catch (e) { console.error('[vertice-mp] avatar', e); r.av = buildAvatar(r.id, tag); }
      r.key = key; G.scene.add(r.av.root);
    }
    var av = r.av; av.root.visible = true;
    var k = r.init ? 1 - Math.exp(-14 * dt) : 1; r.init = true;
    var ox = r.pos.x, oz = r.pos.z;
    r.pos.x += (st.x - r.pos.x) * k; r.pos.y += (st.y - r.pos.y) * k; r.pos.z += (st.z - r.pos.z) * k;
    if (Math.hypot(st.x - r.pos.x, st.z - r.pos.z) > 25) { r.pos.x = st.x; r.pos.y = st.y; r.pos.z = st.z; }   // teletransporte (caída al vacío, reaparición)
    r.yaw = angLerp(r.yaw, st.a, k); r.pitch += (st.b - r.pitch) * k;
    var sp = dt > 0 ? Math.hypot(r.pos.x - ox, r.pos.z - oz) / dt : 0;
    r.speed += (Math.min(sp, 8) - r.speed) * Math.min(1, dt * 8);
    r.phase += r.speed * dt * 2.1;

    var driving = !!st.c;
    av.bodyNode.visible = !driving; av.carG.visible = driving;
    av.root.position.set(r.pos.x, r.pos.y, r.pos.z);
    if (driving) {
      av.root.position.set(st.c[0], r.pos.y, st.c[1]); av.root.rotation.y = st.c[2];
      av.label.position.set(0, 2.6, 0);
    } else if (av.real) {
      av.root.rotation.y = 0; animateReal(av, r, st, dt, now);
    } else {
      av.root.rotation.y = r.yaw; av.label.position.set(0, st.s === 2 ? 0.9 : st.s === 1 ? 1.75 : 2.2, 0);
      var swing = Math.sin(r.phase) * Math.min(0.85, r.speed * 0.28);
      av.legL.rotation.x = swing; av.legR.rotation.x = -swing;
      var kind = weaponKind(st.w);
      av.melee.visible = kind === 'melee'; av.pistol.visible = kind === 'pistol'; av.longGun.visible = kind === 'long';
      av.head.rotation.x = r.pitch * 0.9;
      av.armL.rotation.x = -swing * 0.8;
      if (kind === 'melee') {
        av.armR.rotation.x = st.t ? -1.4 + Math.sin(now / 55) * 1.1 : swing * 0.8 - 0.1;
        av.melee.rotation.x = st.t ? 0 : -0.3;
      } else {
        av.armR.rotation.x = Math.PI / 2 + r.pitch;     // apuntando
        av.armL.rotation.x = Math.PI / 2.4 + r.pitch;
      }
      av.body.position.y = 0; av.body.rotation.x = 0;
      av.root.scale.y = 1;
      if (st.s === 1) { av.root.scale.y = 0.72; }
      if (st.s === 2) { av.body.rotation.x = -Math.PI / 2; av.body.position.y = 0.28; av.body.position.z = 0; }
    }
    if (av.flashT > 0) { av.flashT -= dt; if (av.flash) av.flash.material.opacity = Math.max(0, av.flashT / 0.07); } else if (av.flash) av.flash.material.opacity = 0;
    // datos para la IA del anfitrión (los infectados persiguen a este jugador)
    r.pl.pos.x = r.pos.x; r.pl.pos.y = r.pos.y; r.pl.pos.z = r.pos.z;
    r.pl.h = st.s === 2 ? 0.5 : st.s === 1 ? 1.2 : 1.8;
    r.pl.visibility = st.v == null ? 1 : st.v; r.pl.moving = (st.m || 0) > 0.5; r.pl.crouch = (st.s | 0) >= 1;
    r.pl.alive = (st.h == null || st.h > 0) && !driving;
  }

  // ======================================================================== efectos de disparo
  function patchAudio() {
    var a = G.audio, og = a.gunshot;
    a.gunshot = function (id) {
      try {
        var p = G.ctrl.pos, y = G.look.yaw, b = G.look.pitch;
        if (fxShots.length < 12) fxShots.push([id, r1(p.x), r1(p.y + 1.55), r1(p.z), r2(y), r2(b)]);
      } catch (e) { /* sin datos */ }
      return og.apply(this, arguments);
    };
  }

  function flushFx() {
    if (!nx || !nx.connected) return;
    if (fxShots.length) { try { nx.send('fx', { s: fxShots }); } catch (e) { /* nada */ } fxShots = []; }
    if (fxHits.length && role === 'guest') {
      var h = hostId();
      if (h) { try { nx.send('zh', { h: fxHits }, { to: h }); } catch (e) { /* nada */ } }
      fxHits = [];
    } else if (role !== 'guest') fxHits = [];
  }

  function onFx(d, from) {
    if (!d || !Array.isArray(d.s)) return;
    var r = remote.get(from);
    d.s.slice(0, 12).forEach(function (s) {
      if (!Array.isArray(s) || s.length < 6) return;
      var id = String(s[0]), x = +s[1], y = +s[2], z = +s[3], yaw = +s[4], pitch = +s[5];
      if (![x, y, z, yaw, pitch].every(isFinite)) return;
      remoteShot(id, x, y, z, yaw, pitch, r);
      if (role === 'host') {
        // los infectados del anfitrión oyen los disparos de los invitados
        var W = G.WEAPONS && G.WEAPONS[id];
        try { G.noise(x, y - 1.4, z, (W && W.noise) || 60, 'player', { threat: ((W && W.noise) || 60) * 0.16 }); } catch (e) { /* nada */ }
      }
    });
  }

  function remoteShot(id, x, y, z, yaw, pitch, r) {
    var cp = Math.cos(pitch), fx = -Math.sin(yaw) * cp, fy = Math.sin(pitch), fz = -Math.cos(yaw) * cp;
    var a = G.audio, pos = { x: x, y: y - 1.2, z: z };
    try {
      if (a.ctx) {
        if (id === 'escopeta') { a._noise({ type: 'lowpass', f: 1400, sweep: 300, dur: 0.38, gain: 0.8, attack: 0.002, brown: true, pos: pos }); a._tone({ f: 140, sweep: 38, dur: 0.3, gain: 0.7, type: 'triangle', pos: pos }); }
        else if (id === 'rifle') { a._noise({ type: 'highpass', f: 1000, sweep: 3200, dur: 0.16, gain: 0.55, attack: 0.001, pos: pos }); a._tone({ f: 170, sweep: 45, dur: 0.22, gain: 0.55, type: 'triangle', pos: pos }); }
        else { a._noise({ type: 'bandpass', f: 1900, q: 0.8, dur: 0.12, gain: 0.55, attack: 0.001, pos: pos }); a._tone({ f: 210, sweep: 60, dur: 0.16, gain: 0.5, type: 'triangle', pos: pos }); }
      }
    } catch (e) { /* sin audio */ }
    // trazador
    var L = 45, geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(x + fx * 0.8, y + fy * 0.8 - 0.1, z + fz * 0.8), new THREE.Vector3(x + fx * L, y + fy * L, z + fz * L)]);
    var line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.9, fog: false }));
    G.scene.add(line); tracers.push({ line: line, t: 0.14 });
    if (r && r.av) r.av.flashT = 0.07;
  }

  // ======================================================================== daño a jugadores (infectado → invitado)
  function patchHurtPlayer() {
    origHurtPlayer = G.hurtPlayer;
    G.hurtPlayer = function (dmg, e) {
      var tgt = G._mpTarget;
      if (tgt && tgt !== 'me') {
        // un infectado del anfitrión golpeó a un invitado: el daño se aplica en su dispositivo
        var r = remote.get(tgt);
        if (r && nx && nx.connected) {
          try { nx.send('hurt', { d: Math.round(dmg), n: e && e.T && e.T.name || 'Infectado', x: e && e.pos ? r1(e.pos.x) : 0, z: e && e.pos ? r1(e.pos.z) : 0 }, { to: tgt }); } catch (x) { /* nada */ }
        }
        return;
      }
      return origHurtPlayer.apply(this, arguments);
    };
  }

  function onHurtMe(d) {
    if (!d || !isFinite(+d.d) || +d.d <= 0 || +d.d > 200) return;
    origHurtPlayer.call(G, +d.d, { T: { name: String(d.n || 'Infectado').slice(0, 24) }, pos: { x: +d.x || 0, z: +d.z || 0 }, noDiff: false });
  }

  // ======================================================================== anfitrión: IA con varios objetivos + instantánea
  function wrapEnemy(e) {
    if (e._mpw) return;
    e._mpw = true;
    var orig = e.update;
    e.update = function (dt) {
      var t = pickTarget(this);
      if (!t) return orig.call(this, dt);
      var real = G.player;
      G.player = t.pl; G._mpTarget = t.id;
      try { return orig.call(this, dt); } finally { G.player = real; G._mpTarget = null; }
    };
  }

  function pickTarget(e) {
    var best = null, bd = Infinity, me = G.player;
    if (playing()) { bd = Math.hypot(me.pos.x - e.pos.x, me.pos.z - e.pos.z) + Math.abs(me.pos.y - e.pos.y) * 3; best = null; }
    remote.forEach(function (r) {
      if (!r.active || !r.pl.alive) return;
      var d = Math.hypot(r.pl.pos.x - e.pos.x, r.pl.pos.z - e.pos.z) + Math.abs(r.pl.pos.y - e.pos.y) * 3;   // un piso de diferencia pesa como ~10 m
      if (d < bd) { bd = d; best = { id: r.id, pl: r.pl }; }
    });
    return best;   // null = el jugador local es el más cercano (o el único)
  }

  function allPlayerPoints() {
    var pts = [];
    if (playing()) pts.push(G.ctrl.pos);
    remote.forEach(function (r) { if (r.active) pts.push(r.pos); });
    return pts;
  }

  function sendSnapshot() {
    if (!nx || !nx.connected || remote.size === 0) return;
    var pts = allPlayerPoints(), list = G.dir.enemies, cand = [];
    if (!pts.length) return;
    for (var i = 0; i < list.length; i++) {
      var e = list[i]; if (e._px) continue;
      if (!e.alive && e.deadT > 20) continue;
      var md = Infinity;
      for (var j = 0; j < pts.length; j++) { var d = Math.hypot(pts[j].x - e.pos.x, pts[j].z - e.pos.z); if (d < md) md = d; }
      if (md > (e.isGiant ? 220 : SNAP_RANGE)) continue;
      cand.push([md, e]);
    }
    cand.sort(function (a, b) { return a[0] - b[0]; });
    var out = [];
    for (var n = 0; n < cand.length && n < MAX_SNAP; n++) {
      var q = cand[n][1];
      var ti = Math.max(0, TYPES.indexOf(q.type));
      var fl = (q.alive ? 1 : 0) | ((q.windT > 0) ? 2 : 0) | ((q.state === 'chase' || q.state === 'investigate' || q.state === 'alert') ? 4 : 0) | ((q.stun > 0) ? 8 : 0) | (q.climb ? 16 : 0);
      out.push([q.id, ti, r1(q.pos.x), r2(q.pos.y), r1(q.pos.z), r2(q.yaw), Math.max(0, Math.round(q.hp / q.T.hp * 100)), fl].join('|'));
    }
    var env = G.env, WX = G.WX;
    try { nx.send('zs', { q: ++snapSeq, k: out.join(';'), t: r2(env.t), d: env.dayCount || env.day || 1, w: WX && WX.kind || '' }); } catch (e) { /* nada */ }
  }

  function applyHits(d, from) {
    if (!d || !Array.isArray(d.h)) return;
    var r = remote.get(from); var fp = r ? r.pos : G.ctrl.pos;
    d.h.slice(0, 20).forEach(function (h) {
      if (!Array.isArray(h)) return;
      var e = null, id = +h[0], dmg = +h[1];
      if (!isFinite(id) || !isFinite(dmg) || dmg <= 0 || dmg > 400) return;
      for (var i = 0; i < G.dir.enemies.length; i++) if (G.dir.enemies[i].id === id && !G.dir.enemies[i]._px) { e = G.dir.enemies[i]; break; }
      if (!e || !e.alive) return;
      var from2 = { x: isFinite(+h[2]) ? +h[2] : fp.x, z: isFinite(+h[3]) ? +h[3] : fp.z };
      var was = e.alive;
      try { e.hurt(dmg, from2, !!h[4], h[5] == null ? undefined : +h[5]); } catch (x) { /* enemigo inconsistente */ }
      if (was && !e.alive) { /* muerte atribuida al invitado: sin marcador de bajas compartido */ }
    });
  }

  // ======================================================================== invitado: copias de los infectados
  function applySnapshot(d) {
    if (!d || typeof d.k !== 'string') return;
    var now = performance.now(), seen = {};
    if (isFinite(+d.t) && G.env && Math.abs(G.env.t - d.t) > 0.004 && G.state === 'play') { G.env.t = +d.t; if (d.d) { G.env.dayCount = d.d; } }
    try { if (d.w && G.WX && G.WX.kind !== d.w && G.WX.setMode) G.WX.setMode(d.w); } catch (e) { /* clima no disponible */ }
    var recs = d.k ? d.k.split(';') : [];
    for (var i = 0; i < recs.length; i++) {
      var f = recs[i].split('|'); if (f.length < 8) continue;
      var id = +f[0], ti = +f[1], x = +f[2], y = +f[3], z = +f[4], yaw = +f[5], hp = +f[6], fl = +f[7];
      if (![id, ti, x, y, z, yaw, hp, fl].every(isFinite)) continue;
      seen[id] = true;
      var e = proxies.get(id);
      if (!e) { e = makeProxy(id, TYPES[ti] || 'walker', x, z, y); if (!e) continue; e.pos.x = x; e.pos.y = y; e.pos.z = z; e.yaw = yaw; }
      e._tg = { x: x, y: y, z: z, yaw: yaw, fl: fl };
      e.hp = e.T.hp * hp / 100; e._seen = now;
    }
    // los que dejaron de llegar (lejos, reciclados o ya retirados) se descartan
    proxies.forEach(function (e, id) {
      if (!seen[id] && now - (e._seen || 0) > 1500) {
        try { e.dispose(); } catch (x) { /* nada */ }
        var ix = G.dir.enemies.indexOf(e); if (ix >= 0) G.dir.enemies.splice(ix, 1);
        proxies.delete(id);
      }
    });
  }

  function makeProxy(id, type, x, z, y) {
    var dir = G.dir, e = null;
    try { e = type === 'giant' ? dir.spawnGiant() : dir.spawn(type, x, z, null, null, y); } catch (err) { e = null; }
    if (!e) return null;
    e._px = true; e._hid = id; e._mpw = true;
    e.hear = function () { }; e.go = function () { }; e.perceive = function () { }; e.setPath = function () { };
    e.hurt = function (dmg, from, sneak, kb) {
      if (!this.alive) return;
      if (fxHits.length < 30) fxHits.push([this._hid, Math.round(dmg), from ? r1(from.x) : null, from ? r1(from.z) : null, sneak ? 1 : 0, kb == null ? null : r2(kb)]);
      this.stun = sneak ? 0.5 : 0.25; this.stunMax = this.stun;      // reacción inmediata (la real llega del anfitrión)
      if (from) { var dx = this.pos.x - from.x, dz = this.pos.z - from.z, dd = Math.hypot(dx, dz) || 1; this.hitDir = { x: dx / dd, z: dz / dd }; this.hitK = 0.5; }
    };
    e.update = function (dt) {
      var t = this._tg; if (!t) return;
      var alive = (t.fl & 1) !== 0;
      if (this.alive && !alive) { this.alive = true; this.die(true); }
      if (!this.alive) { this.deadT += dt; this.animate(dt); return; }
      var k = 1 - Math.exp(-12 * dt), ox = this.pos.x, oz = this.pos.z;
      this.pos.x += (t.x - this.pos.x) * k; this.pos.z += (t.z - this.pos.z) * k; this.pos.y += (t.y - this.pos.y) * k;
      if (Math.hypot(t.x - this.pos.x, t.z - this.pos.z) > 15) { this.pos.x = t.x; this.pos.z = t.z; this.pos.y = t.y; }
      this.yaw = angLerp(this.yaw, t.yaw, k);
      var sp = dt > 0 ? Math.hypot(this.pos.x - ox, this.pos.z - oz) / dt : 0;
      this.speedNow += (Math.min(sp, 9) - this.speedNow) * Math.min(1, dt * 10);
      this.state = (t.fl & 4) ? 'chase' : 'patrol';
      this.windT = (t.fl & 2) ? this.T.windup * 0.5 : 0;
      if (this.stun > 0) this.stun -= dt; if ((t.fl & 8) && this.stun <= 0) this.stun = 0.15;
      this.animate(dt);
    };
    proxies.set(id, e);
    return e;
  }

  // ======================================================================== bucle de dibujo
  var last = performance.now();
  function loop(now) {
    requestAnimationFrame(loop);
    var dt = Math.min((now - last) / 1000, 0.1); last = now;
    try {
      if (nx) {
        remote.forEach(function (r) { updateRemote(r, dt, now); });
        if (role === 'host') { var l = G.dir.enemies; for (var i = 0; i < l.length; i++) if (!l[i]._mpw) wrapEnemy(l[i]); }
        else if (role === 'guest') {
          var list = G.dir.enemies;
          for (var j = list.length - 1; j >= 0; j--) if (!list[j]._px) { try { list[j].dispose(); } catch (e) { /* nada */ } list.splice(j, 1); }
          if (G.state === 'menu' && proxies.size) clearProxies();
        }
      }
      for (var t = tracers.length - 1; t >= 0; t--) {
        var tr = tracers[t]; tr.t -= dt; tr.line.material.opacity = Math.max(0, tr.t / 0.14) * 0.9;
        if (tr.t <= 0) { G.scene.remove(tr.line); tr.line.geometry.dispose(); tr.line.material.dispose(); tracers.splice(t, 1); }
      }
    } catch (err) { if (!loop._warned) { loop._warned = true; console.error('[vertice-mp]', err); } }
  }
})();
