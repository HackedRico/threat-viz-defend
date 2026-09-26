# Voice coach

The spoke that runs the whiteboard defense out loud with a private ElevenLabs agent, and lets people speak a question into the ask bar with ElevenLabs Speech to Text. Owner: Eman. It touches the core engine only through the quiz, voice and dictation routes ([docs/team.md](../../../docs/team.md)): the coach asks the same questions as the text quiz, the server grades every answer, and dictation only fills a text box. The root [AGENTS.md](../../../AGENTS.md) holds the rules that apply everywhere.

## The pieces

| Piece | File | Job |
|---|---|---|
| The agent | `scripts/elevenlabs_agent.py` | Creates or updates the private agent and its four client tools by API: prompt, first message, model (`gemini-2.5-flash`), a 10 minute cap, auth required |
| The token | `api/app/voice.py`, `POST /api/boards/{id}/voice` in `api/app/routes/quiz.py` | Spends one daily voice session, mints a WebRTC conversation token with the server's key, and returns it with the dynamic variables `user_name`, `system_name`, `board_brief`, `question_count` |
| The feature check | `index.tsx` | `voiceEnabled(config)`, `dictationEnabled(config)`, the lazily loaded `VoicePanel`, `DictateButton` and `joinDictation`; the rest of the app imports nothing else from here |
| The session | `VoiceCoach.tsx` | Mic check, token, `startSession` inside `ConversationProvider`, controls and transcript |
| The client tools | `tools.ts` | `get_next_question`, `submit_answer`, `show_on_board`, `get_board_brief`, each calling an existing route |
| Speech text | `speech.ts`, `letters.ts` | The sentences the tools return, and "A and C" to option ids; both tested |
| Dictation | `Dictation.tsx`, `dictation.ts`; `ElevenLabsTranscriber` in `api/app/voice.py` and `POST /api/dictation` in `api/app/routes/dictation.py` | The mic beside Ask: records up to a minute with `MediaRecorder`, posts it as base64 JSON, and hands the text back to the ask bar. Format choice, encoding and joining are in `dictation.ts` and tested |

## The tool contract

The names and parameters below must match in `tools.ts` and `scripts/elevenlabs_agent.py`. Change both in the same PR, and rerun the script.

| Tool | Parameters | Returns to the agent |
|---|---|---|
| `get_next_question` | none | The first unanswered question with lettered options, or the score when all are answered |
| `submit_answer` | `question_id`, `answer` (letters for choice questions, the user's words for open ones) | `Result: correct`, `partial` or `wrong`, then the feedback and explanation |
| `show_on_board` | `ids`, comma separated node, flow or threat ids | The labels it lit on the map |
| `get_board_brief` | none | A spoken walkthrough of the board from `GET /api/boards/{id}/brief` |

## Rules for this area

- Grading stays on the server. Dynamic variables come from the browser, so a user can change what their own coach is told; never let them decide a grade, a budget or which board is read.
- The ElevenLabs API key stays on the server. The browser only ever holds a one-conversation token.
- Every start spends from the daily voice budget before the token is minted, and every dictation spends before ElevenLabs is called. Keep that order.
- Dictation goes through our API, never from the browser to ElevenLabs, so the key stays on the server and neither hosting layout needs a CSP change. Keep a clip under the 2,500,000 byte body cap once base64 grows it by a third: `DICTATION_MAX_SECONDS` and `DICTATION_BITS_PER_SECOND` in `dictation.ts` do that, and the server refuses more than about 1,500,000 bytes of audio.
- Dictated text lands in the box for the user to read; it never sends a question on its own, since asking spends a model call.
- The CSP allows scripts only from our origin, so the SDK's audio worklets are self-hosted: `npm run copy:worklets` copies them to `web/public/vendor/elevenlabs/` and `workletPaths` points at them. Recopy after upgrading `@elevenlabs/react`.
- Voice is optional. With it off, `voiceEnabled` hides the panel and the text quiz still works, and `dictationEnabled` hides the mic; nothing outside this folder may depend on voice.

## Getting it running

1. Get an ElevenLabs API key from Jonathan and put it in the repo-root `.env` as `ELEVENLABS_API_KEY`. Never commit it.
2. `cd api && uv run python ../scripts/elevenlabs_agent.py --dry-run` prints what it would send. Then run it without `--dry-run`; it prints the agent id.
3. Put that id in `.env` as `ELEVENLABS_AGENT_ID` and restart the API. `GET /api/config` now reports `voice_enabled: true`.
4. `./scripts/dev.sh`, sign in with the development account, open the example board, go to Defend, and start the voice coach.

Dictation needs only step 1: with `ELEVENLABS_API_KEY` set, `GET /api/config` reports `dictation_enabled: true` and the mic appears beside Ask on a finished board. The key needs the Speech to Text permission.

`npm test` covers the letter parsing, speech text and dictation helpers without a key, and `api/tests/test_dictation.py` covers the route and the ElevenLabs request against a mock. Nothing else here runs in tests, so check the live session and a real recording by hand after each change.

## Known gaps

- The script's request shapes come from the API docs and have only run against a mock; watch the first real run.
- Dictation has run end to end only with a fake transcriber; its ElevenLabs request follows the Speech to Text docs and is checked against a mock. Watch the first real recording, and the API log for "refused".
- The free ElevenLabs plan allows 4 conversations at once. A fifth start fails; the panel should point people to the text quiz.
- iOS Safari has had reports of the SDK's session state sticking at disconnected; start the session inside the click handler, as `VoiceCoach.tsx` does.
- On browsers that cannot set the mic sample rate, the SDK tries to load a resampler from a CDN, which the CSP blocks. WebRTC mode avoids that path.
