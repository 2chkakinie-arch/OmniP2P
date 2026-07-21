/*!
 * ============================================================================
 *  OmniP2P GunDB Adapter  —  GunDB.js
 * ============================================================================
 *  OmniP2P v2 の外部アダプタ。GunDB をリアルタイム分散グラフストアとして統合。
 *
 *  役割:
 *   - ルーム状態を Gun グラフにミラーし、WebRTC/Nostr と並列のリアルタイム同期路を追加
 *   - オフライン耐性のある KV / グラフ DB として room.gun.* を提供
 *   - Gun のリレー (peers) が生きていれば Nostr が詰まっても即時同期が届く
 *
 *  使い方 (読み込むだけ or 遅延ロード):
 *    <script src="OmniP2P.js"></script>
 *    <script src="GunDB.js"></script>            // ← これだけで登録される
 *    <script>
 *      OmniP2P.use('gundb', {
 *        peers: ['https://gun-manhattan.herokuapp.com/gun'], // 任意の Gun リレー
 *        // gunUrl: 'https://cdn.jsdelivr.net/npm/gun/gun.js' // SDK URL 上書き可
 *      });
 *      const omni = new OmniP2P(); await omni.start();
 *      const room = await omni.join('room', { password: 'pw' });
 *      // Gun API:
 *      room.gun.put('title', 'Hello');
 *      room.gun.on('title', v => console.log('gun sync:', v));
 *      room.gun.map('messages', (k, v) => console.log(k, v));
 *    </script>
 *
 *  または明示ロード:
 *    await OmniP2P.loadAdapter('gundb');
 *    omni.use('gundb', { peers:[...] });
 * ============================================================================
 */
(function () {
  'use strict';
  if (typeof OmniP2P === 'undefined') { console.error('[GunDB.js] load OmniP2P.js first'); return; }

  const DEFAULT_GUN_URL = 'https://cdn.jsdelivr.net/npm/gun/gun.js';
  const DEFAULT_SEA_URL = 'https://cdn.jsdelivr.net/npm/gun/sea.js';
  const DEFAULT_PEERS = [
    'https://gun-manhattan.herokuapp.com/gun',
    'https://peer.wallie.io/gun'
  ];

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') { try { require(url); return resolve(); } catch (e) { return reject(e); } }
      if ([...document.scripts].some(s => s.src === url)) return resolve();
      const s = document.createElement('script'); s.src = url; s.async = true;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('load fail ' + url));
      document.head.appendChild(s);
    });
  }

  async function ensureGun(config) {
    let Gun = (typeof window !== 'undefined' && window.Gun) || (typeof global !== 'undefined' && global.Gun);
    if (Gun) return Gun;
    await loadScript((config && config.gunUrl) || DEFAULT_GUN_URL);
    try { await loadScript((config && config.seaUrl) || DEFAULT_SEA_URL); } catch (_) { /* SEA は任意 */ }
    Gun = (typeof window !== 'undefined' && window.Gun) || (typeof global !== 'undefined' && global.Gun);
    if (!Gun) throw new Error('Gun SDK failed to load');
    return Gun;
  }

  // アダプタ本体 (OmniP2P.use('gundb', config) で呼ばれる factory)
  const factory = function (node, config) {
    config = config || {};
    let gun = null;
    return {
      name: 'gundb',
      async onInstall() {
        try {
          const Gun = await ensureGun(config);
          const peers = config.peers || DEFAULT_PEERS;
          gun = Gun({ peers, localStorage: config.localStorage !== false, radisk: !!config.radisk });
          node.gun = gun;
          node.log.i('[gundb] initialized with', peers.length, 'peer(s)');
        } catch (e) { node.log.w('[gundb] init failed:', e.message); }
      },
      onRoom(room) {
        if (!gun) { room.log.w('[gundb] gun not ready — skip room binding'); return; }
        const ns = 'omnip2p';
        const graph = gun.get(ns).get(room.signaling.roomTag);

        // room.gun.* API を提供
        room.gun = {
          _graph: graph,
          put(key, value) {
            const v = (typeof value === 'object' && value !== null) ? value : { _v: value };
            graph.get(key).put(v);
            return this;
          },
          get(key) {
            return new Promise((resolve) => graph.get(key).once(d => resolve(unwrap(d))));
          },
          on(key, cb) {
            graph.get(key).on(d => cb(unwrap(d)));
            return () => graph.get(key).off();
          },
          map(setKey, cb) {
            graph.get(setKey).map().on((d, k) => cb(k, unwrap(d)));
            return this;
          },
          add(setKey, value) {
            const id = (Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
            const v = (typeof value === 'object' && value !== null) ? value : { _v: value };
            graph.get(setKey).get(id).put(v);
            return id;
          }
        };

        // ルームメッセージを Gun にも流し (二重搬送で到達性向上・低遅延)
        // Nostr フォールバックが遅い時、Gun 経由の方が速いことが多い。
        const seen = new Set();
        room.gun.map('_msgs', (k, v) => {
          if (!v || seen.has(k)) return; seen.add(k);
          if (seen.size > 3000) seen.clear();
          if (v.from && v.from !== node.pubkey && v.data) {
            room.emit('message', safeParse(v.data), v.from, { via: 'gun' });
          }
        });
        // OmniP2P の送信をフックして Gun にもミラー
        const origSend = room.send.bind(room);
        room.send = async function (data, opts) {
          const res = await origSend(data, opts);
          try { room.gun.add('_msgs', { from: node.pubkey, data: JSON.stringify(data), ts: Date.now() }); } catch (_) { }
          return res;
        };

        room.log.i('[gundb] realtime graph bound (room.gun.*)');
      }
    };
  };

  function unwrap(d) { if (d && typeof d === 'object' && '_v' in d && Object.keys(d).filter(k => k !== '_' && k !== '_v').length === 0) return d._v; return d; }
  function safeParse(s) { try { return JSON.parse(s); } catch (_) { return s; } }

  OmniP2P.registerAdapter('gundb', factory);
  console.log('[GunDB.js] registered as OmniP2P adapter "gundb"');
})();
