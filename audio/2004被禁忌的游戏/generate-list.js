#!/usr/bin/env node
/* =============================================================================
 *  generate-list.js  —  扫描本地 audio/ 目录，自动生成 manifest.json
 * -----------------------------------------------------------------------------
 *  零依赖，Node 14+ 直接跑：
 *
 *      node generate-list.js                       # 扫描 ./audio，写出 ./manifest.json
 *      node generate-list.js --out=list.js        # 也可写成纯 JSON 的 list.js
 *      node generate-list.js --dry                # 只打印，不写文件
 *      node generate-list.js --dir=../music/audio
 *
 *  目录约定：
 *      audio/
 *        专辑A/
 *          1.mp3  2.mp3  ...  cover.jpg
 *        专辑B/
 *          01.flac  02.flac  cover.jpg
 *        meta.json               ← 可选，补充歌名/歌手/时长
 *
 *  输出是标准 manifest.json（纯 JSON，{ albums: [...] }），由页面 fetch 读取。
 *  之后每次往 GitHub 上传新专辑，重新跑一次本脚本（或用 GitHub Actions
 *  自动跑）再 push，刷新页面即可看到新专辑。
 *
 *  注意：浏览器无法读取音频时长，所以 duration 默认写 "--:--"，
 *  播放器在真正播放该曲目时会通过 <audio> 的 loadedmetadata 自动回填。
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
const OUT = path.resolve(ROOT, opt('out', 'manifest.json'));
const DRY = argv.includes('--dry');

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
function splitFolder(folder) {
  const m = folder.match(/^\s*(.{1,24}?)\s+[-–—]\s+(.+)$/);
  return m ? { artist: m[1].trim(), albumName: m[2].trim() } : { artist: '', albumName: folder };
}
function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (e) { return null; }
}

/* ------------------------------ 扫描目录 --------------------------------- */
if (!fs.existsSync(AUDIO_DIR)) {
  console.error('✗ 找不到目录：' + AUDIO_DIR);
  console.error('  请用 --dir=路径 指定 audio 目录，或先创建 audio/ 文件夹。');
  process.exit(1);
}

const meta = readJson(path.join(AUDIO_DIR, 'meta.json')) || {};
const metaAlbums = meta.albums || {};
const metaTracks = meta.tracks || {};
const defaultArtist = meta.defaultArtist || '未知歌手';

const folders = fs.readdirSync(AUDIO_DIR, { withFileTypes: true })
  .filter(d => d.isDirectory() && !d.name.startsWith('.'))
  .map(d => d.name)
  .sort(natural.compare);

const albums = [];
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
  const parsed = splitFolder(folder);
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

  albums.push({
    albumName: ov.albumName || parsed.albumName || folder,
    artist: ov.artist || parsed.artist || defaultArtist,
    year: ov.year || (folder.match(/(19|20)\d{2}/) || [''])[0] || '',
    cover: ov.cover
      ? (String(ov.cover).includes('/') ? ov.cover : rel(ov.cover))
      : (coverFile ? rel(coverFile.name) : ''),
    tracks,
  });
  totalTracks += tracks.length;
  console.log('✓ ' + folder + '  →  ' + tracks.length + ' 首' + (coverFile ? ' + 封面' : '（无封面）'));
}

if (!albums.length) {
  console.error('✗ 没有扫描到任何专辑。请确认 audio/ 下有「专辑文件夹/音频文件」两级结构。');
  process.exit(1);
}

/* ------------------------------ 输出文件 --------------------------------- */
/* 标准 manifest.json：纯 JSON，页面用 fetch 读取，不是 <script> 引入 */
const content = JSON.stringify({ albums }, null, 2) + '\n';

if (DRY) {
  console.log('\n--- 预览（未写入）---\n' + content.slice(0, 1200) + '\n...');
} else {
  fs.writeFileSync(OUT, content, 'utf8');
  console.log(`\n✓ 已写出 ${path.relative(ROOT, OUT)}  （${albums.length} 张专辑 / ${totalTracks} 首）`);
  console.log('  刷新 index.html 即可看到新曲库；若之前用的是 GitHub 数据源，');
  console.log('  记得加 ?refresh=1 清掉 localStorage 缓存。');
}
