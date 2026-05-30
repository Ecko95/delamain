# state.json schema

The live state file. Read and rewritten atomically every tick. Every field is required unless marked optional.

```json
{
  "schema_version": 1,
  "halted": false,
  "halted_reason": null,
  "current_slice_id": "H0.0",
  "current_slice_index": 0,
  "current_peer_id": "a9f9a0a3",
  "current_merge_branch": "autopilot/h0.0-bootstrap",
  "current_pushed_sha": "",
  "last_origin_main_sha": "24209e9fdc0495f40d6ade2709d9e8886a8a7670",
  "notified_events": [
    "spawn:a9f9a0a3"
  ],
  "history": [
    {
      "slice_id": "H0.0",
      "peer_id": "a9f9a0a3",
      "merge_branch": "autopilot/h0.0-bootstrap",
      "spawned_at": "2026-05-09T22:52:16.027Z",
      "outcome": null
    }
  ]
}
```

## Field reference

| Field | Type | Purpose |
|---|---|---|
| `schema_version` | int | Bump if the shape changes. Currently `1`. |
| `halted` | bool | If true, ticks no-op until cleared. |
| `halted_reason` | string \| null | Free text; written by the supervisor when it halts. |
| `current_slice_id` | string | Slice ID from handoffs.tsv (e.g. "H0.0"). |
| `current_slice_index` | int | 0-based row index in handoffs.tsv. Used by `spawn_next` to pick row `index + 1`. |
| `current_peer_id` | string | codex-peers peer ID currently in flight. |
| `current_merge_branch` | string | Origin branch the current peer pushes to and the auto-PR targets. |
| `current_pushed_sha` | string | Peer's HEAD SHA captured when integration moves to `pushed`. Used by `git cherry` patch-id check after rebase/squash merges. Empty before integration. |
| `last_origin_main_sha` | string | SHA of `origin/<default>` last observed. Tick advances this when an unrelated commit lands; spawn_next advances this when our merge lands. |
| `notified_events` | array of string | Idempotency keys for Telegram. See "Event keys" below. |
| `history` | array of object | One entry per spawned peer with eventual outcome. |

## history entry shape

```json
{
  "slice_id": "H0.0",
  "peer_id": "a9f9a0a3",
  "merge_branch": "autopilot/h0.0-bootstrap",
  "spawned_at": "2026-05-09T22:52:16.027Z",
  "outcome": null
}
```

`outcome` values:
- `null` — still in flight
- `"pushed"` — peer reached done+pushed (auto-review pending)
- `"merged"` — PR landed in default branch
- `"merge-failed"` — peer's integration step failed; chain halted
- `"failed" | "frozen" | "killed"` — peer ended badly; chain halted

## Event keys (idempotency)

| Key | Fired when |
|---|---|
| `spawn:<peer_id>` | Supervisor spawned a peer or attached to one. |
| `waiting:<peer_id>:<lastEvent>` | Peer emitted `CODEX_PEERS_STATUS: WAITING`. Re-fires if `lastEvent` changes. |
| `auto-merged:<peer_id>` | Auto-review passed and PR was merged. |
| `merged:<peer_id>` | Default branch advanced and the slice's branch landed. |
| `merge-failed:<peer_id>` | Peer's runner reported `integrationStatus: failed`. |
| `failed:<peer_id>` / `frozen:<peer_id>` / `killed:<peer_id>` | Peer terminal status other than `done`. |

## Recovery operations

- **Clear halt:** set `halted = false`, set `halted_reason = null`. Next tick resumes from `current_*` fields.
- **Skip a slice:** advance `current_slice_index` by 1, set `current_slice_id` and `current_merge_branch` to match handoffs.tsv row, clear `current_peer_id` and `current_pushed_sha`. Next tick spawns from there. Add a manual history entry to record the skip.
- **Re-spawn current slice:** set `current_peer_id = ""` and `halted = false`. Next tick will return early on missing peer; trigger spawn manually using `codex-peers spawn` and update state, or run the bootstrap workflow's spawn step.
- **Reset event dedupe:** never delete `notified_events` entries — they're cheap and idempotency relies on them.
