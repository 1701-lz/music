#!/usr/bin/env node
/* =============================================================================
 *  generate-list.js  —  扫描本地 audio/ 目录，自动生成 manifest.json + list.js
 * -----------------------------------------------------------------------------
 *  零依赖，Node 14+ 直接跑：
 *
 *      node generate-list.js                  # 扫描 ./audio，写出两个清单
 *      node generate-list.js --watch         # 持续监听：往 audio/ 丢专辑就自动重建
 *      node generate-list.js --dry           # 只打印，不写文件
 *      node generate-list.js --dir=../music/audio
 *
 *  目录约定：
 *      audio/
 *        被禁忌的游戏/
 *          01.黑色信封.mp3  ...  Cover.jpg
 *        梵高先生/
 *          01.你离开了南京,从此没有人和我说话.mp3  ...  Cover.jpg
 *        meta.json               ← 可选，补充歌手 / 年份 / 歌名
 *
 *  ★ 清单里的 albumName 用文件夹名作「初始值 / 兜底」（不硬编码年份前缀、
 *    不猜歌手）。页面显示时优先读 MP3 元数据的 TALB / TPE1 / TYER 覆盖它。
 *    歌手默认取 meta.json 的 defaultArtist，没写就用 DEFAULT_ARTIST。
 *    年份只从文件夹名里的 4 位数字或 meta.json 取，取不到就留空。
 *
 *  ★ --watch 是「新增专辑自动出现」的可靠兜底：
 *    双击 watch-audio.bat 跑一次，之后不用再管；往 audio/ 里加文件夹，
 *    清单自动重建，刷新网页即可看到。刷新时页面会强制 no-store 读最新清单。
 *
 *  输出：
 *      manifest.json  { albums:[{ albumName, artist, year, folder, cover, tracks:[...] }] }
 *      list.js        扁平 JSON 数组 [{ name, artist, url, cover, size }, ...]
 *      两个文件内容同源，谁被页面先读到结果都一样。
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');

/* ------------------------------- 参数 ------------------------------------ */
const argv = process.argv.slice(2);
const opt = (name, def) => {
  const hit = argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.slice(name.length + 3) : def;
};
const ROOT = process.cwd();
const AUDIO_DIR = path.resolve(ROOT, opt('dir', 'audio'));
const OUT_MANIFEST = path.resolve(ROOT, opt('out', 'manifest.json'));
const OUT_LIST = path.resolve(ROOT, opt('outList', 'list.js'));
const DRY = argv.includes('--dry');
const WATCH = argv.includes('--watch');
const DEFAULT_ARTIST = '李志';

const AUDIO_EXT = /\.(mp3|flac|wav|m4a|aac|ogg|opus|ape|aiff?|wma)$/i;
const IMAGE_EXT = /\.(jpe?g|png|webp|gif|avif)$/i;
const LRC_EXT = /\.lrc$/i;
const COVER_NAME = /^(cover|folder|front|artwork|album)\.(jpe?g|png|webp|gif|avif)$/i;
const natural = new Intl.Collator('zh-Hans-CN', { numeric: true, sensitivity: 'base' });

/* ------------------------------ 工具函数 --------------------------------- */
function fmtBytes(n) {
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(1) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KB';
  return n + ' B';
}
function fmtFromName(name) {
  return ((name.match(AUDIO_EXT) || [, ''])[1] || '').toUpperCase();
}
function titleFromName(name) {
  const base = name.replace(/\.[^.]+$/, '');
  const m = base.match(/^\s*\d{1,3}\s*[.\-_ ]\s*(.+)$/);
  if (m && m[1].trim()) return m[1].trim().replace(/_/g, ' ');
  if (/^\s*\d+\s*$/.test(base)) return '音轨 ' + base.trim().padStart(2, '0');
  return base.replace(/_/g, ' ').trim() || name;
}
function yearFromFolder(folder) {
  const m = folder.match(/(?:19|20)\d{2}/);
  return m ? Number(m[0]) : '';
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/* 目录快照：给 --watch 判断「有没有新增 / 删改文件夹或文件」 */
function snapshot(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return '';
  const walk = (d, rel) => {
    let items;
    try { items = fs.readdirSync(d, { withFileTypes: true }); } catch (e) { return; }
    for (const it of items) {
      if (it.name.startsWith('.')) continue;
      const abs = path.join(d, it.name);
      const r = rel ? rel + '/' + it.name : it.name;
      if (it.isDirectory()) { out.push('D|' + r); walk(abs, r); }
      else {
        let st; try { st = fs.statSync(abs); } catch (e) { continue; }
        out.push('F|' + r + '|' + st.size + '|' + Math.floor(st.mtimeMs));
      }
    }
  };
  walk(dir, '');
  return out.sort().join('\n');
}

/* ------------------------------ 扫描 + 生成 -------------------------------- */
function generate() {
  if (!fs.existsSync(AUDIO_DIR)) {
    console.error('✗ 找不到目录：' + AUDIO_DIR);
    console.error('  请用 --dir=路径 指定 audio 目录，或先创建 audio/ 文件夹。');
    return false;
  }

  const meta = readJson(path.join(AUDIO_DIR, 'meta.json')) || {};
  const metaAlbums = meta.albums || {};
  const metaTracks = meta.tracks || {};
  const defaultArtist = meta.defaultArtist || DEFAULT_ARTIST;

  const folders = fs.readdirSync(AUDIO_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory() && !d.name.startsWith('.'))
    .map(d => d.name)
    .sort(natural.compare);

  const albums = [];
  const flat = [];
  let totalTracks = 0;

  for (const folder of folders) {
    const abs = path.join(AUDIO_DIR, folder);
    const files = fs.readdirSync(abs, { withFileTypes: true })
      .filter(f => f.isFile())
      .map(f => ({ name: f.name, size: fs.statSync(path.join(abs, f.name)).size }));

    const audio = files.filter(f => AUDIO_EXT.test(f.name)).sort((a, b) => natural.compare(a.name, b.name));
    if (!audio.length) { console.log('· 跳过（无音频）：' + folder); continue; }

    const coverFile = files.find(f => COVER_NAME.test(f.name)) || files.find(f => IMAGE_EXT.test(f.name));
    const lrcMap = new Map();
    files.filter(f => LRC_EXT.test(f.name)).forEach(f => lrcMap.set(f.name.replace(LRC_EXT, '').toLowerCase(), f.name));
    const ov = metaAlbums[folder] || {};
    const rel = p => ('audio/' + folder + '/' + p).replace(/\\/g, '/');

    const tracks = audio.map(f => {
      const key = folder + '/' + f.name;
      const tOv = metaTracks[key] || metaTracks[f.name] || {};
      const stem = f.name.replace(AUDIO_EXT, '').toLowerCase();
      const lrcFile = lrcMap.get(stem);
      return {
        title: tOv.title || titleFromName(f.name),
        file: rel(f.name),
        ...(lrcFile ? { lrc: rel(lrcFile) } : {}),
        duration: tOv.duration || '--:--',
        size: tOv.size || fmtBytes(f.size),
        format: (tOv.format || fmtFromName(f.name) || 'MP3').toUpperCase(),
      };
    });

    /* albumName 用文件夹名作初始值/兜底，显示名由页面读 MP3 元数据 TALB 覆盖 */
    const cover = ov.cover
      ? (String(ov.cover).includes('/') ? ov.cover : rel(ov.cover))
      : (coverFile ? rel(coverFile.name) : '');

    albums.push({
      albumName: folder,
      artist: ov.artist || defaultArtist,
      year: ov.year || yearFromFolder(folder) || '',
      folder,
      cover,
      tracks,
    });

    /* 兼容旧格式 list.js：artist 字段填文件夹名（页面仍按 url 里的目录分组） */
    for (const t of tracks) {
      flat.push({
        name: t.title,
        artist: folder,
        url: t.file,
        cover,
        size: t.size,
      });
    }
    totalTracks += tracks.length;
    console.log('✓ ' + folder + '  →  ' + tracks.length + ' 首' + (coverFile ? ' + 封面' : '（无封面）'));
  }

  if (!albums.length) {
    console.error('✗ 没有扫描到任何专辑。请确认 audio/ 下有「专辑文件夹/音频文件」两级结构。');
    return false;
  }

  const manifest = JSON.stringify({ albums }, null, 2) + '\n';
  const listText = JSON.stringify(flat, null, 2) + '\n';

  if (DRY) {
    console.log('\n--- 预览（未写入）---\n' + manifest.slice(0, 1400) + '\n...');
    return true;
  }
  fs.writeFileSync(OUT_MANIFEST, manifest, 'utf8');
  fs.writeFileSync(OUT_LIST, listText, 'utf8');
  const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  console.log(`  [${stamp}] ✓ ${path.relative(ROOT, OUT_MANIFEST)} + ${path.relative(ROOT, OUT_LIST)}` +
    `  （${albums.length} 张专辑 / ${totalTracks} 首）`);
  return true;
}

/* ------------------------------ 入口 -------------------------------------- */
if (WATCH) {
  if (DRY) { console.error('--watch 与 --dry 不能同时用'); process.exit(1); }
  console.log('正在监听：' + AUDIO_DIR);
  console.log('往 audio/ 里新增专辑文件夹（或删改文件），清单会自动重建；刷新网页即可看到。');
  console.log('按 Ctrl+C 停止。\n');
  generate();
  let last = snapshot(AUDIO_DIR);
  let debounce = null;
  const trigger = () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => {
      const now = snapshot(AUDIO_DIR);
      if (now !== last) { last = now; generate(); }
    }, 400);
  };
  /* fs.watch 在部分 Windows/Node 版本不支持 recursive，失败就靠下面的轮询 */
  try { fs.watch(AUDIO_DIR, { recursive: true }, trigger); } catch (e) { /* 忽略 */ }
  setInterval(() => {
    const now = snapshot(AUDIO_DIR);
    if (now !== last) { last = now; generate(); }
  }, 1500);
} else {
  const ok = generate();
  if (ok && !DRY) {
    console.log('\n刷新 index.html 即可看到最新曲库（页面会强制读最新清单，无需清缓存）。');
    console.log('想让「以后新增专辑自动出现」，双击 watch-audio.bat 或运行 node generate-list.js --watch');
  }
  if (!ok) process.exit(1);
}
