# Volt

**Settlement that only moves when reality agrees.**

**Live app:** [volt-x9.vercel.app](https://volt-x9.vercel.app) _(deploying)_
**Live contract (GenLayer Bradbury):** [`0x2759203ccc24aAcdAC3D537F912A1D8F30c6B0Ea`](https://explorer-bradbury.genlayer.com/address/0x2759203ccc24aAcdAC3D537F912A1D8F30c6B0Ea)
**Live escrow (Base Sepolia):** [`0x60d692A8731E90A241605644A653ECdCfa31D549`](https://sepolia.basescan.org/address/0x60d692A8731E90A241605644A653ECdCfa31D549)

## What Volt does

Classical oracles (Chainlink, Pyth, UMA) can price an asset. They cannot read a shipment tracking page, a court filing, or interpret an arbitrary natural-language agreement. Volt is a settlement network where money only moves when GenLayer's multi-validator AI consensus confirms that a real-world condition — described in plain English as a **Settlement Mandate** — has genuinely been met.

The core loop:
1. **Create a Channel** with a natural-language Mandate and lock USDC against it.
2. **Submit a Settlement Claim** with evidence pointers (URLs) as a real-world event happens.
3. Volt's Intelligent Contract fetches the evidence itself and runs a two-stage, multi-validator judgment.
4. On consensus, **execute settlement** — full release, partial, or refund.
5. The **channel stays open** for further claims under the same Mandate — this isn't a one-shot bet.

## Quality-bar mapping

- **Solves a real trust problem** — payment for anything beyond a simple price feed currently relies on a trusted counterparty or a centralized oracle. Volt lets that trust be replaced by decentralized AI consensus reasoning over the claimant's own submitted evidence.
- **Live, authoritative data on every judgment** — Stage A fetches each evidence URL the claimant submits (`gl.nondet.web.get`, in contract code) before any interpretation happens; a claim with no fetchable evidence fails closed.
- **Complete source, accurate docs** — this README + `SECURITY.md` map every claim to a test.
- **Frontend genuinely calls the contract** — every write (`create_channel`, `submit_claim`, `judge_claim`, `execute_settlement`, the Base-side `lockFunds`) goes through real wallet transactions with loading/success/error states, not a mock.
- **Reusable settlement infrastructure** — a channel isn't tied to one claim; it's a standing, continuously-usable settlement primitive for any Mandate.

## Architecture — a hybrid, honestly disclosed

GenLayer cannot call or verify state on a separate chain natively — there's no on-chain bridge between an Intelligent Contract and an EVM L2 like Base. So Volt splits responsibility deliberately:

- **GenLayer (Bradbury)** — `contracts/Volt.py` is the **ledger and judge**. It never custodies real funds; `channel.balance_units` mirrors what's actually locked on Base. Two-stage judgment: Stage A fetches and verifies the claimant's own evidence (fail-closed); Stage B (`gl.eq_principle.prompt_non_comparative`) judges the Mandate's intent against those already-agreed facts.
- **Base Sepolia** — `evm/contracts/VoltEscrow.sol` is the **vault**. It holds the real USDC (OpenZeppelin `SafeERC20` + `ReentrancyGuard`, full CEI ordering).
- **`scripts/relayer.mjs`** — a **trusted relayer** bridges both directions: it observes real `FundsLocked` events on Base and mirrors them into GenLayer (`confirm_lock`), and executes GenLayer's already-finalized verdicts as real Base-side transfers (`settle`/`refundChannel`), reporting back via `mark_relayed`.

**This is disclosed explicitly as a trusted bridge, not a trust-minimized one** — the relayer has no independent judgment (it can only ever execute a verdict GenLayer's own consensus already reached), but it is a real, single point of trust for the mirroring step. See `SECURITY.md`'s "Trust model" for the full disclosure, including exactly what a compromised relayer could and couldn't do.

```
contracts/Volt.py                  GenLayer Intelligent Contract: channels, claims, judgment
evm/contracts/VoltEscrow.sol       Base Sepolia vault: real USDC custody
evm/contracts/test/MockUSDC.sol    Test-only ERC-20 for Hardhat's local test suite
scripts/relayer.mjs                The trusted bridge between both chains
scripts/deploy.mjs                 Deploys Volt.py to GenLayer
evm/scripts/deploy.ts              Deploys VoltEscrow.sol to Base Sepolia
tests/direct/                      gltest suite (12 tests)
evm/test/                          Hardhat suite (8 tests)
app/                               Next.js 16 App Router pages
lib/genlayer.ts                    genlayer-js client + typed contract wrappers
lib/base.ts                        viem client for the Base Sepolia leg (lockFunds)
lib/WalletContext.tsx              EIP-6963 multi-wallet connect state
SECURITY.md                        Trust model, access control, known limitations
```

## Running locally

```bash
npm install
npm run dev
```

Point `.env` (see `.env.example`) at the live addresses above and connect a wallet on GenLayer Bradbury.

**Contract tests:**

```bash
pip install genlayer-test genvm-linter
genvm-lint check contracts/Volt.py
gltest tests/direct -v
```

**EVM tests:**

```bash
cd evm
npm install
npm test
```

## Deploying your own instance

```bash
node scripts/deploy.mjs                          # Volt.py -> GenLayer Bradbury
cd evm && npm run deploy:base-sepolia             # VoltEscrow.sol -> Base Sepolia
node scripts/relayer.mjs                          # one pass, or --watch to poll continuously
```

Never trust a deploy script's own success message alone — `scripts/peek-tx.mjs`/`probe-contract.mjs` independently verify a GenLayer deploy actually reached consensus and is readable.

## Security highlights

Full detail in [SECURITY.md](./SECURITY.md). In summary:

- **Fetch-and-authenticate evidence, not a free assertion** — Stage A fetches every evidence URL the claimant submits themselves, in contract code, before any LLM interpretation; a claim with unfetchable evidence fails closed.
- **Two-stage, confidence-gated judgment** — Stage B never runs unless Stage A's independent leader/validator extraction agrees the evidence is real and on-topic.
- **Idempotent bridge in both directions** — every relayer-facing method (`confirm_lock`, `mark_relayed`, `confirm_channel_closed`) is guarded by a processed-tx-hash ledger; a retried or duplicated relayer call can never double-count a lock or double-execute a settlement.
- **Two-phase channel closure** — `close_channel` only moves a channel to `"closing"`; only the relayer's `confirm_channel_closed`, after the real Base-side refund executes, finalizes `"closed"`.
- **Full access-control matrix** — every protected write is guarded, proven by a funded-random-wallet test suite that asserts both the revert and that state is unchanged.
- **Trusted relayer, disclosed not hidden** — the single most important limitation of this design; see SECURITY.md for exactly what it can and can't do.

## Built on GenLayer + Base

Volt is an Intelligent Contract application built for [GenLayer](https://genlayer.com)'s multi-validator AI consensus, with real USDC settlement on [Base](https://base.org) Sepolia.

## License

MIT — see [LICENSE](./LICENSE).

## Author

Built and maintained solely by [Fortunex9](https://github.com/Fortune9thx).
