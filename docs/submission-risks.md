# Production risks

1. **Privacy and consent.** Live audio is sent to a speech provider, and resume
   and job-description text is sent to an LLM provider. Before production, add
   clear consent, document vendor retention and data residency, minimize stored
   data, and provide deletion and retention controls.

2. **Accuracy and interview policy.** English heuristics can miss split
   questions, react to rhetorical questions, or mistake the candidate's voice
   for the interviewer because microphone and tab audio are mixed. Validate
   against real transcripts, separate speaker channels or add diarization, and
   make the product's permitted-use expectations clear.

3. **Security and reliability at scale.** The POC has no authentication,
   stores sessions in process memory, and depends on external providers. Add
   authenticated session ownership, TLS and secret management, quotas and
   provider fallback; move session state to shared storage before running
   multiple instances.
