export interface PiiFinding {
  type: string;
  count: number;
  masked: string[];
}

const PATTERNS: Array<{ type: string; re: RegExp; mask: (m: string) => string }> = [
  {
    type: "주민등록번호",
    re: /\b\d{6}-[1-4]\d{6}\b/g,
    mask: (m) => `${m.slice(0, 8)}******`,
  },
  {
    type: "신용카드번호",
    re: /\b\d{4}-\d{4}-\d{4}-\d{4}\b/g,
    mask: (m) => `${m.slice(0, 4)}-****-****-${m.slice(-4)}`,
  },
  {
    type: "전화번호",
    re: /\b0\d{1,2}-\d{3,4}-\d{4}\b/g,
    mask: (m) => {
      const p = m.split("-");
      return `${p[0]}-${"*".repeat((p[1] ?? "").length)}-${p[2]}`;
    },
  },
  {
    type: "이메일",
    re: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
    mask: (m) => {
      const [u, d] = m.split("@");
      return `${u?.[0] ?? ""}***@${d}`;
    },
  },
];

/** 텍스트에서 한국 PII를 탐지한다. 원문 값은 반환하지 않고 마스킹된 형태만 반환(로그 유출 방지). */
export function detectPii(text: string): PiiFinding[] {
  if (!text) return [];
  const out: PiiFinding[] = [];
  for (const { type, re, mask } of PATTERNS) {
    const matches = text.match(re);
    if (matches && matches.length > 0) {
      const uniq = [...new Set(matches)];
      out.push({ type, count: matches.length, masked: uniq.slice(0, 5).map(mask) });
    }
  }
  return out;
}

/** 탐지 결과를 한 줄 요약으로 (예: "전화번호 3건, 이메일 1건"). 없으면 "". */
export function summarizePii(findings: PiiFinding[]): string {
  return findings.map((f) => `${f.type} ${f.count}건`).join(", ");
}

/** 텍스트의 모든 PII를 마스킹된 형태로 치환한다. {치환된 텍스트, 탐지 결과} 반환. */
export function redactText(text: string): { text: string; findings: PiiFinding[] } {
  if (!text) return { text: text ?? "", findings: [] };
  let result = text;
  const findings = detectPii(text); // reuse existing detection for the report
  for (const { re, mask } of PATTERNS) {
    result = result.replace(new RegExp(re.source, re.flags), (m) => mask(m));
  }
  return { text: result, findings };
}
