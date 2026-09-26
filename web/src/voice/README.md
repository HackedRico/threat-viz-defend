# Voice coach

- `index.tsx`: the only entry point. `voiceEnabled(config)` is the feature check and `VoicePanel` the component; the SDK loads lazily.
- `VoiceCoach.tsx`: mic check, session start (`POST /api/boards/{id}/voice`, then `startSession` over WebRTC with the conversation token), controls and transcript.
- `tools.ts`: the client tools `get_next_question`, `submit_answer`, `show_on_board` and `get_board_brief`.
- `speech.ts` and `letters.ts`: the sentences the tools return and spoken letter parsing, both tested.
- Audio worklets are copied to `public/vendor/elevenlabs/` by `npm run copy:worklets` so the CSP needs no blob scripts.
- The ElevenLabs agent itself (prompt, tool names, voice) is configured by `scripts/elevenlabs_agent.py` in the repo.
