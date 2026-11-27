/* =============================================================================
 *  data-source.js — 飞牛音乐 · 曲库数据接入层（真实数据版 / 零假数据）
 * -----------------------------------------------------------------------------
 *  这个文件里没有任何专辑、歌曲、歌词的假数据。所有内容都来自：
 *    1) 本地 audio/ 目录扫描（静态服务器返回目录列表时，新增专辑刷新即出现）
 *    2) 清单文件（manifest.json / list.js，由 generate-list.js 自动生成）
 *    3) GitHub REST API（Git Trees，一次请求自动发现 audio/ 下所有专辑）
 *    全都没有 → 返回 ok:false 并给出明确的排查指引，页面显示空状态，
 *    绝不会偷偷塞进预设专辑。
 *
 *  ★ 清单里的 albumName 只是「初始值 / 兜底」（取文件夹名，不硬编码年份前缀）。
 *    页面加载后会读每首 MP3 的 ID3 元数据，用 TALB 覆盖专辑名、TPE1 覆盖歌手、
 *    TYER/TDRC 覆盖年份 —— 显示名以歌曲元数据为准，读不到才用文件夹名。
 *
 *  数据源优先级（CONFIG.source = 'auto'）：
 *    本地预览：audio/ 目录扫描 → 清单 → 空状态（本地不拉 GitHub，避免旧数据覆盖新专辑）
 *    线上部署：GitHub API → 清单（两者按文件夹名合并，旧清单挡不住新专辑）
 *
 *  URL 参数（不改动文件就能调试）：
 *    ?list=xxx.json            指定清单文件
 *    ?source=list | github     强制只用某一种数据源（?source=list 可绕过目录扫描）
 *    ?assetHost=keep|local|raw|jsdelivr|github-media
 *    ?owner=xxx&repo=yyy&branch=main
 *    ?refresh=1                跳过缓存强制重拉
 * ========================================================================== */
(function (global) {
  'use strict';

  /* ===========================================================================
   *  0 / 配置 —— 已从你 list.js 的 jsDelivr 链接推断出仓库，通常无需再改
   * ======================================================================== */
  const CONFIG = {
    /* GitHub 仓库：从 https://cdn.jsdelivr.net/gh/1701-lz/music@main/... 推断 */
    owner: '1701-lz',
    repo: 'music',
    branch: 'main',
    audioDir: 'audio',

    /* 清单文件候选，按顺序探测，第一个能读到的生效。
       你的 list.js 是纯 JSON 数组：[{ name, artist, url, cover }, ...] —— 原生支持。 */
    listFiles: ['list.js', 'list (1).js', 'list.json', 'manifest.json', 'music.json'],
    listFile: '',                 // 也可用 ?list=xxx 指定单个文件

    /* ⚠️ Token：公开仓库的 GET 请求不需要 Token（60 次/小时/IP）。
       私有仓库或需要 5000 次/小时才用得到，但纯前端明文 Token 等于公开，
       任何人 View Source 就能拿到 —— 强烈建议改用仓库里的清单文件，
       或用 GitHub Actions 自动生成 manifest.json（见随包 workflow）。 */
    token: '',

    /* 资源地址策略（封面 / mp3 / .lrc）：
       'keep'         清单里已是绝对 URL（jsDelivr 等）：原样保留，只做幂等的
                      中文百分号编码。GitHub Pages 上最稳，不改动你的文件。
       'local'        全部转成同源相对路径 audio/专辑/cover.jpg（推荐同仓库部署）
       'raw'          https://raw.githubusercontent.com/owner/repo/branch/...
       'jsdelivr'     https://cdn.jsdelivr.net/gh/owner/repo@branch/...
                      （注意：单文件约 20MB 上限，无损 FLAC 可能 404）
       'github-media' https://media.githubusercontent.com/media/...（超大文件）
       也可填自定义前缀，如 'https://music.example.com/media' */
    assetHost: 'keep',
    audioHost: 'keep',            // 兼容旧调用名

    /* 你的 artist 字段存的实际是专辑名，没有歌手字段。
       想让卡片副标题统一显示歌手，在这里填（例如 '李志'），留空显示「未知歌手」。 */
    defaultArtist: '李志',

    source: 'auto',               // 'auto' | 'list' | 'github'
    cacheTTL: 5 * 60 * 1000,
    metaFile: 'meta.json',        // 可选：audio/meta.json 补齐歌名/时长等
  };

  /* URL 参数优先级高于 CONFIG */
  const QS = new URLSearchParams(global.location.search);
  ['owner', 'repo', 'branch', 'audioDir', 'listFile', 'token',
   'assetHost', 'audioHost', 'source'].forEach(k => {
    if (QS.get(k)) CONFIG[k] = QS.get(k);
  });
  if (QS.get('assetHost')) CONFIG.audioHost = QS.get('assetHost');
  /* 简写 ?list=xxx.json 等价于 ?listFile=xxx.json */
  if (QS.get('list')) CONFIG.listFile = QS.get('list');
  const FORCE_REFRESH = QS.get('refresh') === '1';

  const CACHE_KEY = 'fn-music:library:v2';
  const API = 'https://api.github.com';

  const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|opus|ape|aiff?|wma)$/i;
  const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
  const LRC_EXT = /\.lrc$/i;
  const COVER_NAME = /^(cover|folder|front|artwork|album)\.(jpe?g|png|webp|gif|avif)$/i;

  /* 图片加载失败时用的 CSS 渐变封面配色（不是假数据，只是兜底背景） */
  const SKINS = ['blue', 'sea', 'red', 'mono', 'white', 'paper', 'olive', 'dark', 'ink',
    'orange', 'charcoal', 'cream', 'pink', 'night', 'simple', 'scarlet', 'urban', 'purple'];
  const PALETTES = [
    ['#2f5f9e', '#0b1a33'], ['#8fb9cf', '#0a2438'], ['#e04a3c', '#210809'], ['#101010', '#050505'],
    ['#f0ede5', '#d9d5ca'], ['#e8dfc8', '#c6b99c'], ['#9c9679', '#3b392e'], ['#403a3e', '#161416'],
    ['#e9b45c', '#6d3c22'], ['#e0231d', '#a81813'], ['#3b4d8f', '#141833'], ['#8e3fa8', '#241033'],
  ];

  /* ===========================================================================
   *  1 / 工具函数
   * ======================================================================== */
  function hashId(str) {
    let h = 2166136261;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    return 'g' + (h >>> 0).toString(36);
  }
  function decodeName(s) { try { return decodeURIComponent(s); } catch (e) { return s; } }
  function escHTML(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  const natural = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });
  function encPath(p) {
    return String(p).replace(/^\/+/, '').split('/').map(encodeURIComponent).join('/');
  }

  /* ---------------------------------------------------------------------------
   *  中文路径修复（你特别问的「图片裂开 / 乱码」）
   * ---------------------------------------------------------------------------
   *  encodeURI 只编码中文、空格等非 ASCII 字符，保留 / : @ ? & = # —
   *  所以 jsDelivr 的 `@main` 不会被误编码成 `%40main`，路径不会坏掉。
   *  先 decodeURI 再 encodeURI 保证幂等：已经编码过的 %E8%BF... 不会被
   *  二次编码成 %25E8%25BF...（这是最常见的乱码来源）。
   * ------------------------------------------------------------------------- */
  function encodeAsset(u) {
    const s = String(u == null ? '' : u).trim();
    if (!s) return '';
    if (/^(data:|blob:|file:)/i.test(s)) return s;
    let decoded = s;
    try { decoded = decodeURI(s); } catch (e) { /* 含非法 % 序列则原样 */ }
    return encodeURI(decoded);
  }

  function stripLeading(p) {
    return String(p || '').replace(/^\.?\//, '').replace(/^\/+/, '');
  }

  /* 从 CDN 绝对链接里抽出仓库内相对路径 audio/专辑名/文件 */
  function extractRepoRel(u) {
    try {
      const path = new URL(u, global.location.href).pathname;
      const idx = path.indexOf('/' + CONFIG.audioDir + '/');
      return idx >= 0 ? path.slice(idx + 1) : '';
    } catch (e) { return ''; }
  }

  function buildURL(rel, host) {
    const enc = encodeAsset(stripLeading(rel));
    const ns = [CONFIG.owner, CONFIG.repo, CONFIG.branch].map(x => encodeURIComponent(String(x)));
    switch (host) {
      case 'raw':
        return `https://raw.githubusercontent.com/${ns[0]}/${ns[1]}/${ns[2]}/${enc}`;
      case 'jsdelivr':
        return `https://cdn.jsdelivr.net/gh/${ns[0]}/${ns[1]}@${ns[2]}/${enc}`;
      case 'github-media':
        return `https://media.githubusercontent.com/media/${ns[0]}/${ns[1]}/${ns[2]}/${enc}`;
      default:                                                  // 自定义前缀
        return String(host).replace(/\/+$/, '') + '/' + enc;
    }
  }

  /* 统一的资源地址解析：给 <img src> / <audio src> / fetch(.lrc) 用 */
  function resolveAsset(path) {
    const p = String(path == null ? '' : path).trim();
    if (!p) return '';
    if (/^(data:|blob:|file:)/i.test(p)) return p;
    const host = CONFIG.assetHost;

    if (/^https?:\/\//i.test(p)) {
      if (host === 'keep') return encodeAsset(p);              // 原样，只修中文编码
      const rel = extractRepoRel(p);
      if (host === 'local') return rel ? encodeAsset(rel) : encodeAsset(p);
      return buildURL(rel || p, host);
    }
    if (host === 'keep' || host === 'local') return encodeAsset(stripLeading(p));
    return buildURL(p, host);
  }
  /* 兼容旧调用名（GitHub 分组代码里沿用） */
  function rawURL(path) { return resolveAsset(path); }
  function audioURL(path) { return resolveAsset(path); }

  function fmtBytes(n) {
    n = Number(n) || 0;
    if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
    if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
    if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
    return n + ' B';
  }
  function fmtSeconds(sec) {
    sec = Math.max(0, Math.floor(Number(sec) || 0));
    return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
  }
  function parseDuration(str) {
    if (!str || str === '--:--') return 0;
    const m = String(str).trim().match(/^(\d+):([0-5]?\d)$/);
    return m ? Number(m[1]) * 60 + Number(m[2]) : 0;
  }
  function fmtFromName(name) {
    return ((String(name).match(AUDIO_EXT) || [, ''])[1] || '').toUpperCase();
  }
  /* 01.黑色信封.mp3 → 黑色信封；纯数字 → 音轨 01 */
  function titleFromName(name) {
    const base = String(name).replace(/\.[^.]+$/, '');
    const m = base.match(/^\s*\d{1,3}\s*[.\-_ ]\s*(.+)$/);
    if (m && m[1].trim()) return m[1].trim().replace(/_/g, ' ');
    if (/^\s*\d+\s*$/.test(base)) return '音轨 ' + base.trim().padStart(2, '0');
    return base.replace(/_/g, ' ').trim() || name;
  }
  /* ---------------------------------------------------------------------------
   *  从 audio/<文件夹>/<文件> 或 jsDelivr 绝对链接里抽出 <文件夹>。
   *  这里得到的是清单里的「初始专辑名 / 兜底名」：页面随后会用 MP3 元数据的
   *  TALB 覆盖显示名（见 index.html 的 primeLibraryMetadata）。
   *  好处是不硬编码、不猜歌手、不加年份前缀，新增专辑也能立刻有个正确兜底名。
   * ------------------------------------------------------------------------- */
  function folderFromPath(p) {
    if (!p) return '';
    const s = String(p).split('?')[0].split('#')[0];
    let pathname = s;
    try { pathname = new URL(s, global.location.href).pathname; } catch (e) { /* 相对路径原样 */ }
    const marker = '/' + CONFIG.audioDir + '/';
    const idx = pathname.indexOf(marker);
    const tail = idx >= 0 ? pathname.slice(idx + marker.length) : s.replace(/^\/+/, '');
    const parts = tail.split('/').filter(Boolean);
    return parts.length >= 2 ? decodeName(parts[0]) : '';
  }
  /* 只有本地预览才扫目录；线上走 GitHub API，避免远程旧数据盖住本地新增 */
  function isLocalHost() {
    const h = String(global.location.hostname || '').replace(/^\[|\]$/g, '');
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '' ||
      /^192\.168\./.test(h) || /^10\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h);
  }
  function isPlaceholder() {
    return !CONFIG.owner || !CONFIG.repo ||
      /^YOUR_/i.test(CONFIG.owner) || /^YOUR_/i.test(CONFIG.repo);
  }

  /* ===========================================================================
   *  2 / 数据模型归一化 —— 三种输入统一成 { albums: [...] }
   * ---------------------------------------------------------------------------
   *  A) 你的 list.js：扁平歌曲数组 [{ name, artist, url, cover }]
   *     按 artist 自动分组 → 专辑（artist 里存的是专辑名，尊重原数据）
   *  B) manifest.json：{ albums: [{ albumName, artist, cover, tracks: [...] }] }
   *  C) GitHub API：自动扫 audio/ 目录生成 B 的结构
   * ======================================================================== */
  /* 清单没写 lrc 时，按音频文件名自动推导同名 .lrc：
       01.黑色信封.mp3 → 01.黑色信封.lrc
     中文目录/文件名保持原样，后面 resolveAsset() 会统一做幂等编码。
     文件不存在时 fetch 会安静 404，页面自动回退到 MP3 内嵌歌词。 */
  function deriveLrc(file) {
    let f = String(file || '');
    const q = f.indexOf('?');
    if (q >= 0) f = f.slice(0, q);
    if (!/\.(mp3|flac|wav|m4a|aac|ogg|opus|ape|aiff?|wma)$/i.test(f)) return '';
    return f.replace(/\.[^.\/]+$/, '') + '.lrc';
  }

  function fromFlat(songs) {
    const groups = new Map();
    songs.forEach(s => {
      if (!s || typeof s !== 'object') return;
      const file = s.url || s.file || s.src || '';
      /* ★ 优先用 url 里的文件夹名当专辑名；只有拿不到才退回清单字段 */
      const albumName = folderFromPath(file) ||
        String(s.album || s.albumName || s.artist || '我的音乐').trim();
      if (!groups.has(albumName)) groups.set(albumName, { albumName, cover: '', tracks: [] });
      const g = groups.get(albumName);
      const cover = s.cover || s.picture || '';
      if (!g.cover && cover) g.cover = cover;
      g.tracks.push({
        title: s.title || s.name || titleFromName(file),
        file,
        artist: s.singer || s.songArtist || CONFIG.defaultArtist || '',
        album: albumName,
        duration: s.duration || '--:--',
        size: s.size || '—',
        format: (s.format || fmtFromName(file) || 'MP3').toUpperCase(),
        lrc: s.lrc || deriveLrc(file),
        cover: cover || g.cover,
      });
    });
    const albums = Array.from(groups.values()).map(g => ({
      albumName: g.albumName,
      artist: CONFIG.defaultArtist || '未知歌手',
      year: (String(g.albumName).match(/(19|20)\d{2}/) || [''])[0] || '',
      cover: g.cover,
      folder: g.albumName,
      tracks: g.tracks,
    }));
    return { albums, format: 'flat' };
  }

  function fromAlbums(list) {
    return {
      format: 'albums',
      albums: list.map(a => {
        const cover = a.cover || '';
        /* 初始专辑名取文件夹名（兜底，不硬编码年份前缀）；
           显示名稍后由 MP3 元数据 TALB 覆盖（primeLibraryMetadata）。 */
        const first = (a.tracks || [])[0] || {};
        const folder = a.folder ||
          folderFromPath(cover) || folderFromPath(first.file || first.url || '') || '';
        const albumName = folder || a.albumName || a.title || a.name || '未命名专辑';
        return {
          albumName,
          artist: a.artist || CONFIG.defaultArtist || '未知歌手',
          year: a.year || '',
          cover,
          folder: folder || albumName,
          tracks: (a.tracks || []).map(t => ({
            title: t.title || titleFromName(t.file || t.url || ''),
            file: t.file || t.url || '',
            artist: t.artist || a.artist || '',
            album: t.album || albumName,
            duration: t.duration || '--:--',
            size: t.size || '—',
            format: (t.format || fmtFromName(t.file || t.url || '') || 'MP3').toUpperCase(),
            lrc: t.lrc || deriveLrc(t.file || t.url || ''),
            cover: t.cover || cover,
          })),
        };
      }),
    };
  }

  function normalize(raw) {
    if (Array.isArray(raw)) return fromFlat(raw);                       // 你的 list.js
    if (raw && Array.isArray(raw.albums)) return fromAlbums(raw.albums); // manifest.json
    if (raw && Array.isArray(raw.tracks)) return fromFlat(raw.tracks);
    if (raw && Array.isArray(raw.songs)) return fromFlat(raw.songs);
    return null;
  }

  /* 宽容解析：纯 JSON / window.XXX = [...] / 带 BOM 或注释尾分号 */
  function parseLoose(text) {
    const s = String(text).replace(/^\uFEFF/, '').trim();
    if (!s) return null;
    try { return JSON.parse(s); } catch (e) { /* 继续尝试 */ }
    const stripped = s
      .replace(/^\s*(?:window|globalThis|var|let|const)\s*\.?\s*[\w$]+\s*=\s*/m, '')
      .replace(/;\s*$/, '')
      .trim();
    if (stripped !== s) {
      try { return JSON.parse(stripped); } catch (e) { /* 继续 */ }
    }
    try { return new Function('return (' + s + ');')(); } catch (e) { /* 放弃 */ }
    return null;
  }

  /* 逐候选探测清单文件；fetch 而不是 <script src>，因为你的文件是纯 JSON */
  async function loadList(force) {
    const files = CONFIG.listFile ? [CONFIG.listFile] : CONFIG.listFiles;
    const tried = [];
    if (/^file:/i.test(global.location.href)) {
      throw new Error('当前是 file:// 双击打开，浏览器禁止 fetch 本地文件。请用本地服务器预览：在仓库目录运行 python -m http.server 8000，再打开 http://localhost:8000');
    }
    for (const f of files) {
      try {
        const url = encodeAsset(f) + (force ? '?_=' + Date.now() : '');
        const res = await fetch(url, { cache: force ? 'no-store' : 'default' });
        if (!res.ok) { tried.push(f + ' → HTTP ' + res.status); continue; }
        const parsed = normalize(parseLoose(await res.text()));
        if (parsed && parsed.albums.length) {
          return { albums: parsed.albums, file: f, format: parsed.format };
        }
        tried.push(f + ' → 格式无法识别');
      } catch (e) { tried.push(f + ' → ' + (e && e.message ? e.message : e)); }
    }
    throw new Error('未找到可用的清单文件（已尝试：' + files.join('、') + '）' +
      (tried.length ? '。明细：' + tried.join('；') : ''));
  }

  /* ===========================================================================
   *  3 / GitHub REST —— 一次请求拿全树（自动发现 audio/ 下新增的专辑文件夹）
   * ======================================================================== */
  class RateLimitError extends Error {
    constructor(resetAt) { super('GitHub API 调用次数已用完'); this.name = 'RateLimitError'; this.resetAt = resetAt; }
  }
  let lastRateInfo = { remaining: null, limit: null, reset: null };

  async function ghFetch(url, extraHeaders) {
    const headers = Object.assign({
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
    }, extraHeaders || {});
    if (CONFIG.token) headers['Authorization'] = 'Bearer ' + CONFIG.token;
    let res;
    try {
      res = await fetch(url, { headers, mode: 'cors', cache: 'no-store' });
    } catch (err) {
      throw new Error('网络请求失败：' + (err && err.message ? err.message : err));
    }
    const rem = res.headers.get('x-ratelimit-remaining');
    if (rem !== null) {
      lastRateInfo = {
        remaining: Number(rem),
        limit: Number(res.headers.get('x-ratelimit-limit') || 0),
        reset: Number(res.headers.get('x-ratelimit-reset') || 0) * 1000,
      };
    }
    if (res.status === 304) return { notModified: true, res };
    if (res.status === 403 || res.status === 429 || (rem !== null && Number(rem) === 0)) {
      throw new RateLimitError(lastRateInfo.reset);
    }
    if (!res.ok) {
      let msg = res.status + ' ' + res.statusText;
      try { const j = await res.json(); if (j && j.message) msg += ' — ' + j.message; } catch (e) { }
      throw new Error('GitHub API ' + msg);
    }
    return { notModified: false, data: await res.json(), etag: res.headers.get('etag') || '', res };
  }

  const repoBase = () => `${API}/repos/${encodeURIComponent(CONFIG.owner)}/${encodeURIComponent(CONFIG.repo)}`;

  async function loadMeta(hasMetaFile) {
    if (!hasMetaFile) return null;
    try {
      const res = await fetch(resolveAsset(`${CONFIG.audioDir}/${CONFIG.metaFile}`), { cache: 'no-store' });
      return res.ok ? await res.json() : null;
    } catch (e) { return null; }
  }

  function buildFromTree(tree) {
    const prefix = CONFIG.audioDir.replace(/^\/+|\/+$/g, '') + '/';
    const groups = new Map();
    let hasMetaFile = false;
    for (const e of tree) {
      if (!e || e.type !== 'blob' || typeof e.path !== 'string') continue;
      if (e.path.indexOf(prefix) !== 0) continue;
      const rest = e.path.slice(prefix.length);
      if (!rest) continue;
      if (rest === CONFIG.metaFile) { hasMetaFile = true; continue; }
      const parts = rest.split('/');
      if (parts.length < 2) continue;
      const folder = parts.slice(0, -1).join('/');
      const file = parts[parts.length - 1];
      if (!groups.has(folder)) groups.set(folder, { audio: [], cover: '', lrc: new Map() });
      const g = groups.get(folder);
      if (AUDIO_EXT.test(file)) g.audio.push({ name: file, path: e.path, size: e.size || 0 });
      else if (LRC_EXT.test(file)) g.lrc.set(file.replace(LRC_EXT, '').toLowerCase(), e.path);
      else if (COVER_NAME.test(file) || IMAGE_EXT.test(file)) {
        if (!g.cover || COVER_NAME.test(file)) g.cover = e.path;
      }
    }
    return { groups, hasMetaFile };
  }

  function groupsToAlbums(groups, meta) {
    const metaAlbums = (meta && meta.albums) || {};
    const metaTracks = (meta && meta.tracks) || {};
    const defaultArtist = (meta && meta.defaultArtist) || CONFIG.defaultArtist || '未知歌手';
    const albums = [];
    for (const [folder, g] of groups) {
      if (!g.audio.length) continue;
      g.audio.sort((a, b) => natural.compare(a.name, b.name));
      const ov = metaAlbums[folder] || metaAlbums[decodeName(folder)] || {};
      /* 初始专辑名 = 最后一级文件夹名（不拆「歌手 - 专辑」、不加年份前缀），
         作为兜底；显示名稍后由 MP3 元数据 TALB 覆盖。meta.json 可补歌手/年份。 */
      const albumName = decodeName(folder.split('/').pop() || folder);
      const artist = ov.artist || defaultArtist;
      const cover = ov.cover
        ? (String(ov.cover).indexOf('/') >= 0 ? ov.cover : `${CONFIG.audioDir}/${folder}/${ov.cover}`)
        : g.cover;
      const tracks = g.audio.map(f => {
        const key = `${folder}/${f.name}`;
        const tOv = metaTracks[key] || metaTracks[f.name] || {};
        const stem = f.name.replace(AUDIO_EXT, '').toLowerCase();
        const lrcPath = g.lrc && g.lrc.get(stem);
        return {
          title: tOv.title || titleFromName(f.name),
          file: resolveAsset(f.path),
          lrc: lrcPath ? resolveAsset(lrcPath)
             : (tOv.lrc ? resolveAsset(tOv.lrc) : resolveAsset(deriveLrc(f.path))),
          duration: tOv.duration || '--:--',
          /* 目录扫描拿不到文件属性时不要写 '0 B'（误导），留占位由前端读文件头补齐 */
          size: tOv.size || (f.size > 0 ? fmtBytes(f.size) : '—'),
          format: (tOv.format || fmtFromName(f.name) || 'MP3').toUpperCase(),
        };
      });
      albums.push({
        albumName, artist,
        year: ov.year || (String(folder).match(/(19|20)\d{2}/) || [''])[0] || '',
        cover: cover ? resolveAsset(cover) : '',
        folder, tracks,
      });
    }
    albums.sort((a, b) => natural.compare(a.folder, b.folder));
    return albums;
  }

  async function loadViaContents() {
    const base = repoBase();
    const ref = '?ref=' + encodeURIComponent(CONFIG.branch);
    const root = await ghFetch(`${base}/contents/${encPath(CONFIG.audioDir)}${ref}`);
    const dirs = (root.data || []).filter(e => e.type === 'dir');
    const groups = new Map();
    let hasMetaFile = false;
    for (const d of dirs) {
      const r = await ghFetch(`${base}/contents/${encPath(d.path)}${ref}`);
      const bucket = { audio: [], cover: '', lrc: new Map() };
      (r.data || []).forEach(e => {
        if (e.type !== 'file') return;
        if (e.name === CONFIG.metaFile) { hasMetaFile = true; return; }
        if (AUDIO_EXT.test(e.name)) bucket.audio.push({ name: e.name, path: e.path, size: e.size || 0 });
        else if (LRC_EXT.test(e.name)) bucket.lrc.set(e.name.replace(LRC_EXT, '').toLowerCase(), e.path);
        else if (COVER_NAME.test(e.name) || IMAGE_EXT.test(e.name)) {
          if (!bucket.cover || COVER_NAME.test(e.name)) bucket.cover = e.path;
        }
      });
      if (bucket.audio.length) groups.set(d.path.split('/').slice(1).join('/'), bucket);
    }
    return groupsToAlbums(groups, await loadMeta(hasMetaFile));
  }

  async function loadFromGithub(force) {
    if (isPlaceholder()) throw new Error('尚未配置 GitHub owner / repo');
    const base = repoBase();
    const cache = (force || FORCE_REFRESH) ? null : readCache();
    /* 条件请求问「仓库变了吗」，304 不计入限流额度 */
    const commitRes = await ghFetch(
      `${base}/commits/${encodeURIComponent(CONFIG.branch)}`,
      (cache && cache.commitEtag) ? { 'If-None-Match': cache.commitEtag } : {}
    );
    if (commitRes.notModified && cache && cache.payload && cache.payload.length) {
      return { albums: cache.payload, fromCache: true };
    }
    const commit = commitRes.data;
    const treeSha = commit && commit.commit && commit.commit.tree && commit.commit.tree.sha;
    if (!treeSha) throw new Error('无法解析 commit.tree.sha');
    const treeRes = await ghFetch(
      `${base}/git/trees/${encodeURIComponent(treeSha)}?recursive=1`,
      (cache && cache.treeSha === treeSha && cache.treeEtag) ? { 'If-None-Match': cache.treeEtag } : {}
    );
    if (treeRes.notModified && cache && cache.payload && cache.payload.length) {
      writeCache(Object.assign({}, cache, { commitEtag: commitRes.etag || cache.commitEtag, ts: Date.now() }));
      return { albums: cache.payload, fromCache: true };
    }
    const tree = treeRes.data;
    let albums;
    if (tree && tree.truncated) {
      albums = await loadViaContents();
    } else {
      const built = buildFromTree((tree && tree.tree) || []);
      albums = groupsToAlbums(built.groups, await loadMeta(built.hasMetaFile));
    }
    writeCache({
      commitEtag: commitRes.etag || '', treeSha: treeSha || '',
      treeEtag: treeRes.etag || '', ts: Date.now(), payload: albums,
    });
    return { albums, fromCache: false };
  }

  /* ===========================================================================
   *  3.5 / 本地目录自动发现 —— 新增专辑「刷新即出现」
   * ---------------------------------------------------------------------------
   *  浏览器不能自己枚举本地目录，但静态服务器访问 audio/ 时通常会返回目录
   *  列表 HTML（python -m http.server、nginx autoindex、Apache、部分 Live Server
   *  配置）。这里解析它拿到专辑文件夹，再逐个读子目录拿音频 / 封面 / .lrc，
   *  完全绕过静态清单 —— 往 audio/ 里丢一个新文件夹，刷新页面就会多一张专辑。
   *  专辑名一律取文件夹名。服务器不给列目录时安静返回 null，回退到清单
   *  （清单由 watch-audio.bat 自动重建，同样不需要手工改文件）。
   * ========================================================================== */
  function entryName(e) {
    let h = String(e.href || '').replace(/\/+$/, '');
    try { h = decodeURIComponent(h); } catch (err) { /* 保留原样 */ }
    let n = h.split('/').pop();
    if (!n || n === '..' || n === '.') n = String(e.name || '').replace(/\/+$/, '');
    return (n || '').replace(/^\/+/, '');
  }
  function isJunkEntry(e) {
    const h = String(e.href || '');
    if (!h || h === '/' || h.startsWith('..') || h.indexOf('/../') >= 0 ||
        h.startsWith('?') || h.startsWith('#') ||
        /^(https?:|javascript:|mailto:)/i.test(h)) return true;
    /* Apache / nginx 的绝对路径链接，只允许指向 audio/ 内部 */
    if (h.startsWith('/') && h.indexOf('/' + CONFIG.audioDir + '/') !== 0) return true;
    const n = entryName(e);
    return !n || n === '..' || n === '.' || n.startsWith('.') ||
      n === CONFIG.audioDir || n.toLowerCase() === 'parent directory';
  }
  async function fetchDirIndex(url) {
    let res;
    try { res = await fetch(url, { cache: 'no-store' }); }
    catch (e) { return null; }
    if (!res.ok) return null;
    const ct = res.headers.get('content-type') || '';
    const text = await res.text();
    /* JSON 形式的目录索引（部分 dev server 返回 [{name,type}]） */
    if (/json/i.test(ct)) {
      try {
        const j = JSON.parse(text);
        const arr = Array.isArray(j) ? j : (j.files || j.entries || j.items || []);
        if (Array.isArray(arr) && arr.length) {
          return arr.map(x => ({
            name: String(x.name || x.path || ''),
            href: String(x.name || x.path || ''),
            isDir: !!(x.isDir || x.isDirectory || x.type === 'dir' || x.type === 'directory'),
          })).filter(x => x.name);
        }
      } catch (err) { /* 继续按 HTML 解析 */ }
    }
    if (!/html/i.test(ct) && !/<a\s/i.test(text)) return null;
    const doc = new global.DOMParser().parseFromString(text, 'text/html');
    return Array.from(doc.querySelectorAll('a[href]')).map(a => {
      const href = a.getAttribute('href') || '';
      const label = (a.textContent || '').trim();
      return {
        name: label.replace(/\/+$/, ''),
        href,
        isDir: /\/$/.test(href) || /\/$/.test(label),
      };
    });
  }
  async function loadFromLocalIndex() {
    if (!isLocalHost()) return null;
    const base = CONFIG.audioDir.replace(/^\/+|\/+$/g, '') + '/';
    const top = await fetchDirIndex(encodeAsset(base));
    if (!top) return null;

    const dirs = [];
    for (const e of top) {
      if (isJunkEntry(e)) continue;
      /* 带斜杠的当作目录；没有文件扩展名的也当目录候选（兼容不写斜杠的服务器） */
      const looksFile = /\.[a-z0-9]{1,6}$/i.test(e.href || '');
      if (!e.isDir && looksFile) continue;
      const name = entryName(e);
      if (!name || name === CONFIG.audioDir || dirs.indexOf(name) >= 0) continue;
      dirs.push(name);
    }
    if (!dirs.length) return null;

    const groups = new Map();
    let hasMetaFile = false;
    for (const dirName of dirs) {
      const rel = base + dirName + '/';
      const entries = await fetchDirIndex(encodeAsset(rel));
      if (!entries) continue;                       // 服务器不给子目录列表 → 跳过
      const bucket = { audio: [], cover: '', lrc: new Map() };
      for (const f of entries) {
        if (isJunkEntry(f)) continue;
        const fname = entryName(f);
        if (!fname) continue;
        if (fname === CONFIG.metaFile) { hasMetaFile = true; continue; }
        const p = rel + fname;
        if (AUDIO_EXT.test(fname)) bucket.audio.push({ name: fname, path: p, size: 0 });
        else if (LRC_EXT.test(fname)) bucket.lrc.set(fname.replace(LRC_EXT, '').toLowerCase(), p);
        else if (COVER_NAME.test(fname) || IMAGE_EXT.test(fname)) {
          if (!bucket.cover || COVER_NAME.test(fname)) bucket.cover = p;
        }
      }
      if (bucket.audio.length) groups.set(dirName, bucket);
    }
    if (!groups.size) return null;
    return groupsToAlbums(groups, await loadMeta(hasMetaFile));
  }
  /* 按文件夹名合并去重：primary（目录扫描 / GitHub）覆盖同名，secondary 补遗漏 */
  function mergeAlbums(primary, secondary) {
    const map = new Map();
    (secondary || []).forEach(a => map.set(String(a.folder || a.albumName), a));
    (primary || []).forEach(a => map.set(String(a.folder || a.albumName), a));
    return Array.from(map.values())
      .sort((a, b) => natural.compare(String(a.folder || ''), String(b.folder || '')));
  }

  /* ===========================================================================
   *  4 / 归一化：外部模型 → 页面内部模型
   * ======================================================================== */
  function toInternal(albums, source) {
    const outAlbums = [];
    const tracklists = {};
    (albums || []).forEach((a, ai) => {
      const id = a.id || hashId(a.folder || a.albumName || String(ai));
      const h = Math.abs([...id].reduce((n, c) => (n * 31 + c.charCodeAt(0)) >>> 0, 7));
      const pal = PALETTES[h % PALETTES.length];
      const cover = {
        skin: SKINS[h % SKINS.length], c1: pal[0], c2: pal[1], ink: '#ffffff',
        kicker: '', title: '', foot: '', extra: '',
        url: a.cover || '',                       // ← 真实封面地址
      };
      const tracks = (a.tracks || []).map((t, ti) => {
        const duration = t.duration || '--:--';
        return {
          id: id + '-t' + (ti + 1), no: ti + 1,
          title: t.title || titleFromName(t.file || ''),
          artist: t.artist || a.artist || '未知歌手',
          album: t.album || a.albumName || '',
          sec: parseDuration(duration),
          duration,
          size: t.size || '—',
          format: (t.format || fmtFromName(t.file || '') || 'MP3').toUpperCase(),
          file: t.file || '',
          lrc: t.lrc || '',
          liked: false,
          albumId: id,
          cover,
        };
      });
      outAlbums.push({
        id,
        title: a.albumName || a.title || a.name || ('专辑 ' + (ai + 1)),
        artist: a.artist || '未知歌手',
        year: a.year || '',
        count: tracks.length,
        cover,
        folder: a.folder || '',
      });
      tracklists[id] = tracks;
    });
    return { albums: outAlbums, tracklists, source: source || 'list' };
  }

  /* ===========================================================================
   *  5 / 动态渲染 —— 页面 HTML 里只有一个空容器，卡片全部在这里生成
   * ======================================================================== */
  function asEl(container) {
    return typeof container === 'string' ? global.document.querySelector(container) : container;
  }

  function coverNode(cv) {
    cv = cv || {};
    const box = global.document.createElement('div');
    box.className = 'cv cv--' + (cv.skin || 'blue');
    box.style.cssText = `--c1:${cv.c1 || '#2a5fa8'};--c2:${cv.c2 || '#0a1730'};--ink:${cv.ink || '#ffffff'}`;
    const art = global.document.createElement('div');
    art.className = 'cv__art';
    box.appendChild(art);
    if (cv.url) {
      const img = global.document.createElement('img');
      img.className = 'cv__img';
      img.alt = '';
      img.loading = 'lazy';
      img.src = cv.url;
      /* 封面裂开时移除自己，底层 CSS 渐变封面无缝接管 —— 不留破图 */
      img.addEventListener('error', () => img.remove());
      box.appendChild(img);
    } else if (cv.title) {
      const t = global.document.createElement('span');
      t.className = 'cv__title';
      t.textContent = cv.title;
      box.appendChild(t);
    }
    return box;
  }

  /** 把真实专辑数据渲染进空容器；返回渲染数量 */
  function renderAlbums(albums, container) {
    const root = asEl(container);
    if (!root) return 0;
    const frag = global.document.createDocumentFragment();
    const list = albums || [];
    list.forEach((a, i) => {
      const card = global.document.createElement('article');
      card.className = 'album-card';
      card.setAttribute('data-action', 'open-album');
      card.setAttribute('data-id', a.id);
      card.setAttribute('tabindex', '0');
      card.setAttribute('role', 'button');
      card.setAttribute('aria-label', '打开专辑 ' + (a.title || ''));
      card.style.setProperty('--i', i);

      const wrap = global.document.createElement('div');
      wrap.className = 'cover-wrap';
      wrap.appendChild(coverNode(a.cover));

      const badge = global.document.createElement('span');
      badge.className = 'card-badge num';
      badge.textContent = String(a.count != null ? a.count : 0);
      wrap.appendChild(badge);

      const play = global.document.createElement('button');
      play.className = 'card-play';
      play.setAttribute('data-action', 'play-album');
      play.setAttribute('data-id', a.id);
      play.title = '播放 ' + (a.title || '');
      play.innerHTML = '<svg class="ic"><use href="#i-play"/></svg>';
      wrap.appendChild(play);
      card.appendChild(wrap);

      const title = global.document.createElement('div');
      title.className = 'card-title';
      title.textContent = a.title || '';
      const artist = global.document.createElement('div');
      artist.className = 'card-artist';
      artist.textContent = a.artist || '';
      card.appendChild(title);
      card.appendChild(artist);
      frag.appendChild(card);
    });
    root.replaceChildren(frag);
    return list.length;
  }

  /** 加载中占位（容器里没有任何假卡片） */
  function renderLoading(container) {
    const root = asEl(container);
    if (!root) return;
    root.innerHTML = '<div class="empty"><h3>正在读取曲库…</h3><p>正在从清单文件 / GitHub 仓库获取你的真实音乐。</p></div>';
  }

  /** 空状态 + 明确排查指引；绝不显示预设专辑 */
  function renderEmpty(container, info) {
    const root = asEl(container);
    if (!root) return;
    const reason = escHTML((info && info.reason) || '未找到可用的数据源');
    const detail = (info && info.reasons || []).map(escHTML).join('<br>');
    root.innerHTML = `
      <div class="empty">
        <svg class="ic" style="width:42px;height:42px"><use href="#i-empty"/></svg>
        <h3>还没有读到你的音乐</h3>
        <p>${reason}</p>
        ${detail ? `<p style="opacity:.65;font-size:12px;line-height:1.8">${detail}</p>` : ''}
        <div style="text-align:left;max-width:520px;margin:18px auto 0;padding:16px 18px;
                    border:1px solid rgba(255,255,255,.12);border-radius:12px;
                    font-size:13px;line-height:2;color:rgba(255,255,255,.75)">
          <b style="color:#fff">三步排查（新增专辑读不出来时看这里）</b><br>
          1. 确认 <code>audio/</code> 下是「专辑文件夹 / 音频文件」两级结构；
             显示用的专辑名读 MP3 元数据 <code>TALB</code>，读不到才用文件夹名兜底。<br>
          2. 在项目目录运行 <code>node generate-list.js</code> 重建 <code>manifest.json</code> +
             <code>list.js</code>；想让以后新增专辑自动出现，双击 <code>watch-audio.bat</code>。<br>
          3. 用本地服务器打开（<code>python -m http.server 8000</code> → <code>http://localhost:8000</code>），
             别用 <code>file://</code> 双击；支持列目录的服务器会自动扫描 <code>audio/</code>。<br>
          部署到 GitHub Pages 后由 GitHub API 自动发现新专辑，无需改清单；
          也可用 <code>?source=list</code> / <code>?list=manifest.json</code> 指定数据源。
        </div>
        <button class="ghost-btn" data-action="refresh-library" style="margin-top:14px">重新同步</button>
      </div>`;
  }

  /* ===========================================================================
   *  6 / 缓存
   * ======================================================================== */
  function readCache() {
    try {
      const c = JSON.parse(global.localStorage.getItem(CACHE_KEY));
      if (!c || !c.payload) return null;
      if (CONFIG.cacheTTL > 0 && Date.now() - (c.ts || 0) > CONFIG.cacheTTL) return null;
      return c;
    } catch (e) { return null; }
  }
  function writeCache(c) {
    try { global.localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch (e) { /* 隐私模式 */ }
  }
  function clearCache() { try { global.localStorage.removeItem(CACHE_KEY); } catch (e) { } }

  /* ===========================================================================
   *  7 / 对外入口 load()
   * ---------------------------------------------------------------------------
   *  永不 reject；ok=false 时页面显示空状态 + 配置指引，绝不回退到假数据。
   * ======================================================================== */
  function okResult(r, source, fromCache, reasons) {
    /* 统一把 cover / file / lrc 过一遍路径修复（中文编码 / host 策略） */
    const albums = (r.albums || []).map(a => Object.assign({}, a, {
      cover: resolveAsset(a.cover),
      tracks: (a.tracks || []).map(t => Object.assign({}, t, {
        file: resolveAsset(t.file),
        lrc: resolveAsset(t.lrc),
        cover: resolveAsset(t.cover),
      })),
    }));
    return {
      ok: true,
      albums,
      internal: toInternal(albums, source),
      source,
      fromCache: !!fromCache,
      count: albums.length,
      listFile: r.file || '',
      format: r.format || source,
      reason: (reasons && reasons.length ? reasons.join('；') + ' → ' : '') +
        (source === 'github' ? 'GitHub API'
          : source === 'scan' ? '本地目录扫描 ' + (r.file || '')
          : '清单文件 ' + (r.file || '')),
      reasons: reasons || [],
    };
  }
  function failResult(reasons) {
    return {
      ok: false, albums: [], internal: null, source: 'empty',
      count: 0, fromCache: false,
      reason: reasons.length ? reasons.join('；') : '没有找到任何真实音乐数据',
      reasons,
    };
  }

  async function load(opts) {
    /* 本地一律 no-store：watch-audio.bat 重建清单后，刷新页面就是最新曲库 */
    const force = !!(opts && opts.force) || FORCE_REFRESH || isLocalHost();
    const mode = (CONFIG.source || 'auto').toLowerCase();
    const local = isLocalHost();
    const reasons = [];
    let listAlbums = [], listFile = '', listFormat = 'albums';

    /* ① 读清单（永远先读，作为目录扫描失败时的兜底 / 线上合并素材） */
    if (mode === 'list' || mode === 'auto') {
      try {
        const r = await loadList(force);
        if (r.albums.length) {
          listAlbums = r.albums; listFile = r.file; listFormat = r.format;
        } else reasons.push('清单文件里没有专辑');
      } catch (err) {
        reasons.push('清单：' + (err && err.message ? err.message : err));
      }
      if (mode === 'list') {
        return listAlbums.length
          ? okResult({ albums: listAlbums, file: listFile, format: listFormat }, 'list', false, reasons)
          : failResult(reasons);
      }
    }

    /* ② 本地预览：先扫描真实 audio/ 目录 —— 新增专辑刷新即出现。
          失败才回退清单。本地不调 GitHub API：远程仓库通常还没 push 你
          刚加的文件夹，拉回旧数据反而会把新专辑盖掉。 */
    if (local && mode === 'auto') {
      try {
        const scanned = await loadFromLocalIndex();
        if (scanned && scanned.length) {
          const merged = mergeAlbums(scanned, listAlbums);
          return okResult({ albums: merged, file: CONFIG.audioDir + '/ 目录', format: 'albums' },
            'scan', false, reasons);
        }
        reasons.push('服务器未开放列目录（可用 watch-audio.bat 自动重建清单）');
      } catch (err) {
        reasons.push('目录扫描：' + (err && err.message ? err.message : err));
      }
      if (listAlbums.length) {
        return okResult({ albums: listAlbums, file: listFile, format: listFormat },
          'list', false, reasons);
      }
      return failResult(reasons);
    }

    /* ③ 线上：GitHub API 优先（自动发现仓库里新增的专辑文件夹），清单兜底。
          两者按文件夹名合并去重，过期的清单不会再挡住线上新专辑。 */
    if (mode === 'github' || mode === 'auto') {
      if (isPlaceholder()) {
        reasons.push('GitHub owner / repo 未配置');
      } else {
        try {
          const r = await loadFromGithub(force);
          if (!r.albums.length) throw new Error(`${CONFIG.audioDir}/ 下没有发现任何专辑文件夹`);
          const merged = listAlbums.length ? mergeAlbums(r.albums, listAlbums) : r.albums;
          const out = okResult({ albums: merged, format: 'albums' }, 'github', r.fromCache, reasons);
          out.fromCache = r.fromCache;
          return out;
        } catch (err) {
          reasons.push(err instanceof RateLimitError
            ? 'GitHub API 限流' + (err.resetAt ? '（约 ' + new Date(err.resetAt).toLocaleTimeString('zh-CN') + ' 恢复）' : '')
            : 'GitHub：' + (err && err.message ? err.message : err));
        }
      }
    }

    if (listAlbums.length) {
      return okResult({ albums: listAlbums, file: listFile, format: listFormat },
        'list', false, reasons);
    }
    return failResult(reasons);   // ← 关键：不返回任何假数据
  }

  /* ===========================================================================
   *  8 / 导出
   * ======================================================================== */
  global.MusicDataSource = {
    CONFIG, load, toInternal, normalize, resolveAsset, encodeAsset,
    rawURL, audioURL,
    renderAlbums, renderEmpty, renderLoading,
    fmtSeconds, parseDuration, fmtBytes, titleFromName,
    folderFromPath, isLocalHost, loadFromLocalIndex, mergeAlbums,
    clearCache,
    get rateInfo() { return lastRateInfo; },
    _debug: { parseLoose, fromFlat, fromAlbums, buildFromTree, groupsToAlbums,
      isPlaceholder, entryName, isJunkEntry },
  };
})(window);
