/* ==========================================================================
 * advanced-player.js · 飞牛音乐「高级播放引擎」
 * --------------------------------------------------------------------------
 * 纯前端、零构建、零依赖（jsmediatags 为可选增强）。经典 script 引入，
 * 暴露全局 window.AdvancedPlayer，兼容 file:// 双击打开。
 *
 * 五个模块，全部可单独取用：
 *   ① URL       resolveAudioURL()  音频直链解析 + GitHub CORS / 域名策略
 *   ② ID3       readID3() / readEmbeddedLyrics()
 *              jsmediatags 可选；内置原生 ID3v2 解析器兜底，能读出
 *              TXXX:LYRICS（很多工具把完整 LRC 塞在这里）、USLT、SYLT，
 *              离线 / 本地 Live Server 也能用，且只读文件头部不整包下载
 *   ③ LRC       parseLRC() / activeIndex()  完整 LRC 解析 + 二分定位当前行
 *   ④ Playback  MODES / ShuffleBag / computeNextIndex()  播放模式与切歌
 *   ⑤ PlayerEngine                完整独立引擎（new Audio() + 全事件同步）
 *
 * 本站 index.html 实际接入的是 ①②③④ 这几个纯函数（UI 层已有自己的
 * state/render，没必要推翻）；⑤ 是把同一套逻辑包成可直接复制到别处用的
 * 独立引擎，也是「new Audio() 怎么拿播放 URL」的完整参考答案。
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ------------------------------------------------------------------------
   * 0 / 小工具
   * ---------------------------------------------------------------------- */
  const ABS = /^(https?:|data:|blob:|file:|\/\/)/i;
  const cleanRel = p => String(p == null ? '' : p).trim().replace(/^\.?\//, '').replace(/^\/+/, '');
  const encPath  = p => cleanRel(p).split('/').map(encodeURIComponent).join('/');
  const clamp    = (v, a, b) => Math.min(b, Math.max(a, v));

  function fmtSeconds(sec) {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const s = Math.floor(sec);
    return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }
  function titleFromName(name) {
    return String(name || '')
      .replace(/\.[a-z0-9]+$/i, '')          // 去扩展名
      .replace(/^\d{1,3}[\s._\-—]+/, '')    // 去 01. / 01 - 之类序号
      .replace(/[_-]+/g, ' ')
      .trim() || '未命名';
  }

  /* ------------------------------------------------------------------------
   * 1 / 音频 URL 与 CORS —— 回答「new Audio() 的 src 到底该填什么」
   * ------------------------------------------------------------------------
   * 先把三个概念分开，否则很容易踩坑：
   *
   *  A. 【播放】<audio src> / new Audio(url) 加载跨域媒体是 no-cors 的，
   *     **不需要**服务端返回 Access-Control-Allow-Origin。只有当你想用
   *     Web Audio API 做频谱/可视化（createMediaElementSource）时，才需要
   *     audio.crossOrigin = 'anonymous' + 服务端 CORS 头。
   *
   *  B. 【读 ID3】jsmediatags 用 XHR 去取 MP3 的字节 → **必须 CORS**。
   *  好消息是下面三个 GitHub 域都返回 `Access-Control-Allow-Origin: *`，
   *  且都支持 Range 请求，jsmediatags 只读头部 ID3v2 + 尾部 ID3v1，
   *  不会把 100MB 的 FLAC 整包下载下来。
   *
   *  C. 【域名选择】这三条差别很关键：
   *     raw.githubusercontent.com     ✅ CORS * ✅ Range ✅ 无体积上限 ✅ 无重定向
   *                                  → 默认，音频和 ID3 都最稳
   *     media.githubusercontent.com   ✅ CORS * ✅ Range ✅ 超大文件 / Git LFS
   *                                  ⚠️ 会 302 到对象存储，XHR 跨域重定向可能丢 CORS 头，
   *                                     所以只推荐「播放」，ID3 读取容易失败
   *     cdn.jsdelivr.net/gh/...       ✅ CORS * ✅ Range ✅ 国内快
   *                                  ❌ GitHub 路径单文件上限约 20MB → FLAC 会 404
   *                                  → 只给封面 / .lrc / meta.json 这类小文件用
   *     同域相对路径（local）          最理想：无 CORS、无外网、无体积限制。
   *                                  正式部署建议把 audio/ 和 index.html 放一起。
   *
   *  结论：音频默认 raw.githubusercontent.com；封面/歌词继续 jsDelivr。
   *  这条策略在 data-source.js 的 CONFIG.audioHost 里配置，本函数负责在
   *  播放端做二次规范化（也支持把别人贴进来的链接直接改 host）。
   * ---------------------------------------------------------------------- */
  const HOSTS = {
    local:        '',
    raw:          'https://raw.githubusercontent.com',
    'github-media': 'https://media.githubusercontent.com/media',
    jsdelivr:     'https://cdn.jsdelivr.net/gh',
  };

  /**
   * 把「仓库相对路径」或「已有直链」规范化成可给 new Audio() / <audio src> 用的 URL。
   * @param {string} path   audio/专辑/01.mp3 或 https://... 或 blob:/data:
   * @param {object} opts   { owner, repo, branch, host, forceHost }
   *                        host: 'raw' | 'github-media' | 'jsdelivr' | 'local' | 自定义前缀
   *                        forceHost=true 时，连已生成的绝对直链也按 host 重写
   * @returns {string}
   */
  function resolveAudioURL(path, opts) {
    const o = opts || {};
    const p = String(path == null ? '' : path).trim();
    if (!p) return '';
    if (ABS.test(p) && !o.forceHost) return p;          // 已是绝对地址，原样用
    if (/^(data:|blob:)/i.test(p)) return p;            // 内存资源无法重写

    const host = o.host || 'raw';
    const ns   = [o.owner, o.repo, o.branch].map(x => encodeURIComponent(String(x || '')));

    // 先还原成「仓库相对路径」的明文形式，再按目标 host 重新编码
    let plain = cleanRel(p);
    if (ABS.test(p)) {
      // forceHost：把已有 gh/raw/media 直链里的 path 抽出来重建
      try {
        const u = new URL(p, global.location && global.location.href);
        const m = u.pathname.match(/\/(?:gh\/[^@/]+@[^/]+|media\/[^/]+\/[^/]+\/[^/]+|[^/]+\/[^/]+\/[^/]+)\/(.+)$/);
        plain = m ? decodeURIComponent(m[1]) : u.pathname.replace(/^\/+/, '');
      } catch (e) { /* 保留 cleanRel 结果 */ }
    }
    if (host === 'local') return plain;       // 同域相对路径，保持可读、不编码
    const target = encPath(plain);

    if (HOSTS[host]) {
      if (host === 'jsdelivr') return `${HOSTS[host]}/${ns[0]}/${ns[1]}@${ns[2]}/${target}`;
      return `${HOSTS[host]}/${ns[0]}/${ns[1]}/${ns[2]}/${target}`;
    }
    // 自定义前缀，例如 'https://music.example.com/media'
    return String(host).replace(/\/+$/, '') + '/' + target;
  }

  /** 给调试面板用：说明某个 URL 的 CORS / Range / 体积特性 */
  function describeURL(url) {
    const s = String(url || '');
    if (!s) return { cors: '—', note: '空地址' };
    if (/^data:|^blob:|^file:|^\.\//.test(s)) return { cors: '同源', note: '本地/内存资源，无跨域限制' };
    if (/cdn\.jsdelivr\.net/.test(s)) return { cors: '*', note: '支持 Range；GitHub 路径单文件约 20MB 上限，仅适合小文件' };
    if (/media\.githubusercontent\.com/.test(s)) return { cors: '*', note: '支持 Range、无体积上限；302 跳对象存储，ID3 读取可能失败' };
    if (/raw\.githubusercontent\.com/.test(s)) return { cors: '*', note: '支持 Range、无体积上限、无重定向；音频与 ID3 最稳' };
    if (/api\.github\.com/.test(s)) return { cors: '*', note: '仅用于列目录，勿作为 <audio src>' };
    return { cors: '取决于服务端', note: '跨域播放无需 CORS；读取字节（ID3）需要 CORS 头' };
  }

  /* ------------------------------------------------------------------------
   * 2 / ID3 元数据（jsmediatags）
   * ------------------------------------------------------------------------
   * 在 <head> 里引入（CDN 挂了也不影响播放，readID3 会直接返回 null）：
   *   <script defer src="https://cdn.jsdelivr.net/npm/jsmediatags@3.9.7/dist/jsmediatags.min.js"></script>
   *
   * 注意两个诚实的边界：
   *   · ID3 里没有精确时长（TLEN 帧可选且常不准）→ 时长一律以 <audio>
   *     的 loadedmetadata / duration 为准，不要用 ID3 的。
   *   · SYLT（同步歌词）帧 jsmediatags 基本不支持；USLT 只有纯文本没有
   *     时间轴。所以逐行滚动高亮请放同名 .lrc，内嵌歌词只做整段展示。
   * ---------------------------------------------------------------------- */
  const id3Cache = new Map();       // url -> Promise<tags|null>，同一首只读一次

  function b64(bytes) {
    let bin = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    if (typeof global.btoa === 'function') return global.btoa(bin);
    if (typeof Buffer !== 'undefined') return Buffer.from(bin, 'binary').toString('base64');
    return '';
  }

  function normalizeTags(tags) {
    if (!tags || typeof tags !== 'object') return null;
    const str = v => {
      if (v == null) return '';
      if (typeof v === 'object') return String(v.text || v.value || v.data || '').trim();
      return String(v).trim();
    };
    let picture = '';
    const pic = tags.picture;
    if (pic && pic.data && pic.format) {
      const bytes = pic.data instanceof Uint8Array ? pic.data : new Uint8Array(pic.data);
      const data = b64(bytes);
      if (data) picture = `data:${pic.format};base64,${data}`;
    }
    // 内嵌歌词：jsmediatags 可能给 lyrics / USLT / SYLT 中的任意一种；
    // TXXX:LYRICS 是很多工具的写法，jsmediatags 会保留成 TXXX 数组，这里也接住。
    let lyrics = str(tags.lyrics || tags.USLT || tags.unsynchronisedLyrics);
    if (!lyrics && tags.SYLT) {
      const s = tags.SYLT;
      lyrics = Array.isArray(s) ? s.map(x => str(x.text || x)).join('\n') : str(s.text || s);
    }
    if (!lyrics && tags.TXXX) {
      const arr = Array.isArray(tags.TXXX) ? tags.TXXX : [tags.TXXX];
      const hit = arr.find(x => x && /^(lyrics?|lrc|歌词)$/i.test(
        String(x.description || x.userDescription || x.key || '').trim()));
      if (hit) lyrics = str(hit.text || hit.value || hit.data);
    }
    if (lyrics) lyrics = String(lyrics).replace(/^\uFEFF/, '');
    const out = {
      title:  str(tags.title),
      artist: str(tags.artist),
      album:  str(tags.album),
      year:   str(tags.year),
      track:  str(tags.track),
      genre:  str(tags.genre),
      picture,
      lyrics,
    };
    return Object.keys(out).some(k => out[k]) ? out : null;
  }

  /**
   * 读取一个音频 URL 的 ID3 标签。永不 reject：CDN 缺失 / 跨域失败 /
   * 无标签 / 超时，统统返回 null，调用方用文件名兜底即可。
   */
  /* ------------------------------------------------------------------------
   * 2b / 原生 ID3v2 解析（不依赖 jsmediatags CDN）
   * ------------------------------------------------------------------------
   * 为什么必须有这一层：
   *   · 很多打标签工具把完整 LRC 歌词写进 TXXX:LYRICS 自定义帧，
   *     jsmediatags 不会把它映射成 tags.lyrics，所以歌词「明明在文件里却读不到」；
   *   · 本地 Live Server / 离线环境可能根本加载不到 CDN；
   *   · 同源音频只需流式 fetch 头部几百 KB，读到标签区末尾就 cancel()，
   *     不会把 10MB+ 的 mp3 整包下载（Range 不支持时也靠 reader.cancel 兜住）。
   * 支持 ID3v2.2 / 2.3 / 2.4：TIT2/TPE1/TALB…、TXXX、USLT、SYLT、APIC。
   * ---------------------------------------------------------------------- */
  const nativeTagCache = new Map();

  function synchsafe(b, o, n) {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 7) | (b[o + i] & 0x7f);
    return v >>> 0;
  }
  function u32be(b, o) {
    return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  }
  function decodeBytes(bytes, enc) {
    if (!bytes || !bytes.length) return '';
    let s = '';
    try {
      const TD = global.TextDecoder;
      if (TD) {
        if (enc === 3)      s = new TD('utf-8').decode(bytes);
        else if (enc === 1) s = new TD('utf-16').decode(bytes);      // 带 BOM
        else if (enc === 2) s = new TD('utf-16be').decode(bytes);
        else {
          // 声明 ISO-8859-1，但国产工具常把 UTF-8 中文错标成 0：
          // 先按 UTF-8 严格解，失败再退回 latin1。
          try { s = new TD('utf-8', { fatal: true }).decode(bytes); }
          catch (e) { s = Array.from(bytes, x => String.fromCharCode(x)).join(''); }
        }
      } else {
        s = Array.from(bytes, x => String.fromCharCode(x)).join('');
      }
    } catch (e) { /* 保底返回空串 */ }
    return String(s).replace(/^\uFEFF/, '').replace(/\0+$/, '').trim();
  }
  /** 从 offset 起读一个 \0 结尾的字符串（UTF-16 为 \0\0），返回 {text, next} */
  function readCString(buf, offset, end, enc) {
    const wide = (enc === 1 || enc === 2);
    let i = offset;
    if (wide) {
      while (i + 1 < end && !(buf[i] === 0 && buf[i + 1] === 0)) i += 2;
      return { text: decodeBytes(buf.subarray(offset, i), enc), next: Math.min(i + 2, end) };
    }
    while (i < end && buf[i] !== 0) i++;
    return { text: decodeBytes(buf.subarray(offset, i), enc), next: Math.min(i + 1, end) };
  }
  function toDataURL(bytes, mime) {
    if (!bytes || !bytes.length) return '';
    try {
      let bin = '';
      for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      const b = typeof global.btoa === 'function' ? global.btoa(bin)
              : (typeof Buffer !== 'undefined' ? Buffer.from(bytes).toString('base64') : '');
      return b ? `data:${mime || 'image/jpeg'};base64,${b}` : '';
    } catch (e) { return ''; }
  }

  const LYRIC_KEY = /^(lyrics?|unsyncedlyrics|unsynchronisedlyrics|lrc|歌词|syncedlyrics|sylt)$/i;
  const SIMPLE_TEXT = {
    TIT2:'title', TT2:'title', TPE1:'artist', TP1:'artist',
    TALB:'album', TAL:'album', TYER:'year', TDRC:'year', TYE:'year',
    TRCK:'track', TRK:'track', TCON:'genre', TCO:'genre',
  };

  function collectFrame(id, body, out) {
    if (SIMPLE_TEXT[id] && body.length > 1) {
      const v = decodeBytes(body.subarray(1), body[0]);
      if (v && !out[SIMPLE_TEXT[id]]) out[SIMPLE_TEXT[id]] = v;
      return;
    }
    if (id === 'TXXX' || id === 'TXX') {
      const enc = body[0];
      const d = readCString(body, 1, body.length, enc);
      const value = decodeBytes(body.subarray(d.next), enc);
      if (LYRIC_KEY.test(d.text.trim()) && value && !out.lyrics) {
        out.lyrics = value;
        out.lyricsSource = 'TXXX:' + d.text.trim();
      }
      return;
    }
    if (id === 'USLT' || id === 'ULT') {
      const enc = body[0];
      const d = readCString(body, 4, body.length, enc);   // enc + lang(3)
      const value = decodeBytes(body.subarray(d.next), enc);
      if (value && !out.lyrics) { out.lyrics = value; out.lyricsSource = 'USLT'; }
      return;
    }
    if (id === 'SYLT' || id === 'SLT') {
      const enc = body[0];
      const d = readCString(body, 6, body.length, enc);   // enc + lang(3) + format(1) + type(1)
      const lines = [];
      let r = d.next;
      while (r + 5 <= body.length) {
        const t = readCString(body, r, body.length, enc);
        if (t.next + 4 > body.length) break;
        const ms = u32be(body, t.next);
        const sec = ms / 1000;
        const mm = String(Math.floor(sec / 60)).padStart(2, '0');
        const ss = (sec % 60).toFixed(2).padStart(5, '0');
        lines.push(`[${mm}:${ss}]${t.text}`);
        r = t.next + 4;
      }
      if (lines.length && !out.lyrics) { out.lyrics = lines.join('\n'); out.lyricsSource = 'SYLT'; }
      return;
    }
    if ((id === 'APIC' || id === 'PIC') && !out.picture) {
      const enc = body[0];
      const mime = id === 'APIC'
        ? readCString(body, 1, body.length, enc).text
        : 'image/' + String.fromCharCode(body[1], body[2], body[3]).toLowerCase();
      let q = id === 'APIC' ? readCString(body, 1, body.length, enc).next + 1 : 4;
      const desc = readCString(body, q, body.length, enc);
      if (desc.next < body.length) out.picture = toDataURL(body.subarray(desc.next), mime || 'image/jpeg');
    }
  }

  /** 解析一个完整的 ID3v2 标签区（含 10 字节头） */
  function parseID3v2(buf) {
    const out = { title:'', artist:'', album:'', year:'', track:'', genre:'',
                  picture:'', lyrics:'', lyricsSource:'' };
    if (!buf || buf.length < 10) return out;
    if (!(buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33)) return out;  // "ID3"
    const ver = buf[3];
    if (ver > 4 || ver < 2) return out;
    const tagFlags = buf[5];
    const tagSize = synchsafe(buf, 6, 4);
    const end = Math.min(buf.length, 10 + tagSize);
    if (!tagSize || end <= 10) return out;

    let p = 10;
    if (tagFlags & 0x40) {                       // 扩展头
      if (p + 4 > end) return out;
      p += ver === 3 ? 4 + u32be(buf, p) : synchsafe(buf, p, 4);
    }
    const idLen = ver === 2 ? 3 : 4;
    const head  = ver === 2 ? 6 : 10;
    while (p + head <= end) {
      const id = String.fromCharCode.apply(null, buf.subarray(p, p + idLen));
      if (!/^[A-Z0-9]+$/.test(id)) break;       // padding 区
      const size = ver === 2
        ? ((buf[p+3] << 16) | (buf[p+4] << 8) | buf[p+5])
        : (ver === 4 ? synchsafe(buf, p + 4, 4) : u32be(buf, p + 4));
      if (size <= 0 || p + head + size > end) break;
      // 歌词已拿到、后面又是超大封面帧 → 不必再扫，省掉 200KB 的 base64
      if (out.lyrics && (id === 'APIC' || id === 'PIC')) break;
      try { collectFrame(id, buf.subarray(p + head, p + head + size), out); }
      catch (e) { /* 单帧损坏不影响其它帧 */ }
      p += head + size;
    }
    return out;
  }

  function concatChunks(chunks, total) {
    const out = new Uint8Array(total);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  /** 流式读取音频头部。命中缓存后同一首歌只发一次请求。 */
  function readNativeTags(url) {
    const key = String(url || '');
    if (!key) return Promise.resolve(null);
    if (nativeTagCache.has(key)) return nativeTagCache.get(key);

    const task = (async () => {
      if (typeof global.fetch !== 'function') return null;
      let res;
      try {
        res = await global.fetch(key, {
          headers: { Range: 'bytes=0-1048575' },     // 1MB 上限，足够覆盖 ID3v2 标签区
          cache: 'force-cache',
        });
      } catch (e) { return null; }
      if (!res || !res.ok) return null;

      if (!res.body || typeof res.body.getReader !== 'function') {
        try { return parseID3v2(new Uint8Array(await res.arrayBuffer())); }
        catch (e) { return null; }
      }
      const reader = res.body.getReader();
      const chunks = [];
      let total = 0, need = 0;
      const MAX = 1024 * 1024;
      try {
        while (total < MAX) {
          const r = await reader.read();
          if (r.done) break;
          if (!r.value || !r.value.length) continue;
          chunks.push(r.value);
          total += r.value.length;
          if (total >= 10 && !need) {
            const h = concatChunks(chunks, 10);
            if (h[0] === 0x49 && h[1] === 0x44 && h[2] === 0x33) need = 10 + synchsafe(h, 6, 4);
            else return null;                      // 无 ID3v2（ID3v1 里没有歌词）
          }
          if (need && total >= Math.min(need, MAX)) break;
        }
      } catch (e) { /* 读到多少算多少 */ }
      finally { try { await reader.cancel(); } catch (e) {} }   // 立刻停止下载剩余 mp3
      if (!chunks.length) return null;
      const all = concatChunks(chunks, total);
      const tags = parseID3v2(need ? all.subarray(0, Math.min(need, total)) : all);
      return (tags.lyrics || tags.title || tags.artist || tags.picture) ? tags : null;
    })();
    nativeTagCache.set(key, task);
    return task;
  }

  /** 给 UI 用：返回 { text, source }，text 可能是完整 LRC，也可能只是纯文本 */
  function readEmbeddedLyrics(url) {
    return readNativeTags(url).then(t =>
      t && t.lyrics ? { text: t.lyrics, source: t.lyricsSource || 'ID3' } : null);
  }

  /* ------------------------------------------------------------------------
   *  媒体元信息：一次轻量读取同时拿到「文件大小」和「时长」
   *  浏览器不能枚举本地目录，静态服务器也不给文件属性，所以详情表里这两列
   *  必须由前端读文件头补齐。只读 ID3v2 标签区 + 第一个 MPEG 帧（几十 KB），
   *  读够就 cancel，不下载整首 mp3；响应头给出真实总大小。
   * ---------------------------------------------------------------------- */
  const mediaMetaCache = new Map();

  /** 安全取流的前 n 字节（不依赖单个 chunk 的大小） */
  function firstBytes(chunks, n) {
    const out = new Uint8Array(n);
    let filled = 0;
    for (const c of chunks) {
      if (filled >= n) break;
      const take = Math.min(c.length, n - filled);
      out.set(c.subarray(0, take), filled);
      filled += take;
    }
    return out;
  }

  /** 从 MP3 头部字节解析出 { size, sec }。非 MP3 / 解析失败时 sec = 0。 */
  function parseMediaMeta(buf, size) {
    const out = { size: size || 0, sec: 0 };
    if (!buf || buf.length < 16) return out;

    /* ① 跳过 ID3v2 标签：10 字节头 + synchsafe 长度（v2.4 footer 再 +10） */
    let audioStart = 0;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
      const tagSize = synchsafe(buf, 6, 4);
      audioStart = 10 + tagSize + ((buf[5] & 0x10) && buf[3] === 4 ? 10 : 0);
    }

    /* ② 找第一个合法的 MPEG 音频帧，取码率 / 采样率 */
    const BR1 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320,0];
    const BR2 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160,0];
    const SR  = { 3:[44100,48000,32000], 2:[22050,24000,16000], 0:[11025,12000,8000] };
    let p = -1, verBits = 0, layerBits = 0, br = 0, sr = 0;
    const limit = Math.min(buf.length - 4, audioStart + 262144);
    for (let i = Math.max(0, audioStart); i < limit; i++) {
      if (buf[i] !== 0xff || (buf[i+1] & 0xe0) !== 0xe0) continue;
      const h = u32be(buf, i);
      const v = (h >>> 19) & 3, l = (h >>> 17) & 3;
      if (v === 1 || l === 0) continue;                 // 保留值
      const bi = (h >>> 12) & 15, si = (h >>> 10) & 3;
      if (bi === 0 || bi === 15 || si === 3) continue; // free / bad / 保留采样率
      const b = (v === 3 ? BR1 : BR2)[bi];
      const s = (SR[v] || SR[0])[si];
      if (!b || !s) continue;
      p = i; verBits = v; layerBits = l; br = b; sr = s;
      break;
    }
    if (p < 0 || !br || !sr) return out;

    /* ③ Xing / Info / VBRI 里有总帧数 → VBR 也能精确算 */
    const spf = layerBits === 3 ? 384 : (verBits === 3 ? 1152 : 576);
    let frames = 0;
    for (let i = p + 4; i < Math.min(buf.length - 18, p + 4 + 96); i++) {
      const tag = String.fromCharCode(buf[i], buf[i+1], buf[i+2], buf[i+3]);
      if (tag === 'Xing' || tag === 'Info') {
        if (u32be(buf, i + 4) & 1) frames = u32be(buf, i + 8);
        break;
      }
      if (tag === 'VBRI') {
        frames = u32be(buf, i + 14);
        break;
      }
    }

    /* ④ 无帧数：按 CBR 由「总字节 / 码率」估算，扣掉 ID3v1 尾部 128B */
    let sec;
    if (frames > 0) sec = frames * spf / sr;
    else if (size > p) sec = (size - p - (size > 128 ? 128 : 0)) * 8 / (br * 1000);
    if (!isFinite(sec) || sec <= 0) return out;
    out.sec = Math.round(sec);
    return out;
  }

  /** 读音频头部元信息，命中缓存后同一首歌只发一次请求 */
  function readMediaMeta(url) {
    const key = String(url || '');
    if (!key) return Promise.resolve(null);
    if (mediaMetaCache.has(key)) return mediaMetaCache.get(key);

    const task = (async () => {
      if (typeof global.fetch !== 'function') return null;
      const ctl = typeof global.AbortController === 'function' ? new global.AbortController() : null;
      const timer = ctl ? setTimeout(() => { try { ctl.abort(); } catch (e) {} }, 10000) : null;
      let res;
      try {
        res = await global.fetch(key, {
          headers: { Range: 'bytes=0-1048575' },
          cache: 'force-cache',
          signal: ctl ? ctl.signal : undefined,
        });
      } catch (e) { return null; }
      finally { if (timer) clearTimeout(timer); }
      if (!res || !res.ok) return null;

      /* 总大小：优先 Content-Range 的 /TOTAL；服务器忽略 Range 时用 Content-Length */
      let size = 0;
      const cr = res.headers && res.headers.get('content-range');
      if (cr) { const m = cr.match(/\/(\d+)\s*$/); if (m) size = Number(m[1]); }
      if (!size) {
        const cl = res.headers && res.headers.get('content-length');
        if (cl) size = Number(cl);
      }

      if (!res.body || typeof res.body.getReader !== 'function') {
        try { return parseMediaMeta(new Uint8Array(await res.arrayBuffer()), size); }
        catch (e) { return null; }
      }

      const reader = res.body.getReader();
      const chunks = [];
      let total = 0, need = 0;
      const MAX = 1024 * 1024;
      try {
        while (total < MAX) {
          const r = await reader.read();
          if (r.done) break;
          if (!r.value || !r.value.length) continue;
          chunks.push(r.value);
          total += r.value.length;
          if (total >= 10 && !need) {
            const head = firstBytes(chunks, 10);
            const id3 = (head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33)
              ? synchsafe(head, 6, 4) : 0;
            /* 标签区 + 第一个音频帧（32KB 足够覆盖 padding / Xing 头） */
            need = Math.min(MAX, (id3 ? 10 + id3 : 0) + 32768);
          }
          if (need && total >= need) break;
        }
      } catch (e) { /* 读到多少算多少 */ }
      finally { try { await reader.cancel(); } catch (e) {} }
      if (!chunks.length) return null;
      return parseMediaMeta(concatChunks(chunks, total), size);
    })();
    mediaMetaCache.set(key, task);
    return task;
  }

  function readID3(url, opts) {
    const o = opts || {};
    const key = String(url || '');
    if (!key) return Promise.resolve(null);
    if (!o.force && id3Cache.has(key)) return id3Cache.get(key);

    // 与 readEmbeddedLyrics 共用同一份缓存 → 一首歌只发一次请求
    const native = readNativeTags(key);
    const cdn = new Promise(resolve => {
      const jmt = global.jsmediatags;
      if (!jmt || typeof jmt.read !== 'function') return resolve(null);   // CDN 未加载
      let done = false;
      const finish = v => { if (!done) { done = true; resolve(v); } };
      const timeout = setTimeout(() => finish(null), o.timeout || 8000);
      try {
        jmt.read(key, {
          onSuccess: tag => { clearTimeout(timeout); finish(normalizeTags(tag && tag.tags)); },
          onError:   ()  => { clearTimeout(timeout); finish(null); },
        });
      } catch (e) { clearTimeout(timeout); finish(null); }
    });

    const task = Promise.all([cdn, native]).then(([a, b]) => {
      const base = a || {}, n = b || {};
      const merged = Object.assign({}, n, base);          // CDN 的常规字段优先
      // 关键补位：jsmediatags 读不到 TXXX:LYRICS，用原生解析结果补上
      if (!merged.lyrics  && n.lyrics)  merged.lyrics  = n.lyrics;
      if (!merged.picture && n.picture) merged.picture = n.picture;
      if (!merged.title   && n.title)   merged.title   = n.title;
      if (!merged.artist  && n.artist)  merged.artist  = n.artist;
      if (!merged.album   && n.album)   merged.album   = n.album;
      return Object.keys(merged).some(k => merged[k]) ? merged : null;
    });
    id3Cache.set(key, task);
    return task;
  }
  function clearID3Cache() { id3Cache.clear(); nativeTagCache.clear(); mediaMetaCache.clear(); }

  /** 读不到 ID3 时的兜底：从文件名推歌名、从路径推专辑/歌手 */
  function fallbackFromFilename(url) {
    const raw = String(url || '').split('?')[0];
    let name = raw.split('/').pop() || '';
    try { name = decodeURIComponent(name); } catch (e) { /* 保留原样 */ }
    const folder = (() => {
      const parts = raw.split('/');
      return parts.length > 1 ? parts[parts.length - 2] : '';
    })();
    let dir = '';
    try { dir = decodeURIComponent(folder); } catch (e) { dir = folder; }
    const dash = dir.split(/\s+[-–—]\s+/);
    return {
      title:  titleFromName(name),
      artist: dash.length > 1 ? dash[0].trim() : '',
      album:  dash.length > 1 ? dash.slice(1).join(' - ').trim() : dir,
    };
  }

  /* ------------------------------------------------------------------------
   * 3 / LRC 歌词解析
   * ------------------------------------------------------------------------
   * 支持：
   *   [ti:标题] [ar:歌手] [al:专辑] [by:制作] [offset:±毫秒] [re:] [ve:]
   *   [mm:ss] / [mm:ss.xx] / [mm:ss:xx] / [hh:mm:ss]
   *   一行多时间戳  [00:12.00][00:45.00]同一句歌词
   *   增强型逐字    [00:12.00]你<00:12.40>好<00:13.00>呀（剥离尖括号，另存 wordTimes）
   * 返回 { lines:[{time,text,wordTimes}], meta, offset(秒), toPairs() }
   * offset 语义按 LRC 规范： [offset:+500] 表示歌词整体提前 0.5 秒，
   * 即 判定时间 = 播放时间 + offset。
   * ---------------------------------------------------------------------- */
  const META_RE = /^\[(ti|ar|al|by|offset|re|ve|length)\s*:\s*([^\]]*)\]\s*$/i;
  const TIME_RE = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  const WORD_RE = /<(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?>/g;

  function parseTime(m) {
    const frac = m[3] ? Number(m[3]) / Math.pow(10, m[3].length) : 0;
    return Number(m[1]) * 60 + Number(m[2]) + frac;
  }

  function parseLRC(text) {
    const meta = {}, raw = [];
    // UTF-8 BOM 在 .lrc 文件和 TXXX:LYRICS 文本里都很常见，先剥掉，
    // 否则第一行 \uFEFF[ti:xxx] 会匹配不上元数据正则。
    const src = String(text == null ? '' : text).replace(/^\uFEFF/, '');

    src.split(/\r?\n/).forEach(line => {
      const L = line.replace(/^\uFEFF/, '').trim();
      if (!L) return;
      const mm = L.match(META_RE);
      if (mm) { meta[mm[1].toLowerCase()] = mm[2].trim(); return; }

      // 收集本行所有时间戳
      TIME_RE.lastIndex = 0;
      let m, times = [];
      while ((m = TIME_RE.exec(L)) !== null) times.push(parseTime(m));
      if (!times.length) return;

      // 去掉全部 [时间] 标签，得到歌词正文
      let body = L.replace(TIME_RE, '').trim();
      const wordTimes = [];
      WORD_RE.lastIndex = 0;
      let w;
      while ((w = WORD_RE.exec(body)) !== null) wordTimes.push(parseTime(w));
      body = body.replace(WORD_RE, '').trim();
      if (!body) body = '♪';               // 间奏行保留占位，维持滚动节奏

      times.forEach(time => raw.push({ time, text: body, wordTimes }));
    });

    raw.sort((a, b) => a.time - b.time || a.text.localeCompare(b.text));
    // 同一时刻去重（多时间戳合并且文本相同时）
    const lines = raw.filter((x, i) => i === 0 || !(x.time === raw[i - 1].time && x.text === raw[i - 1].text));

    const offsetMs = Number(meta.offset);
    const offset = isFinite(offsetMs) ? clamp(offsetMs / 1000, -60, 60) : 0;

    return {
      lines,
      meta,
      offset,
      /** 兼容旧的 [[秒,文本], ...] 结构，老 UI 一行都不用改 */
      toPairs() { return lines.map(l => [l.time, l.text]); },
      get length() { return lines.length; },
    };
  }

  /** 二分查找当前应高亮的行；t 为播放进度（秒）。返回 -1 表示还没到第一行。
   *  同时接受 [{time,text}] 和旧版 [[秒,文本]] 两种结构，方便老 UI 直接接。 */
  function activeIndex(lines, t, offset) {
    const n = lines && lines.length ? lines.length : 0;
    if (!n) return -1;
    const at = Number(t || 0) + Number(offset || 0);
    const timeAt = i => { const l = lines[i]; return Array.isArray(l) ? Number(l[0]) : Number(l && l.time); };
    let lo = 0, hi = n - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeAt(mid) <= at) { ans = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    return ans;
  }

  /** .lrc 直链 → 解析结果；跨域失败返回 null，不抛错 */
  async function loadLRC(url) {
    if (!url) return null;
    try {
      const res = await global.fetch(url, { cache: 'no-store' });
      if (!res || !res.ok) return null;
      const parsed = parseLRC(await res.text());
      return parsed.lines.length ? parsed : null;
    } catch (e) { return null; }
  }

  /* ------------------------------------------------------------------------
   * 4 / 播放模式与切歌
   * ---------------------------------------------------------------------- */
  const MODES = ['loop', 'shuffle', 'single'];
  const MODE_LABEL = { loop: '列表循环', shuffle: '随机播放', single: '单曲循环' };

  /**
   * 洗牌桶：一轮内每首只出现一次，播完一轮再重新洗。
   * 比 Math.random() 好在不会「刚播过又抽到」「连着三首没轮到」。
   */
  class ShuffleBag {
    constructor(size) { this.size = size || 0; this.bag = []; }
    setSize(size) { if (size !== this.size) { this.size = size; this.bag = []; } }
    reset() { this.bag = []; }
    next(exclude) {
      if (this.size <= 0) return 0;
      if (this.size === 1) return 0;
      if (!this.bag.length) {
        this.bag = Array.from({ length: this.size }, (_, i) => i);
        for (let i = this.bag.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [this.bag[i], this.bag[j]] = [this.bag[j], this.bag[i]];
        }
        // 避免新一轮第一首恰好是刚播完的那首
        if (this.bag[0] === exclude) [this.bag[0], this.bag[1]] = [this.bag[1], this.bag[0]];
      }
      return this.bag.shift();
    }
  }

  /**
   * 计算下一首索引。
   * @param {number} len     队列长度
   * @param {number} cur     当前索引（-1 表示还没开始）
   * @param {string} mode    loop | shuffle | single
   * @param {ShuffleBag} bag
   * @param {boolean} manual true=用户手动点「下一首」（此时单曲循环也要切歌）
   * @returns {{index:number, replay:boolean}} replay=true 表示重播当前曲
   */
  function computeNextIndex(len, cur, mode, bag, manual) {
    if (!len) return { index: -1, replay: false };
    if (mode === 'single' && !manual) return { index: cur < 0 ? 0 : cur, replay: true };
    if (mode === 'shuffle' && len > 1) {
      const b = bag || new ShuffleBag(len);
      b.setSize(len);
      return { index: b.next(cur), replay: false };
    }
    return { index: ((cur < 0 ? -1 : cur) + 1) % len, replay: false };
  }

  /* ------------------------------------------------------------------------
   * 5 / PlayerEngine —— 完整独立引擎（new Audio() 版）
   * ------------------------------------------------------------------------
   * 这一段是「可直接复制到任何项目」的参考实现：自带队列、模式、音量、
   * timeupdate 同步、ID3 回填、LRC 加载，UI 只需订阅 on* 回调。
   *
   *   const p = new AdvancedPlayer.PlayerEngine({
   *     owner:'user', repo:'music', branch:'main', audioHost:'raw',
   *     onTime: (t, d) => drawProgress(t, d),
   *     onLyrics: (parsed, idx) => drawLyrics(parsed, idx),
   *     onMeta: m => console.log('时长', m.duration),
   *     onTrack: t => console.log('当前曲目', t.title),
   *     onError: e => console.warn(e),
   *   });
   *   p.loadQueue(tracks);   // tracks: [{title, file, lrc, cover, ...}]
   *   p.play(0);
   * ---------------------------------------------------------------------- */
  class PlayerEngine {
    constructor(opts) {
      const o = opts || {};
      this.opts = Object.assign({
        owner: '', repo: '', branch: 'main', audioHost: 'raw',
        volume: 0.72,
        onTime() {}, onMeta() {}, onTrack() {}, onState() {},
        onLyrics() {}, onError() {},
      }, o);

      // ↓↓↓ 这就是「new Audio() 怎么拿到播放 URL」：
      //     src 由 resolveAudioURL() 从仓库相对路径生成，指向带 CORS 的域。
      //     播放本身不需要 CORS；只有 readID3() 的 XHR 才需要。
      this.audio = o.audio || new global.Audio();
      this.audio.preload = 'metadata';
      this.audio.volume = this.opts.volume;

      this.queue = [];
      this.index = -1;
      this.mode = 'loop';
      this.bag = new ShuffleBag(0);
      this.progress = 0;
      this.lyrics = null;
      this._token = 0;
      this._bind();
    }

    _url(track) {
      return resolveAudioURL(track.file, {
        owner: this.opts.owner, repo: this.opts.repo,
        branch: this.opts.branch, host: this.opts.audioHost,
      });
    }

    _bind() {
      const a = this.audio;
      // 唯一的进度源：所有进度条 / 歌词都从这里驱动，不再另起 setInterval
      a.addEventListener('timeupdate', () => {
        this.progress = a.currentTime || 0;
        const idx = activeIndex(this.lyrics && this.lyrics.lines, this.progress, this.lyrics && this.lyrics.offset);
        this.opts.onTime(this.progress, a.duration || 0);
        this.opts.onLyrics(this.lyrics, idx);
      });
      a.addEventListener('loadedmetadata', () => {
        if (!isFinite(a.duration) || a.duration <= 0) return;
        this.opts.onMeta({ duration: a.duration, formatted: fmtSeconds(a.duration) });
      });
      a.addEventListener('ended', () => this.next(false));      // 自动切歌走模式判断
      a.addEventListener('play',  () => this.opts.onState(true));
      a.addEventListener('pause', () => this.opts.onState(false));
      a.addEventListener('error', () => {
        const code = a.error && a.error.code;
        this.opts.onError('音频加载失败（code ' + code + '）：检查 URL / 仓库是否公开 / 格式是否被浏览器支持');
      });
    }

    loadQueue(tracks) {
      this.queue = (tracks || []).slice();
      this.bag.setSize(this.queue.length);
      this.bag.reset();
    }

    setMode(mode) {
      if (MODES.indexOf(mode) < 0) return;
      this.mode = mode;
      this.bag.setSize(this.queue.length);
      this.bag.reset();
    }
    cycleMode() { this.setMode(MODES[(MODES.indexOf(this.mode) + 1) % MODES.length]); return this.mode; }

    /** 统一的「开始播某首」入口：设置 src → load → play → 异步补元数据/歌词 */
    async play(index, autoplay) {
      const i = clamp(Number(index) || 0, 0, Math.max(0, this.queue.length - 1));
      const t = this.queue[i];
      if (!t) return false;
      this.index = i;
      this.progress = 0;
      this.lyrics = null;
      const token = ++this._token;
      const url = this._url(t);
      if (!url) { this.opts.onError('曲目缺少 file 字段'); return false; }

      const a = this.audio;
      a.pause();
      a.src = url;                                  // ← new Audio() 的播放 URL
      a.load();
      this.opts.onTrack(t, { url, cors: describeURL(url) });
      this.opts.onLyrics(null, -1);

      if (autoplay !== false) {
        try { await a.play(); }
        catch (e) { this.opts.onState(false); /* 自动播放被浏览器拦截，等用户点一下 */ }
      }
      this._enrich(t, url, token);
      return true;
    }

    /** ID3 + LRC 并行补齐，不阻塞起播；结果回来时校验 token 防止错歌覆盖 */
    async _enrich(track, url, token) {
      const [tags, lrc] = await Promise.all([
        readID3(url),
        loadLRC(track.lrc),
      ]);
      if (token !== this._token) return;          // 已切歌，丢弃过期结果

      if (!tags) {
        const fb = fallbackFromFilename(url);
        track.title = track.title || fb.title;
        track.artist = track.artist || fb.artist;
        track.album = track.album || fb.album;
      } else {
        // ID3 优先；只在有值时覆盖，避免空标签把人工维护的歌名抹掉
        if (tags.title)  track.title  = tags.title;
        if (tags.artist) track.artist = tags.artist;
        if (tags.album)  track.album  = tags.album;
        if (tags.year)   track.year   = tags.year;
        if (tags.picture) track.cover = Object.assign({}, track.cover, { url: tags.picture });
        if (tags.lyrics) track.embeddedLyrics = tags.lyrics;
        this.opts.onMeta({ id3: tags });
      }
      if (lrc) this.lyrics = lrc;
      else if (track.embeddedLyrics) {
        // USLT 无时间轴：整段展示，不伪造时间
        this.lyrics = parseLRC(track.embeddedLyrics.split(/\r?\n/).map(x => '[00:00.00]' + x).join('\n'));
      }
      this.opts.onTrack(track, { url, cors: describeURL(url) });
      this.opts.onLyrics(this.lyrics, activeIndex(this.lyrics && this.lyrics.lines, this.progress, this.lyrics && this.lyrics.offset));
    }

    toggle() {
      if (this.audio.paused) return this.audio.play().catch(() => {});
      this.audio.pause();
    }

    next(manual) {
      const r = computeNextIndex(this.queue.length, this.index, this.mode, this.bag, !!manual);
      if (r.index < 0) return;
      if (r.replay) {                            // 单曲循环：原地重播
        this.audio.currentTime = 0;
        this.progress = 0;
        this.audio.play().catch(() => {});
        return;
      }
      this.play(r.index, true);
    }

    prev() {
      // 播过 5 秒就先回到本曲开头，这是主流播放器的习惯
      if (this.progress > 5) { this.audio.currentTime = 0; this.progress = 0; return; }
      if (!this.queue.length) return;
      const i = (this.index - 1 + this.queue.length) % this.queue.length;
      this.play(i, true);
    }

    seek(sec) {
      if (!isFinite(this.audio.duration)) return;
      this.audio.currentTime = clamp(Number(sec) || 0, 0, this.audio.duration);
      this.progress = this.audio.currentTime;
    }
    seekRatio(r) {
      if (!isFinite(this.audio.duration)) return;
      this.seek(clamp(Number(r) || 0, 0, 1) * this.audio.duration);
    }
    setVolume(v) {
      const vol = clamp(Number(v) || 0, 0, 1);
      this.audio.volume = vol;
      this.audio.muted = vol === 0;
      this.opts.volume = vol;
    }
  }

  /* ------------------------------------------------------------------------
   * 导出
   * ---------------------------------------------------------------------- */
  global.AdvancedPlayer = {
    // ① URL
    HOSTS, resolveAudioURL, describeURL,
    // ② ID3
    readID3, clearID3Cache, normalizeTags, fallbackFromFilename,
    parseID3v2, readNativeTags, readEmbeddedLyrics, readMediaMeta, parseMediaMeta,
    // ③ LRC
    parseLRC, activeIndex, loadLRC,
    // ④ 播放模式
    MODES, MODE_LABEL, ShuffleBag, computeNextIndex,
    // ⑤ 引擎
    PlayerEngine,
    // utils
    fmtSeconds, titleFromName,
  };
})(typeof window !== 'undefined' ? window : globalThis);
