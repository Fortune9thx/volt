// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title VoltEscrow
/// @notice The real-funds vault half of Volt's hybrid settlement design.
/// GenLayer (Bradbury) is the ledger and judge: it interprets natural-
/// language Settlement Mandates via multi-validator AI consensus and
/// decides *whether and how much* to settle. It cannot call or verify
/// state on Base directly -- there is no on-chain bridge between the two
/// networks -- so a single trusted `relayer` address executes the real
/// USDC movement here once GenLayer has already finalized a verdict.
///
/// This is a TRUSTED bridge, not a trust-minimized one -- there is still
/// no on-chain light client verifying GenLayer's state from here. But
/// settle/refund are a two-step propose -> execute flow separated by a
/// challenge window, not instant: the relayer only ever PROPOSES a
/// settlement it read off GenLayer's own finalized verdict, and the
/// channel's funder (who can independently read that same GenLayer
/// record via the public explorer or a view call) can dispute a proposal
/// that doesn't match, before any transfer actually happens. This
/// converts "the relayer's word is instant and final" into "the
/// relayer's word is provisional and independently checkable before it
/// takes effect." See SECURITY.md for the full trust-model disclosure.
contract VoltEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct PendingSettlement {
        bytes32 channelId;
        address recipient;
        uint256 amount;
        string kind;
        uint256 proposedAt;
        bool disputed;
        bool executed;
    }

    IERC20 public immutable usdc;
    address public owner;
    address public relayer;
    /// @notice Testnet-tuned default (short, so manual testing stays
    /// practical) -- a production deployment would set this to something
    /// on the order of hours to days via setChallengeWindow.
    uint256 public challengeWindow = 10 minutes;

    mapping(bytes32 => uint256) public channelBalance;
    mapping(bytes32 => address) public channelFunder;
    mapping(bytes32 => PendingSettlement) public pendingSettlements;

    event FundsLocked(bytes32 indexed channelId, address indexed funder, uint256 amount);
    event SettlementProposed(bytes32 indexed key, bytes32 indexed channelId, address indexed recipient, uint256 amount, string kind, uint256 executableAt);
    event SettlementDisputed(bytes32 indexed key, address indexed disputedBy);
    event SettlementExecuted(bytes32 indexed channelId, bytes32 indexed claimId, address indexed recipient, uint256 amount, string kind);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);
    event ChallengeWindowUpdated(uint256 previousWindow, uint256 newWindow);

    error NotOwner();
    error NotRelayer();
    error NotChannelFunder();
    error ZeroAmount();
    error InsufficientChannelBalance();
    error ZeroAddress();
    error NoPendingSettlement();
    error AlreadyExecuted();
    error PendingSettlementExists();
    error SettlementIsDisputed();
    error StillInChallengeWindow();
    error ChallengeWindowElapsed();

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyRelayer() {
        if (msg.sender != relayer) revert NotRelayer();
        _;
    }

    constructor(address usdcAddress, address relayerAddress) {
        if (usdcAddress == address(0) || relayerAddress == address(0)) revert ZeroAddress();
        usdc = IERC20(usdcAddress);
        owner = msg.sender;
        relayer = relayerAddress;
    }

    /// @notice Anyone may lock USDC against a channel. `channelId` must
    /// match the id GenLayer's Volt.create_channel assigned (as a
    /// bytes32, e.g. keccak256 of the string "chn_1"), so the relayer can
    /// unambiguously mirror this lock via Volt.confirm_lock. The FIRST
    /// caller to lock against a given channelId is recorded as its
    /// funder -- the only address later authorized to dispute a proposed
    /// settlement/refund against that channel.
    function lockFunds(bytes32 channelId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (channelFunder[channelId] == address(0)) {
            channelFunder[channelId] = msg.sender;
        }
        channelBalance[channelId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsLocked(channelId, msg.sender, amount);
    }

    /// @notice Relayer-only. Proposes (does not yet execute) the real USDC
    /// transfer for a verdict GenLayer's Volt.execute_settlement already
    /// finalized. Takes effect only after challengeWindow elapses
    /// unopposed -- see executeSettlement/disputeSettlement. `kind` is
    /// purely descriptive for the event log.
    function proposeSettlement(bytes32 claimId, bytes32 channelId, address recipient, uint256 amount, string calldata kind)
        external
        onlyRelayer
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        PendingSettlement storage existing = pendingSettlements[claimId];
        if (existing.executed) revert AlreadyExecuted();
        // A live, undisputed proposal already occupies this key -- refuse
        // to silently clobber it. Only a DISPUTED proposal may be
        // superseded (the relayer re-proposing a corrected settlement).
        if (existing.proposedAt != 0 && !existing.disputed) revert PendingSettlementExists();
        if (channelBalance[channelId] < amount) revert InsufficientChannelBalance();

        pendingSettlements[claimId] = PendingSettlement({
            channelId: channelId,
            recipient: recipient,
            amount: amount,
            kind: kind,
            proposedAt: block.timestamp,
            disputed: false,
            executed: false
        });
        emit SettlementProposed(claimId, channelId, recipient, amount, kind, block.timestamp + challengeWindow);
    }

    /// @notice Relayer-only. Proposes refunding a channel's entire
    /// remaining balance to `recipient` (the funder) once GenLayer's
    /// Volt.close_channel has marked the channel "closing". The amount is
    /// captured NOW, at proposal time, from the contract's own recorded
    /// balance -- the relayer never states it directly, so it can't
    /// misreport how much is owed. Uses the channelId itself as the key,
    /// since a channel can only close (and be refunded) once.
    function proposeRefund(bytes32 channelId, address recipient) external onlyRelayer returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroAddress();
        PendingSettlement storage existing = pendingSettlements[channelId];
        if (existing.executed) revert AlreadyExecuted();
        if (existing.proposedAt != 0 && !existing.disputed) revert PendingSettlementExists();
        amount = channelBalance[channelId];
        if (amount == 0) revert ZeroAmount();

        pendingSettlements[channelId] = PendingSettlement({
            channelId: channelId,
            recipient: recipient,
            amount: amount,
            kind: "channel_refund",
            proposedAt: block.timestamp,
            disputed: false,
            executed: false
        });
        emit SettlementProposed(channelId, channelId, recipient, amount, "channel_refund", block.timestamp + challengeWindow);
    }

    /// @notice Callable only by the channel's recorded funder, who can
    /// independently read GenLayer's own claim/channel record (via the
    /// public explorer or a direct view call) and compare it against what
    /// was proposed here. Cancels the pending proposal before it can
    /// execute -- the relayer may re-propose a corrected settlement
    /// afterward via proposeSettlement/proposeRefund.
    function disputeSettlement(bytes32 key) external {
        PendingSettlement storage pending = pendingSettlements[key];
        if (pending.proposedAt == 0) revert NoPendingSettlement();
        if (pending.executed) revert AlreadyExecuted();
        if (msg.sender != channelFunder[pending.channelId]) revert NotChannelFunder();
        if (block.timestamp >= pending.proposedAt + challengeWindow) revert ChallengeWindowElapsed();
        pending.disputed = true;
        emit SettlementDisputed(key, msg.sender);
    }

    /// @notice Permissionless -- anyone may execute a proposal once its
    /// challenge window has elapsed unopposed (in practice, the relayer's
    /// own watch loop does this, but nothing requires it to be the one).
    /// Re-checks the channel balance at execution time, not just at
    /// proposal time, in case another settlement against the same channel
    /// executed in between.
    function executeSettlement(bytes32 key) external nonReentrant {
        PendingSettlement storage pending = pendingSettlements[key];
        if (pending.proposedAt == 0) revert NoPendingSettlement();
        if (pending.executed) revert AlreadyExecuted();
        if (pending.disputed) revert SettlementIsDisputed();
        if (block.timestamp < pending.proposedAt + challengeWindow) revert StillInChallengeWindow();
        if (channelBalance[pending.channelId] < pending.amount) revert InsufficientChannelBalance();

        pending.executed = true;
        channelBalance[pending.channelId] -= pending.amount;
        usdc.safeTransfer(pending.recipient, pending.amount);
        emit SettlementExecuted(pending.channelId, key, pending.recipient, pending.amount, pending.kind);
    }

    function setRelayer(address newRelayer) external onlyOwner {
        if (newRelayer == address(0)) revert ZeroAddress();
        emit RelayerUpdated(relayer, newRelayer);
        relayer = newRelayer;
    }

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroAddress();
        emit OwnerUpdated(owner, newOwner);
        owner = newOwner;
    }

    /// @notice Owner-adjustable so a production deployment can lengthen
    /// this well beyond the testnet default without redeploying.
    function setChallengeWindow(uint256 newWindow) external onlyOwner {
        emit ChallengeWindowUpdated(challengeWindow, newWindow);
        challengeWindow = newWindow;
    }

    function getChannelBalance(bytes32 channelId) external view returns (uint256) {
        return channelBalance[channelId];
    }

    function getPendingSettlement(bytes32 key) external view returns (PendingSettlement memory) {
        return pendingSettlements[key];
    }
}
