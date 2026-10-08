import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');

const mediaId = process.argv[2] || 'test-media-1';
const sourceMp4 = process.argv[3] || join(__dirname, 'test_sample.mp4');

if (!existsSync(sourceMp4)) {
  console.error(`Source MP4 not found at ${sourceMp4}`);
  process.exit(1);
}

// Target folder in dev/output-storage/output/videos/<mediaId>/
const outDir = join(ROOT, 'dev', 'output-storage', 'output', 'videos', mediaId);
mkdirSync(outDir, { recursive: true });

console.log(`🎬 Encoding ${sourceMp4} -> 360p / 720p / 1080p HLS in ${outDir}...`);

const ffmpegCmd = [
  'ffmpeg', '-hide_banner', '-loglevel', 'warning', '-y',
  '-i', `"${sourceMp4}"`,
  '-map', '0:v:0', '-map', '0:a:0',
  '-map', '0:v:0', '-map', '0:a:0',
  '-map', '0:v:0', '-map', '0:a:0',
  '-c:v:0', 'libx264', '-b:v:0', '800k', '-s:v:0', '640x360', '-c:a:0', 'aac', '-b:a:0', '96k',
  '-c:v:1', 'libx264', '-b:v:1', '2800k', '-s:v:1', '1280x720', '-c:a:1', 'aac', '-b:a:1', '128k',
  '-c:v:2', 'libx264', '-b:v:2', '5000k', '-s:v:2', '1920x1080', '-c:a:2', 'aac', '-b:a:2', '192k',
  '-var_stream_map', '"v:0,a:0,name:360p v:1,a:1,name:720p v:2,a:2,name:1080p"',
  '-f', 'hls',
  '-hls_time', '6',
  '-hls_playlist_type', 'vod',
  '-hls_segment_filename', `"${join(outDir, '%v', 'seg%d.ts')}"`,
  '-master_pl_name', 'master.m3u8',
  `"${join(outDir, '%v', 'index.m3u8')}"`,
].join(' ');

// Make sure target subdirs exist for ffmpeg segment writing
mkdirSync(join(outDir, '360p'), { recursive: true });
mkdirSync(join(outDir, '720p'), { recursive: true });
mkdirSync(join(outDir, '1080p'), { recursive: true });

execSync(ffmpegCmd, { stdio: 'inherit' });
console.log(`✅ HLS generation complete at ${outDir}`);
