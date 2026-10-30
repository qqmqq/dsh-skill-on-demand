# dsh-skill-on-demand

English | [中文](README.zh.md)

DeepSeek Harness publishes the session skill catalog once per session, and every later request carries it again as part of the conversation. With dozens of installed skills that is a few thousand tokens of description text re-sent on every turn, most of it about skills the current task will never touch.

This plugin removes that catalog and replaces it with three small tools.

## What it does

| Before | With this plugin |
| --- | --- |
| One message lists every skill name **and** its description, sent in every request | The catalog message is never published |
| The model reads all descriptions to decide what it needs | `skill_list` returns skill **names only**; descriptions are fetched only for a search (`skill_list` with `query`) |
| Nothing records what the task actually uses | `skill_pick` records the skills kept for this session; everything else is ignored |
| Every skill body is reachable but unmeasured | `skill` loads exactly one full skill body, by name |

The plugin injects **one** short protocol message per session: list names, judge which skills the task needs (five or fewer), ask the user when the shortlist is unclear, record them with `skill_pick`, then continue. It never repeats, and subagent sessions get none — they keep the tools, they just do not pay for the prompt.

A prompt alone gets ignored often enough to matter, so the first step is also **gated**: until a skill is picked, an ordinary tool call is denied with a one-line reason that names `skill_list` and `skill_pick`. At most two denials per session, then the gate opens for good. `skill_list`, `skill_pick`, `skill`, `ask_user` and `ask_user_question` always pass, and subagents are never gated.

Removing the catalog costs discoverability, so two **deterministic hints** put it back where it matters, still one line each and once per session:

- The user's request reads like browser work (网页 / 浏览器 / 抓取 / 登录 / screenshot / browser …) and this session has `browser_*` tools → one reminder that those tools exist, instead of a silent `web_fetch`.
- A `web_*` tool call fails → one reminder to fall back to `browser_session` → `browser_page` → `browser_inspect`.
- Every user message is matched against all skill descriptions locally (CJK bigrams + latin words, common phrases filtered). Up to three matching skills are named with an 80-character description, once each per session — a skill whose name says nothing ("archify", "grill") still surfaces when the task wording matches what it does.

## How the catalog is removed

`@deepseek-ai/dsh-tool-skill` publishes its catalog only while `ctx.tools.get('skill', agent)` still resolves to its own tool registration. This plugin registers a same-name `skill` tool in each agent's own scope (the nearest scope wins), so that check fails and the catalog stops being published. The replacement tool does the same job — load one skill's instructions by exact name.

Presets that never mounted a `skill` tool are left untouched: there is nothing to replace, and a deliberately minimal preset should not silently gain tools.

## Install

```sh
dsh plugin --profile web add dsh-skill-on-demand
```

Restart the harness afterwards; the bundle is loaded at boot.

## Verify

Start a new session and ask anything. The first turn should show `skill_list` → `skill_pick` and no `<available_skills>` block. `skill_list` with no argument returns names only.

## Limitations

- **Bounded, not absolute.** The gate denies an ordinary tool call twice at most. A model that ignores both hints still gets its work done; the catalog stays gone either way, so the token saving holds regardless.
- **Old sessions keep their history.** A session that already had a catalog published before the plugin was installed still carries that message, plus one "no skills available" correction from the shipped plugin. Start a fresh session for a clean slate.
- **Selection is per session.** A new session re-runs the judgement; that is intentional, since the right skills depend on the task.
- **Duplicates.** If a preset already registered `skill` in the agent's own layer, registration fails and the plugin degrades to "picker tools available, catalog unchanged" instead of breaking the session.

## Development

`index.js` is a single Host plugin, no build step. `scripts/selftest.mjs` runs it against a mock context. Run it from inside the installed package directory, so module resolution still reaches the harness's own `@deepseek-ai/*` packages:

```sh
node <profile>/node_modules/dsh-skill-on-demand/scripts/selftest.mjs
```

## License

MIT
