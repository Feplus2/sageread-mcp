import { MathMLToLaTeX } from "mathml-to-latex";

const BLOCK_TAGS = new Set([
  "p", "div", "section", "article", "chapter", "blockquote", "pre", "figure", "figcaption",
  "h1", "h2", "h3", "h4", "h5", "h6", "li", "tr", "hr", "dt", "dd",
]);

function mathTexOf(element: Element): { tex: string; display: boolean } | null {
  const annotation = Array.from(element.querySelectorAll("annotation")).find((item) =>
    (item.getAttribute("encoding") ?? "").toLowerCase().includes("tex"),
  );
  const tex = (annotation?.textContent ?? element.getAttribute("alttext") ?? "").trim();
  if (!tex) return null;
  return { tex, display: element.getAttribute("display") === "block" };
}

function mathElementToLatex(math: Element, display: boolean): string {
  const source = mathTexOf(math);
  if (source) return display ? `\n$$\n${source.tex}\n$$\n` : `$${source.tex}$`;
  try {
    const latex = MathMLToLaTeX.convert(math.outerHTML);
    if (latex?.trim()) return display ? `\n$$\n${latex.trim()}\n$$\n` : `$${latex.trim()}$`;
  } catch {
    // Preserve the original MathML when conversion is unavailable.
  }
  return display ? `\n[MathML] ${math.outerHTML}\n` : math.outerHTML;
}

function imageElementToMarkdown(image: Element): string {
  const alt = (image.getAttribute("alt") ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\\/g, "\\\\")
    .replace(/([\[\]])/g, "\\$1");
  const src = (image.getAttribute("src") ?? "").trim();
  const destination = /[\s()]/.test(src) ? `<${src.replace(/</g, "%3C").replace(/>/g, "%3E")}>` : src;
  return `![${alt}](${destination})`;
}

function inlineStructuredText(root: Element): string {
  let out = "";
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      out += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName?.toLowerCase() ?? "";
    if (["script", "style", "head", "title"].includes(tag)) return;
    if (tag === "math") {
      out += mathElementToLatex(element, false);
      return;
    }
    if (tag === "img") {
      out += ` ${imageElementToMarkdown(element)} `;
      return;
    }
    if (tag === "br") {
      out += " ";
      return;
    }
    for (const child of Array.from(element.childNodes)) walk(child);
  };
  walk(root);
  return out.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
}

export function tableToMarkdown(table: Element): string {
  const tableRows = Array.from(table.querySelectorAll("tr"));
  const rows: string[][] = [];
  const occupied = new Set<string>();
  let maxCols = 0;
  for (const [rowIndex, rowElement] of tableRows.entries()) {
    rows[rowIndex] ??= [];
    const row = rows[rowIndex];
    let column = 0;
    const cells = Array.from(rowElement.children).filter((cell) => ["td", "th"].includes(cell.localName));
    for (const cell of cells) {
      while (occupied.has(`${rowIndex}:${column}`)) column += 1;
      const htmlCell = cell as HTMLTableCellElement;
      const colSpan = Math.max(htmlCell.colSpan || Number(cell.getAttribute("colspan")) || 1, 1);
      const rowSpan = Math.max(htmlCell.rowSpan || Number(cell.getAttribute("rowspan")) || 1, 1);
      row[column] = inlineStructuredText(cell);
      for (let c = column + 1; c < column + colSpan; c += 1) row[c] = "";
      for (let r = rowIndex + 1; r < Math.min(tableRows.length, rowIndex + rowSpan); r += 1) {
        rows[r] ??= [];
        for (let c = column; c < column + colSpan; c += 1) {
          occupied.add(`${r}:${c}`);
          rows[r][c] = "";
        }
      }
      column += colSpan;
      maxCols = Math.max(maxCols, column);
    }
  }
  if (!rows.length || maxCols === 0) return "";
  const normalize = (row: string[]) => Array.from({ length: maxCols }, (_, index) => row[index] ?? "");
  const head = normalize(rows[0]);
  const lines = [
    `| ${head.join(" | ")} |`,
    `| ${head.map(() => "---").join(" | ")} |`,
    ...rows.slice(1).map((row) => `| ${normalize(row).join(" | ")} |`),
  ];
  return `\n${lines.join("\n")}\n`;
}

export interface StructuredExtract {
  text: string;
  totalChars: number;
}

export function extractStructuredText(doc: Document, startElement: Element | null): StructuredExtract {
  const root = startElement ?? doc.body;
  if (!root) return { text: "", totalChars: 0 };
  const parts: string[] = [];
  let lastBlockEnded = false;
  const pushText = (value: string) => {
    if (!value) return;
    parts.push(value);
    lastBlockEnded = false;
  };
  const pushBlockBreak = () => {
    if (lastBlockEnded) return;
    parts.push("\n");
    lastBlockEnded = true;
  };
  const walk = (node: Node) => {
    if (node.nodeType === 3) {
      pushText(node.nodeValue ?? "");
      return;
    }
    if (node.nodeType !== 1) return;
    const element = node as Element;
    const tag = element.localName?.toLowerCase() ?? "";
    if (["script", "style", "head", "title"].includes(tag)) return;
    if (tag === "math") {
      const display = element.getAttribute("display") === "block";
      if (display) pushBlockBreak();
      pushText(mathElementToLatex(element, display));
      if (display) pushBlockBreak();
      return;
    }
    if (tag === "table") {
      pushBlockBreak();
      pushText(tableToMarkdown(element));
      pushBlockBreak();
      return;
    }
    if (tag === "img") {
      pushText(` ${imageElementToMarkdown(element)} `);
      return;
    }
    if (tag === "br") {
      pushBlockBreak();
      return;
    }
    const isBlock = BLOCK_TAGS.has(tag);
    if (isBlock) pushBlockBreak();
    for (const child of Array.from(element.childNodes)) walk(child);
    if (isBlock) pushBlockBreak();
  };
  walk(root);
  let ancestor: Node | null = root;
  while (ancestor && ancestor !== doc.body) {
    let sibling = ancestor.nextSibling;
    while (sibling) {
      walk(sibling);
      sibling = sibling.nextSibling;
    }
    ancestor = ancestor.parentNode;
  }
  const text = parts
    .join("")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n+ */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { text, totalChars: text.length };
}
