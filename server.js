import { createReadStream, existsSync } from 'node:fs';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, normalize } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 4173);
const YT_DLP = process.env.YT_DLP_PATH || 'yt-dlp';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const jobs = new Map();

const qualityProfiles = {
  best: { label: '最佳画质', format: 'bv*+ba/b', args: ['--merge-output-format', 'mp4'] },
  '1080': { label: '1080p', format: 'bv*[height<=1080]+ba/b[height<=1080]/b', args: ['--merge-output-format', 'mp4'] },
  '720': { label: '720p', format: 'bv*[height<=720]+ba/b[height<=720]/b', args: ['--merge-output-format', 'mp4'] },
  '480': { label: '480p', format: 'bv*[height<=480]+ba/b[height<=480]/b', args: ['--merge-output-format', 'mp4'] },
  audio: { label: '仅音频', format: 'ba/b', args: ['--extract-audio', '--audio-format', 'mp3', '--audio-quality', '0'] },
};

const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16 * 1024) throw new Error('请求内容过大');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  } catch {
    throw new Error('请求格式不正确');
  }
}

function isYouTubeUrl(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return false;
    const host = url.hostname.toLowerCase().replace(/^www\./, '');
    return host === 'youtu.be' || host === 'youtube.com' || host.endsWith('.youtube.com') || host === 'youtube-nocookie.com';
  } catch {
    return false;
  }
}

function runYtDlp(args, { onLine, maxOutput = 8 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(YT_DLP, args, { shell: false, env: { ...process.env, PYTHONUNBUFFERED: '1' } });
    let stdout = '';
    let stderr = '';
    let stdoutLineBuffer = '';
    let stderrLineBuffer = '';

    child.stdout.on('data', (chunk) => {
      const text = chunk.toString();
      if (stdout.length < maxOutput) stdout += text;
      if (onLine) {
        stdoutLineBuffer += text;
        const lines = stdoutLineBuffer.split(/\r?\n|\r/);
        stdoutLineBuffer = lines.pop() || '';
        lines.forEach((line) => onLine(line));
      }
    });
    child.stderr.on('data', (chunk) => {
      const text = chunk.toString();
      if (stderr.length < maxOutput) stderr += text;
      stderrLineBuffer += text;
      const lines = stderrLineBuffer.split(/\r?\n|\r/);
      stderrLineBuffer = lines.pop() || '';
      lines.forEach((line) => onLine?.(line));
    });
    child.on('error', (error) => {
      if (error.code === 'ENOENT') reject(new Error('找不到 yt-dlp，请先安装或设置 YT_DLP_PATH'));
      else reject(error);
    });
    child.on('close', (code) => {
      if (stdoutLineBuffer) onLine?.(stdoutLineBuffer);
      if (stderrLineBuffer) onLine?.(stderrLineBuffer);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(compactYtDlpError(stderr)));
    });
  });
}

function compactYtDlpError(stderr) {
  const lines = stderr.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const useful = [...lines].reverse().find((line) => /ERROR:|Sign in|unavailable|Unsupported URL/i.test(line));
  return (useful || '下载器未能处理这个链接').replace(/^ERROR:\s*/i, '').slice(0, 280);
}

function durationText(seconds) {
  if (!Number.isFinite(seconds)) return '未知时长';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  return hours ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}` : `${minutes}:${String(secs).padStart(2, '0')}`;
}

async function handleInfo(req, res) {
  try {
    const { url } = await readJson(req);
    if (!isYouTubeUrl(url)) return sendJson(res, 400, { error: '请输入有效的 YouTube 链接' });

    const { stdout } = await runYtDlp([
      '--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', '--no-call-home', url,
    ]);
    const data = JSON.parse(stdout);
    const heights = [...new Set((data.formats || []).map((format) => format.height).filter(Number.isFinite))].sort((a, b) => b - a);
    sendJson(res, 200, {
      title: data.title || '未命名视频',
      channel: data.channel || data.uploader || 'YouTube',
      duration: data.duration || null,
      durationText: durationText(data.duration),
      thumbnail: data.thumbnail || null,
      webpageUrl: data.webpage_url || url,
      maxHeight: heights[0] || null,
      viewCount: data.view_count || null,
    });
  } catch (error) {
    sendJson(res, 422, { error: error.message || '无法读取视频信息' });
  }
}

async function findDownloadedFile(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && !/\.(part|ytdl|temp)$/i.test(entry.name));
  if (!files.length) throw new Error('下载完成，但没有找到输出文件');
  const withStats = await Promise.all(files.map(async (entry) => ({ entry, info: await stat(join(directory, entry.name)) })));
  withStats.sort((a, b) => b.info.size - a.info.size);
  return { path: join(directory, withStats[0].entry.name), name: withStats[0].entry.name, size: withStats[0].info.size };
}

async function startDownload(url, quality, job) {
  const profile = qualityProfiles[quality];
  job.status = 'downloading';
  job.updatedAt = Date.now();

  try {
    job.directory = await mkdtemp(join(tmpdir(), 'ytb-local-'));
    const output = join(job.directory, '%(title).120B [%(id)s].%(ext)s');
    const args = [
      '--no-playlist', '--newline', '--no-call-home', '--no-warnings',
      '--progress-template', 'download:%(progress._percent_str)s|%(progress._speed_str)s|%(progress._eta_str)s',
      '--output', output, '--format', profile.format, ...profile.args, url,
    ];

    await runYtDlp(args, {
      maxOutput: 1024 * 1024,
      onLine(line) {
        const match = line.match(/download:\s*([\d.]+)%\|([^|]*)\|?(.*)/);
        if (!match) return;
        job.progress = Math.max(job.progress, Math.min(100, Number(match[1]) || 0));
        job.speed = match[2]?.trim() || null;
        job.eta = match[3]?.trim() || null;
        job.updatedAt = Date.now();
      },
    });

    const file = await findDownloadedFile(job.directory);
    job.status = 'ready';
    job.progress = 100;
    job.filename = file.name;
    job.filepath = file.path;
    job.size = file.size;
    job.updatedAt = Date.now();
  } catch (error) {
    job.status = 'error';
    job.error = error.message || '下载失败';
    job.updatedAt = Date.now();
    if (job.directory) await rm(job.directory, { recursive: true, force: true }).catch(() => {});
  }
}

async function handleCreateDownload(req, res) {
  try {
    const { url, quality = 'best' } = await readJson(req);
    if (!isYouTubeUrl(url)) return sendJson(res, 400, { error: '请输入有效的 YouTube 链接' });
    if (!qualityProfiles[quality]) return sendJson(res, 400, { error: '不支持这个下载格式' });
    const activeCount = [...jobs.values()].filter((job) => job.status === 'downloading').length;
    if (activeCount >= 2) return sendJson(res, 429, { error: '已有两个任务正在下载，请稍后再试' });

    const id = randomUUID();
    const job = { id, status: 'queued', progress: 0, speed: null, eta: null, createdAt: Date.now(), updatedAt: Date.now() };
    jobs.set(id, job);
    startDownload(url, quality, job);
    sendJson(res, 202, { id });
  } catch (error) {
    sendJson(res, 400, { error: error.message || '无法创建下载任务' });
  }
}

function publicJob(job) {
  return {
    id: job.id,
    status: job.status,
    progress: job.progress,
    speed: job.speed,
    eta: job.eta,
    filename: job.filename,
    size: job.size,
    error: job.error,
  };
}

async function handleJobFile(job, res) {
  if (job.status !== 'ready' || !job.filepath || !existsSync(job.filepath)) return sendJson(res, 404, { error: '文件尚未准备好或已被清理' });
  const safeName = job.filename.replace(/[\r\n"]/g, '_');
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': job.size,
    'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(safeName)}`,
    'Cache-Control': 'no-store',
  });
  const stream = createReadStream(job.filepath);
  stream.pipe(res);
  stream.on('error', () => res.destroy());
  res.on('close', async () => {
    jobs.delete(job.id);
    await rm(job.directory, { recursive: true, force: true }).catch(() => {});
  });
}

async function serveStatic(pathname, res) {
  const requested = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, '');
  const filepath = join(PUBLIC_DIR, safePath);
  if (!filepath.startsWith(PUBLIC_DIR) || !existsSync(filepath)) return false;
  const info = await stat(filepath);
  if (!info.isFile()) return false;
  res.writeHead(200, {
    'Content-Type': contentTypes[extname(filepath)] || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': extname(filepath) === '.html' ? 'no-cache' : 'public, max-age=3600',
  });
  createReadStream(filepath).pipe(res);
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (req.method === 'POST' && url.pathname === '/api/info') return handleInfo(req, res);
    if (req.method === 'POST' && url.pathname === '/api/download') return handleCreateDownload(req, res);

    const jobMatch = url.pathname.match(/^\/api\/jobs\/([0-9a-f-]+)(\/file)?$/i);
    if (req.method === 'GET' && jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return sendJson(res, 404, { error: '下载任务不存在或已被清理' });
      if (jobMatch[2]) return handleJobFile(job, res);
      return sendJson(res, 200, publicJob(job));
    }

    if (req.method === 'GET' && await serveStatic(url.pathname, res)) return;
    sendJson(res, 404, { error: '页面不存在' });
  } catch (error) {
    sendJson(res, 500, { error: error.message || '服务器发生错误' });
  }
});

const cleanupTimer = setInterval(async () => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (job.updatedAt >= cutoff) continue;
    jobs.delete(id);
    if (job.directory) await rm(job.directory, { recursive: true, force: true }).catch(() => {});
  }
}, 10 * 60 * 1000);
cleanupTimer.unref();

server.listen(PORT, HOST, () => {
  console.log(`本地 YouTube 下载器已启动：http://${HOST}:${PORT}`);
});

async function shutdown() {
  server.close();
  await Promise.all([...jobs.values()].map((job) => job.directory ? rm(job.directory, { recursive: true, force: true }).catch(() => {}) : null));
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
