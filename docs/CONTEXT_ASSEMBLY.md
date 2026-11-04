# Explainable context assembly

`assembleContext` combines the local Context Manager primitives into a single deterministic result:

- selected blocks and their selection reasons;
- omitted blocks and the `budget` reason;
- possible structured conflicts without choosing a winner;
- bounded local retrieval snippets with matched-term reasons.

The result is an explanation payload for the UI and runtime boundary. It does not mutate SQLite state and does not send content to TrueForge by itself.

