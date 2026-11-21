# Recoverable MCP wake claims (proposal, not production behavior)

Noun: Bot reach. Extend existing push_state; retire clearing MCP delivery intent at claim time. No new service, queue or external dependency. This is a design/test artifact, not a migration or implementation approval.

## Proposed fields and invariants

Retain pending_since as unacknowledged work eligibility. Add monotonic claim_fence, claim_until, claim_wake, claim_changed_at and acknowledged_wake. A claim freezes a wake counter and its stored occurrence time. The lease is DB-clock based and longer than the maximum bounded send/record phase. Fence ownership is required for all completion mutations. Every wake bump and its pending update remain transactional. Active claim excludes competing drains, even if a newer arrival is already pending.

## Transactions

1. Claim: lock push_state with SKIP LOCKED; inspect live methods and limits. If eligible and no unexpired claim, snapshot wake_counters atomically, increment fence, set lease and snapshot. Do NOT clear pending. All reads/updates have one documented lock order. A newer pending wake can replace an expired claim's snapshot because wake is an invalidation, not an arrival log.
2. Cap reservation: consume provider/host allowance once per actual attempt, before network. Denied allowance leaves pending and sets earliest eligibility without creating a runnable claim. A crash after cap reservation may waste allowance; never refund an uncertain reservation, and recovery may reserve again. Honor per-method gap, not just generic push gap. Fence recheck before send reduces stale attempts but cannot retract a request already in flight.
3. Send: outside transaction, using immutable snapshot and bounded deadline. Record outcome for the exact subscription generation (PR153), not a replacement. Stable event identity uses public subscription identity + handle/wake, with snapshot occurrence time (PR155). Signing timestamp is per attempt.
4. Acknowledge: lock state; if fence mismatches, no mutation. On receipt satisfying the configured reach policy, advance acknowledged_wake to claim_wake. Existing successful fallback may satisfy that policy without MCP receipt. If the subscription changed during delivery, do not interpret the old subscription’s receipt as receipt by its replacement; outstanding-wake disposition remains a model-review decision. Clear pending only if current counter <= acknowledged_wake; otherwise preserve the newer arrival. Clear owned lease. This is at-least-once delivery, never exactly-once external execution.
5. Retry: A transient MCP failure or unknown outcome leaves intent pending, subject to bounded retry policy; a durably recorded terminal outcome suppresses retries for its method and delivery scope. If recording fails completely, lease expiry is recovery. Known transient outcome sets next eligibility according to bounded retry policy; unknown outcome is retried with stable event identity. Permanent 410/413, revocation, freeze and pause need explicit disposition: no immediate retry for that method. Do not retry a durably recorded 413 on lease recovery. A response lost before durable recording remains an unknown outcome and may be retried. Completion and terminal disposition must be durable before releasing claim.
6. Recovery: a later drain reclaims expired leases. No traffic or host invocation means no progress guarantee. Stable identity protects ambiguous duplicate deliveries, but client write tools must still be idempotent.

## Compatibility and unresolved choices

- PR153 generation fencing remains required. A stale subscription response must not end or change counters for its replacement. Define whether a new subscription should receive an outstanding old wake; do not assume replacement means receipt.
- PR155 identity persists across restart/secret refresh. Same wake snapshot keeps occurrence time; a newer counter is a new coalesced event. Handle and public subscription identity must remain stable during each attempt.
- Preserve generic push's existing best-effort/non-retry policy. Apply recovery to claims with MCP delivery intent, not automatically to push-only bots. Mixed-method success currently ends retry; retain that until the owner/model explicitly changes it. A failed generic push must not erase MCP intent.
- Lease duration, bounded retry exhaustion, and terminal-outcome recovery need explicit decisions and DB tests. Recording a 413 after sending is itself crash-vulnerable: if the process dies before persisting it, the server cannot know the response. State the unavoidable at-least-once ambiguity rather than promise zero 413 repeats under process loss.
- Existing counter shape uses bigint and application numbers; preserve precision limits or separately address bigint serialization. Counter/time snapshot must be one SQL read.
- No new user-facing scheduling promise. This contract needs model review and DB migration/HTTP tests before a production PR.

## Regression plan

Executable toy tests cover: crash after claim before send; record exception after transient send; accepted response loss and stable retry identity; newer arrival during older completion; stale fence completion; expired claim coalescing. They intentionally do not model SQL locking, transport, caps, multiple adapters, terminal errors or production clocks.

Production tests must additionally cover two drains racing, late old completion after lease reclaim, subscription/key rotation during send, 413/410 disposition, paused methods, provider cap denial/reservation loss, DB failure at each transition, kill switch, and mixed-method fallback. Use HTTP fake receiver plus DB assertions and restart injection, not only mocked rows.
