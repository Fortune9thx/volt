# Volt — Security Model

This document is the pre-submission security artifact for `contracts/Volt.py` (GenLayer) and `evm/contracts/VoltEscrow.sol` (Base Sepolia). Every claim below is backed by a passing test — treat this file as a map to those tests, not a substitute for reading them.

## Trust model (read this first)

Volt is a **hybrid** system: GenLayer (Bradbury) is the ledger and judge — it interprets natural-language Settlement Mandates via multi-validator AI consensus and decides *whether and how much* to settle. Base Sepolia's `VoltEscrow.sol` is the vault — it holds the real USDC.

**There is no on-chain bridge between GenLayer and Base.** A GenVM Intelligent Contract cannot call or cryptographically verify state on a separate L1/L2 the way it can call another contract on its own chain — that would require a light client or a general message-passing protocol (LayerZero, Axelar, Hyperlane, CCIP), which is a materially different scope than this build. Instead, a single **trusted relayer** (`scripts/relayer.mjs`) bridges both directions:

- **Base → GenLayer**: the relayer observes a real `FundsLocked` event on `VoltEscrow` and calls `Volt.confirm_lock(channel_id, base_tx_hash, amount)` to mirror it into GenLayer's ledger.
- **GenLayer → Base**: once `Volt.judge_claim` + `Volt.execute_settlement` have already finalized a verdict (full validator consensus, already reached), the relayer calls `VoltEscrow.settle(...)` to execute the real transfer, then reports back via `Volt.mark_relayed(...)`.

**What this relayer can and cannot do, stated plainly:**
- It has **no independent judgment** — it can only ever execute a `channelId`/`claimId`/`recipient`/`amount` that GenLayer's own multi-validator consensus already decided. It cannot originate a settlement, change an amount, or approve anything itself.
- It **is** a single point of trust for the mirroring step. A compromised or malicious relayer key could: report a lock that never happened (inflating a channel's GenLayer-side balance without real USDC backing it), delay or withhold a legitimate release, or misdirect *which* address a settlement goes to if it lies about the recipient it relays (though the recipient itself is read from GenLayer's own claim record, not chosen freely by the relayer).
- This is disclosed as a genuine, unresolved limitation of a testnet-stage hybrid design, not hidden behind reassuring language. A production version would need either a trust-minimized messaging layer or a economically-bonded/slashable relayer set, neither of which is in scope here.
- Every relayer-facing method (`confirm_lock`, `mark_relayed`, `confirm_channel_closed`) is idempotent via `processed_tx_hashes` / `claim.relayed` / channel status checks — a retried or duplicated relayer call can never double-count a lock or double-execute a settlement, even if the relayer itself is unreliable (crashes, restarts, network retries).

## Access control matrix

| Method | Guard | Enforced by |
|---|---|---|
| `create_channel` | none (permissionless — anyone may create a channel under their own Mandate) | input validation only |
| `confirm_lock` | relayer only | `NOT_RELAYER` |
| `close_channel` | caller must be the channel's `funder` | `NOT_CHANNEL_FUNDER` |
| `confirm_channel_closed` | relayer only | `NOT_RELAYER` |
| `submit_claim` | any party against an `active` channel | `CHANNEL_NOT_ACTIVE` |
| `judge_claim` | permissionless trigger — the verdict carries no discretion for the caller, same reasoning as prior GenLayer builds' keeper pattern | — |
| `execute_settlement` | channel funder, claimant, or contract owner | `NOT_AUTHORIZED_TO_EXECUTE` |
| `mark_relayed` | relayer only | `NOT_RELAYER` |
| `set_relayer` / `pause_contract` / `unpause_contract` | contract owner only | `NOT_OWNER` |

Every row is proven by `tests/direct/test_access_control_matrix.py::TestAccessControlMatrix`, using a random unauthorized wallet and asserting both the revert **and** that state is unchanged afterward.

## Two-stage judgment (fetch-and-extract → binding gate → intent)

Volt's Mandate is arbitrary natural language, not a fixed schema (unlike a flight/weather product), so Stage A cannot hardcode which external API to call. Instead:

- **Stage A** (`_extract_settlement_facts`) fetches each evidence URL the *claimant themselves* submitted (`gl.nondet.web.get`, plain HTTP — chosen over `.render()` for the same rendering-latency reason proven in prior GenLayer builds: full browser rendering on every validator is the dominant cost, not the specific URL), sanitizes the fetched content, and has the model extract only `facts_summary`/`supports_claim` from that real fetched text — never a free assertion. A claim whose evidence URLs can't be fetched at all fails closed (`fetch_ok: False`).
- **Binding gate**: Stage B never runs unless `fetch_ok` and `supports_claim` are both true. A claim with no verifiable evidence is rejected deterministically before any intent judgment.
- **Stage B** (`judge_intent`, via `gl.eq_principle.prompt_non_comparative`) judges the Mandate's intent against those already-agreed facts, and must return `outcome_type` (`full`/`partial`/`refund`), a payout amount never exceeding the requested amount, a quoted confidence string, and one-sentence reasoning.
- **Confidence gate**: `outcome_type` is forced to `refund` if confidence falls below `CONFIDENCE_THRESHOLD` (0.85).
- **`approved_amount_usdc` omission handling**: an omitted (not wrong) amount on an otherwise-valid `full`/`partial` approval falls back to the requested amount for `full`, `0` otherwise — never trusted to exceed the requested amount either way. This mirrors a live-discovered, live-fixed finding from a prior GenLayer production build: a well-formed, correctly-reasoned model response can validly omit an optional-looking field, and treating that identically to an explicit wrong value causes false rejections of genuinely correct settlements. An *explicit* wrong amount still forces `refund`.

## Malformed-output handling (fail-closed)

- `judge_claim`'s `outcome_str` is defensively parsed: non-JSON or non-dict output degrades to a safe `refund` default, never a crash or a default approval.
- `outcome_type` is validated against a closed enum (`full`/`partial`/`refund`) — anything else coerces to `refund`.
- `confidence` is requested as a quoted JSON string (GenVM calldata has no float type; a bare decimal in the model's own JSON output would become a Python `float` and fail at the next `gl_call` boundary).

## State-machine invariants

- **Idempotent judgment**: `judge_claim` requires `claim.status == "pending"` — an already-judged claim can never be re-judged.
- **Idempotent execution**: `execute_settlement` requires `claim.status == "judged"` — a claim can never be executed twice.
- **Idempotent relay**: `mark_relayed` requires `status == "executed"` and `relayed == False`.
- **Two-phase channel closure**: `close_channel` (funder) only moves a channel to `"closing"`, never directly to `"closed"` — the real USDC refund on Base hasn't happened yet at that point. Only the relayer's `confirm_channel_closed` (after executing the real Base-side refund) finalizes `"closed"`.
- **Idempotent cross-chain events**: every relayer-facing method requires a fresh `base_tx_hash` via `processed_tx_hashes` — the same Base transaction can never be mirrored into GenLayer's ledger twice.

## Fund safety

- GenLayer never custodies real funds in this design — `create_channel`/`submit_claim`/`judge_claim`/`execute_settlement` are all non-payable. `channel.balance_units` is a mirror of what `VoltEscrow` actually holds, updated only by the relayer's `confirm_lock`/`execute_settlement`'s own decrement.
- On the Base side, `VoltEscrow.sol` uses OpenZeppelin's `SafeERC20` (handles non-standard ERC-20 return values safely) and `ReentrancyGuard` on every state-mutating function, with CEI ordering (state updated — `claimSettled`, `channelBalance` — before the external `safeTransfer` call).
- `settle`/`refundChannel` both require `!claimSettled[key]` before paying out, and `channelBalance[channelId] >= amount` before debiting — a channel can never be drained below zero, and a claim/channel-close can never be paid out twice.

## Known limitations

1. **Trusted relayer, not a trust-minimized bridge** — see "Trust model" above. This is the single most important disclosed limitation of this design.
2. **No live cross-chain end-to-end test coverage in `gltest`** — inherent to the test harness (GenLayer's direct-mode WASI mock has no hook for calling out to a separate chain); Base-side behavior is covered by Hardhat's own test suite (`evm/test/VoltEscrow.test.ts`) instead, and the two are verified independently, not as one atomic transaction.
3. **LLM consensus proves agreement, not correctness** — inherent to any LLM-adjudicated contract, disclosed the same way in every prior GenLayer build in this series.
4. **Base Sepolia's USDC address is not hardcoded** — `evm/scripts/deploy.ts` requires it as an explicit env var, verified against Circle's own test-network docs at deploy time, rather than trusting a possibly-stale hardcoded address.
5. **The relayer is currently a single script/key**, run manually or via `--watch`; it is not yet a redundant, monitored, always-on service. Acceptable for a testnet submission; a production deployment would need operational hardening (alerting, key rotation, multiple relayer candidates with a fallback).

## Running the tests

```bash
pip install genlayer-test genvm-linter
genvm-lint check contracts/Volt.py
gltest tests/direct -v
```

```bash
cd evm
npm install
npm run compile
npm test
```
