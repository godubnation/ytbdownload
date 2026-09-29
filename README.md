# TubeDrop

一个基于 [yt-dlp](https://github.com/yt-dlp/yt-dlp) 的本地 YouTube 视频下载页面。服务只监听 `127.0.0.1`，下载文件先写入系统临时目录，传输给浏览器后会自动清理。

## 启动

需要 Node.js 20+、yt-dlp 和 ffmpeg。

```bash
npm start
```

浏览器打开：<http://127.0.0.1:4173>

如果 yt-dlp 不在系统 PATH 中，可以指定路径：

```bash
YTDLP_PATH=/path/to/yt-dlp npm start
```

## 使用说明

1. 粘贴 YouTube 视频链接并点击“读取视频”。
2. 选择画质或 MP3 音频。
3. 等待处理完成，然后点击“保存文件到设备”。

请仅下载你有权保存的内容，并遵守 YouTube 服务条款与当地法律。
