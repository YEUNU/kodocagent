# 보안 정책 (Security Policy)

## 지원 버전 (Supported Versions)

보안 수정은 최신 마이너 라인에만 제공됩니다. 항상 최신 `@kodocagent/cli`를 사용하세요.

| 버전 | 지원 |
|------|------|
| 0.7.x (최신) | ✅ |
| 0.7.x 미만 | ❌ |

업데이트:

```bash
npm install -g @kodocagent/cli@latest
# 또는
kodocagent update
```

## 왜 보안 신고가 중요한가 (Why this matters)

kodocagent는 **개인정보(PII)가 담길 수 있는 실제 문서**(HWP/HWPX/DOCX/XLSX)를 읽고 편집하는 도구입니다.
잘못 다루면 문서 손상·정보 유출로 이어질 수 있으므로, 보안 취약점은 일반 버그보다 우선해 처리합니다.

kodocagent is a tool that reads and edits **real documents that may contain personal data (PII)**.
Because mishandling can lead to document corruption or data exposure, we treat security
vulnerabilities with higher priority than ordinary bugs.

## 취약점 신고 (Reporting a Vulnerability)

**공개 이슈로 올리지 마세요.** 대신 GitHub의 비공개 취약점 보고 기능을 사용해 주세요:

1. 저장소 상단의 **Security** 탭으로 이동
2. **Report a vulnerability** 클릭 (Security Advisories)
3. 또는 직접 링크: https://github.com/YEUNU/kodocagent/security/advisories/new

신고에 포함하면 좋은 내용:

- 영향받는 버전(`kodocagent --version`)과 OS/Node 버전
- 재현 단계 및 영향 범위(정보 유출, 파일 손상, 임의 코드 실행 등)
- 가능하다면 PoC

> **민감정보를 첨부하지 마세요.** 실제 문서·API 키·주민등록번호 등 PII를 포함하지 말고,
> 재현 가능한 **최소 합성 예시**를 사용해 주세요.

---

**Please do not open a public issue for security reports.** Use GitHub's private
vulnerability reporting instead: the repository's **Security** tab →
**Report a vulnerability** (Security Advisories), or
https://github.com/YEUNU/kodocagent/security/advisories/new .

Do not attach sensitive data (real documents, API keys, PII) — use a minimal,
reproducible synthetic example.

## 응답 (Disclosure)

신고를 확인하면 검토 후 수정 계획과 일정을 회신합니다. 수정이 발행되면
[CHANGELOG.md](CHANGELOG.md)에 기록하고, 신고자가 원하면 advisory에 기여를 명시합니다.
