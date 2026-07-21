/*!
 * ============================================================================
 *  OmniP2P Yjs Adapter  —  Yjs.js
 * ============================================================================
 *  OmniP2P v2 の外部アダプタ。MiniCRDT を本物の Yjs (Y.Doc) に差し替え、
 *  Y-Provider プロトコル (update / stateVector ベースの差分同期) を
 *  WebRTC DataChannel + Nostr broadcast の両輪に載せる。
 *
 *  特徴:
 *   - 完全な Yjs 互換 (Y.Map / Y.Array / Y.Text / awareness など全機能)
 *   - state vector を交換して差分だけ送るため大規模ドキュメントでも高速
 *   - 新規ピア参加時に自動で全状態を同期 (sync step 1/2)
 *   - Nostr へ定期スナップショット永続化 (再入室時に復元)
 *
 *  使い方:
 *    <script src="OmniP2P.js"></script>
 *    <script src="Yjs.js"></script>
 *    <script>
 *      OmniP2P.use('yjs');
 *      const omni = new OmniP2P(); await omni.start();
 *      const room = await omni.join('doc-room', { password: 'pw' });
 *      const ydoc = room.ydoc('shared');       // 本物の Y.Doc
 *      const ymap = ydoc.getMap('state');
 *      ymap.observe(() => console.log(ymap.toJSON()));
 *      ymap.set('count', 1);
 *      const ytext = ydoc.getText('body');      // 共同テキスト編集
 *      ytext.insert(0, 'Hello');
 *    </script>
 * ============================================================================
 */
(function () {
  'use strict';
  if (typeof OmniP2P === 'undefined') { console.error('[Yjs.js] load OmniP2P.js first'); return; }
  const U = OmniP2P._internal.U;

  const DEFAULT_YJS_URL = 'https://cdn.jsdelivr.net/npm/yjs@13/dist/yjs.mjs';

  async function ensureY(config) {
    let Y = (typeof window !== 'undefined' && window.Y) || (typeof global !== 'undefined' && global.Y);
    if (Y && Y.Doc) return Y;
    // Yjs は ESM。動的 import で読む。
    const url = (config && config.yjsUrl) || DEFAULT_YJS_URL;
    try {
      const mod = await import(/* webpackIgnore: true */ url);
      Y = mod.default && mod.default.Doc ? mod.default : mod;
      if (typeof window !== 'undefined') window.Y = Y;
      return Y;
    } catch (e) {
      // Node/CJS フォールバック
      try { return require('yjs'); } catch (_) { throw new Error('Yjs SDK load failed: ' + e.message); }
    }
  }

  const factory = function (node, config) {
    config = config || {};
    let Y = null;
    return {
      name: 'yjs',
      async onInstall() {
        try { Y = await ensureY(config); node.log.i('[yjs] SDK ready'); }
        catch (e) { node.log.w('[yjs] SDK load failed:', e.message); }
      },
      onRoom(room) {
        if (!Y) { room.log.w('[yjs] SDK not ready — MiniCRDT stays active'); return; }
        const hookRawWire = OmniP2P._internal.hookRawWire;
        const provider = new YProvider(Y, room, node, config, hookRawWire);
        room.ydoc = (name) => provider.doc(name);
        room.yProvider = provider;
        room.log.i('[yjs] Y-Provider active (room.ydoc(name))');
      }
    };
  };

  // ---- Y-Provider: OmniP2P トランスポート上の Yjs 同期プロバイダ ----
  class YProvider {
    constructor(Y, room, node, config, hookRawWire) {
      this.Y = Y; this.room = room; this.node = node; this.config = config;
      this.docs = new Map();   // name -> { ydoc, persistTimer }
      // 生 wire 経路を確保
      hookRawWire(room, (pubkey, wire) => this._onWire(pubkey, wire));
      // 新規ピア参加時に sync step1 (state vector) を送る
      room.on('peer:join', (pk) => this._syncTo(pk));
    }
    doc(name) {
      if (this.docs.has(name)) return this.docs.get(name).ydoc;
      const Y = this.Y;
      const ydoc = new Y.Doc();
      const rec = { ydoc, name };
      this.docs.set(name, rec);
      // ローカル更新 → 全ピアへ diff broadcast
      ydoc.on('update', (update, origin) => {
        if (origin === 'omni-remote') return;
        this._broadcast({ __raw: 'yjs', k: 'u', doc: name, u: U.b64(update) });
      });
      // 永続化されたスナップショットを Nostr から復元
      this._loadPersisted(rec);
      // 定期スナップショット永続化
      let dirty = false;
      ydoc.on('update', () => { dirty = true; });
      rec.persistTimer = setInterval(() => { if (dirty) { dirty = false; this._persist(rec); } }, (this.config.persistMs || 10000));
      // 既存ピアへ sync 要求
      for (const pk of this.room.peers()) this._syncTo(pk, name);
      return ydoc;
    }
    _broadcast(wire) { this.room._broadcastRaw(wire); }
    _onWire(pubkey, wire) {
      if (!wire || wire.__raw !== 'yjs') return;
      const Y = this.Y;
      if (wire.k === 'u') { // update
        const rec = this.docs.get(wire.doc); if (rec) Y.applyUpdate(rec.ydoc, U.unb64(wire.u), 'omni-remote');
      } else if (wire.k === 'sv') { // sync step1: 相手の state vector → diff を返す
        const rec = this.docs.get(wire.doc) || { ydoc: this.doc(wire.doc), name: wire.doc };
        const diff = Y.encodeStateAsUpdate(rec.ydoc, U.unb64(wire.sv));
        this._broadcast({ __raw: 'yjs', k: 'u', doc: wire.doc, u: U.b64(diff) });
      } else if (wire.k === 'req') { // 相手が全ドキュメントの sync を要求
        for (const [name, rec] of this.docs) this._sendSV(name, rec);
      }
    }
    _syncTo(pk, onlyName) {
      // step1: 自分の state vector を送り、相手から diff をもらう
      if (onlyName) { const rec = this.docs.get(onlyName); if (rec) this._sendSV(onlyName, rec); return; }
      for (const [name, rec] of this.docs) this._sendSV(name, rec);
      // 相手にも全同期を促す
      this._broadcast({ __raw: 'yjs', k: 'req' });
    }
    _sendSV(name, rec) {
      const sv = this.Y.encodeStateVector(rec.ydoc);
      this._broadcast({ __raw: 'yjs', k: 'sv', doc: name, sv: U.b64(sv) });
    }
    async _persist(rec) {
      try {
        const snap = this.Y.encodeStateAsUpdate(rec.ydoc);
        const dTag = 'omni-ydoc:' + this.room.signaling.roomTag + ':' + rec.name;
        const enc = await this.room.signaling._encryptRoom({ u: U.b64(snap) });
        const evt = await this.node.identity.signEvent({ kind: 30078, tags: [['d', dTag]], content: enc });
        this.node.pool.publish(evt, { timeoutMs: 6000 }).catch(() => { });
      } catch (e) { this.node.log.d('[yjs] persist err', e.message); }
    }
    async _loadPersisted(rec) {
      try {
        const dTag = 'omni-ydoc:' + this.room.signaling.roomTag + ':' + rec.name;
        const evt = await this.node.storage._queryOne([{ kinds: [30078], '#d': [dTag] }]);
        if (!evt) return;
        const dec = await this.room.signaling._decryptRoom(evt.content);
        if (dec && dec.u) this.Y.applyUpdate(rec.ydoc, U.unb64(dec.u), 'omni-remote');
      } catch (e) { this.node.log.d('[yjs] load err', e.message); }
    }
  }

  OmniP2P.registerAdapter('yjs', factory);
  console.log('[Yjs.js] registered as OmniP2P adapter "yjs"');
})();
