# Architecture

## The pieces

| Layer | Where | What it does |
|---|---|---|
| UI | `src/ui` | React app served by the local server. The preview is a Remotion `<Player>` drawing the same composition the renderer uses. |
| Server | `src/server/main.ts` | Bun HTTP + WebSocket server bound to `127.0.0.1`. Project store, uploads, render queue, Night Shift, live progress events. Non-GET requests need a custom header (CSRF guard). |
| Ingest | `src/server/ingest.ts` | Per file: probe → browser proxy → audio → whisper.cpp transcript (word timings) → silences → YuNet face track → picture check (exposure / contrast / colour cast / shake). |
| Edit Spec | `src/shared/spec.ts` | One zod-validated JSON document describes the whole edit: clips, overlays, captions, audio, grade, effects, layout, brand. Every change is validated and kept in an undo history. |
| Composition | `src/remotion` | Clips with transitions and camera moves, overlays and templates, captions, look (grade + effects), audio mix. Used for the browser preview **and** the final render. |
| Render | `src/server/render*.ts` | A Node worker drives Remotion + headless Chrome. One render at a time; exports are then loudness-mastered (two-pass `loudnorm`, −14 LUFS) and get an `.srt` beside them. |
| Claude bridge | `src/claude/bridge.ts` | Starts the user's own Claude Code CLI headless (`claude -p`, stream-json) per project, with no built-in tools and a single MCP server. |
| Editor tools | `src/claude/mcp.ts` | The only tools Claude has: read the project and transcript, look at source frames, preview renders, cut / layer / caption / settings, music and voiceover, footage fixes, stock and AI images, hooks, publish info, thumbnails. |
| Night Shift | `src/server/night.ts` | Batches that run unattended: per-video autonomous Claude sessions, hook proposals with preview renders, usage-limit waits, a no-Claude fallback edit, keep-awake, resume after restart. |

## An edit, step by step

1. The creator uploads a clip; ingest produces a transcript, silences, a face track and a picture verdict.
2. They describe the edit. The bridge sends it to Claude together with the project context (media, analysis,
   current spec, which free sources are available).
3. Claude calls editor tools (`auto_cut`, `upsert_layers`, `update_settings`…). Each call is validated against the
   schema and the project (unknown media, out-of-range times, chat layers too short for their messages…) and is either
   applied or rejected with readable errors that Claude fixes and retries.
4. Claude calls `preview_edit` to render frames of its own work, checks legibility and framing, and adjusts.
5. It writes the upload text (`set_publish_info`), renders thumbnail options (`make_thumbnails`, which it can see),
   and reports back with suggested next steps.
6. Export renders the spec at full quality, masters the audio and writes subtitles.

## Design choices

- **One source of truth.** Preview and export share one composition and one spec, so there's no "looks different
  after export" class of bugs.
- **Tools, not free-form code.** Claude never writes files or runs commands; it can only make valid spec changes.
  That keeps edits safe, undoable and explainable.
- **Local first.** Heavy work runs on the creator's machine with free, open tools. Network use is limited to Claude
  (the user's own account), optional stock / AI-image services (search words and prompts only) and one-time downloads.
- **Heavy files outside the repo.** Tools, models, projects and renders live in `%LOCALAPPDATA%\Video Editor`
  (override with `VIDEO_EDITOR_HOME`), so the code folder can sit anywhere — even a synced folder.
- **Honest failure modes.** When something can't be done (a platform page link, a copyrighted song in an export,
  stock video without a key), the app says so and offers the allowed alternative.

## Testing strategy

- `bun test`: fast unit tests for the pure parts — timeline maths, caption pagination and corrections, footage
  analysis rules, transition and camera maths, chat parsing, number formatting, reframing rules.
- `scripts/*-test.ts` and `scripts/*-e2e.ts`: gates that render real video, extract frames or contact sheets, and check
  the output (MP4 validity, loudness, subtitle format, served files). Visual gates produce sheets a person (or Claude)
  inspects.
- `scripts/ui-smoke.ts`: drives the real UI in headless Microsoft Edge over the DevTools protocol.
