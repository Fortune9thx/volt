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
/// This is a TRUSTED bridge, not a trust-minimized one. The relayer never
/// has independent judgment (it can only execute a channelId/claimId/
/// amount that GenLayer's own consensus already decided), but a
/// compromised or malicious relayer key could still misreport a lock or
/// withhold/misdirect a release. See SECURITY.md for the full disclosure.
contract VoltEscrow is ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    address public owner;
    address public relayer;

    mapping(bytes32 => uint256) public channelBalance;
    mapping(bytes32 => bool) public claimSettled;

    event FundsLocked(bytes32 indexed channelId, address indexed funder, uint256 amount);
    event SettlementExecuted(bytes32 indexed channelId, bytes32 indexed claimId, address indexed recipient, uint256 amount, string kind);
    event RelayerUpdated(address indexed previousRelayer, address indexed newRelayer);
    event OwnerUpdated(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotRelayer();
    error ZeroAmount();
    error InsufficientChannelBalance();
    error ClaimAlreadySettled();
    error ZeroAddress();

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
    /// unambiguously mirror this lock via Volt.confirm_lock.
    function lockFunds(bytes32 channelId, uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        channelBalance[channelId] += amount;
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit FundsLocked(channelId, msg.sender, amount);
    }

    /// @notice Relayer-only. Executes the real USDC transfer for a verdict
    /// GenLayer's Volt.execute_settlement already finalized. `kind` is
    /// purely descriptive for the event log ("release" or "refund") --
    /// this function doesn't distinguish behavior by kind, only by the
    /// recipient/amount the relayer (mirroring GenLayer's own decision)
    /// supplies.
    function settle(bytes32 channelId, bytes32 claimId, address recipient, uint256 amount, string calldata kind)
        external
        onlyRelayer
        nonReentrant
    {
        if (recipient == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroAmount();
        if (claimSettled[claimId]) revert ClaimAlreadySettled();
        if (channelBalance[channelId] < amount) revert InsufficientChannelBalance();

        claimSettled[claimId] = true;
        channelBalance[channelId] -= amount;
        usdc.safeTransfer(recipient, amount);
        emit SettlementExecuted(channelId, claimId, recipient, amount, kind);
    }

    /// @notice Relayer-only. Refunds a channel's entire remaining balance
    /// to `recipient` (the funder) once GenLayer's Volt.close_channel has
    /// marked the channel "closing". Uses the channelId itself (not a
    /// claimId) as the settled-once key, since a channel can only close once.
    function refundChannel(bytes32 channelId, address recipient) external onlyRelayer nonReentrant returns (uint256 amount) {
        if (recipient == address(0)) revert ZeroAddress();
        if (claimSettled[channelId]) revert ClaimAlreadySettled();
        amount = channelBalance[channelId];
        if (amount == 0) revert ZeroAmount();

        claimSettled[channelId] = true;
        channelBalance[channelId] = 0;
        usdc.safeTransfer(recipient, amount);
        emit SettlementExecuted(channelId, channelId, recipient, amount, "channel_refund");
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

    function getChannelBalance(bytes32 channelId) external view returns (uint256) {
        return channelBalance[channelId];
    }
}
