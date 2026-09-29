const form = document.querySelector('#lookup-form');
const input = document.querySelector('#video-url');
const clearButton = document.querySelector('#clear-button');
const lookupButton = document.querySelector('#lookup-button');
const message = document.querySelector('#form-message');
const emptyState = document.querySelector('#empty-state');
const card = document.querySelector('#video-card');
const thumbnail = document.querySelector('#thumbnail');
const duration = document.querySelector('#duration');
const channel = document.querySelector('#channel');
const title = document.querySelector('#video-title');
const meta = document.querySelector('#video-meta');
const downloadButton = document.querySelector('#download-button');
const progressPanel = document.querySelector('#progress-panel');
const progressKicker = document.querySelector('#progress-kicker');
const progressTitle = document.querySelector('#progress-title');
const progressPercent = document.querySelector('#progress-percent');
const progressBar = document.querySelector('#progress-bar');
const progressSpeed = document.querySelector('#progress-speed');
const progressEta = document.querySelector('#progress-eta');
const saveFileButton = document.querySelector('#save-file-button');

let currentVideo = null;
let pollingTimer = null;

function formatCount(value) {
  if (!Number.isFinite(value)) return null;
  return new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 }).format(value);
}

function setMessage(text = '') {
  message.textContent = text;
}

function setLookupLoading(isLoading) {
  lookupButton.disabled = isLoading;
  lookupButton.classList.toggle('loading', isLoading);
  input.disabled = isLoading;
}

function resetDownload() {
  clearInterval(pollingTimer);
  pollingTimer = null;
  progressPanel.hidden = true;
  saveFileButton.hidden = true;
  downloadButton.disabled = false;
  progressBar.style.width = '0%';
}

function resetVideo() {
  currentVideo = null;
  card.hidden = true;
  emptyState.hidden = false;
  resetDownload();
}

function renderVideo(video) {
  currentVideo = video;
  thumbnail.src = video.thumbnail || '';
  thumbnail.alt = `${video.title} 的视频封面`;
  duration.textContent = video.durationText;
  channel.textContent = video.channel;
  title.textContent = video.title;
  const details = [];
  if (video.maxHeight) details.push(`最高 ${video.maxHeight}p`);
  if (video.viewCount) details.push(`${formatCount(video.viewCount)} 次观看`);
  meta.textContent = details.join(' · ') || '视频信息已读取';

  document.querySelectorAll('input[name="quality"]').forEach((radio) => {
    const height = Number(radio.value);
    radio.disabled = Number.isFinite(height) && video.maxHeight && height > video.maxHeight;
  });
  const checked = document.querySelector('input[name="quality"]:checked');
  if (checked?.disabled) document.querySelector('input[value="best"]').checked = true;

  emptyState.hidden = true;
  card.hidden = false;
  resetDownload();
}

async function request(path, options) {
  const response = await fetch(path, options);
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || '请求失败，请稍后再试');
  return payload;
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const url = input.value.trim();
  if (!url) {
    setMessage('请先粘贴一个 YouTube 视频链接');
    input.focus();
    return;
  }

  setMessage();
  setLookupLoading(true);
  try {
    const video = await request('/api/info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    renderVideo(video);
  } catch (error) {
    resetVideo();
    setMessage(error.message);
  } finally {
    setLookupLoading(false);
  }
});

input.addEventListener('input', () => {
  clearButton.hidden = !input.value;
  setMessage();
});

clearButton.addEventListener('click', () => {
  input.value = '';
  clearButton.hidden = true;
  setMessage();
  resetVideo();
  input.focus();
});

async function pollJob(id) {
  try {
    const job = await request(`/api/jobs/${id}`);
    const percent = Math.round(job.progress || 0);
    progressPercent.textContent = `${percent}%`;
    progressBar.style.width = `${percent}%`;
    progressSpeed.textContent = job.speed || (job.status === 'queued' ? '等待开始' : '处理中');
    progressEta.textContent = job.eta && job.eta !== 'NA' ? `剩余 ${job.eta}` : '';

    if (job.status === 'ready') {
      clearInterval(pollingTimer);
      pollingTimer = null;
      progressKicker.textContent = '下载完成';
      progressTitle.textContent = job.filename;
      progressSpeed.textContent = job.size ? `${(job.size / 1024 / 1024).toFixed(1)} MB` : '文件已准备好';
      progressEta.textContent = '';
      saveFileButton.href = `/api/jobs/${id}/file`;
      saveFileButton.hidden = false;
      downloadButton.disabled = false;
    } else if (job.status === 'error') {
      clearInterval(pollingTimer);
      pollingTimer = null;
      progressKicker.textContent = '下载失败';
      progressTitle.textContent = job.error || '请稍后再试';
      progressSpeed.textContent = '';
      progressEta.textContent = '';
      downloadButton.disabled = false;
    }
  } catch (error) {
    clearInterval(pollingTimer);
    pollingTimer = null;
    progressKicker.textContent = '连接中断';
    progressTitle.textContent = error.message;
    downloadButton.disabled = false;
  }
}

downloadButton.addEventListener('click', async () => {
  if (!currentVideo) return;
  const quality = document.querySelector('input[name="quality"]:checked')?.value || 'best';
  downloadButton.disabled = true;
  saveFileButton.hidden = true;
  progressPanel.hidden = false;
  progressKicker.textContent = '正在下载';
  progressTitle.textContent = currentVideo.title;
  progressPercent.textContent = '0%';
  progressBar.style.width = '0%';
  progressSpeed.textContent = '创建任务…';
  progressEta.textContent = '';
  progressPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

  try {
    const job = await request('/api/download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: input.value.trim(), quality }),
    });
    await pollJob(job.id);
    pollingTimer = setInterval(() => pollJob(job.id), 900);
  } catch (error) {
    progressKicker.textContent = '无法开始';
    progressTitle.textContent = error.message;
    progressSpeed.textContent = '';
    downloadButton.disabled = false;
  }
});
