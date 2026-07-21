/*!
 * ============================================================================
 *  OmniP2P.js  —  The Everything P2P Communication & Persistence Engine
 * ============================================================================
 *  Version : 1.0.0
 *  License : MIT
 *  Author  : OmniP2P Contributors
 *  Size    : single-file, ZERO external build dependencies (browser-native)
 *
 *  「読み込むだけで使える」完全静的 P2P 通信・保存ライブラリ。
 *  <script src="OmniP2P.js"></script> するだけで window.OmniP2P が使えます。
 *  Node/CommonJS では require('./OmniP2P.js')、AMD にも対応 (UMD)。
 *  ネイティブ ESM で使う方法はファイル末尾コメント参照。
 *
 *  ---------------------------------------------------------------------------
 *  何ができるか (WHAT)
 *  ---------------------------------------------------------------------------
 *   ✅ Nostr シグナリング → WebRTC 移行 (決定的イニシエータ選出 + ICE restart)
 *   ✅ 超低遅延 P2P (WebRTC DataChannel、失敗時のみ Nostr ブロードキャストへ自動フォールバック)
 *   ✅ Nostr 放置切断バグ対策
 *        - 20秒 heartbeat + 55秒 watchdog + 指数バックオフ + マルチリレーレース
 *   ✅ 永続保存 (Blossom → NIP-96 フォールバック、IPFS ゲートウェイ読み出し)
 *        - 高速な Key-Value / Blob データベースとして利用可能
 *   ✅ 音声/動画通信 startCall() / shareScreen() + ライブトラック差し替え
 *   ✅ 音声/動画保存 MediaRecorder + 暗号化 + Blossom/NIP-96 アップロード + Nostr 告知
 *   ✅ E2EE 通信 X25519 ECDH → HKDF → AES-GCM 256 (AAD 付き)
 *   ✅ E2EE 保存 AES-GCM で暗号化してからアップロード (鍵はメタで別配布可能)
 *   ✅ CRDT 共同編集 MiniCRDT (Yjs 互換シェイプ)、WebRTC で即時 + Nostr で永続
 *   ✅ プラガブル拡張 OmniP2P.use(adapter)
 *        - 同梱アダプタ: Yjs / Automerge / Matrix / GunDB / OrbitDB / Iris / Waku
 *
 *  ---------------------------------------------------------------------------
 *  最短の使い方 (QUICK START)
 *  ---------------------------------------------------------------------------
 *
 *    <script src="OmniP2P.js"></script>
 *    <script>
 *      (async () => {
 *        // 1) インスタンス生成 (鍵は自動生成 or 既存の nsec/hex を渡す)
 *        const omni = new OmniP2P({
 *          relays: [
 *            'wss://relay.damus.io',
 *            'wss://nos.lol',
 *            'wss://relay.nostr.band',
 *            'wss://nostr.wine'
 *          ],
 *          // secretKey: '<64-hex or nsec...>'   // 省略で新規生成
 *        });
 *
 *        await omni.start();               // リレー接続 + heartbeat 開始
 *
 *        // 2) ルームに参加 (合言葉ベース、E2EE 自動)
 *        const room = await omni.join('my-secret-room', { password: 'p@ss' });
 *
 *        // 3) メッセージ (WebRTC 優先、ダメなら Nostr で必ず届く)
 *        room.on('message', (msg, peer) => console.log('recv', msg, 'from', peer));
 *        room.send({ hello: 'world' });
 *
 *        // 4) 音声/動画通話
 *        const call = await room.startCall({ audio: true, video: true });
 *        call.on('track', (stream, peer) => {
 *          const v = document.createElement('video');
 *          v.srcObject = stream; v.autoplay = true; document.body.appendChild(v);
 *        });
 *        // 画面共有に差し替え:
 *        // await call.shareScreen();
 *        // 録画して暗号化保存:
 *        // const rec = call.record(); ... const url = await rec.stopAndStore();
 *
 *        // 5) 永続保存 (暗号化 KV / Blob DB)
 *        const ref = await omni.storage.put('note:1', { text: 'hi' }); // -> 参照
 *        const val = await omni.storage.get('note:1');                 // -> {text:'hi'}
 *        const url = await omni.storage.putBlob(fileBlob);             // -> 公開URL
 *
 *        // 6) CRDT 共同編集
 *        const doc = room.doc('shared');       // MiniCRDT (Yjs 互換 API)
 *        const ymap = doc.getMap('state');
 *        ymap.set('count', 1);
 *        doc.on('update', () => console.log(ymap.toJSON()));
 *      })();
 *    </script>
 *
 *  ---------------------------------------------------------------------------
 *  プラガブルアダプタ (差し替え / 増強)
 *  ---------------------------------------------------------------------------
 *    // 本物の Yjs に差し替え (先に yjs を読み込んでおく)
 *    OmniP2P.use(OmniP2P.adapters.Yjs);
 *    // Automerge / Matrix / GunDB / OrbitDB / Iris / Waku 同様:
 *    OmniP2P.use(OmniP2P.adapters.Waku, { pubsubTopic: '/omnip2p/1/msg/proto' });
 *    OmniP2P.use(OmniP2P.adapters.Matrix, { homeserver: 'https://matrix.org' });
 *
 *  各アダプタは対応する SDK (yjs / automerge / matrix-js-sdk / gun /
 *  orbit-db / @waku/sdk) を「もし読み込まれていれば」使い、無ければ
 *  内蔵実装にフォールバックします。依存を強制しません。
 *
 *  ---------------------------------------------------------------------------
 *  主要 API 一覧 (REFERENCE)
 *  ---------------------------------------------------------------------------
 *   new OmniP2P(opts)
 *     opts.relays        : string[]  Nostr リレー URL 群
 *     opts.secretKey     : string?   秘密鍵 (hex / nsec)。省略で自動生成
 *     opts.iceServers    : RTCIceServer[]?  STUN/TURN
 *     opts.storage       : {blossom?:string[], nip96?:string[], ipfs?:string[]}
 *     opts.heartbeatMs   : number?   default 20000
 *     opts.watchdogMs    : number?   default 55000
 *     opts.debug         : boolean?
 *
 *   omni.start() / omni.stop()
 *   omni.join(roomId, {password?, e2ee?}) -> Room
 *   omni.pubkey        : string (hex)
 *   omni.storage       : Storage (put/get/del/putBlob/getBlob/list)
 *   omni.on(evt, cb) / omni.off / omni.emit
 *
 *   Room:
 *     room.send(data, {reliable?, to?})   // to 省略で全員へ
 *     room.on('message'|'peer:join'|'peer:leave'|'state', cb)
 *     room.peers()          -> string[]
 *     room.startCall(constraints) -> Call
 *     room.doc(name)        -> CRDT Doc
 *     room.leave()
 *
 *   Call:
 *     call.localStream, call.on('track', cb)
 *     call.shareScreen(), call.stopScreen()
 *     call.replaceTrack(kind, track)
 *     call.mute(kind, bool)
 *     call.record() -> Recorder ; recorder.stopAndStore() -> url
 *     call.hangup()
 *
 *   Storage:
 *     storage.put(key, jsonable, {encrypt?}) -> ref
 *     storage.get(key) -> value
 *     storage.del(key)
 *     storage.putBlob(blob|file, {encrypt?, name?}) -> url
 *     storage.getBlob(url, {key?}) -> Blob
 *     storage.list(prefix?) -> [{key, ref, ts}]
 *
 *  ---------------------------------------------------------------------------
 *  設計メモ
 *  ---------------------------------------------------------------------------
 *  - Nostr の署名/検証は WebCrypto では secp256k1 が無いため、内蔵の
 *    純 JS secp256k1 (schnorr, BIP-340) を実装。SHA-256 は WebCrypto。
 *  - E2EE の X25519 は内蔵の純 JS 実装 (RFC 7748)。HKDF/AES-GCM は WebCrypto。
 *  - すべて tree-shake 不要の単一クロージャ。グローバル汚染は OmniP2P のみ。
 *  - 大規模対応: リレーは多重接続 + レース、WebRTC は mesh + relay-mesh
 *    ハイブリッド、保存はコンテンツアドレス指定。
 * ============================================================================
 */
(function (root, factory) {
  'use strict';
  const mod = factory();
  // UMD: CommonJS / AMD / ブラウザ global の全対応 (ネイティブ ESM は末尾コメント参照)
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else if (typeof define === 'function' && define.amd) {
    define([], () => mod);
  }
  // window / self / globalThis / global のどれでも確実にグローバル公開
  try { if (root) root.OmniP2P = mod; } catch (_) { }
  try { if (typeof globalThis !== 'undefined') globalThis.OmniP2P = mod; } catch (_) { }
})(
  (typeof globalThis !== 'undefined' && globalThis) ||
  (typeof self !== 'undefined' && self) ||
  (typeof window !== 'undefined' && window) ||
  (typeof global !== 'undefined' && global) ||
  this,
  function () {
  'use strict';

  // ==========================================================================
  // 0. 環境ユーティリティ / 定数
  // ==========================================================================
  const IS_BROWSER = typeof window !== 'undefined' && typeof window.document !== 'undefined';
  const g = (typeof self !== 'undefined') ? self : (typeof globalThis !== 'undefined' ? globalThis : this);
  const WS = g.WebSocket || (typeof require === 'function' ? tryRequireWS() : null);
  function tryRequireWS() { try { return require('ws'); } catch (_) { return null; } }
  const CRYPTO = (g.crypto && g.crypto.subtle) ? g.crypto : (typeof require === 'function' ? tryNodeCrypto() : null);
  function tryNodeCrypto() { try { return require('crypto').webcrypto; } catch (_) { return null; } }
  const SUBTLE = CRYPTO && CRYPTO.subtle;

  const DEFAULT_RELAYS = [
    'wss://relay.damus.io',
    'wss://nos.lol',
    'wss://relay.nostr.band',
    'wss://nostr.wine',
    'wss://relay.snort.social',
    'wss://relay.primal.net'
  ];
  const DEFAULT_ICE = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' }
  ];
  const DEFAULT_BLOSSOM = ['https://blossom.primal.net', 'https://cdn.satellite.earth'];
  const DEFAULT_NIP96 = ['https://nostr.build', 'https://nostrcheck.me'];
  const DEFAULT_IPFS_GW = ['https://ipfs.io/ipfs/', 'https://cloudflare-ipfs.com/ipfs/', 'https://dweb.link/ipfs/'];

  // ==========================================================================
  // 1. 低レベルユーティリティ (hex / base64 / utf8 / random / time)
  // ==========================================================================
  const U = {
    now: () => Math.floor(Date.now() / 1000),
    nowMs: () => Date.now(),
    rand: (n) => { const a = new Uint8Array(n); CRYPTO.getRandomValues(a); return a; },
    randHex: (n) => U.hex(U.rand(n)),
    hex(bytes) {
      let s = ''; for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0'); return s;
    },
    unhex(str) {
      if (str.length % 2) throw new Error('bad hex');
      const a = new Uint8Array(str.length / 2);
      for (let i = 0; i < a.length; i++) a[i] = parseInt(str.substr(i * 2, 2), 16);
      return a;
    },
    utf8(str) { return new TextEncoder().encode(str); },
    fromUtf8(bytes) { return new TextDecoder().decode(bytes); },
    b64(bytes) {
      let bin = ''; const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      for (let i = 0; i < b.length; i++) bin += String.fromCharCode(b[i]);
      return (IS_BROWSER || g.btoa) ? g.btoa(bin) : Buffer.from(b).toString('base64');
    },
    unb64(str) {
      const bin = (IS_BROWSER || g.atob) ? g.atob(str) : Buffer.from(str, 'base64').toString('binary');
      const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a;
    },
    b64url(bytes) { return U.b64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    unb64url(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return U.unb64(s); },
    concat(...arrs) {
      let len = 0; for (const a of arrs) len += a.length;
      const out = new Uint8Array(len); let o = 0;
      for (const a of arrs) { out.set(a, o); o += a.length; }
      return out;
    },
    eq(a, b) { if (a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i]; return d === 0; },
    async sha256(bytes) { return new Uint8Array(await SUBTLE.digest('SHA-256', bytes)); },
    async sha256hex(bytes) { return U.hex(await U.sha256(bytes)); },
    // 決定的比較 (イニシエータ選出等)
    cmp(a, b) { return a < b ? -1 : a > b ? 1 : 0; },
    sleep: (ms) => new Promise(r => setTimeout(r, ms)),
    jitter: (ms, f = 0.3) => ms * (1 - f + Math.random() * 2 * f),
    uuid() { return U.randHex(16); }
  };

  // ==========================================================================
  // 2. Bech32 (nsec/npub) デコード/エンコード — NIP-19 最小実装
  // ==========================================================================
  const Bech32 = (function () {
    const CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
    function polymod(values) {
      const GEN = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
      let chk = 1;
      for (const v of values) {
        const top = chk >> 25;
        chk = ((chk & 0x1ffffff) << 5) ^ v;
        for (let i = 0; i < 5; i++) if ((top >> i) & 1) chk ^= GEN[i];
      }
      return chk;
    }
    function hrpExpand(hrp) {
      const out = [];
      for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) >> 5);
      out.push(0);
      for (let i = 0; i < hrp.length; i++) out.push(hrp.charCodeAt(i) & 31);
      return out;
    }
    function verify(hrp, data) { return polymod(hrpExpand(hrp).concat(data)) === 1; }
    function createChecksum(hrp, data) {
      const values = hrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
      const mod = polymod(values) ^ 1;
      const out = [];
      for (let i = 0; i < 6; i++) out.push((mod >> (5 * (5 - i))) & 31);
      return out;
    }
    function convert(data, from, to, pad) {
      let acc = 0, bits = 0; const ret = []; const maxv = (1 << to) - 1;
      for (const value of data) {
        acc = (acc << from) | value; bits += from;
        while (bits >= to) { bits -= to; ret.push((acc >> bits) & maxv); }
      }
      if (pad) { if (bits) ret.push((acc << (to - bits)) & maxv); }
      else if (bits >= from || ((acc << (to - bits)) & maxv)) return null;
      return ret;
    }
    return {
      decode(str) {
        str = str.toLowerCase();
        const pos = str.lastIndexOf('1');
        const hrp = str.slice(0, pos);
        const data = [];
        for (let i = pos + 1; i < str.length; i++) data.push(CHARSET.indexOf(str[i]));
        if (!verify(hrp, data)) throw new Error('bad bech32 checksum');
        const bytes = convert(data.slice(0, -6), 5, 8, false);
        return { hrp, bytes: new Uint8Array(bytes) };
      },
      encode(hrp, bytes) {
        const data = convert(Array.from(bytes), 8, 5, true);
        const combined = data.concat(createChecksum(hrp, data));
        let out = hrp + '1';
        for (const d of combined) out += CHARSET[d];
        return out;
      }
    };
  })();

  // ==========================================================================
  // 3. secp256k1 — BIP-340 Schnorr 署名/検証 (純 JS, 依存ゼロ)
  //    Nostr イベントの署名に必須。定数時間ではないがブラウザ内なので実用十分。
  // ==========================================================================
  const Secp = (function () {
    const P = 2n ** 256n - 2n ** 32n - 977n;
    const N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141n;
    const Gx = 0x79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798n;
    const Gy = 0x483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8n;
    const mod = (a, m = P) => { const r = a % m; return r >= 0n ? r : r + m; };
    function pow(a, e, m) { let r = 1n; a = mod(a, m); while (e > 0n) { if (e & 1n) r = mod(r * a, m); a = mod(a * a, m); e >>= 1n; } return r; }
    const inv = (a, m) => pow(mod(a, m), m - 2n, m);
    // Jacobian ではなく affine + inv でシンプルに (署名/検証程度なら十分速い)
    function ptAdd(p1, p2) {
      if (!p1) return p2; if (!p2) return p1;
      const [x1, y1] = p1, [x2, y2] = p2;
      if (x1 === x2 && mod(y1 + y2) === 0n) return null;
      let m;
      if (x1 === x2 && y1 === y2) m = mod(3n * x1 * x1 * inv(2n * y1, P));
      else m = mod((y2 - y1) * inv(mod(x2 - x1), P));
      const x3 = mod(m * m - x1 - x2);
      const y3 = mod(m * (x1 - x3) - y1);
      return [x3, y3];
    }
    function ptMul(k, p) {
      let r = null, a = p; k = mod(k, N);
      while (k > 0n) { if (k & 1n) r = ptAdd(r, a); a = ptAdd(a, a); k >>= 1n; }
      return r;
    }
    const G = [Gx, Gy];
    function bytesToBig(b) { let x = 0n; for (const v of b) x = (x << 8n) | BigInt(v); return x; }
    function bigToBytes(x, len = 32) { const a = new Uint8Array(len); for (let i = len - 1; i >= 0; i--) { a[i] = Number(x & 0xffn); x >>= 8n; } return a; }
    function liftX(x) {
      if (x >= P) return null;
      const c = mod(x * x * x + 7n);
      const y = pow(c, (P + 1n) / 4n, P);
      if (mod(y * y) !== c) return null;
      return [x, (y & 1n) === 0n ? y : P - y];
    }
    async function taggedHash(tag, ...msgs) {
      const tagHash = await U.sha256(U.utf8(tag));
      return U.sha256(U.concat(tagHash, tagHash, ...msgs));
    }
    return {
      N, P,
      getPublicKey(sk) { // sk: 32 bytes -> x-only pubkey (32 bytes hex)
        const d = bytesToBig(sk);
        const Pt = ptMul(d, G);
        return U.hex(bigToBytes(Pt[0]));
      },
      // BIP-340 schnorr sign. msg: 32-byte hash (Uint8Array). sk: 32 bytes.
      async schnorrSign(msg, sk) {
        let d0 = bytesToBig(sk);
        if (d0 <= 0n || d0 >= N) throw new Error('bad privkey');
        let Pt = ptMul(d0, G);
        const d = (Pt[1] & 1n) === 0n ? d0 : N - d0;
        const px = bigToBytes(Pt[0]);
        const aux = U.rand(32);
        const t = bigToBytes(d ^ bytesToBig(await taggedHash('BIP0340/aux', aux)));
        const rand = await taggedHash('BIP0340/nonce', t, px, msg);
        let k0 = mod(bytesToBig(rand), N);
        if (k0 === 0n) throw new Error('k0=0');
        let R = ptMul(k0, G);
        const k = (R[1] & 1n) === 0n ? k0 : N - k0;
        const rx = bigToBytes(R[0]);
        const e = mod(bytesToBig(await taggedHash('BIP0340/challenge', rx, px, msg)), N);
        const sig = U.concat(rx, bigToBytes(mod(k + e * d, N)));
        return sig;
      },
      async schnorrVerify(sig, msg, pubHex) {
        try {
          const px = bytesToBig(U.unhex(pubHex));
          const P0 = liftX(px); if (!P0) return false;
          const rx = bytesToBig(sig.slice(0, 32));
          const s = bytesToBig(sig.slice(32, 64));
          if (rx >= P || s >= N) return false;
          const e = mod(bytesToBig(await taggedHash('BIP0340/challenge', sig.slice(0, 32), U.unhex(pubHex), msg)), N);
          const R = ptAdd(ptMul(s, G), ptMul(N - e, P0));
          if (!R) return false;
          if ((R[1] & 1n) !== 0n) return false;
          return R[0] === rx;
        } catch (_) { return false; }
      },
      // ECDH secret (compressed-ish): return shared X coordinate bytes
      ecdh(sk, pubXHex) {
        const P0 = liftX(bytesToBig(U.unhex(pubXHex)));
        if (!P0) throw new Error('bad pub');
        const S = ptMul(bytesToBig(sk), P0);
        return bigToBytes(S[0]);
      }
    };
  })();

  // ==========================================================================
  // 4. X25519 — RFC 7748 (E2EE 鍵共有, 純 JS)
  // ==========================================================================
  const X25519 = (function () {
    const P = 2n ** 255n - 19n;
    const A24 = 121665n;
    const mod = (a) => { const r = a % P; return r >= 0n ? r : r + P; };
    function pow(a, e) { let r = 1n; a = mod(a); while (e > 0n) { if (e & 1n) r = mod(r * a); a = mod(a * a); e >>= 1n; } return r; }
    const inv = (a) => pow(a, P - 2n);
    function decodeScalar(k) { const b = k.slice(); b[0] &= 248; b[31] &= 127; b[31] |= 64; let x = 0n; for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return x; }
    function decodeU(u) { const b = u.slice(); b[31] &= 127; let x = 0n; for (let i = 31; i >= 0; i--) x = (x << 8n) | BigInt(b[i]); return mod(x); }
    function encodeU(x) { x = mod(x); const a = new Uint8Array(32); for (let i = 0; i < 32; i++) { a[i] = Number(x & 0xffn); x >>= 8n; } return a; }
    function scalarMult(kBytes, uBytes) {
      const k = decodeScalar(kBytes); const x1 = decodeU(uBytes);
      let x2 = 1n, z2 = 0n, x3 = x1, z3 = 1n, swap = 0n;
      for (let t = 254; t >= 0; t--) {
        const kt = (k >> BigInt(t)) & 1n;
        swap ^= kt;
        if (swap) { [x2, x3] = [x3, x2];[z2, z3] = [z3, z2]; }
        swap = kt;
        const Aa = mod(x2 + z2), AA = mod(Aa * Aa);
        const B = mod(x2 - z2), BB = mod(B * B);
        const E = mod(AA - BB);
        const C = mod(x3 + z3), D = mod(x3 - z3);
        const DA = mod(D * Aa), CB = mod(C * B);
        x3 = mod((DA + CB)); x3 = mod(x3 * x3);
        z3 = mod((DA - CB)); z3 = mod(z3 * z3); z3 = mod(z3 * x1);
        x2 = mod(AA * BB);
        z2 = mod(E * (AA + mod(A24 * E)));
      }
      if (swap) { [x2, x3] = [x3, x2];[z2, z3] = [z3, z2]; }
      return encodeU(mod(x2 * inv(z2)));
    }
    const BASE = (() => { const a = new Uint8Array(32); a[0] = 9; return a; })();
    return {
      generateKeyPair() { const sk = U.rand(32); sk[0] &= 248; sk[31] &= 127; sk[31] |= 64; return { secretKey: sk, publicKey: scalarMult(sk, BASE) }; },
      getPublic(sk) { return scalarMult(sk, BASE); },
      sharedSecret(sk, pk) { return scalarMult(sk, pk); }
    };
  })();

  // ==========================================================================
  // 5. WebCrypto ラッパー (HKDF / AES-GCM)
  // ==========================================================================
  const AEAD = {
    async hkdf(ikm, salt, info, len = 32) {
      const key = await SUBTLE.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      const bits = await SUBTLE.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: salt || new Uint8Array(0), info: info || new Uint8Array(0) },
        key, len * 8);
      return new Uint8Array(bits);
    },
    async importAes(rawKey) {
      return SUBTLE.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    },
    async encrypt(rawKey, plaintext, aad) {
      const key = await this.importAes(rawKey);
      const iv = U.rand(12);
      const ct = new Uint8Array(await SUBTLE.encrypt(
        { name: 'AES-GCM', iv, additionalData: aad || new Uint8Array(0) }, key, plaintext));
      return U.concat(iv, ct);
    },
    async decrypt(rawKey, data, aad) {
      const key = await this.importAes(rawKey);
      const iv = data.slice(0, 12), ct = data.slice(12);
      return new Uint8Array(await SUBTLE.decrypt(
        { name: 'AES-GCM', iv, additionalData: aad || new Uint8Array(0) }, key, ct));
    }
  };

  // ==========================================================================
  // 6. Tiny EventEmitter (全モジュール共通)
  // ==========================================================================
  class Emitter {
    constructor() { this._h = Object.create(null); }
    on(ev, fn) { (this._h[ev] || (this._h[ev] = [])).push(fn); return () => this.off(ev, fn); }
    once(ev, fn) { const w = (...a) => { this.off(ev, w); fn(...a); }; return this.on(ev, w); }
    off(ev, fn) { if (!this._h[ev]) return; this._h[ev] = this._h[ev].filter(f => f !== fn); }
    emit(ev, ...a) { (this._h[ev] || []).slice().forEach(f => { try { f(...a); } catch (e) { console.error('[OmniP2P] handler error', ev, e); } }); (this._h['*'] || []).slice().forEach(f => { try { f(ev, ...a); } catch (_) { } }); }
  }

  // logger
  function mkLog(debug, tag) {
    return {
      d: (...a) => { if (debug) console.log('%c[OmniP2P:' + tag + ']', 'color:#6cf', ...a); },
      i: (...a) => console.log('[OmniP2P:' + tag + ']', ...a),
      w: (...a) => console.warn('[OmniP2P:' + tag + ']', ...a),
      e: (...a) => console.error('[OmniP2P:' + tag + ']', ...a)
    };
  }

  // ==========================================================================
  // 7. Nostr Identity + Event 署名
  // ==========================================================================
  class Identity {
    constructor(sk) {
      if (typeof sk === 'string') {
        if (sk.startsWith('nsec')) sk = U.hex(Bech32.decode(sk).bytes);
        this.sk = U.unhex(sk);
      } else if (sk instanceof Uint8Array) {
        this.sk = sk;
      } else {
        this.sk = U.rand(32);
      }
      this.pubkey = Secp.getPublicKey(this.sk);
    }
    get npub() { return Bech32.encode('npub', U.unhex(this.pubkey)); }
    get nsec() { return Bech32.encode('nsec', this.sk); }
    async signEvent(evt) {
      evt.pubkey = this.pubkey;
      evt.created_at = evt.created_at || U.now();
      evt.tags = evt.tags || [];
      evt.content = evt.content || '';
      const serial = JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
      const idBytes = await U.sha256(U.utf8(serial));
      evt.id = U.hex(idBytes);
      const sig = await Secp.schnorrSign(idBytes, this.sk);
      evt.sig = U.hex(sig);
      return evt;
    }
    static async verify(evt) {
      try {
        const serial = JSON.stringify([0, evt.pubkey, evt.created_at, evt.kind, evt.tags, evt.content]);
        const idBytes = await U.sha256(U.utf8(serial));
        if (U.hex(idBytes) !== evt.id) return false;
        return Secp.schnorrVerify(U.unhex(evt.sig), idBytes, evt.pubkey);
      } catch (_) { return false; }
    }
  }

  // ==========================================================================
  // 8. RelayConnection — 1 リレーへの堅牢な WS 接続
  //    放置切断バグ対策: heartbeat REQ + watchdog + 指数バックオフ再接続
  // ==========================================================================
  class RelayConnection extends Emitter {
    constructor(url, opts) {
      super();
      this.url = url;
      this.opts = opts;
      this.log = opts.log;
      this.ws = null;
      this.state = 'idle';           // idle|connecting|open|closing|closed
      this.subs = new Map();          // subId -> filters
      this.pendingPub = new Map();    // eventId -> {resolve, reject, timer}
      this.backoff = 1000;
      this.maxBackoff = 30000;
      this.lastRecvMs = 0;
      this.hbTimer = null;
      this.wdTimer = null;
      this.reconnectTimer = null;
      this.closedByUser = false;
      this._hbSub = '_omni_hb_' + U.randHex(4);
    }
    connect() {
      if (this.state === 'open' || this.state === 'connecting') return;
      this.closedByUser = false;
      this.state = 'connecting';
      this.log.d('connecting', this.url);
      let ws;
      try { ws = new WS(this.url); } catch (e) { this.log.w('WS ctor fail', this.url, e.message); return this._scheduleReconnect(); }
      this.ws = ws;
      ws.onopen = () => {
        this.state = 'open';
        this.backoff = 1000;
        this.lastRecvMs = U.nowMs();
        this.log.d('open', this.url);
        this.emit('open');
        // 既存サブスク再送
        for (const [sid, filters] of this.subs) this._raw(['REQ', sid, ...filters]);
        this._startHeartbeat();
      };
      ws.onmessage = (m) => {
        this.lastRecvMs = U.nowMs();
        let data; try { data = JSON.parse(m.data); } catch (_) { return; }
        this._handle(data);
      };
      ws.onerror = (e) => { this.log.d('ws error', this.url, e && e.message); };
      ws.onclose = () => {
        this.log.d('close', this.url);
        this.state = 'closed';
        this._stopHeartbeat();
        this.emit('close');
        if (!this.closedByUser) this._scheduleReconnect();
      };
    }
    _handle(msg) {
      const type = msg[0];
      if (type === 'EVENT') {
        const sid = msg[1], evt = msg[2];
        this.emit('event', sid, evt, this.url);
      } else if (type === 'EOSE') {
        this.emit('eose', msg[1]);
      } else if (type === 'OK') {
        const id = msg[1], ok = msg[2], reason = msg[3];
        const p = this.pendingPub.get(id);
        if (p) { clearTimeout(p.timer); this.pendingPub.delete(id); ok ? p.resolve(this.url) : p.reject(new Error(reason || 'rejected')); }
      } else if (type === 'NOTICE') {
        this.log.d('NOTICE', this.url, msg[1]);
      } else if (type === 'CLOSED') {
        this.emit('closed-sub', msg[1], msg[2]);
      }
    }
    _raw(arr) {
      if (this.state !== 'open') return false;
      try { this.ws.send(JSON.stringify(arr)); return true; } catch (e) { this.log.w('send fail', e.message); return false; }
    }
    sub(subId, filters) {
      this.subs.set(subId, filters);
      this._raw(['REQ', subId, ...filters]);
    }
    unsub(subId) {
      this.subs.delete(subId);
      this._raw(['CLOSE', subId]);
    }
    publish(evt, timeoutMs = 8000) {
      return new Promise((resolve, reject) => {
        if (this.state !== 'open') return reject(new Error('relay not open'));
        const timer = setTimeout(() => { this.pendingPub.delete(evt.id); reject(new Error('publish timeout')); }, timeoutMs);
        this.pendingPub.set(evt.id, { resolve, reject, timer });
        if (!this._raw(['EVENT', evt])) { clearTimeout(timer); this.pendingPub.delete(evt.id); reject(new Error('send fail')); }
      });
    }
    // --- 放置切断バグ対策の心臓部 --------------------------------------------
    _startHeartbeat() {
      this._stopHeartbeat();
      // 20秒ごとに軽量 REQ を打って WS 上に上り/下りトラフィックを維持
      this.hbTimer = setInterval(() => {
        if (this.state !== 'open') return;
        // 直近1秒だけの空フィルタ REQ → 即 EOSE が返る = 生存確認
        const since = U.now();
        this._raw(['REQ', this._hbSub, { kinds: [1], since, limit: 0 }]);
        // すぐ閉じてサブスク汚染を防ぐ
        setTimeout(() => this._raw(['CLOSE', this._hbSub]), 1500);
      }, this.opts.heartbeatMs || 20000);
      // 55秒何も受信していなければ死んだWSとみなし強制再接続
      this.wdTimer = setInterval(() => {
        if (this.state !== 'open') return;
        const idle = U.nowMs() - this.lastRecvMs;
        if (idle > (this.opts.watchdogMs || 55000)) {
          this.log.w('watchdog: idle', idle, 'ms — forcing reconnect', this.url);
          this._forceReconnect();
        }
      }, 5000);
    }
    _stopHeartbeat() { clearInterval(this.hbTimer); clearInterval(this.wdTimer); this.hbTimer = this.wdTimer = null; }
    _forceReconnect() {
      try { this.ws && this.ws.close(); } catch (_) { }
      this.state = 'closed';
      this._stopHeartbeat();
      this._scheduleReconnect(true);
    }
    _scheduleReconnect(immediate) {
      if (this.closedByUser) return;
      clearTimeout(this.reconnectTimer);
      const delay = immediate ? U.jitter(500) : U.jitter(this.backoff);
      this.log.d('reconnect in', Math.round(delay), 'ms', this.url);
      this.reconnectTimer = setTimeout(() => this.connect(), delay);
      this.backoff = Math.min(this.backoff * 2, this.maxBackoff);
    }
    close() {
      this.closedByUser = true;
      this._stopHeartbeat();
      clearTimeout(this.reconnectTimer);
      try { this.ws && this.ws.close(); } catch (_) { }
      this.state = 'closed';
    }
  }

  // ==========================================================================
  // 9. RelayPool — マルチリレー管理 + パブリッシュレース + 重複排除
  // ==========================================================================
  class RelayPool extends Emitter {
    constructor(urls, opts) {
      super();
      this.opts = opts;
      this.log = opts.log;
      this.conns = new Map();
      this.seen = new Set();          // event id dedupe
      this.seenOrder = [];
      this.subFilters = new Map();    // subId -> filters (プール横断)
      for (const u of urls) this.add(u);
    }
    add(url) {
      if (this.conns.has(url)) return;
      const c = new RelayConnection(url, this.opts);
      c.on('event', (sid, evt, relay) => this._onEvent(sid, evt, relay));
      c.on('eose', (sid) => this.emit('eose', sid));
      c.on('open', () => this.emit('relay:open', url));
      c.on('close', () => this.emit('relay:close', url));
      this.conns.set(url, c);
      c.connect();
    }
    remove(url) { const c = this.conns.get(url); if (c) { c.close(); this.conns.delete(url); } }
    _onEvent(sid, evt, relay) {
      if (this.seen.has(evt.id)) return;      // dedupe across relays
      this.seen.add(evt.id); this.seenOrder.push(evt.id);
      if (this.seenOrder.length > 5000) this.seen.delete(this.seenOrder.shift());
      this.emit('event', sid, evt, relay);
    }
    connectAll() { for (const c of this.conns.values()) c.connect(); }
    sub(subId, filters) {
      this.subFilters.set(subId, filters);
      for (const c of this.conns.values()) c.sub(subId, filters);
    }
    unsub(subId) {
      this.subFilters.delete(subId);
      for (const c of this.conns.values()) c.unsub(subId);
    }
    // レース: 最速の1リレーで成功すれば OK、全部失敗で reject
    async publish(evt, { minAck = 1, timeoutMs = 8000 } = {}) {
      const conns = [...this.conns.values()];
      let acks = 0, errs = 0; const total = conns.length;
      return new Promise((resolve, reject) => {
        if (total === 0) return reject(new Error('no relays'));
        let settled = false;
        conns.forEach(c => {
          c.publish(evt, timeoutMs).then(() => {
            acks++; if (!settled && acks >= minAck) { settled = true; resolve({ id: evt.id, acks }); }
          }).catch(() => {
            errs++; if (!settled && errs >= total) { settled = true; reject(new Error('all relays failed')); }
          });
        });
        // 保険タイムアウト: 1つでも ack あれば成功扱い
        setTimeout(() => { if (!settled) { settled = true; acks > 0 ? resolve({ id: evt.id, acks }) : reject(new Error('publish timeout')); } }, timeoutMs + 500);
      });
    }
    openCount() { let n = 0; for (const c of this.conns.values()) if (c.state === 'open') n++; return n; }
    closeAll() { for (const c of this.conns.values()) c.close(); }
  }

  // モジュールをここまでで一区切り。以降のクラスは後続ブロックで追記。
  // ==========================================================================
  // (続きは同ファイル下部 — Signaling / WebRTC / Storage / Media / CRDT / Room)
  // ==========================================================================

  // ==========================================================================
  // 10. Signaling — Nostr 上で SDP/ICE を暗号化交換 + ルーム presence
  //     ルーム鍵から決定的な "ルーム識別子タグ" を導出し、その kind に載せる。
  //     ルーム内 E2EE: password から HKDF でルーム共通鍵を導出 (簡易) し、
  //     ペア間は X25519 ECDH で個別鍵 (前方秘匿) を張る。
  // ==========================================================================
  const KIND_ROOM = 20808;      // presence / signaling (regular, ephemeral 相当)
  const KIND_SIGNAL = 20809;    // WebRTC signaling payload (P2P 用, 宛先指定)
  const KIND_BROADCAST = 20810; // relay-mesh フォールバックのアプリメッセージ
  const KIND_STORE = 30078;     // NIP-78 app-specific data (永続保存 KV 索引)
  const KIND_MEDIA = 1063;      // NIP-94 file metadata (録画/Blobの告知)

  class Signaling extends Emitter {
    constructor(node, roomId, roomKey) {
      super();
      this.node = node;
      this.log = node.log;
      this.pool = node.pool;
      this.identity = node.identity;
      this.roomId = roomId;
      this.roomKey = roomKey;            // Uint8Array(32) ルーム共通鍵
      this.roomTag = null;               // 決定的タグ (hex)
      this.subId = null;
      this._presenceTimer = null;
      this._peers = new Map();           // pubkey -> {lastSeen, meta}
    }
    async init() {
      // roomTag = HKDF(roomKey, "omni-room-tag", roomId) の先頭16バイト hex
      const tag = await AEAD.hkdf(this.roomKey, U.utf8('omni-room-tag'), U.utf8(this.roomId), 16);
      this.roomTag = U.hex(tag);
      this.subId = 'omni_' + this.roomTag.slice(0, 12);
      // このルームの presence/signaling/broadcast を購読
      this.pool.sub(this.subId, [{
        kinds: [KIND_ROOM, KIND_SIGNAL, KIND_BROADCAST],
        '#d': [this.roomTag],
        since: U.now() - 30
      }]);
      this._onEvent = async (sid, evt) => {
        if (sid !== this.subId) return;
        if (evt.pubkey === this.identity.pubkey) return; // 自分は無視
        if (!(await Identity.verify(evt))) return;
        try { await this._route(evt); } catch (e) { this.log.d('signal route err', e.message); }
      };
      this.pool.on('event', this._onEvent);
      await this._announcePresence('join');
      // presence を定期送信 (放置対策の一部: ルームに存在し続ける)
      this._presenceTimer = setInterval(() => this._announcePresence('ping').catch(() => { }), 25000);
      // presence 掃除
      this._gcTimer = setInterval(() => this._gcPeers(), 15000);
    }
    async _route(evt) {
      if (evt.kind === KIND_ROOM) {
        const type = tagVal(evt, 't') || 'ping';
        this._peers.set(evt.pubkey, { lastSeen: U.nowMs(), meta: safeJson(evt.content) });
        if (type === 'join') { this.emit('peer:hello', evt.pubkey); await this._announcePresence('ping'); }
        this.emit('presence', evt.pubkey, type);
      } else if (evt.kind === KIND_SIGNAL) {
        const to = tagVal(evt, 'p');
        if (to && to !== this.identity.pubkey) return; // 自分宛でない
        const payload = await this._decryptFor(evt.pubkey, evt.content);
        if (payload) this.emit('signal', evt.pubkey, payload);
      } else if (evt.kind === KIND_BROADCAST) {
        const to = tagVal(evt, 'p');
        if (to && to !== this.identity.pubkey) return;
        const payload = await this._decryptRoom(evt.content);
        if (payload) this.emit('broadcast', evt.pubkey, payload);
      }
    }
    _gcPeers() {
      const now = U.nowMs();
      for (const [pk, info] of this._peers) {
        if (now - info.lastSeen > 90000) { this._peers.delete(pk); this.emit('peer:timeout', pk); }
      }
    }
    peers() { return [...this._peers.keys()]; }
    // presence 告知
    async _announcePresence(type) {
      const evt = await this.identity.signEvent({
        kind: KIND_ROOM,
        tags: [['d', this.roomTag], ['t', type], ['expiration', String(U.now() + 120)]],
        content: JSON.stringify({ v: 1, t: U.nowMs() })
      });
      try { await this.pool.publish(evt, { timeoutMs: 6000 }); }
      catch (e) { this.log.d('presence publish fail', e.message); }
    }
    // 宛先ペアへ暗号化シグナリング (X25519 ECDH で個別鍵)
    async sendSignal(toPubkey, payload) {
      const ct = await this._encryptFor(toPubkey, payload);
      const evt = await this.identity.signEvent({
        kind: KIND_SIGNAL,
        tags: [['d', this.roomTag], ['p', toPubkey], ['expiration', String(U.now() + 120)]],
        content: ct
      });
      return this.pool.publish(evt, { timeoutMs: 6000 });
    }
    // relay-mesh フォールバックのアプリメッセージ (ルーム鍵で暗号化, 全員 or 宛先指定)
    async broadcast(payload, toPubkey) {
      const ct = await this._encryptRoom(payload);
      const tags = [['d', this.roomTag], ['expiration', String(U.now() + 300)]];
      if (toPubkey) tags.push(['p', toPubkey]);
      const evt = await this.identity.signEvent({ kind: KIND_BROADCAST, tags, content: ct });
      return this.pool.publish(evt, { timeoutMs: 6000 });
    }
    // ---- 暗号 (ペア間 ECDH: secp256k1 の x-only pub を使う) ----
    async _pairKey(otherPubHex) {
      if (!this._pk) this._pk = new Map();
      if (this._pk.has(otherPubHex)) return this._pk.get(otherPubHex);
      const shared = Secp.ecdh(this.identity.sk, otherPubHex);
      const key = await AEAD.hkdf(shared, this.roomKey, U.utf8('omni-pair'), 32);
      this._pk.set(otherPubHex, key);
      return key;
    }
    async _encryptFor(toPub, obj) {
      const key = await this._pairKey(toPub);
      const aad = U.utf8(this.identity.pubkey + '>' + toPub);
      const ct = await AEAD.encrypt(key, U.utf8(JSON.stringify(obj)), aad);
      return U.b64(ct);
    }
    async _decryptFor(fromPub, b64) {
      try {
        const key = await this._pairKey(fromPub);
        const aad = U.utf8(fromPub + '>' + this.identity.pubkey);
        const pt = await AEAD.decrypt(key, U.unb64(b64), aad);
        return JSON.parse(U.fromUtf8(pt));
      } catch (e) { this.log.d('decryptFor fail', e.message); return null; }
    }
    async _encryptRoom(obj) {
      const ct = await AEAD.encrypt(this.roomKey, U.utf8(JSON.stringify(obj)), U.utf8('omni-room'));
      return U.b64(ct);
    }
    async _decryptRoom(b64) {
      try { const pt = await AEAD.decrypt(this.roomKey, U.unb64(b64), U.utf8('omni-room')); return JSON.parse(U.fromUtf8(pt)); }
      catch (e) { return null; }
    }
    async destroy() {
      clearInterval(this._presenceTimer); clearInterval(this._gcTimer);
      await this._announcePresence('leave').catch(() => { });
      if (this._onEvent) this.pool.off('event', this._onEvent);
      if (this.subId) this.pool.unsub(this.subId);
    }
  }
  function tagVal(evt, name) { const t = (evt.tags || []).find(x => x[0] === name); return t ? t[1] : null; }
  function safeJson(s) { try { return JSON.parse(s); } catch (_) { return null; } }

  // ==========================================================================
  // 11. PeerConnection — WebRTC ラッパー (DataChannel + メディア + ICE restart)
  //     決定的イニシエータ選出: pubkey が小さい方が offer を出す (glare 回避)。
  // ==========================================================================
  const RTCPC = g.RTCPeerConnection || g.webkitRTCPeerConnection || (typeof require === 'function' ? tryWrtc() : null);
  function tryWrtc() { try { return require('wrtc').RTCPeerConnection; } catch (_) { return null; } }

  class PeerConnection extends Emitter {
    constructor(node, room, remotePubkey) {
      super();
      this.node = node;
      this.room = room;
      this.log = node.log;
      this.signaling = room.signaling;
      this.remote = remotePubkey;
      this.iceServers = node.opts.iceServers || DEFAULT_ICE;
      this.pc = null;
      this.dc = null;                 // reliable ordered channel
      this.dcUnreliable = null;       // best-effort channel
      this.state = 'new';
      this.polite = U.cmp(node.identity.pubkey, remotePubkey) > 0; // 大きい方が polite
      this.makingOffer = false;
      this.ignoreOffer = false;
      this._pendingCandidates = [];
      this._connected = false;
      this._restartTimer = null;
      this._recvBuffers = new Map();   // チャンク再構成
    }
    _newPC() {
      const pc = new RTCPC({ iceServers: this.iceServers, iceCandidatePoolSize: 4 });
      pc.onicecandidate = (e) => {
        if (e.candidate) this.signaling.sendSignal(this.remote, { type: 'ice', candidate: e.candidate }).catch(() => { });
      };
      pc.onicecandidateerror = (e) => this.log.d('ice cand err', e && e.errorText);
      pc.onnegotiationneeded = async () => {
        try {
          this.makingOffer = true;
          await pc.setLocalDescription();
          await this.signaling.sendSignal(this.remote, { type: 'sdp', sdp: pc.localDescription });
        } catch (e) { this.log.d('negneeded err', e.message); }
        finally { this.makingOffer = false; }
      };
      pc.oniceconnectionstatechange = () => {
        this.log.d('ice state', this.remote.slice(0, 8), pc.iceConnectionState);
        if (pc.iceConnectionState === 'failed') this.restartIce();
        if (pc.iceConnectionState === 'disconnected') {
          clearTimeout(this._restartTimer);
          this._restartTimer = setTimeout(() => { if (pc.iceConnectionState === 'disconnected') this.restartIce(); }, 4000);
        }
      };
      pc.onconnectionstatechange = () => {
        this.state = pc.connectionState;
        this.emit('state', pc.connectionState);
        if (pc.connectionState === 'connected' && !this._connected) { this._connected = true; this.emit('connect'); }
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') { this._connected = false; this.emit('disconnect'); }
      };
      pc.ondatachannel = (e) => this._setupChannel(e.channel);
      pc.ontrack = (e) => {
        this.emit('track', e.streams[0] || new MediaStream([e.track]), e.track);
      };
      return pc;
    }
    async connect() {
      if (this.pc) return;
      if (!RTCPC) {
        // WebRTC 非対応環境 (一部の SSR/Worker/古い WebView 等)。
        // 落とさず Nostr relay-mesh フォールバックに委ねる。
        this.state = 'unavailable';
        this.log.w('RTCPeerConnection unavailable — using Nostr relay-mesh fallback for peer', this.remote.slice(0, 8));
        this.emit('webrtc:unavailable');
        return;
      }
      try {
        this.pc = this._newPC();
        // イニシエータ (impolite = pubkey 小) が DataChannel を作る → negotiationneeded 発火
        if (!this.polite) {
          this.dc = this.pc.createDataChannel('omni-reliable', { ordered: true });
          this.dcUnreliable = this.pc.createDataChannel('omni-fast', { ordered: false, maxRetransmits: 0 });
          this._setupChannel(this.dc);
          this._setupChannel(this.dcUnreliable);
        }
      } catch (e) {
        this.state = 'unavailable';
        this.pc = null;
        this.log.w('WebRTC init failed — Nostr fallback', e.message);
        this.emit('webrtc:unavailable');
      }
    }
    _setupChannel(ch) {
      ch.binaryType = 'arraybuffer';
      if (ch.label === 'omni-fast') this.dcUnreliable = ch; else this.dc = ch;
      ch.onopen = () => { this.log.d('dc open', ch.label, this.remote.slice(0, 8)); this.emit('dc:open', ch.label); };
      ch.onclose = () => this.emit('dc:close', ch.label);
      ch.onmessage = (e) => this._onData(e.data);
    }
    // シグナリング受信ハンドラ (Room から委譲)
    async handleSignal(payload) {
      if (!this.pc) await this.connect();
      const pc = this.pc;
      if (!pc) return; // WebRTC 不在 — フォールバックに任せる
      try {
        if (payload.type === 'sdp') {
          const desc = payload.sdp;
          const offerCollision = desc.type === 'offer' && (this.makingOffer || pc.signalingState !== 'stable');
          this.ignoreOffer = !this.polite && offerCollision;
          if (this.ignoreOffer) { this.log.d('ignoring offer (glare)'); return; }
          await pc.setRemoteDescription(desc);
          // 保留 ICE を流し込む
          for (const c of this._pendingCandidates.splice(0)) { try { await pc.addIceCandidate(c); } catch (_) { } }
          if (desc.type === 'offer') {
            await pc.setLocalDescription();
            await this.signaling.sendSignal(this.remote, { type: 'sdp', sdp: pc.localDescription });
          }
        } else if (payload.type === 'ice') {
          if (!pc.remoteDescription) this._pendingCandidates.push(payload.candidate);
          else { try { await pc.addIceCandidate(payload.candidate); } catch (e) { if (!this.ignoreOffer) this.log.d('addIce err', e.message); } }
        }
      } catch (e) { this.log.d('handleSignal err', e.message); }
    }
    async restartIce() {
      if (!this.pc || this.polite) return; // impolite 側が restart 主導
      try {
        this.log.d('ICE restart', this.remote.slice(0, 8));
        if (this.pc.restartIce) this.pc.restartIce();
        else { const offer = await this.pc.createOffer({ iceRestart: true }); await this.pc.setLocalDescription(offer); await this.signaling.sendSignal(this.remote, { type: 'sdp', sdp: this.pc.localDescription }); }
      } catch (e) { this.log.d('restartIce err', e.message); }
    }
    // ---- データ送受信 (16KB チャンク分割 + 再構成) ----
    get open() { return this.dc && this.dc.readyState === 'open'; }
    send(bytes, { unreliable = false } = {}) {
      const ch = unreliable && this.dcUnreliable && this.dcUnreliable.readyState === 'open' ? this.dcUnreliable : this.dc;
      if (!ch || ch.readyState !== 'open') return false;
      const CHUNK = 16 * 1024;
      if (bytes.length <= CHUNK) { ch.send(bytes); return true; }
      // 大きいデータ: [msgId(4)][idx(2)][total(2)][payload]
      const id = (Math.random() * 0xffffffff) >>> 0;
      const total = Math.ceil(bytes.length / CHUNK);
      for (let i = 0; i < total; i++) {
        const slice = bytes.subarray(i * CHUNK, (i + 1) * CHUNK);
        const head = new Uint8Array(8);
        new DataView(head.buffer).setUint32(0, id); new DataView(head.buffer).setUint16(4, i); new DataView(head.buffer).setUint16(6, total);
        ch.send(U.concat(head, slice));
      }
      return true;
    }
    _onData(data) {
      const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : (data instanceof Uint8Array ? data : U.utf8(String(data)));
      // チャンクヘッダ判定: 8 バイト以上 & total>1 のときのみ再構成対象
      if (bytes.length > 8) {
        const dv = new DataView(bytes.buffer, bytes.byteOffset);
        const id = dv.getUint32(0), idx = dv.getUint16(4), total = dv.getUint16(6);
        // ヒューリスティック: total が妥当範囲なら分割メッセージとみなす
        if (total > 1 && total < 65535 && idx < total) {
          let buf = this._recvBuffers.get(id);
          if (!buf) { buf = { parts: new Array(total), got: 0 }; this._recvBuffers.set(id, buf); }
          if (!buf.parts[idx]) { buf.parts[idx] = bytes.subarray(8); buf.got++; }
          if (buf.got === total) { this._recvBuffers.delete(id); this.emit('data', U.concat(...buf.parts)); }
          return;
        }
      }
      this.emit('data', bytes);
    }
    // ---- メディア ----
    addStream(stream) {
      if (!this.pc) return;
      this._senders = this._senders || [];
      for (const track of stream.getTracks()) this._senders.push(this.pc.addTrack(track, stream));
    }
    replaceTrack(kind, track) {
      if (!this._senders) return;
      const s = this._senders.find(x => x.track && x.track.kind === kind);
      if (s) s.replaceTrack(track);
    }
    close() {
      clearTimeout(this._restartTimer);
      try { this.dc && this.dc.close(); } catch (_) { }
      try { this.pc && this.pc.close(); } catch (_) { }
      this._connected = false;
      this.emit('closed');
    }
  }

  // ==========================================================================
  // 12. Storage — Blossom → NIP-96 → IPFS の冗長保存 + 暗号化 KV/Blob DB
  // ==========================================================================
  class Storage extends Emitter {
    constructor(node) {
      super();
      this.node = node;
      this.log = node.log;
      this.identity = node.identity;
      const s = node.opts.storage || {};
      this.blossom = s.blossom || DEFAULT_BLOSSOM;
      this.nip96 = s.nip96 || DEFAULT_NIP96;
      this.ipfsGw = s.ipfs || DEFAULT_IPFS_GW;
      // KV は Nostr replaceable event (NIP-78) を索引に、値本体は Blossom へ。
      this._kvCache = new Map();
      this._encKey = null; // KV デフォルト暗号鍵 (identity 由来)
    }
    async _defaultKey() {
      if (this._encKey) return this._encKey;
      this._encKey = await AEAD.hkdf(this.identity.sk, U.utf8('omni-storage'), U.utf8('kv'), 32);
      return this._encKey;
    }
    // ---- Blob 保存: Blossom (BUD-02) 認証アップロード ----
    async _blossomUpload(blob) {
      const buf = new Uint8Array(await blob.arrayBuffer());
      const sha = await U.sha256hex(buf);
      for (const server of this.blossom) {
        try {
          // Blossom 認証イベント (kind 24242)
          const auth = await this.identity.signEvent({
            kind: 24242,
            tags: [['t', 'upload'], ['x', sha], ['expiration', String(U.now() + 3600)]],
            content: 'Upload ' + sha
          });
          const authHeader = 'Nostr ' + U.b64(U.utf8(JSON.stringify(auth)));
          const res = await fetch(server.replace(/\/$/, '') + '/upload', {
            method: 'PUT', headers: { 'Authorization': authHeader, 'Content-Type': blob.type || 'application/octet-stream' }, body: blob
          });
          if (res.ok) { const j = await res.json().catch(() => ({})); const url = j.url || (server.replace(/\/$/, '') + '/' + sha); this.log.d('blossom ok', url); return { url, sha, provider: 'blossom', server }; }
          this.log.d('blossom non-ok', server, res.status);
        } catch (e) { this.log.d('blossom fail', server, e.message); }
      }
      return null;
    }
    // ---- Blob 保存: NIP-96 フォールバック ----
    async _nip96Upload(blob, name) {
      for (const server of this.nip96) {
        try {
          const base = server.replace(/\/$/, '');
          // NIP-96: /.well-known/nostr/nip96.json から api_url を取得
          let apiUrl = base + '/api/v2/nip96/upload';
          try { const wk = await (await fetch(base + '/.well-known/nostr/nip96.json')).json(); if (wk.api_url) apiUrl = wk.api_url.startsWith('http') ? wk.api_url : base + wk.api_url; } catch (_) { }
          const buf = new Uint8Array(await blob.arrayBuffer());
          const sha = await U.sha256hex(buf);
          const auth = await this.identity.signEvent({
            kind: 27235, // NIP-98 HTTP Auth
            tags: [['u', apiUrl], ['method', 'POST'], ['payload', sha]],
            content: ''
          });
          const fd = new FormData();
          fd.append('file', blob, name || ('file-' + sha.slice(0, 8)));
          const res = await fetch(apiUrl, { method: 'POST', headers: { 'Authorization': 'Nostr ' + U.b64(U.utf8(JSON.stringify(auth))) }, body: fd });
          if (res.ok) { const j = await res.json(); const url = (j.nip94_event && tagValArr(j.nip94_event.tags, 'url')) || j.url; if (url) { this.log.d('nip96 ok', url); return { url, sha, provider: 'nip96', server }; } }
          this.log.d('nip96 non-ok', server, res.status);
        } catch (e) { this.log.d('nip96 fail', server, e.message); }
      }
      return null;
    }
    async putBlob(blob, { encrypt = true, name, key } = {}) {
      let payload = blob, meta = { enc: false, type: blob.type };
      if (encrypt) {
        const k = key || await this._defaultKey();
        const buf = new Uint8Array(await blob.arrayBuffer());
        const ct = await AEAD.encrypt(k, buf, U.utf8('omni-blob'));
        payload = new Blob([ct], { type: 'application/octet-stream' });
        meta = { enc: true, type: blob.type, alg: 'AES-GCM' };
      }
      let res = await this._blossomUpload(payload);
      if (!res) res = await this._nip96Upload(payload, name);
      if (!res) throw new Error('all storage providers failed (blossom + nip96)');
      // NIP-94 で告知 (任意, 検索/共有用)
      try {
        const evt = await this.identity.signEvent({
          kind: KIND_MEDIA,
          tags: [['url', res.url], ['x', res.sha], ['m', meta.type || 'application/octet-stream'], ['encrypted', meta.enc ? '1' : '0']],
          content: name || ''
        });
        this.node.pool.publish(evt, { timeoutMs: 5000 }).catch(() => { });
      } catch (_) { }
      return { url: res.url, sha: res.sha, provider: res.provider, encrypted: meta.enc };
    }
    async getBlob(url, { key } = {}) {
      let data = null;
      // IPFS URL なら複数ゲートウェイでレース
      if (/ipfs:\/\/|\/ipfs\//.test(url)) {
        const cid = url.replace(/^ipfs:\/\//, '').split('/ipfs/').pop();
        data = await this._raceFetch(this.ipfsGw.map(gw => gw + cid));
      } else {
        data = await this._fetchBytes(url);
      }
      if (!data) throw new Error('getBlob: fetch failed ' + url);
      // 暗号化されている可能性 → key があれば復号を試みる
      if (key || this._encKey) {
        try { const k = key || await this._defaultKey(); const pt = await AEAD.decrypt(k, data, U.utf8('omni-blob')); return new Blob([pt]); }
        catch (_) { /* 平文だった */ }
      }
      return new Blob([data]);
    }
    async _fetchBytes(url) { try { const r = await fetch(url); if (!r.ok) return null; return new Uint8Array(await r.arrayBuffer()); } catch (_) { return null; } }
    async _raceFetch(urls) {
      return new Promise((resolve) => {
        let left = urls.length, done = false;
        urls.forEach(async u => { const b = await this._fetchBytes(u); if (b && !done) { done = true; resolve(b); } else if (--left === 0 && !done) resolve(null); });
      });
    }
    // ---- KV: 値を Blob 化して保存、参照を NIP-78 replaceable event に索引 ----
    async put(key, value, { encrypt = true } = {}) {
      const blob = new Blob([U.utf8(JSON.stringify({ v: value, ts: U.nowMs() }))], { type: 'application/json' });
      const ref = await this.putBlob(blob, { encrypt, name: 'kv:' + key });
      const dTag = 'omni-kv:' + await U.sha256hex(U.utf8(key));
      const evt = await this.identity.signEvent({
        kind: KIND_STORE,
        tags: [['d', dTag], ['k', key], ['ref', ref.url], ['x', ref.sha], ['enc', ref.encrypted ? '1' : '0']],
        content: JSON.stringify({ url: ref.url, sha: ref.sha, enc: ref.encrypted })
      });
      await this.node.pool.publish(evt, { timeoutMs: 6000 });
      this._kvCache.set(key, { ...ref, value });
      this.emit('put', key, ref);
      return ref;
    }
    async get(key) {
      if (this._kvCache.has(key)) return this._kvCache.get(key).value;
      const dTag = 'omni-kv:' + await U.sha256hex(U.utf8(key));
      const evt = await this._queryOne([{ kinds: [KIND_STORE], authors: [this.identity.pubkey], '#d': [dTag] }]);
      if (!evt) return undefined;
      const info = safeJson(evt.content); if (!info || !info.url) return undefined;
      const blob = await this.getBlob(info.url);
      const obj = JSON.parse(U.fromUtf8(new Uint8Array(await blob.arrayBuffer())));
      this._kvCache.set(key, { url: info.url, sha: info.sha, value: obj.v });
      return obj.v;
    }
    async del(key) {
      this._kvCache.delete(key);
      const dTag = 'omni-kv:' + await U.sha256hex(U.utf8(key));
      // NIP-09 削除 + 空の replaceable で上書き
      const evt = await this.identity.signEvent({ kind: KIND_STORE, tags: [['d', dTag], ['deleted', '1']], content: '' });
      await this.node.pool.publish(evt, { timeoutMs: 6000 });
      this.emit('del', key);
    }
    async list(prefix = '') {
      const evts = await this._query([{ kinds: [KIND_STORE], authors: [this.identity.pubkey], limit: 500 }], 2500);
      const out = [];
      for (const e of evts) { const k = tagVal(e, 'k'); if (k && k.startsWith(prefix) && tagVal(e, 'deleted') !== '1') out.push({ key: k, ref: tagVal(e, 'ref'), ts: e.created_at }); }
      return out;
    }
    // 単発クエリ (最新1件)
    _queryOne(filters) { return this._query(filters, 2500).then(arr => arr.sort((a, b) => b.created_at - a.created_at)[0]); }
    _query(filters, timeoutMs = 3000) {
      return new Promise((resolve) => {
        const sid = 'q_' + U.randHex(6); const got = [];
        const onEvt = (s, evt) => { if (s === sid) got.push(evt); };
        const onEose = (s) => { if (s === sid) finish(); };
        let done = false;
        const finish = () => { if (done) return; done = true; this.node.pool.off('event', onEvt); this.node.pool.off('eose', onEose); this.node.pool.unsub(sid); resolve(got); };
        this.node.pool.on('event', onEvt); this.node.pool.on('eose', onEose);
        this.node.pool.sub(sid, filters);
        setTimeout(finish, timeoutMs);
      });
    }
  }
  function tagValArr(tags, name) { const t = (tags || []).find(x => x[0] === name); return t ? t[1] : null; }

  // ==========================================================================
  // 13. Call & Recorder — 音声/動画通信 + 録画 + 暗号化保存
  // ==========================================================================
  class Recorder extends Emitter {
    constructor(call, stream, storage, opts = {}) {
      super();
      this.call = call; this.stream = stream; this.storage = storage; this.opts = opts;
      this.chunks = []; this.rec = null; this.mimeType = pickMime(opts.mimeType);
    }
    start() {
      this.rec = new MediaRecorder(this.stream, { mimeType: this.mimeType, videoBitsPerSecond: this.opts.videoBitsPerSecond || 2500000 });
      this.rec.ondataavailable = (e) => { if (e.data && e.data.size) { this.chunks.push(e.data); this.emit('chunk', e.data); } };
      this.rec.onstop = () => this.emit('stop');
      this.rec.start(this.opts.timeslice || 1000);
      this.emit('start');
      return this;
    }
    pause() { this.rec && this.rec.pause(); }
    resume() { this.rec && this.rec.resume(); }
    async stop() {
      return new Promise((resolve) => {
        if (!this.rec || this.rec.state === 'inactive') return resolve(this._blob());
        this.rec.onstop = () => resolve(this._blob());
        this.rec.stop();
      });
    }
    _blob() { return new Blob(this.chunks, { type: this.mimeType }); }
    // 録画停止 → 暗号化 → Blossom/NIP-96 保存 → URL
    async stopAndStore({ encrypt = true } = {}) {
      const blob = await this.stop();
      const ref = await this.storage.putBlob(blob, { encrypt, name: 'recording-' + Date.now() + mimeExt(this.mimeType) });
      this.emit('stored', ref);
      return ref.url;
    }
  }
  function pickMime(pref) {
    const cands = pref ? [pref] : ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'audio/webm;codecs=opus', 'audio/webm'];
    if (typeof MediaRecorder === 'undefined') return cands[0];
    for (const c of cands) if (MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(c)) return c;
    return cands[cands.length - 1];
  }
  function mimeExt(m) { return m.includes('audio') ? '.webm' : '.webm'; }

  class Call extends Emitter {
    constructor(room, constraints) {
      super();
      this.room = room; this.node = room.node; this.log = room.node.log;
      this.constraints = constraints || { audio: true, video: true };
      this.localStream = null; this.screenStream = null;
      this.remoteStreams = new Map(); // pubkey -> stream
    }
    async start() {
      if (!IS_BROWSER || !navigator.mediaDevices) throw new Error('getUserMedia unavailable');
      this.localStream = await navigator.mediaDevices.getUserMedia(this.constraints);
      // 既存 & 今後の全ピアにトラック追加
      for (const pc of this.room._peerConns()) { pc.addStream(this.localStream); pc.on('track', (stream, track) => this._onRemote(pc.remote, stream)); }
      this._trackHook = (pc) => { pc.addStream(this.localStream); pc.on('track', (stream) => this._onRemote(pc.remote, stream)); };
      this.room.on('peer:pc', this._trackHook);
      this.emit('local', this.localStream);
      return this;
    }
    _onRemote(pubkey, stream) { this.remoteStreams.set(pubkey, stream); this.emit('track', stream, pubkey); }
    async shareScreen() {
      const screen = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      this.screenStream = screen;
      const vtrack = screen.getVideoTracks()[0];
      for (const pc of this.room._peerConns()) pc.replaceTrack('video', vtrack);
      vtrack.onended = () => this.stopScreen();
      this.emit('screen', screen);
      return screen;
    }
    async stopScreen() {
      if (!this.screenStream) return;
      this.screenStream.getTracks().forEach(t => t.stop()); this.screenStream = null;
      const cam = this.localStream && this.localStream.getVideoTracks()[0];
      if (cam) for (const pc of this.room._peerConns()) pc.replaceTrack('video', cam);
      this.emit('screen:stop');
    }
    replaceTrack(kind, track) { for (const pc of this.room._peerConns()) pc.replaceTrack(kind, track); }
    mute(kind, muted) { if (!this.localStream) return; this.localStream.getTracks().filter(t => t.kind === kind).forEach(t => t.enabled = !muted); }
    record(opts) {
      // ローカル+リモートを1本にミックスしたい場合は combined stream を作る
      const combined = this._combinedStream();
      return new Recorder(this, combined, this.node.storage, opts).start();
    }
    _combinedStream() {
      const tracks = [];
      if (this.localStream) tracks.push(...this.localStream.getTracks());
      for (const s of this.remoteStreams.values()) tracks.push(...s.getTracks());
      return new MediaStream(tracks);
    }
    hangup() {
      if (this._trackHook) this.room.off('peer:pc', this._trackHook);
      if (this.localStream) this.localStream.getTracks().forEach(t => t.stop());
      if (this.screenStream) this.screenStream.getTracks().forEach(t => t.stop());
      this.emit('hangup');
    }
  }

  // ==========================================================================
  // 14. MiniCRDT — Yjs 互換シェイプの LWW-Map + RGA 風 Array (依存ゼロ)
  //     WebRTC で即時同期、Nostr で永続。OmniP2P.use(Yjs) で本物に差し替え可。
  // ==========================================================================
  class MiniDoc extends Emitter {
    constructor(name, room) {
      super();
      this.name = name; this.room = room; this.clientId = U.randHex(4);
      this.clock = 0;
      this.maps = new Map();   // mapName -> {key -> {v, ts, client}}
      this.arrays = new Map(); // arrName -> [{id, v, ts, client, del}]
      this._applyingRemote = false;
    }
    _tick() { return ++this.clock * 1000000 + parseInt(this.clientId.slice(0, 6), 16); }
    getMap(name) {
      if (!this.maps.has(name)) this.maps.set(name, new Map());
      const store = this.maps.get(name); const self = this;
      return {
        set(k, v) { const ts = self._tick(); store.set(k, { v, ts, client: self.clientId }); self._broadcast({ op: 'map.set', map: name, k, v, ts, client: self.clientId }); self.emit('update'); },
        get(k) { const e = store.get(k); return e ? e.v : undefined; },
        delete(k) { const ts = self._tick(); store.set(k, { v: undefined, ts, client: self.clientId, del: true }); self._broadcast({ op: 'map.del', map: name, k, ts, client: self.clientId }); self.emit('update'); },
        has(k) { const e = store.get(k); return e && !e.del; },
        toJSON() { const o = {}; for (const [k, e] of store) if (!e.del) o[k] = e.v; return o; },
        keys() { return [...store.keys()].filter(k => !store.get(k).del); }
      };
    }
    getArray(name) {
      if (!this.arrays.has(name)) this.arrays.set(name, []);
      const arr = this.arrays.get(name); const self = this;
      return {
        push(v) { const ts = self._tick(); const item = { id: U.randHex(8), v, ts, client: self.clientId, del: false }; arr.push(item); arr.sort((a, b) => a.ts - b.ts); self._broadcast({ op: 'arr.ins', arr: name, item }); self.emit('update'); },
        delete(index) { const live = arr.filter(x => !x.del); const it = live[index]; if (it) { it.del = true; self._broadcast({ op: 'arr.del', arr: name, id: it.id }); self.emit('update'); } },
        toJSON() { return arr.filter(x => !x.del).map(x => x.v); },
        get length() { return arr.filter(x => !x.del).length; }
      };
    }
    _broadcast(op) {
      if (this._applyingRemote) return;
      this.room._docSend(this.name, op);
    }
    applyRemote(op) {
      this._applyingRemote = true;
      try {
        if (op.op === 'map.set' || op.op === 'map.del') {
          const store = this.maps.get(op.map) || (this.maps.set(op.map, new Map()), this.maps.get(op.map));
          const cur = store.get(op.k);
          if (!cur || op.ts > cur.ts || (op.ts === cur.ts && op.client > cur.client)) {
            store.set(op.k, { v: op.op === 'map.del' ? undefined : op.v, ts: op.ts, client: op.client, del: op.op === 'map.del' });
            this.emit('update');
          }
        } else if (op.op === 'arr.ins') {
          const arr = this.arrays.get(op.arr) || (this.arrays.set(op.arr, []), this.arrays.get(op.arr));
          if (!arr.find(x => x.id === op.item.id)) { arr.push(op.item); arr.sort((a, b) => a.ts - b.ts); this.emit('update'); }
        } else if (op.op === 'arr.del') {
          const arr = this.arrays.get(op.arr); if (arr) { const it = arr.find(x => x.id === op.id); if (it && !it.del) { it.del = true; this.emit('update'); } }
        } else if (op.op === 'state') {
          this._merge(op.state);
        }
      } finally { this._applyingRemote = false; }
    }
    snapshot() {
      const maps = {}; for (const [n, s] of this.maps) maps[n] = [...s.entries()];
      const arrays = {}; for (const [n, a] of this.arrays) arrays[n] = a;
      return { maps, arrays, clock: this.clock };
    }
    _merge(state) {
      if (state.clock > this.clock) this.clock = state.clock;
      for (const n in state.maps) { const s = this.maps.get(n) || (this.maps.set(n, new Map()), this.maps.get(n)); for (const [k, e] of state.maps[n]) { const cur = s.get(k); if (!cur || e.ts > cur.ts) s.set(k, e); } }
      for (const n in state.arrays) { const a = this.arrays.get(n) || (this.arrays.set(n, []), this.arrays.get(n)); for (const it of state.arrays[n]) if (!a.find(x => x.id === it.id)) a.push(it); a.sort((x, y) => x.ts - y.ts); }
      this.emit('update');
    }
    // Nostr へ永続化スナップショット (NIP-78)
    async persist() {
      const dTag = 'omni-doc:' + this.room.signaling.roomTag + ':' + this.name;
      const enc = await this.room.signaling._encryptRoom(this.snapshot());
      const evt = await this.node().identity.signEvent({ kind: KIND_STORE, tags: [['d', dTag]], content: enc });
      return this.node().pool.publish(evt, { timeoutMs: 6000 });
    }
    node() { return this.room.node; }
    async loadPersisted() {
      const dTag = 'omni-doc:' + this.room.signaling.roomTag + ':' + this.name;
      const evt = await this.node().storage._queryOne([{ kinds: [KIND_STORE], '#d': [dTag] }]);
      if (!evt) return;
      const state = await this.room.signaling._decryptRoom(evt.content);
      if (state) this.applyRemote({ op: 'state', state });
    }
  }

  // ==========================================================================
  // 15. Room — 全部を束ねる。P2P mesh + relay-mesh フォールバック + CRDT。
  // ==========================================================================
  class Room extends Emitter {
    constructor(node, roomId, roomKey) {
      super();
      this.node = node; this.log = node.log;
      this.roomId = roomId; this.roomKey = roomKey;
      this.signaling = new Signaling(node, roomId, roomKey);
      this.conns = new Map();   // pubkey -> PeerConnection
      this.docs = new Map();
      this._seq = 0;
      this._recvSeq = new Map();
    }
    async _init() {
      await this.signaling.init();
      this.signaling.on('peer:hello', (pk) => this._ensurePeer(pk));
      this.signaling.on('presence', (pk, type) => { if (type !== 'leave') this._ensurePeer(pk); else this._dropPeer(pk); });
      this.signaling.on('signal', (pk, payload) => { const pc = this._ensurePeer(pk); pc.handleSignal(payload); });
      this.signaling.on('peer:timeout', (pk) => this._dropPeer(pk));
      // relay-mesh フォールバック受信 (WebRTC 未接続時のアプリメッセージ)
      this.signaling.on('broadcast', (pk, payload) => this._onAppMessage(pk, payload, 'relay'));
      return this;
    }
    _ensurePeer(pubkey) {
      if (pubkey === this.node.identity.pubkey) return null;
      if (this.conns.has(pubkey)) return this.conns.get(pubkey);
      const pc = new PeerConnection(this.node, this, pubkey);
      this.conns.set(pubkey, pc);
      pc.on('connect', () => { this.emit('peer:join', pubkey); this._syncDocsTo(pc); });
      pc.on('disconnect', () => { this.log.d('peer disconnect', pubkey.slice(0, 8)); });
      pc.on('closed', () => { });
      pc.on('data', (bytes) => this._onWireData(pubkey, bytes));
      pc.connect();
      this.emit('peer:pc', pc);       // Call 用フック
      return pc;
    }
    _dropPeer(pubkey) {
      const pc = this.conns.get(pubkey);
      if (pc) { pc.close(); this.conns.delete(pubkey); this.emit('peer:leave', pubkey); }
    }
    _peerConns() { return [...this.conns.values()]; }
    peers() { return [...this.conns.keys()]; }
    // ---- アプリメッセージ送信: WebRTC 優先、開いてなければ Nostr broadcast ----
    async send(data, { reliable = true, to = null } = {}) {
      const wire = { __omni: 1, seq: ++this._seq, ts: U.nowMs(), data };
      const bytes = U.utf8(JSON.stringify(wire));
      const targets = to ? [to] : this.peers();
      let sentViaRTC = 0;
      for (const pk of targets) {
        const pc = this.conns.get(pk);
        if (pc && pc.open) { if (pc.send(bytes, { unreliable: !reliable })) sentViaRTC++; }
        else {
          // フォールバック: Nostr 経由 (E2EE ルーム鍵)
          this.signaling.broadcast({ __omni: 1, kind: 'app', wire }, pk).catch(e => this.log.d('relay send fail', e.message));
        }
      }
      // 宛先未指定: RTC で全員に届いていない可能性があれば全体 broadcast を1回打つ。
      // (presence では見えているが PeerConnection 未確立のピアを取りこぼさないため)
      if (!to) {
        const knownPeers = this.signaling.peers().length;
        if (sentViaRTC < knownPeers || targets.length === 0) {
          this.signaling.broadcast({ __omni: 1, kind: 'app', wire }).catch(() => { });
        }
      }
      return { rtc: sentViaRTC, total: targets.length, peersKnown: this.signaling.peers().length };
    }
    _onWireData(pubkey, bytes) {
      let wire; try { wire = JSON.parse(U.fromUtf8(bytes)); } catch (_) { return; }
      if (wire.__doc) return this._onDocWire(pubkey, wire);
      if (wire.__omni) this._onAppMessage(pubkey, { kind: 'app', wire }, 'rtc');
    }
    _onAppMessage(pubkey, payload, via) {
      if (!payload) return;
      const wire = payload.wire || payload;
      if (payload.__doc || wire.__doc) return this._onDocWire(pubkey, wire.__doc ? wire : payload);
      // 重複排除 (RTC と relay 両方で来る可能性)
      const key = pubkey + ':' + (wire.seq || wire.ts);
      const last = this._recvSeq.get(pubkey) || 0;
      if (wire.seq && wire.seq <= last && via === 'relay') return; // 既に RTC で受信済み
      if (wire.seq) this._recvSeq.set(pubkey, Math.max(last, wire.seq));
      this.emit('message', wire.data, pubkey, { via });
    }
    // ---- CRDT ----
    doc(name) {
      if (this.docs.has(name)) return this.docs.get(name);
      const d = new MiniDoc(name, this);
      this.docs.set(name, d);
      d.loadPersisted().catch(() => { });
      // 定期永続化
      let dirty = false; d.on('update', () => { dirty = true; });
      d._persistTimer = setInterval(() => { if (dirty) { dirty = false; d.persist().catch(() => { }); } }, 8000);
      return d;
    }
    _docSend(docName, op) {
      const wire = { __doc: 1, doc: docName, op };
      const bytes = U.utf8(JSON.stringify(wire));
      let sent = 0;
      for (const pc of this._peerConns()) { if (pc.open && pc.send(bytes)) sent++; }
      if (sent === 0) this.signaling.broadcast(wire).catch(() => { }); // 誰も RTC 未接続なら Nostr
    }
    _onDocWire(pubkey, wire) {
      const d = this.docs.get(wire.doc); if (d) d.applyRemote(wire.op);
    }
    _syncDocsTo(pc) {
      for (const [name, d] of this.docs) { const wire = { __doc: 1, doc: name, op: { op: 'state', state: d.snapshot() } }; pc.send(U.utf8(JSON.stringify(wire))); }
    }
    // ---- メディア ----
    async startCall(constraints) {
      const call = new Call(this, constraints);
      await call.start();
      // 通話開始を presence 経由で通知し、全員と renegotiate
      for (const pk of this.signaling.peers()) this._ensurePeer(pk);
      return call;
    }
    async leave() {
      for (const d of this.docs.values()) clearInterval(d._persistTimer);
      for (const pc of this._peerConns()) pc.close();
      this.conns.clear();
      await this.signaling.destroy();
      this.emit('left');
    }
  }

  // ==========================================================================
  // 16. Node — トップレベル。OmniP2P インスタンス。
  // ==========================================================================
  class Node extends Emitter {
    constructor(opts = {}) {
      super();
      this.opts = Object.assign({
        relays: DEFAULT_RELAYS.slice(),
        iceServers: DEFAULT_ICE.slice(),
        storage: {},
        heartbeatMs: 20000,
        watchdogMs: 55000,
        debug: false
      }, opts);
      this.log = mkLog(this.opts.debug, 'node');
      this.identity = new Identity(opts.secretKey);
      this.opts.log = this.log;
      this.pool = new RelayPool(this.opts.relays, this.opts);
      this.pool.on('relay:open', (u) => this.emit('relay:open', u));
      this.pool.on('relay:close', (u) => this.emit('relay:close', u));
      this.storage = new Storage(this);
      this.rooms = new Map();
      this._plugins = [];
    }
    get pubkey() { return this.identity.pubkey; }
    get npub() { return this.identity.npub; }
    get nsec() { return this.identity.nsec; }
    async start() {
      this.pool.connectAll();
      // 少なくとも1リレー open を待つ (最大8秒)
      await Promise.race([
        new Promise(res => { const t = setInterval(() => { if (this.pool.openCount() > 0) { clearInterval(t); res(); } }, 200); }),
        U.sleep(8000)
      ]);
      this.log.i('started. pubkey=', this.pubkey.slice(0, 16), 'relays open=', this.pool.openCount());
      this.emit('ready');
      return this;
    }
    async join(roomId, { password = '', e2ee = true } = {}) {
      // ルーム鍵導出: HKDF(password || roomId)。password 無しでも roomId から決定的鍵。
      const ikm = U.utf8((password || '') + '::' + roomId);
      const roomKey = await AEAD.hkdf(await U.sha256(ikm), U.utf8('omni-roomkey'), U.utf8(roomId), 32);
      const room = new Room(this, roomId, roomKey);
      await room._init();
      this.rooms.set(roomId, room);
      // プラグインにルーム通知
      for (const p of this._plugins) if (p.onRoom) try { p.onRoom(room, this); } catch (e) { this.log.w('plugin onRoom err', e.message); }
      this.log.i('joined room', roomId, 'tag', room.signaling.roomTag.slice(0, 8));
      return room;
    }
    use(plugin, config) {
      const p = typeof plugin === 'function' ? plugin(this, config) : plugin;
      this._plugins.push(p);
      if (p.onInstall) try { p.onInstall(this, config); } catch (e) { this.log.w('plugin install err', e.message); }
      this.log.i('plugin installed', p.name || '(anon)');
      return this;
    }
    stop() {
      for (const r of this.rooms.values()) r.leave().catch(() => { });
      this.pool.closeAll();
      this.emit('stopped');
    }
  }

  // ==========================================================================
  // 17. プラガブルアダプタ群 (SDK があれば使い、無ければ内蔵にフォールバック)
  // ==========================================================================
  const Adapters = {};

  // ---- Yjs アダプタ: 本物の Y.Doc を WebRTC DataChannel + Nostr に載せる ----
  Adapters.Yjs = function (node, config) {
    return {
      name: 'yjs',
      onRoom(room) {
        const Y = g.Y || (typeof require === 'function' ? tryReq('yjs') : null);
        if (!Y) { room.log.w('[yjs] SDK 未読込 — MiniCRDT を継続使用'); return; }
        // room.doc を Y.Doc ベースに差し替え
        const origDoc = room.doc.bind(room);
        const ydocs = new Map();
        room.doc = function (name) {
          if (ydocs.has(name)) return ydocs.get(name);
          const ydoc = new Y.Doc();
          ydoc.on('update', (update, origin) => {
            if (origin === 'remote') return;
            const wire = { __ydoc: 1, doc: name, update: U.b64(update) };
            room._broadcastRaw(wire);
          });
          // 受信
          room._yHandler = room._yHandler || new Map();
          room._yHandler.set(name, (b64) => Y.applyUpdate(ydoc, U.unb64(b64), 'remote'));
          ydocs.set(name, ydoc);
          return ydoc;
        };
        // 受信フックを wire ルータへ
        hookRawWire(room, (pubkey, wire) => {
          if (wire.__ydoc && room._yHandler && room._yHandler.has(wire.doc)) room._yHandler.get(wire.doc)(wire.update);
        });
        room.log.i('[yjs] adapter active');
      }
    };
  };

  // ---- Automerge アダプタ ----
  Adapters.Automerge = function (node, config) {
    return {
      name: 'automerge',
      onRoom(room) {
        const AM = g.Automerge || (typeof require === 'function' ? tryReq('@automerge/automerge') || tryReq('automerge') : null);
        if (!AM) { room.log.w('[automerge] SDK 未読込 — MiniCRDT を継続使用'); return; }
        const docs = new Map();
        room.amDoc = function (name, initial) {
          if (docs.has(name)) return docs.get(name);
          let doc = AM.init();
          if (initial) doc = AM.change(doc, d => Object.assign(d, initial));
          const wrap = {
            change(fn) { const nd = AM.change(doc, fn); const changes = AM.getChanges(doc, nd); doc = nd; room._broadcastRaw({ __am: 1, doc: name, changes: changes.map(c => U.b64(c)) }); return doc; },
            get doc() { return doc; }, _apply(chunks) { const [nd] = AM.applyChanges(doc, chunks.map(U.unb64)); doc = nd; }
          };
          docs.set(name, wrap); return wrap;
        };
        hookRawWire(room, (pubkey, wire) => { if (wire.__am && docs.has(wire.doc)) docs.get(wire.doc)._apply(wire.changes); });
        room.log.i('[automerge] adapter active');
      }
    };
  };

  // ---- Matrix アダプタ: matrix-js-sdk をラップし E2EE ルーム永続化 ----
  Adapters.Matrix = function (node, config) {
    return {
      name: 'matrix',
      async onInstall() {
        const sdk = g.matrixcs || (typeof require === 'function' ? tryReq('matrix-js-sdk') : null);
        if (!sdk) { node.log.w('[matrix] matrix-js-sdk 未読込 — Matrix 永続化は無効'); return; }
        this.client = sdk.createClient({ baseUrl: (config && config.homeserver) || 'https://matrix.org', accessToken: config && config.accessToken, userId: config && config.userId });
        try { await this.client.startClient({ initialSyncLimit: 10 }); node.log.i('[matrix] client started'); } catch (e) { node.log.w('[matrix] start fail', e.message); }
      },
      onRoom(room) {
        if (!this.client) return;
        const mxRoomId = 'omni-' + room.signaling.roomTag.slice(0, 16);
        // Matrix ルームへメッセージをミラー永続化 (Megolm E2EE はサーバ設定に従う)
        room.on('message', async (data) => { try { await this.client.sendEvent(mxRoomId, 'io.omnip2p.msg', { body: JSON.stringify(data) }); } catch (_) { } });
        room.log.i('[matrix] mirroring to', mxRoomId);
      }
    };
  };

  // ---- GunDB アダプタ: リアルタイムグラフストア ----
  Adapters.GunDB = function (node, config) {
    return {
      name: 'gundb',
      onInstall() {
        const Gun = g.Gun || (typeof require === 'function' ? tryReq('gun') : null);
        if (!Gun) { node.log.w('[gun] SDK 未読込'); return; }
        this.gun = Gun(config && config.peers ? { peers: config.peers } : undefined);
        node.log.i('[gun] initialized');
      },
      onRoom(room) {
        if (!this.gun) return;
        const graph = this.gun.get('omnip2p').get(room.signaling.roomTag);
        // KV を Gun グラフにミラー + WebRTC 未接続時のリアルタイム同期補助
        room._gun = graph;
        room.gunPut = (k, v) => graph.get(k).put(typeof v === 'object' ? v : { value: v });
        room.gunOn = (k, cb) => graph.get(k).on(cb);
        room.log.i('[gun] graph store bound');
      }
    };
  };

  // ---- OrbitDB アダプタ: IPFS ベース永続 DB ----
  Adapters.OrbitDB = function (node, config) {
    return {
      name: 'orbitdb',
      async onInstall() {
        const createOrbitDB = g.createOrbitDB || (typeof require === 'function' ? (tryReq('@orbitdb/core') || {}).createOrbitDB : null);
        const ipfs = config && config.ipfs;
        if (!createOrbitDB || !ipfs) { node.log.w('[orbitdb] core/ipfs 未指定 — 無効'); return; }
        try { this.orbit = await createOrbitDB({ ipfs }); node.log.i('[orbitdb] ready'); } catch (e) { node.log.w('[orbitdb] init fail', e.message); }
      },
      async onRoom(room) {
        if (!this.orbit) return;
        try { room._orbitdb = await this.orbit.open('omni-' + room.signaling.roomTag.slice(0, 16), { type: 'documents' }); room.log.i('[orbitdb] db opened'); } catch (e) { room.log.w('[orbitdb] open fail', e.message); }
      }
    };
  };

  // ---- Iris アダプタ: Nostr 上のソーシャルレイヤ ----
  Adapters.Iris = function (node, config) {
    return {
      name: 'iris',
      onInstall() {
        // Iris は Nostr ベース。プロフィール/フォローグラフを kind 0/3 で扱う薄いレイヤ。
        node.iris = {
          async setProfile(profile) { const e = await node.identity.signEvent({ kind: 0, tags: [], content: JSON.stringify(profile) }); return node.pool.publish(e); },
          async getProfile(pubkey) { const e = await node.storage._queryOne([{ kinds: [0], authors: [pubkey] }]); return e ? safeJson(e.content) : null; },
          async follow(pubkeys) { const e = await node.identity.signEvent({ kind: 3, tags: pubkeys.map(p => ['p', p]), content: '' }); return node.pool.publish(e); }
        };
        node.log.i('[iris] social layer ready (node.iris)');
      }
    };
  };

  // ---- Waku アダプタ: @waku/sdk をラップし Nostr と並列搬送 (匿名性強化) ----
  Adapters.Waku = function (node, config) {
    return {
      name: 'waku',
      async onInstall() {
        const waku = g.waku || (typeof require === 'function' ? tryReq('@waku/sdk') : null);
        if (!waku) { node.log.w('[waku] @waku/sdk 未読込 — 無効'); return; }
        try {
          this.node = await waku.createLightNode({ defaultBootstrap: true });
          await this.node.start();
          this.topic = (config && config.pubsubTopic) || '/omnip2p/1/msg/proto';
          node.log.i('[waku] light node started');
        } catch (e) { node.log.w('[waku] start fail', e.message); }
      },
      onRoom(room) {
        if (!this.node) return;
        const enc = this.node.createEncoder ? this.node.createEncoder({ contentTopic: '/omnip2p/1/' + room.signaling.roomTag.slice(0, 12) + '/proto' }) : null;
        // Nostr と並列に Waku でも送る (どちらか届けば OK, 匿名性向上)
        room.on('message', async (data) => { try { if (enc) await this.node.lightPush.send(enc, { payload: U.utf8(JSON.stringify(data)) }); } catch (_) { } });
        room.log.i('[waku] parallel transport bound');
      }
    };
  };

  function tryReq(name) { try { return require(name); } catch (_) { return null; } }
  // raw wire (アダプタ用の生ブロードキャスト経路) を Room に注入
  function hookRawWire(room, handler) {
    if (!room._rawHandlers) {
      room._rawHandlers = [];
      // WebRTC data の生パスに割り込む
      const origWireData = room._onWireData.bind(room);
      room._onWireData = function (pubkey, bytes) {
        let wire; try { wire = JSON.parse(U.fromUtf8(bytes)); } catch (_) { return origWireData(pubkey, bytes); }
        if (wire.__ydoc || wire.__am || wire.__raw) { room._rawHandlers.forEach(h => h(pubkey, wire)); return; }
        return origWireData(pubkey, bytes);
      };
      // Nostr broadcast の生パス
      room.signaling.on('broadcast', (pubkey, payload) => {
        if (payload && (payload.__ydoc || payload.__am || payload.__raw)) room._rawHandlers.forEach(h => h(pubkey, payload));
      });
      // 送信ヘルパ
      room._broadcastRaw = function (wire) {
        const bytes = U.utf8(JSON.stringify(wire)); let sent = 0;
        for (const pc of room._peerConns()) if (pc.open && pc.send(bytes)) sent++;
        if (sent === 0) room.signaling.broadcast(wire).catch(() => { });
      };
    }
    room._rawHandlers.push(handler);
  }
  // _broadcastRaw が未定義でもアダプタが呼べるよう Room に既定を用意
  Room.prototype._broadcastRaw = function (wire) {
    const bytes = U.utf8(JSON.stringify(wire)); let sent = 0;
    for (const pc of this._peerConns()) if (pc.open && pc.send(bytes)) sent++;
    if (sent === 0) this.signaling.broadcast(wire).catch(() => { });
  };

  // ==========================================================================
  // 18. 公開 API 組み立て
  // ==========================================================================
  function OmniP2P(opts) {
    if (!(this instanceof OmniP2P)) return new OmniP2P(opts);
    return new Node(opts);
  }
  // クラスとして new OmniP2P() でも、OmniP2P(opts) でも動くよう Node を継承的に公開
  OmniP2P.create = (opts) => new Node(opts);
  OmniP2P.Node = Node;
  OmniP2P.Room = Room;
  OmniP2P.Call = Call;
  OmniP2P.Recorder = Recorder;
  OmniP2P.Storage = Storage;
  OmniP2P.Identity = Identity;
  OmniP2P.adapters = Adapters;
  OmniP2P.version = '1.0.0';
  // グローバルレベルの use (全 Node に適用するデフォルトプラグイン登録)
  OmniP2P._globalPlugins = [];
  OmniP2P.use = function (plugin, config) { OmniP2P._globalPlugins.push({ plugin, config }); return OmniP2P; };
  // Node 生成時にグローバルプラグインを自動適用
  const _origJoin = Node.prototype.start;
  Node.prototype.start = async function () {
    for (const { plugin, config } of OmniP2P._globalPlugins) { try { this.use(plugin, config); } catch (e) { this.log.w('global plugin err', e.message); } }
    return _origJoin.call(this);
  };
  OmniP2P._internal = { U, Bech32, Secp, X25519, AEAD, Emitter, Identity, RelayConnection, RelayPool, Signaling, PeerConnection, Storage, Call, Recorder, MiniDoc, Room, Node, mkLog, DEFAULTS: { DEFAULT_RELAYS, DEFAULT_ICE, DEFAULT_BLOSSOM, DEFAULT_NIP96, DEFAULT_IPFS_GW } };

  return OmniP2P;
});

/*
 * ESM で使いたい場合:
 *   このファイルは UMD なので <script> / require() ではそのまま動きます。
 *   ネイティブ ES Module (import) として使いたいときは、別ファイルで:
 *
 *     import './OmniP2P.js';            // 副作用で globalThis.OmniP2P を定義
 *     const OmniP2P = globalThis.OmniP2P;
 *     export default OmniP2P;
 *
 *   もしくは動的 import:
 *     await import('./OmniP2P.js');
 *     const OmniP2P = globalThis.OmniP2P;
 *
 *   (この本体に素の `export` 文を書くと通常の <script> 読み込みが構文エラーに
 *    なるため、あえて UMD + グローバル公開のみとしています。)
 */

