/**
 * UIMessage parts 渲染：text 原样输出，quote 以引用格式呈现，
 * reasoning / tool-* / step-start 等过程性 part 跳过。
 * 与 SageRead 应用内 export-thread-markdown 的行为保持一致。
 */

export interface MsgPart {
  type: string;
  text?: string;
  source?: string;
}

export interface UIMsg {
  role: string;
  parts?: MsgPart[];
}

/** quote 文本转 Markdown blockquote（逐行加 "> "） */
function toBlockquote(text: string): string {
  return text
    .split("\n")
    .map((line) => `> ${line}`.trimEnd())
    .join("\n");
}

/** 渲染单条消息为 Markdown 片段（text + quote，其余 part 跳过） */
export function renderMessageMarkdown(message: UIMsg): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const blocks: string[] = [];
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    if (text) blocks.push(text);
    textBuffer = "";
  };

  for (const part of parts) {
    if (part?.type === "text") {
      textBuffer += part.text ?? "";
      continue;
    }
    if (part?.type === "quote") {
      flushText();
      const quote = toBlockquote(String(part.text ?? ""));
      if (quote.trim()) {
        blocks.push(part.source ? `${quote}\n> —— ${part.source}` : quote);
      }
    }
    // reasoning / tool-* / step-start：跳过
  }

  flushText();
  return blocks.join("\n\n");
}

/** 渲染单条消息为纯文本片段（get_thread 用，quote 缩进呈现） */
export function renderMessagePlain(message: UIMsg): string {
  const parts = Array.isArray(message.parts) ? message.parts : [];
  const blocks: string[] = [];
  let textBuffer = "";

  const flushText = () => {
    const text = textBuffer.trim();
    if (text) blocks.push(text);
    textBuffer = "";
  };

  for (const part of parts) {
    if (part?.type === "text") {
      textBuffer += part.text ?? "";
      continue;
    }
    if (part?.type === "quote") {
      flushText();
      const quote = String(part.text ?? "").trim();
      if (quote) {
        const label = part.source ? `【${part.source}】` : "【引用】";
        blocks.push(`${label}\n${quote}`);
      }
    }
  }

  flushText();
  return blocks.join("\n\n");
}

/** 整段对话 → Markdown 文档（元信息头 + 问答分区） */
export function buildThreadMarkdown(
  messages: UIMsg[],
  meta: { title: string; bookTitle?: string; createdAt: string; updatedAt: string },
): string {
  const lines: string[] = [];
  lines.push(`# ${meta.title || "未命名对话"}`);
  lines.push("");
  if (meta.bookTitle) lines.push(`- 书名：《${meta.bookTitle}》`);
  lines.push(`- 创建时间：${meta.createdAt}`);
  lines.push(`- 更新时间：${meta.updatedAt}`);
  lines.push(`- 消息数：${messages.length}`);
  lines.push("");
  lines.push("---");
  lines.push("");

  for (const message of messages) {
    const body = renderMessageMarkdown(message);
    if (!body) continue;
    lines.push(message.role === "user" ? "## 🧑 用户" : "## 🤖 AI");
    lines.push("");
    lines.push(body);
    lines.push("");
  }
  return lines.join("\n");
}

/** 整段对话 → 可读纯文本（用户/AI 交替分区） */
export function buildThreadPlain(messages: UIMsg[], meta: { title: string; bookTitle?: string }): string {
  const lines: string[] = [];
  lines.push(`对话：${meta.title || "未命名对话"}`);
  if (meta.bookTitle) lines.push(`书籍：《${meta.bookTitle}》`);
  lines.push(`消息数：${messages.length}`);
  lines.push("".padEnd(40, "="));
  for (const message of messages) {
    const body = renderMessagePlain(message);
    if (!body) continue;
    lines.push("");
    lines.push(message.role === "user" ? "【用户】" : "【AI】");
    lines.push(body);
  }
  return lines.join("\n");
}

/** epoch 毫秒 → 本地时间字符串 YYYY-MM-DD HH:mm:ss */
export function fmtTime(ms: number | null | undefined): string | null {
  if (ms == null) return null;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return null;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
