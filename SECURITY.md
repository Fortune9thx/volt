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

**Why GenLayer itself never calls a native transfer here, unlike a single-chain escrow contract:** a GenLayer Intelligent Contract on Bradbury can custody and move GEN, or emit a transfer to an EOA on its own chain — but it has no way to hold or move USDC on Base, because Base isn't GenLayer's chain. There is no `gl.transfer`-equivalent that reaches across chains without exactly the kind of relayer/message-passing layer described above. So the choice here isn't "we forgot to wire up a payable method" (a narrow, single-line fix on a single-chain contract) — it's the structural fact that a genuine cross-chain settlement product has to put real custody on the chain the asset actually lives on, and use *some* bridging mechanism to let GenLayer's verdict reach it. This build picks the simplest honestly-disclosed one (a single trusted relayer) rather than a more elaborate trust-minimized bridge, because the latter is a materially larger, separate scope (see above). If Volt instead custodied GEN natively, `judge_claim`/`execute_settlement` could call `gl.transfer`/an EOA emit directly and this entire trust-model section would be unnecessary — that tradeoff (native GEN, single-chain, fully on-chain custody vs. cross-chain USDC via a disclosed bridge) is a product decision, not an oversight, and is exactly what "settlement that only moves when reality agrees" requires in order to settle a real-world-denominated asset rather than only GenLayer's own native token.

## Access control matrix

| Method | Guard | Enforced by |
|---|---|---|
| `create_channel` | none (permissionless — anyone may create a channel under their own Mandate) | input validation only |
| `confirm_lock` | relayer only | `NOT_RELAYER` |
| `close_channel` | caller must be the channel's `funder` | `NOT_CHANNEL_FUNDER` |
| `confirm_channel_closed` | relayer only | `NOT_RELAYER` |
| `submit_claim` | caller must be the channel's `funder` or a listed `party` against an `active` channel | `NOT_CHANNEL_PARTY` / `CHANNEL_NOT_ACTIVE` |
| `judge_claim` | permissionless trigger — the verdict carries no discretion for the caller, same reasoning as prior GenLayer builds' keeper pattern | — |
| `execute_settlement` | channel funder, claimant, or contract owner | `NOT_AUTHORIZED_TO_EXECUTE` |
| `mark_relayed` | relayer only | `NOT_RELAYER` |
| `set_relayer` / `pause_contract` / `unpause_contract` | contract owner only | `NOT_OWNER` |

Every row is proven by `tests/direct/test_access_control_matrix.py::TestAccessControlMatrix`, using a random unauthorized wallet and asserting both the revert **and** that state is unchanged afterward.

## Two-stage judgment (fetch-and-extract → binding gate → intent)

Volt's Mandate is arbitrary natural language, not a fixed schema (unlike a flight/weather product), so Stage A cannot hardcode which external API to call. Instead:

- **Stage A** (`_extract_settlement_facts`) fetches each evidence URL the *claimant themselves* submitted (`gl.nondet.web.get`, plain HTTP — chosen over `.render()` for the same rendering-latency reason proven in prior GenLayer builds: full browser rendering on every validator is the dominant cost, not the specific URL), sanitizes the fetched content, and has the model extract only `facts_summary`/`supports_claim` from that real fetched text — never a free assertion. A claim whose evidence URLs can't be fetched at all fails closed (`fetch_ok: False`).
- **Binding gate**: Stage B never runs unless `fetch_ok` and `supports_claim` are both true. A claim with no verifiable evidence is rejected deterministically before any intent judgment.
- **Stage B** (`judge_intent`, via `gl.eq_principle.prompt_comparative`) judges the Mandate's intent against those already-agreed facts, and must return `outcome_type` (`full`/`partial`/`refund`), a quoted confidence string, and one-sentence reasoning.
- **Confidence gate**: `outcome_type` is forced to `refund` if confidence falls below `CONFIDENCE_THRESHOLD` (0.85).
- **The exact USDC amount is never a free-typed model field.** `full` always pays exactly the requested amount; `refund` always pays `0`; both are fully deterministic regardless of anything the model outputs. `partial` is the only case with any model discretion, and it's constrained to choosing one of three fixed buckets — `partial_percent` must be exactly `25`, `50`, or `75` — with the actual `approved_amount_units` then computed in contract code (`requested_usdc * partial_percent // 100`), never trusted directly from the model's JSON. A `partial` verdict with any other percent is refused (`refund`, `0`), not guessed at.
- **Why `prompt_comparative`, not `prompt_non_comparative`:** an earlier version of this contract used `prompt_non_comparative`, whose validator only checks the *leader's* answer against a qualitative rubric — independently of what the validator's own re-derivation of the same task would have concluded. That means two materially different payout decisions (e.g. leader says 80% justified, validator's own independent judgment says 40%) can both "satisfy the criteria" and pass, since nothing requires them to agree with each other, only individually with the rubric. This is a real, previously-seen GenLayer rejection pattern ("materially different payments can pass under the same qualitative verdict"). `prompt_comparative` instead asks the model to judge whether the leader's answer and the validator's own independent answer describe the *same* decision, under an explicit `principle` that names exactly which fields must match (`outcome_type`, and `partial_percent` when `partial`) and which must not matter (reasoning wording, exact confidence value). Combined with collapsing `partial` to three named buckets, this is what actually binds the fund-moving number to consensus rather than to either party's free-typed integer.

## Address normalization

Every stored and compared address (`funder`, `parties`, `claimant`, `owner`, `relayer`) is lowercased via a single `_addr()` helper before storage or comparison. Without this, a value derived from GenLayer's own canonical `str(Address)` (which may be EIP-55 checksummed mixed-case) compared against a raw, unnormalized address string from a connected wallet (`eth_requestAccounts`, commonly lowercase) silently fails to match — a genuine party would see an empty dashboard or an "unknown party" rejection with no indication of why. This is a confirmed, previously-seen real GenLayer rejection pattern; `tests/direct/test_access_control_matrix.py::test_list_channels_by_party_matches_regardless_of_wallet_address_case` proves the fix by querying with both a lowercase and an uppercase-hex form of the same address. Lowercasing is safe for comparison purposes because EIP-55 checksum casing encodes no information beyond the same underlying hex digits.

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
6. **Stage B's `prompt_comparative` validator cannot be independently exercised in `gltest` direct-mode.** The test harness's `ExecPromptTemplate` mock (see `tests/direct/conftest.py`) stubs the real GenVM node's "EqComparative" judgment entirely — it cannot simulate the node genuinely comparing two independently-produced answers and voting false on a real mismatch, the same class of gap already documented for `gl.eq_principle.strict_eq`'s `spawn_sandbox` dependency. What *is* independently provable in this harness, and covered by `tests/direct/test_judgment_consensus.py`, is: (a) Stage A's hand-written `run_nondet_unsafe` validator, which does not depend on `ExecPromptTemplate` and genuinely re-fetches/re-extracts under swapped mocks via `direct_vm.run_validator()`; and (b) the deterministic bucket arithmetic that turns a model's `partial_percent` into `approved_amount_units`, which is ordinary contract-code logic with no eq_principle involvement. `prompt_comparative`'s own cross-validator agreement behavior is asserted by reading the SDK source (`genlayer/gl/eq_principle.py`) and cited above, not demonstrated by a passing direct-mode test — disclosed here rather than left implicit.

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
