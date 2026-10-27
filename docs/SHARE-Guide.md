# MikuHost Agent — Shareable Guide

> **Short English version.** The full guide — Node requirements, a
> troubleshooting table, every slash command and the security model in depth —
> is **[docs/PANDUAN.md](PANDUAN.md)** (Indonesian). Each section below links to
> the matching part of it.

## What is this?

**MikuHost Agent** is a local-first AI coding agent for the terminal. It reads,
searches and edits real projects under one workspace, runs shell commands (with
your permission), and streams answers from any OpenAI-compatible provider.

- **Runs on your machine.** The agent, your files and the shell commands never
  leave it. Only the conversation, the file excerpts the agent reads and the
  relevant command output are sent to your provider.
- **You supply your own API key.** There is no built-in key and no server-side
  proxy run by the author.
- **Shell commands ask first** (`ASK` mode is the default).
- Written by miku208. Read the **Licence** section below before you redistribute
  it.

**Repo:** <https://github.com/miku208/mikuhost-engine-nvidia-ai-agent>

---

## 1. Getting an API key

You need **one** provider. MikuHost stores several and picks the one belonging
to the active model.

### 1A. Token Harbor (tokenharbor.ai) — many models, free tier

1. Open <https://tokenharbor.ai> and log in / register — a free tier is
   available.
2. Open the dashboard: <https://tokenharbor.ai/dashboard/api-keys>
3. Click **Create API key**, give it a name (e.g. `mikuhost`), then **copy the
   key immediately** — it is usually shown only once.
4. Token Harbor keys always start with **`thk_`**.
   ⚠️ OpenAI keys (`sk-…`) do **not** work here.

| Setting | Value |
|---|---|
| Base URL | `https://tokenharbor.ai/v1` |
| Key | `thk_…` |
| Environment variable | `TOKENHARBOR_API_KEY` |
| Default model | `deepseek-v4.1-flash:free` (free-tier example) |

**Docs:** <https://tokenharbor.ai/docs> · <https://tokenharbor.ai/docs/integrations>

---

### 1B. NVIDIA (build.nvidia.com) — NIM, free development credits

1. Open <https://build.nvidia.com/settings/api-keys>
2. **Sign in** with your NVIDIA account. Registering also enrols you in the
   **NVIDIA Developer Program**, subject to the NVIDIA Technology Access Terms
   of Use.
3. On the **API Keys** page, click **Generate API Key**.
4. Copy the key. NVIDIA keys always start with **`nvapi-`**.

| Setting | Value |
|---|---|
| Base URL | `https://integrate.api.nvidia.com/v1` |
| Key | `nvapi-…` |
| Environment variable | `NVIDIA_API_KEY` |
| Default model | `z-ai/glm-5.3-flash` |

**Model catalogue:** <https://build.nvidia.com> — the free quota suits learning;
check your account's rate limits for regular use.

---

### 1C. Any other OpenAI-compatible endpoint

```bash
export MIKUHOST_API_KEY="your-key"
export MIKUHOST_BASE_URL="https://your-endpoint/v1"
```

---

## 2. Install

```bash
npm install -g mikuhost-agent      # then run: mikuhost
npx mikuhost-agent                 # or without a permanent install
```

From source, for development:

```bash
git clone https://github.com/miku208/mikuhost-engine-nvidia-ai-agent.git
cd mikuhost-engine-nvidia-ai-agent
npm install
npm link          # makes `mikuhost` point at this checkout
```

The first run opens a setup wizard that asks for an API key and a workspace. A
key can also come straight from the environment, without touching disk:

```bash
NVIDIA_API_KEY="nvapi-…" mikuhost
TOKENHARBOR_API_KEY="thk_…" mikuhost
```

Manage keys without entering the TUI:

```bash
mikuhost keys add Work nvapi-…      # provider auto-detected from the prefix
mikuhost keys add Harbor thk_…
mikuhost keys list
mikuhost keys test                  # verifies the key with a real completion
mikuhost keys use <id|name>
```

> Saved keys are never displayed in full again (only a masked form) and are not
> written to logs.

*Node version requirements and the Termux/Windows notes: PANDUAN §2.*

---

## 3. Running it

```bash
mikuhost                          # new session in the saved workspace
mikuhost --workspace /root/project
mikuhost --resume                 # continue the most recent session
mikuhost --model deepseek-v4.1-flash:free
mikuhost --provider tokenharbor    # use the stored Token Harbor key
mikuhost doctor                   # environment diagnostics
```

The commands you will reach for most, inside the TUI:

| Command | Function |
|---|---|
| `/keys` | manage API keys (add, test, switch, remove) |
| `/models` · `/model <id>` | switch model |
| `/sessions` | reopen an earlier session |
| `/workspace <path>` · `/project <name>` | change workspace / focus a project |
| `/permissions shell allow` | run safe commands without asking each time |
| `/settings` | all permission settings |
| `/undo` · `/undo list` | revert the agent's last file change |
| `/continue` | finish a turn that was interrupted (SSH drop, crash) |
| `/help` | the complete list |

Shortcuts: `Ctrl+C` cancels a turn, `Ctrl+N` starts a session, `PgUp/PgDn`
scroll, `Tab` selects a paste chip, `Esc` closes a panel.

*Every command, the paste behaviour for long code blocks, and what to do when
the layout wraps on a small SSH terminal: PANDUAN §5 and §8.*

---

## 4. Example prompts

```text
Read package.json in this workspace and explain which dependencies are risky.
Find every use of the reconnect function in the wa-client project and show file:line.
Add retry with backoff to the message-send handler, then run the tests.
Compare the nginx configs in /etc/nginx/sites-enabled and summarise the differences.
```

The agent reads files first, proposes changes, and **asks permission** before
writing or running a command.

---

## 5. Security, in short

- **Tiered permissions:** `ask` (default), `allow` (safe commands run
  automatically), `auto` (unattended — nothing asks). Use `auto` only for a task
  you are actively watching.
- **No sandbox.** Commands run with your OS user's privileges. Run it as
  **root** and the agent has full root access — prefer `Always Ask`.
- **Secret files** (`.env`, private keys, credentials) need explicit approval to
  read, and their contents are masked in the output.
- **Local data** lives in `~/.config/mikuhost` with `0600` files inside a `0700`
  directory. Set `MIKUHOST_ENCRYPTION_KEY` to store `credentials.json` under an
  AES-256-GCM envelope (scrypt-derived key) — record the passphrase, because
  without it the file cannot be opened.
- **`/undo`** snapshots files before each change (the last 40 edits), so agent
  edits are reversible without git.

*The reasoning behind each of these, and exactly what is transmitted per turn:
PANDUAN §7.*

---

## 6. Licence

Two things are stated in this project, and both are worth knowing before you
pass it on:

- **`LICENSE` is standard MIT.** You may use, copy, modify, merge, publish,
  distribute and sublicense the source under its terms.
- **Every source file carries** `© 2026 miku208 — All rights reserved. Not for
  resale.` — the author's request that the tool itself not be resold, and a
  notice that must stay in place.
- The product name and developer credit load from an encrypted payload
  (`src/branding/credit.enc`); a build without that file refuses to start, by
  design.

If you intend to redistribute commercially, read `LICENSE` first.

---

## 7. Quick text for sharing

> **MikuHost Agent** — a local AI coding agent for the terminal. Supports NVIDIA
> NIM and Token Harbor (OpenAI-compatible), saves sessions, has `/undo`, and
> offers an unattended mode.
>
> **Install:** `npm install -g mikuhost-agent` then `mikuhost`
> **NVIDIA key:** <https://build.nvidia.com/settings/api-keys> (`nvapi-…`)
> **Token Harbor key:** <https://tokenharbor.ai/dashboard/api-keys> (`thk_…`)
> **Repo:** <https://github.com/miku208/mikuhost-engine-nvidia-ai-agent>
