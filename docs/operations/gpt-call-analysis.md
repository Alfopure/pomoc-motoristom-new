# GPT call analysis

The existing transcript-analysis adapter now uses OpenAI Responses with `gpt-5.6-luna` and low reasoning. It creates Slovak summaries and extracts only stated vehicle, location, problem, next-step and phone information. The pipeline does not currently start recordings, import their audio or run the new evidence-based employee rubric.

## Server configuration

- `OPENAI_API_KEY`: server-only OpenAI project credential; never a `NEXT_PUBLIC_` variable.
- `OPENAI_CALL_ANALYSIS_MODEL`: `gpt-5.6-luna` by default; `gpt-5.6-terra` is an explicit alternative. Other values are rejected before a paid request. No automatic model escalation or Anthropic fallback.
- `AI_TRANSCRIPT_ENABLED`: must be exactly `true` for the processing service to submit analysis. Keep it false until the durable processing and access-control work in the recording plan is complete. A key alone never enables analysis.

`TRANSCRIPTS_ENABLED` / the organization's transcription feature is a separate existing gate. No new cron, worker, listener or migration accompanies this release. The synchronous adapter must not be called from the live-call cron: the future recording pipeline uses OpenAI Batch with durable claims and separate cancellation/retention handling.

## Reliability and privacy

Requests have a 45-second timeout, no automatic retries, no redirects and explicit input/output limits. Responses use `store:false` and explicit caching without breakpoints. Incomplete, refused, malformed or oversized responses are errors, never successful empty summaries. Provider error bodies and credentials are not included in application errors.

The current pipeline cannot prove employee identity from speaker order or diarization balance, so it requests no employee scores. The adapter additionally requires independent role and completeness evidence before accepting legacy QA fields. The future seven-criterion rubric, evidence validation, deterministic scoring and human review remain separate work; the compatibility shape is not calibrated employee grading.

AI summaries are written only to transcript records. They are no longer mirrored into broadly readable `motorist_calls.summary`. This prevents new disclosure through that mirror; it does not retrospectively erase older data or resolve every existing transcript authorization/race issue. Those are activation gates for the complete pipeline.

## Model choice and evidence

Comparison used eight synthetic cases, followed by four new cases across SK/CS/EN/DE. An initially ambiguous applicability instruction was corrected; initial model errors and the correction were retained in the QA report. With explicit rules, Luna met the checked criteria in all 12 cases after a manual review of a semantically equivalent time expression. Terra missed the incomplete-call applicability rule in one case. This small smoke comparison supports Luna as the inexpensive starting model, not a claim of universal superiority or calibrated employee scoring.

The actual production adapter was separately exercised on the same 12 synthetic transcripts. A nonnumeric phone-description error was fixed with instructions, schema and runtime validation. No real customer audio, transcripts or employee evaluations were sent for testing.

Standard prices checked on 2026-09-06: Luna $0.20 input / $1.20 output per million tokens; Terra $2 / $12. At 5,000 input and 1,000 billed output tokens per call, Luna analysis costs about $0.0022 per call, or $2.20 per 1,000 calls. The future Batch path is half that token price. These examples exclude speech transcription, telephony, storage, taxes and any regional surcharge; reasoning tokens count as output. Record returned model and measured usage in the future durable pipeline.

Sources: [Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna), [pricing](https://developers.openai.com/api/docs/pricing), [Batch](https://developers.openai.com/api/docs/guides/batch), [data controls](https://developers.openai.com/api/docs/guides/your-data), [prompt caching](https://developers.openai.com/api/docs/guides/prompt-caching). `store:false` is not a promise of zero provider retention or automatic EU residency.
