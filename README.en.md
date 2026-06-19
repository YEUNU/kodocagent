# kodocagent

**A Korean-focused document AI agent** — a terminal agent that reads and edits HWP/HWPX/DOCX/XLSX documents and reviews/advises on them by checking Korean statutes.

[한국어 README](README.md)

---

## Install

```bash
# Global install via npm (recommended)
npm install -g @kodocagent/cli

# Global install via pnpm
pnpm add -g @kodocagent/cli

# Run directly with npx (no install)
npx @kodocagent/cli@latest
```

After install, the run command is `kodocagent`.

**Requirement**: Node.js 20+

---

## Quick start

### 1. First run — onboarding

```
kodocagent
```

On first run, onboarding begins:

1. Choose a provider (Anthropic / OpenAI / Google)
2. Enter your API key (masked, stored at `~/.kodocagent/config.json` with `0600`)
3. Optional law feature setup (enter the `LAW_OC` key now or later)

### 2. Chat examples

```
You: Check whether the annual-leave clause in this employment policy complies with the Labor Standards Act.
Assistant: running read_document(employment_policy.hwpx)...
          running mcp__korean-law__search_law...
          Compared against Article 60 (annual paid leave)...
```

```
You: Change the date on page 3 to January 1, 2026.
Assistant: propose_edit(employment_policy.hwpx) — shows a diff preview
          [Approve / Reject / Reject with reason]
```

---

## Features

### Read/write format matrix

| Format | Read | Write/Edit | Notes |
|--------|------|------------|-------|
| `.hwpx` | ✅ | ✅ | Preserves original formatting |
| `.hwp` | ✅ | ✅ | Lossless in-place edit in `.hwp` (`propose_edit`), original auto-backed up (table/cell structure edits go through `.hwpx`) |
| `.docx` | ✅ | ✅ | Re-generated formatting (possible loss noted in the diff) |
| `.xlsx` | ✅ | ✅ | Cell-level edits, formatting preserved |
| `.pdf` | ✅ | ❌ | Text extraction only (scanned PDFs unsupported) |
| `.md` / `.txt` | ✅ | ✅ | Plain text handled directly |

### Document comparison (redline)

Compares two documents block by block. Asking something like "compare these two contracts and tell me what changed" runs `compare_documents`, which lays out added/removed/modified blocks plus statistics in a table. Cross-format comparison (e.g. HWP ↔ HWPX) is supported.

### Precise table-cell edits (merge-preserving)

Korean documents frequently use merged cells (horizontal/vertical). The general edit path (`propose_edit`) patches only the changed parts losslessly, but when you need to **target a specific cell by coordinates** or work with documents involving merges, `propose_cell_edit` is safer. It **replaces only the target cell's text directly inside the `.hwpx` XML**, preserving merges, formatting, other cells, and form objects.

- Cells can be addressed by table number / row / column (coordinates) or by **label** (e.g. the cell next to or below "Name"). `expectedText` (the current cell value) is used for safe validation.
- **Filling empty cells** is supported, so blank cells in form documents can be filled.
- Multiple cells can be edited at once; if any one fails, the file is left untouched (atomic).
- `.hwpx` only (for `.hwp`, save as `.hwpx` in Hangul first).

### Filling form objects (edit box / push button / combo box / check / radio)

Lists and sets values for HWPX form objects. Supports the five kinds inserted in Hangul: **edit box, command button, combo box, list box, and radio button**.

- Ask "what input fields does this form have?" to see the form-object list (name, kind, current value), then "enter Hong Gil-dong in the Name field" to set values.
- Per kind: edit-box text, check/radio on/off, combo selection, button caption (combo only accepts actual items).
- `.hwpx` only; changes are shown as a diff preview and saved after approval.

> Known limitation: cells of a **table nested inside another table** cannot be addressed by coordinate/label (the parser does not expose nested tables as structure).

### Document-wide find & replace

Finds and replaces text across the whole document (body, tables, headers, etc.) — e.g. "replace every 'OOO' with 'Ganada Co., Ltd.'". It edits the document's internal XML directly, so **images, tables, and formatting are preserved**, and it stays safe even on complex documents (`.hwpx` only).

- Applies to all text: table cells, nested-table cells, body, etc.
- Text split mid-run by formatting may be partially missed; in that case you are notified.

### Table row/column editing (structural changes)

Adds/removes **rows and columns or merges cells** in a table (e.g. "add a row at the bottom of this table", "merge cells 1–2 in row 1"). The target table is identified by **unique text (an anchor) inside it** (read the document first to confirm table contents). It edits the document XML directly to **preserve images, other tables, and formatting**, then auto-validates that the intended row/column count matches (`.hwpx` only).

> Safeguard: inserting/removing rows or columns that cross existing merged cells can break the table, so it is **rejected** with a notice (unmerge first, then retry).

### PII de-identification (masking)

Finds and hides **resident registration numbers, phone numbers, emails, and card numbers** in a document. Asking to "just check" shows detection results only (read-only); asking to "mask / hide / de-identify" proposes a masking edit (e.g. "hide all personal info in this document"). The original values are never exposed in previews or responses, and the `.hwpx` structure is preserved.

### Document export (HTML / PDF)

Exports a document to **HTML or PDF** (e.g. "export this report as HTML", "save it as report.pdf"). The original is left untouched and a new file is created. HTML always works; PDF requires an environment with `puppeteer-core` installed (you are told if it is missing).

### Efficient reading of large documents

Instead of reading a large document whole, only the needed parts are fetched.

- **Outline first**: extract headings to grasp the document's structure — "show me just the table of contents of this report"
- **Search**: return only the matching parts plus surrounding context — "find just the 'penalty' part in this contract"
- **Page range**: read only specific pages/sections

### Context management

So context does not grow unbounded in long conversations, when the token budget (`max-context-tokens`, default 120k) is exceeded, **older document-read results are automatically condensed** (recent dialogue and approval pairs are kept). At the end of each response and via `/context` you can check **current context usage** (used tokens / budget / %); `/usage` shows **cumulative API usage for the session** (input/output tokens).

### Preview + approval flow

The agent **never saves directly.** Every write follows this order:

```
generate edit → save to staging → show diff preview → user approval
→ auto-backup of original (~/.kodocagent/backups/) → atomic save
```

On rejection, only the staging file remains and the original is unchanged.

> **Self-verification (v0.7.0+)**: after changing a document, the agent **re-reads the result and checks on its own whether the request was fully applied**, fixing any omissions (reducing the problem of handling only part of an "all/everything" request). Meaningless repetition of the same tool automatically nudges it to change approach.

### Law integration (requires LAW_OC key)

Looks up current Korean statutes via the National Law Information Center Open API.

**Get a LAW_OC key**: [open.law.go.kr](https://open.law.go.kr) → apply for Open API (free)

```bash
# register the key
kodocagent config set law-key <your_LAW_OC_key>
```

Citations are printed in the form 「statute name」 Article N, Paragraph N.

### MCP extension (mcp.json)

You can add MCP servers in `~/.kodocagent/mcp.json` or in a project-root `.kodocagent/mcp.json`.

```jsonc
{
  "mcpServers": {
    "korean-law": {
      "command": "npx",
      "args": ["-y", "korean-law-mcp@latest"],
      "env": { "LAW_OC": "${LAW_OC}" },
      "disabled": false,
      "allowedTools": null
    },
    "my-server": {
      "url": "https://my-mcp-server.example.com",
      "headers": { "Authorization": "Bearer ${MY_TOKEN}" }
    }
  }
}
```

- The `korean-law` server is bundled and included by default.
- If `LAW_OC` is unset, only the korean-law server is skipped.
- Tool namespace: `mcp__<server>__<tool>`
- You can connect Korean-service MCP servers from [awesome-mcp-korea](https://github.com/darjeeling/awesome-mcp-korea) like plugins.

---

## CLI commands

| Command | Description |
|---------|-------------|
| `kodocagent` | Start chat (onboarding on first run) |
| `kodocagent -p "<question>"` | One-shot query (write tools disabled, non-interactive) |
| `kodocagent --continue` | Resume the most recent session |
| `kodocagent --resume [id]` | Resume a session (pick from a list if id omitted) |
| `kodocagent sessions` | List sessions (with first-message preview) |
| `kodocagent config set <key> <value>` | Save a setting |
| `kodocagent config show` | Show current settings (API keys masked) |
| `kodocagent mcp list` | List MCP server status |
| `kodocagent mcp test <server>` | Test connection to a specific MCP server + list its tools |
| `kodocagent clean` | Clear all staging + backups older than 30 days (`--all` to delete all backups) |
| `kodocagent update` | Update to the latest version |
| `kodocagent --version` | Print version |

### In-chat slash commands

| Command | Description |
|---------|-------------|
| `/model` | Switch provider/model (only providers with keys shown; manual entry possible) |
| `/context` | Show current context usage (used tokens / budget / %) |
| `/usage` | Show cumulative API usage (input/output tokens) |
| `/clear` | Start a new session |
| `/help` | Help |
| `/exit` | Quit |

### config keys

| Key | Description | Example |
|-----|-------------|---------|
| `provider` | Active provider | `anthropic` \| `openai` \| `google` |
| `model` | Active model | `claude-sonnet-4-6` |
| `api-key.anthropic` | Anthropic API key | `sk-ant-...` |
| `api-key.openai` | OpenAI API key | `sk-...` |
| `api-key.google` | Google API key | `AI...` |
| `law-key` | LAW_OC law API key | |
| `max-steps` | Max tool calls per turn (default 24) | `24` |
| `max-context-tokens` | Context token budget (older tool results auto-compressed when exceeded, default 120000) | `120000` |

---

## Config file paths

| File | Description |
|------|-------------|
| `~/.kodocagent/config.json` | Provider / API key / model settings (0600) |
| `~/.kodocagent/mcp.json` | Global MCP server settings |
| `./.kodocagent/mcp.json` | Per-project MCP server settings (overrides global per server name) |
| `~/.kodocagent/sessions/` | Session history (JSONL) |
| `~/.kodocagent/backups/` | Auto-backups (on approval) |
| `~/.kodocagent/staging/` | Unapproved edit staging |
| `~/.kodocagent/update-check.json` | OTA update cache (24h) |

---

## Windows users

Set the terminal encoding to UTF-8:

```cmd
chcp 65001
```

Or use Windows Terminal (UTF-8 by default).

---

## Developer section

### Monorepo structure

```
packages/
├── shared/      # Shared types, zod schemas, errors  [workspace-only, not published to npm]
├── core/        # Agent loop, BYOK providers, tool registry, MCP client, sessions  [workspace-only]
├── doc-tools/   # kordoc/docx/exceljs wrappers, staging/backup/diff  [workspace-only]
└── cli/         # kodocagent CLI — bundles the three packages above at build time into a single npm package
```

The internal packages (`shared`, `core`, `doc-tools`) are marked `"private": true` and are not published to npm; they are inlined into the `@kodocagent/cli` package at build time. Users only install `npm i -g @kodocagent/cli`, and the run command is `kodocagent`.

### Development setup

```bash
# Install dependencies
pnpm install

# Build everything
pnpm build

# Test
pnpm test

# Lint
pnpm lint

# Type-check
pnpm -r typecheck
```

### Related docs

- [Technical spec (SPEC.md)](docs/SPEC.md)
- [Development strategy (DEVELOPMENT.md)](docs/DEVELOPMENT.md)

---

## Supported models

| Provider | Default model | Env var |
|----------|---------------|---------|
| Anthropic | `claude-sonnet-4-6` | `ANTHROPIC_API_KEY` |
| OpenAI | `gpt-5.4` | `OPENAI_API_KEY` |
| Google | `gemini-3.5-flash` | `GOOGLE_GENERATIVE_AI_API_KEY` |

Environment variables take precedence over `config.json`. API keys are managed by you (BYOK — Bring Your Own Key).

---

## Privacy & data handling

kodocagent **collects no telemetry or usage data of its own.** No data is sent to the author or any third party.

There are only two paths by which data leaves your machine, both required for the agent to work and sent **only to destinations you configure yourself**:

- **LLM providers** (Anthropic / OpenAI / Google): your API key (BYOK) and **document content** (the text read, your edit requests, etc.) are sent to the provider's API you chose. This is unavoidable, since the model must receive the content to work on a document.
- **MCP law server**: if you enable the law feature, the search terms needed for statute lookups are sent to the National Law Information Center Open API (or any MCP server you added).

Keys, session history, backups, and settings are all stored locally under `~/.kodocagent` only (`config.json` is `0600`). Nothing is uploaded anywhere.

> In short: document content is sent only to **the LLM provider you enabled (and the MCP law server if you enabled it)**. It is never sent to the kodocagent author.

---

## Changelog · Contributing · Security

- [Changelog (CHANGELOG.md)](CHANGELOG.md)
- [Contributing (CONTRIBUTING.md)](CONTRIBUTING.md)
- [Security policy (SECURITY.md)](SECURITY.md)

---

## License

MIT
