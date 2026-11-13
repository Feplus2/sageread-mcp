# SageRead MCP 文档图片能力设计

## 目标与范围

让外部 MCP 客户端完成“发现书籍/论文插图 → 取得安全绝对路径 → 真正读取图片内容”的闭环，与 Better SageRead 0.5.0 的图片链路对齐。此次不发布版本、不改跨库检索与 canonical 坐标、不增加当前阅读位置参数。

## 已选方案

- `read_document` 在论文窗口切片之后，把存在且位于论文目录内的相对图片路径改写成绝对路径；不存在的文件、外部 URL、data URI 原样保留，offset 不受路径改写影响。
- 新增 `list_paper_figures(doc, offset?, limit?)`，从论文 canonical 正文扫描 Markdown 与 HTML 图片，每页最多 50 张，返回图片引用、可用的绝对路径、图注、图注来源、所在小节、全量计数和下一页图片序号。
- 新增 `read_images(doc, paths, max_edge?)`，同一工具处理 1–6 张图片。`doc` 限定可读的论文/书籍目录；书籍额外允许该书自己的 `image-cache/epub/<bookId>`。
- 返回标准 MCP `image` content（裸 base64 + `mimeType`）及每张图的文本信封。Better SageRead 0.5.0 已负责 MCP 图片落盘和模型协议回灌，本 MCP 不判断模型能力、不处理 provider 协议。
- 使用 `sharp` 做真实图片解码、尺寸读取、缩放和 JPEG 编码。源图上限 20 MiB，默认长边 1024、可调 512–1536；批量 data URL 总预算 700,000 字符，内部按 90% 摊分。透明图片以白色铺底，避免黑底丢失图形。

## 方案取舍

- **返回图片本体，而非只返回文件链接**：文件链接不能让普通 MCP 模型真正看图；标准 `image` content 同时兼容 Better SageRead 0.5.0 的收口逻辑。
- **一个批量工具，而非照搬 readImage/viewImages 两个工具**：覆盖单图与多图，避免默认工具面继续膨胀。
- **引入 sharp，而非直接回传任意原图**：20 MiB 原图和多图 base64 会撑爆上下文；需要真实解码、尺寸上限与压缩预算。SVG 不作为图片输入接受，避免把标记文档当作光栅图。
- **按 DocRef 限定根目录，而非任意绝对路径**：保持本项目的“文献库只读”边界；同时检查词法路径与真实路径，拒绝目录穿越和越界 symlink/junction。

## 接口

```ts
list_paper_figures({ doc: string, offset?: number, limit?: number }): {
  doc: string;
  total: number;
  total_found: number;
  truncated: boolean;
  offset: number;
  limit: number;
  next_offset: number | null;
  orphanCaptions: number;
  figures: Array<{
    image: string;
    image_path: string | null;
    caption: string;
    captionFrom: "alt" | "block" | null;
    section: string | null;
    offset: number;
  }>;
}

read_images({ doc: string, paths: string[], max_edge?: number }): {
  content: Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: "image/jpeg" }
  >;
  isError?: boolean;
}
```

`paths` 只接受 `read_document` / `list_paper_figures` 给出的绝对路径。单张失败不抹掉同批其他成功图片；部分失败在首条文本和末尾清单同时标明，全部失败才返回 `isError: true`。图片读取使用同一文件描述符做有界读取与大小复核，损坏图片返回中文解码错误。

## 非目标

- 不读取聊天附件、工作区图片或任意本地文件。
- 不清理 EPUB/MCP 图片缓存，不实现缓存 LRU。
- 不复制 App 的图片历史回灌预算、视觉模型检测或 UI 行为。
- 不提交、不推送、不发布；图片任务完成后统一验收，之后再决定发版。
