/**
 * 마크다운 → DOCX 변환기 (소형)
 *
 * 지원:
 * - # 헤딩 (1-6)
 * - 단락 (줄바꿈으로 구분)
 * - **bold**, *italic*
 * - - 불릿 리스트 (단순)
 * - | 테이블 (GFM 테이블)
 *
 * 복잡한 서식(머리글/각주/스타일)은 손실됨 — Proposal.warnings에 명시할 것
 *
 * docs/SPEC.md §6 propose_edit .docx 처리
 */

import {
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from "docx";

type HeadingLevelValue = (typeof HeadingLevel)[keyof typeof HeadingLevel];

const HEADING_LEVELS: Record<number, HeadingLevelValue> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
  6: HeadingLevel.HEADING_6,
};

/**
 * 인라인 마크다운(볼드/이탤릭)을 TextRun 배열로 파싱한다.
 */
function parseInline(text: string): TextRun[] {
  const runs: TextRun[] = [];
  // **bold** 또는 *italic* 처리
  const pattern = /(\*\*(.+?)\*\*|\*(.+?)\*)/g;
  let lastIndex = 0;

  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    // 매칭 전 일반 텍스트
    if (match.index > lastIndex) {
      runs.push(new TextRun({ text: text.slice(lastIndex, match.index) }));
    }
    if (match[0].startsWith("**")) {
      runs.push(new TextRun({ text: match[2] ?? "", bold: true }));
    } else {
      runs.push(new TextRun({ text: match[3] ?? "", italics: true }));
    }
    lastIndex = match.index + match[0].length;
  }

  // 나머지 텍스트
  if (lastIndex < text.length) {
    runs.push(new TextRun({ text: text.slice(lastIndex) }));
  }

  if (runs.length === 0) {
    runs.push(new TextRun({ text }));
  }

  return runs;
}

/**
 * GFM 테이블 파싱.
 * 첫 줄: 헤더, 두 번째 줄: 구분자 (무시), 나머지: 데이터 행
 */
function parseTable(lines: string[]): Table {
  const rows: TableRow[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    // 구분자 행 (--- 패턴) 건너뜀
    if (/^\|[\s-:|]+\|/.test(line)) continue;

    const cells = line
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());

    const isHeader = i === 0;
    rows.push(
      new TableRow({
        children: cells.map(
          (cell) =>
            new TableCell({
              children: [
                new Paragraph({
                  children: parseInline(cell),
                  ...(isHeader ? { heading: HeadingLevel.HEADING_6 } : {}),
                }),
              ],
            }),
        ),
      }),
    );
  }

  return new Table({
    rows,
    width: { size: 100, type: WidthType.PERCENTAGE },
  });
}

/**
 * 마크다운 텍스트를 DOCX Buffer로 변환한다.
 */
export async function markdownToDocx(markdown: string): Promise<Buffer> {
  const lines = markdown.split("\n");
  const children: (Paragraph | Table)[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;

    // 빈 줄
    if (!line.trim()) {
      i++;
      continue;
    }

    // 헤딩
    const headingMatch = /^(#{1,6})\s+(.+)$/.exec(line);
    if (headingMatch) {
      const level = headingMatch[1]!.length;
      const text = headingMatch[2] ?? "";
      children.push(
        new Paragraph({
          children: parseInline(text),
          heading: HEADING_LEVELS[level] ?? HeadingLevel.HEADING_1,
        }),
      );
      i++;
      continue;
    }

    // 불릿 리스트 항목
    if (/^[-*+]\s+/.test(line)) {
      const text = line.replace(/^[-*+]\s+/, "");
      children.push(
        new Paragraph({
          children: parseInline(text),
          bullet: { level: 0 },
        }),
      );
      i++;
      continue;
    }

    // 테이블 (| 로 시작)
    if (line.trim().startsWith("|")) {
      const tableLines: string[] = [];
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        tableLines.push(lines[i]!);
        i++;
      }
      if (tableLines.length >= 1) {
        children.push(parseTable(tableLines));
      }
      continue;
    }

    // 일반 단락
    children.push(
      new Paragraph({
        children: parseInline(line),
      }),
    );
    i++;
  }

  // 최소 1개 단락 보장
  if (children.length === 0) {
    children.push(new Paragraph({ children: [new TextRun({ text: "" })] }));
  }

  const doc = new Document({
    sections: [
      {
        children,
      },
    ],
  });

  return Packer.toBuffer(doc);
}
