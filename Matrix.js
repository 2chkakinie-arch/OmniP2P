/*!
 * ============================================================================
 *  OmniP2P Matrix Adapter  —  Matrix.js
 * ============================================================================
 *  OmniP2P v2 の外部アダプタ。matrix-js-sdk をラップし、Matrix を
 *  「E2EE (Megolm) 永続ルーム / メッセージアーカイブ」として統合する。
 *
 *  役割:
 *   - OmniP2P ルームのメッセージを Matrix ルームへミラーし、サーバ側で
 *     暗号化永続化 (履歴の恒久保存・複数デバイス同期)
 *   - 過去ログの取得 (room.matrix.history()) で "参加前のメッセージ" も読める
 *   - Matrix の Megolm E2EE によりサーバ運営者にも内容を秘匿
 *
 *  使い方:
 *    <script src="OmniP2P.js"></script>
 *    <script src="Matrix.js"></script>
 *    <script>
 *      OmniP2P.use('matrix', {
 *        homeserver: 'https://matrix.org',
 *        accessToken: '<your token>',       // 事前にログインして取得
 *        userId: '@you:matrix.org',
 *        encrypted: true                     // Megolm E2EE を有効化
 *      });
 *      const omni = new OmniP2P(); await omni.start();
 *      const room = await omni.join('room', { password: 'pw' });
 *      // 過去ログ取得:
 *      const past = await room.matrix.history(50);
 *    </script>
 *
 *  注意: Matrix はアカウント (userId + accessToken) が必要です。未指定の場合は
 *        ゲストログインを試みますが、E2EE には正規アカウントを推奨します。
 * ============================================================================
 */
(function () {
  'use strict';
  if (typeof OmniP2P === 'undefined') { console.error('[Matrix.js] load OmniP2P.js first'); return; }
  const U = OmniP2P._internal.U;

  const DEFAULT_SDK_URL = 'https://cdn.jsdelivr.net/npm/matrix-js-sdk@34/lib/browser-index.js';

  function loadScript(url) {
    return new Promise((resolve, reject) => {
      if (typeof document === 'undefined') { try { require(url); return resolve(); } catch (e) { return reject(e); } }
      if ([...document.scripts].some(s => s.src === url)) return resolve();
      const s = document.createElement('script'); s.src = url; s.async = true;
      s.onload = () => resolve(); s.onerror = () => reject(new Error('load fail ' + url));
      document.head.appendChild(s);
    });
  }

  async function ensureSdk(config) {
    let sdk = (typeof window !== 'undefined' && (window.matrixcs || window.matrix)) || null;
    if (sdk && sdk.createClient) return sdk;
    try { await loadScript((config && config.sdkUrl) || DEFAULT_SDK_URL); } catch (e) { /* try require below */ }
    sdk = (typeof window !== 'undefined' && (window.matrixcs || window.matrix)) || null;
    if (!sdk) { try { sdk = require('matrix-js-sdk'); } catch (_) { } }
    if (!sdk || !sdk.createClient) throw new Error('matrix-js-sdk load failed');
    return sdk;
  }

  const factory = function (node, config) {
    config = config || {};
    let client = null, ready = false;
    const roomMap = new Map(); // omni roomTag -> matrix roomId

    return {
      name: 'matrix',
      async onInstall() {
        try {
          const sdk = await ensureSdk(config);
          if (!config.accessToken) {
            node.log.w('[matrix] no accessToken — register a guest (limited, no E2EE)');
            const tmp = sdk.createClient({ baseUrl: config.homeserver || 'https://matrix.org' });
            try { const g = await tmp.registerGuest(); config.accessToken = g.access_token; config.userId = g.user_id; } catch (e) { node.log.w('[matrix] guest register failed:', e.message); return; }
          }
          client = sdk.createClient({
            baseUrl: config.homeserver || 'https://matrix.org',
            accessToken: config.accessToken,
            userId: config.userId,
            deviceId: config.deviceId || ('OMNI' + U.randHex(4).toUpperCase())
          });
          if (config.encrypted && client.initCrypto) { try { await client.initCrypto(); } catch (e) { node.log.w('[matrix] initCrypto failed:', e.message); } }
          await client.startClient({ initialSyncLimit: config.initialSyncLimit || 20 });
          await new Promise((res) => { const h = (st) => { if (st === 'PREPARED') { client.removeListener('sync', h); res(); } }; client.on('sync', h); setTimeout(res, 15000); });
          ready = true;
          node.matrix = client;
          node.log.i('[matrix] client ready as', config.userId);
        } catch (e) { node.log.w('[matrix] init failed:', e.message); }
      },
      async onRoom(room) {
        if (!ready || !client) { room.log.w('[matrix] client not ready — skip'); return; }
        const alias = 'omni_' + room.signaling.roomTag.slice(0, 24);
        let mxRoomId = null;
        try {
          // 既存の別名ルームを探す or 作成
          try { const r = await client.getRoomIdForAlias('#' + alias + ':' + hostOf(config.homeserver)); mxRoomId = r.room_id; }
          catch (_) {
            const created = await client.createRoom({
              room_alias_name: alias,
              name: 'OmniP2P ' + room.roomId,
              visibility: 'private',
              initial_state: config.encrypted ? [{ type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } }] : []
            });
            mxRoomId = created.room_id;
          }
          roomMap.set(room.signaling.roomTag, mxRoomId);
        } catch (e) { room.log.w('[matrix] room setup failed:', e.message); return; }

        // 受信: Matrix → OmniP2P (他デバイス/他ユーザからの永続メッセージ)
        client.on('Room.timeline', (event, mxRoom) => {
          if (!mxRoom || mxRoom.roomId !== mxRoomId) return;
          if (event.getType() !== 'io.omnip2p.msg') return;
          if (event.getSender() === config.userId) return;
          const content = event.getContent();
          try { room.emit('message', JSON.parse(content.body), 'matrix:' + event.getSender(), { via: 'matrix' }); } catch (_) { }
        });

        // 送信: OmniP2P → Matrix (永続ミラー)
        const origSend = room.send.bind(room);
        room.send = async function (data, opts) {
          const res = await origSend(data, opts);
          try { await client.sendEvent(mxRoomId, 'io.omnip2p.msg', { body: JSON.stringify(data) }); } catch (e) { room.log.d('[matrix] send err', e.message); }
          return res;
        };

        // 過去ログ API
        room.matrix = {
          roomId: mxRoomId,
          async history(limit = 50) {
            const mxRoom = client.getRoom(mxRoomId); if (!mxRoom) return [];
            try { await client.scrollback(mxRoom, limit); } catch (_) { }
            return mxRoom.getLiveTimeline().getEvents()
              .filter(e => e.getType() === 'io.omnip2p.msg')
              .map(e => ({ from: e.getSender(), ts: e.getTs(), data: safeParse(e.getContent().body) }));
          }
        };
        room.log.i('[matrix] mirroring + E2EE persistence to', mxRoomId);
      }
    };
  };

  function hostOf(url) { try { return new URL(url || 'https://matrix.org').host; } catch (_) { return 'matrix.org'; } }
  function safeParse(s) { try { return JSON.parse(s); } catch (_) { return s; } }

  OmniP2P.registerAdapter('matrix', factory);
  console.log('[Matrix.js] registered as OmniP2P adapter "matrix"');
})();
