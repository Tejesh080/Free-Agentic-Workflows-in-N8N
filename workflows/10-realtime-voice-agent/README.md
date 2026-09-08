# 10 Real-Time Voice Automation Agent

> Webhook to speech: transcription, intent classification against a closed tool registry, Governance for data-changing intents, verification, and speech synthesis, with per-stage latency measurement.

**Status:** LIVE VERIFIED · **23 nodes** (20 executable) · n8n workflow `5Aup44P7oBr6Zolg` on the instance it was built and tested on

## The problem

A voice agent that can act on what it thinks it heard is a liability, and a single end-to-end latency number hides where the time actually goes.

## How it works

1. Accept audio or text on a webhook and stamp a start time.
2. Transcribe audio with Whisper, or use the supplied text.
3. Classify the transcript against a **closed registry** of five intents using the `voice/intent-router` prompt.
4. Send data-changing intents to Governance.
5. Execute a restricted tool, compose a short spoken reply, verify it against the tool result, synthesise speech, and respond.

## Platform services it calls

- **02 Model Router**
- **05 Governance**
- **08 Prompt Registry**
- **09 Verification**

## Safety properties

The tool surface is a closed registry: an invented intent name becomes `unsupported`, never an undefined action. Whether an intent changes data is declared **in the registry, not by the model**. Even on approval this workflow **does not execute** data-changing intents — the approval is recorded for a human. That is what makes a public webhook demo safe.

## Triggers

- `Voice Webhook`
- `Respond to Caller`

## Verification

- **2/2 passed** — [`tests/results-2026-09-08.json`](tests/results-2026-09-08.json)
  - latency_measured_ms is real per-stage wall clock. Transcription is near zero on these runs because they used the text-payload path; a real audio upload adds the speech-to-text call.

Every figure above came from an execution on a live n8n instance. See [docs/TESTING.md](../../docs/TESTING.md) for how to reproduce them.

## Connections required

- OpenAI Whisper (speech to text)
- OpenAI TTS (text to speech)

Full setup: [docs/CONNECTIONS.md](../../docs/CONNECTIONS.md)

## Limitations

- The audio upload path is structurally validated but not exercised end to end; both recorded runs used the text payload. Text-to-speech **is** exercised.
- No conversation memory across turns.
- Demo tools return invented static data.

## Import

```bash
python scripts/import-workflows.py --only 10
```

Or import [`workflow.json`](workflow.json) in the n8n editor. Sub-workflow references carry the placeholder `REPLACE_WITH_YOUR_WORKFLOW_ID` and must be relinked — the import script does this automatically.
