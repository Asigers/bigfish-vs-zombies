# Live2D stage (OBS browser source)

The character layer for the stream. It is a plain local web page that OBS captures
as a **browser source**; the controller pushes speech events to it over SSE.

```
controller (game events)  ──SSE──▶  overlay page  ──▶  OBS browser source
                                    (PIXI + Cubism)       (transparent, 1920x1080)
```

## Rights gate (read before streaming)

The bundled whale-girl model is **CC BY-NC-SA 4.0** (attribution, non-commercial,
share-alike), and upstream notices conflict about commercial livestream use.

- Non-monetized testing: fine with attribution kept in the page.
- Monetized Douyin streams: get written permission from the rights holders first.
- The model and Cubism runtime are **not committed** to this repository
  (`overlay/assets/model/`, `overlay/assets/vendor/` are git-ignored).

Attribution: 上善无形 (character), ZipZipPipe (derivative), 氵六青 (Live2D),
Andersen216 (adaptation). The page renders this credit line at all times.

## Install the model and runtime

```bash
npm run overlay:install -- --acknowledge-noncommercial
```

The installer pins upstream commit `f977bef5…`, verifies Git blob hashes, and
places files under the ignored `overlay/assets/`. Slow links:

```bash
BIGFISH_DOWNLOAD_TIMEOUT=180 BIGFISH_DOWNLOAD_CONCURRENCY=1 \
BIGFISH_DOWNLOAD_RETRIES=6 npm run overlay:install -- --acknowledge-noncommercial
```

## Run

```bash
npm run overlay                 # preview only: http://127.0.0.1:45931/overlay
npm run live                    # game controller + overlay on 45931
node src/main.mjs --engine=bridge --overlay=45932 --tick=300   # custom port
```

`npm run live` expects a bridge-enabled game already running (see RUNBOOK.md).

## OBS

1. Scene → **+** → **Browser** (浏览器)
2. URL `http://127.0.0.1:45931/overlay`
3. Width `1920`, Height `1080`, FPS 30
4. Tick **Shutdown source when not visible: off** and **Refresh browser when scene
   becomes active: off** (the page keeps its SSE connection)
5. Background is transparent; put it **above** the game window capture
6. Optional `?zoom=1.3` (0.4–2.4) if the character looks small

Layer order: game window capture → Live2D browser source → vote/subtitle widgets.

## Event contract

`GET /overlay/events` (SSE, loopback only):

```text
event: speech
data: {"text":"第3路，上豌豆。","emotion":"happy","goal":"第 8 关防守"}
```

Emotion → expression/motion (see `overlay/live2d.js`):

| emotion | expression | motion |
|---|---|---|
| idle | reset | idle |
| happy | 开心兴奋 | aidale |
| excited | 星星眼 | splash |
| thinking | 问号 | selfieQuick |
| tired | 闭眼口水 | bubble |
| sad | 悲伤 | idle |
| surprised | 感叹号 | splash |

Mouth movement is driven by the text length (~130 ms per character, capped at
11 s). TTS is not wired yet; when it is, drive the mouth from the audio envelope
instead.

## What the controller says

`src/overlay/speech.mjs` maps **confirmed** events only:

| controller event | line |
|---|---|
| verified plant | `第N路，<植物>。` |
| verified sun | `阳光收下。` |
| verified next level | `继续，下一关。` |
| rejected command | `这一步不行，换一个。` |
| abandoned intent | `刚才那一下没确认，稳住。` |
| level cleared / lost | `第 N 关，拿下！` / `第 N 关丢了，再来。` |
| campaign complete / lost | `十关打完，收工！` / `这局没守住，重来。` |
| narration (Pi) | the narrator's own line |

A rejected or unverified action never claims success on stream. Speech is throttled
to one line per 4.5 s, except level events.

## Verified

- Model, expressions, physics and mouth movement render in a browser
  (Playwright screenshot, `overlay/assets/status → installed: true`).
- Real game events reach the avatar: during a bridge session the page showed
  `阳光收下。` with goal `第 8 关攒经济`.
- 58 controller tests pass; overlay server tests cover static serving, decoded
  Chinese asset paths, traversal rejection, SSE delivery and loopback binding.

## Limits

- Visual quality inside OBS itself is not asserted by tests; check once per model
  change.
- No TTS, no lip-sync from audio, no expression blending.
- The page is a capture surface only: no clicks, no chat input.
