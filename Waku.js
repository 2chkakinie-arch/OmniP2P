/*!
 * ============================================================================
 *  OmniP2P Waku Adapter  —  Waku.js
 * ============================================================================
 *  OmniP2P v2 の外部アダプタ。@waku/sdk (Waku v2 / libp2p) をラップし、
 *  Nostr と並列の匿名メッセージ搬送路と、Store プロトコルによる長期保存を追加。
 *
 *  役割:
 *   - Nostr フォールバックと "並列" に Waku Relay/LightPush で送る (二重搬送)
 *     → どちらか速い方で届くため到達性と低遅延を両立
 *   - Waku は送信者の匿名性が Nostr より高い (署名不要の pub/sub)
 *   - Store プロトコルで過去メッセージを後から取得 (room.waku.history())
 *
 *  使い方:
 *    <script src="OmniP2P.js"></script>
 *    <script src="Waku.js"></script>
 *    <script>
 *      OmniP2P.use('waku', {
 *        // contentTopic は roomTag から自動生成。上書きも可:
 *        // contentTopicPrefix: '/omnip2p/1/'
 *        bootstrap: true,      // 既定ブートストラップを使う
 *        store: true           // Store で過去ログ取得を有効化
 *      });
 *      const omni = new OmniP2P(); await omni.start();
 *      const room = await omni.join('room', { password: 'pw' });
 *      const past = await room.waku.history();  // Store から過去メッセージ
 *    </script>
 *
 *  注意: Waku は E2EE 済みペイロード (OmniP2P のルーム鍵で暗号化) を搬送します。
 *        本アダプタは平文を Waku に載せません。
 * ============================================================================
 */
(function () {
  'use strict';
  if (typeof OmniP2P === 'undefined') { console.error('[Waku.js] load OmniP2P.js first'); return; }
  const { U, AEAD } = OmniP2P._internal;

  const DEFAULT_SDK_URL = 'https://cdn.jsdelivr.net/npm/@waku/sdk@0.0.30/bundle/index.js';

  async function ensureWaku(config) {
    let waku = (typeof window !== 'undefined' && window.waku) || null;
    if (waku && waku.createLightNode) return waku;
    const url = (config && config.sdkUrl) || DEFAULT_SDK_URL;
    try {
      const mod = await import(/* webpackIgnore: true */ url);
      waku = mod.default && mod.default.createLightNode ? mod.default : mod;
      if (typeof window !== 'undefined') window.waku = waku;
      return waku;
    } catch (e) {
      try { return require('@waku/sdk'); } catch (_) { throw new Error('Waku SDK load failed: ' + e.message); }
    }
  }

  const factory = function (node, config) {
    config = config || {};
    let waku = null, lightNode = null;

    return {
      name: 'waku',
      async onInstall() {
        try {
          waku = await ensureWaku(config);
          lightNode = await waku.createLightNode({ defaultBootstrap: config.bootstrap !== false });
          await lightNode.start();
          try { await waku.waitForRemotePeer(lightNode, undefined, 15000); } catch (_) { node.log.w('[waku] no remote peer yet (continuing)'); }
          node.waku = lightNode;
          node.log.i('[waku] light node started');
        } catch (e) { node.log.w('[waku] init failed:', e.message); }
      },
      async onRoom(room) {
        if (!lightNode) { room.log.w('[waku] node not ready — skip'); return; }
        const topic = (config.contentTopicPrefix || '/omnip2p/1/') + room.signaling.roomTag.slice(0, 16) + '/proto';
        let encoder = null, decoder = null;
        try {
          encoder = waku.createEncoder ? waku.createEncoder({ contentTopic: topic, ephemeral: false }) : lightNode.createEncoder({ contentTopic: topic });
          decoder = waku.createDecoder ? waku.createDecoder(topic) : lightNode.createDecoder(topic);
        } catch (e) { room.log.w('[waku] codec init failed:', e.message); return; }

        // ルーム鍵で暗号化してから Waku へ (Waku 上は暗号文のみ)
        const roomKey = room.roomKey;
        const seen = new Set();

        async function encpack(obj) {
          const ct = await AEAD.encrypt(roomKey, U.utf8(JSON.stringify(obj)), U.utf8('omni-waku'));
          return ct;
        }
        async function decpack(bytes) {
          try { const pt = await AEAD.decrypt(roomKey, new Uint8Array(bytes), U.utf8('omni-waku')); return JSON.parse(U.fromUtf8(pt)); }
          catch (_) { return null; }
        }

        // 受信サブスクライブ (Filter/Relay)
        try {
          const cb = async (wakuMsg) => {
            if (!wakuMsg || !wakuMsg.payload) return;
            const obj = await decpack(wakuMsg.payload);
            if (!obj || !obj.id || seen.has(obj.id)) return; seen.add(obj.id);
            if (seen.size > 4000) seen.clear();
            if (obj.from !== node.pubkey && obj.data !== undefined) {
              room.emit('message', obj.data, obj.from, { via: 'waku' });
            }
          };
          if (lightNode.filter && lightNode.filter.subscribe) await lightNode.filter.subscribe([decoder], cb);
          else if (lightNode.relay && lightNode.relay.subscribe) lightNode.relay.subscribe([decoder], cb);
        } catch (e) { room.log.w('[waku] subscribe failed:', e.message); }

        // 送信: OmniP2P → Waku (Nostr と並列)
        const origSend = room.send.bind(room);
        room.send = async function (data, opts) {
          const res = await origSend(data, opts);
          try {
            const payload = await encpack({ id: U.randHex(8), from: node.pubkey, data, ts: Date.now() });
            if (lightNode.lightPush && lightNode.lightPush.send) await lightNode.lightPush.send(encoder, { payload });
            else if (lightNode.relay && lightNode.relay.send) await lightNode.relay.send(encoder, { payload });
          } catch (e) { room.log.d('[waku] push err', e.message); }
          return res;
        };

        // Store から過去メッセージ取得
        room.waku = {
          contentTopic: topic,
          async history(limit = 50) {
            if (!config.store || !lightNode.store) return [];
            const out = [];
            try {
              const gen = lightNode.store.queryGenerator ? lightNode.store.queryGenerator([decoder]) : null;
              if (gen) { for await (const page of gen) { for (const m of await Promise.all(page)) { if (m && m.payload) { const o = await decpack(m.payload); if (o) out.push(o); } } if (out.length >= limit) break; } }
            } catch (e) { room.log.d('[waku] store err', e.message); }
            return out.slice(-limit);
          }
        };
        room.log.i('[waku] parallel encrypted transport bound on', topic);
      }
    };
  };

  OmniP2P.registerAdapter('waku', factory);
  console.log('[Waku.js] registered as OmniP2P adapter "waku"');
})();
