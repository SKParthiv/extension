# Observation capture

Observations are stored as ordinary context blocks with `source_type = 'observation'` and a provenance string that identifies the originating turn, tool result, or file location. They are always attached to the current session in `inbox` status with no priority and are not selected automatically by the context selector until the user promotes them.

The `ContextService.captureObservation` method is the single write path for this behavior. It preserves an optional `originalRef` so the UI can later link an observation back to its source without rewriting the captured text.

