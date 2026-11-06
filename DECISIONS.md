# Retrieval decisions

- Persisting a conversation ID hands submission over to retrieval immediately; an open event stream must not delay polling. Retrieval retains the existing account binding, owner lock, cooldown, one-hour wedge floor, and six-hour deadline.
- Completed answer selection excludes messages only when `metadata.is_visually_hidden_from_conversation === true`. Hidden final messages can accompany a visible research answer; multiple distinct visible answers remain ambiguous and are rejected.
