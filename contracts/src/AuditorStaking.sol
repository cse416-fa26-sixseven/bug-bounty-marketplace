// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

/// @title AuditorStaking
/// @notice Holds each auditor's ETH stake and reputation score. A stake of at
/// least REQUIRED_STAKE makes an auditor's submissions eligible for payout (R9)
/// and is required to open a submission (lockSubmission).
/// Slashing and reputation changes are only applied by the DisputeResolution
/// contract, once it is bound.
contract AuditorStaking {
    /// @notice Minimum stake to open a submission and for it to be eligible
    /// for payout.
    uint256 public constant REQUIRED_STAKE = 0.1 ether;

    /// @notice Backend role that opens and closes submissions for an auditor.
    /// Also the only address allowed to bind DisputeResolution.
    address public immutable operator;

    /// @notice The DisputeResolution contract allowed to slash and adjust
    /// reputation. Zero until bound.
    address public disputeResolution;

    mapping(address => uint256) public stakeOf;
    mapping(address => int256) public reputation;

    /// @notice Open submissions per auditor. Withdrawal is blocked while
    /// this is non-zero.
    mapping(address => uint256) public activeSubmissions;

    error NotOperator();
    error NotDisputeResolution();
    error AlreadyBound();
    error ZeroAddress();
    error ZeroAmount();
    error ActiveSubmissions();
    error NoActiveSubmission();
    error InsufficientStake(uint256 available, uint256 requested);
    /// @notice The auditor's stake is below REQUIRED_STAKE, so no submission
    /// can be opened for them. `stake` is their stake at the time of the call.
    error StakeBelowRequired(address auditor, uint256 stake);
    error TransferFailed();

    event DisputeResolutionBound(address indexed disputeResolution);
    event Staked(address indexed auditor, uint256 amount, uint256 total);
    event Withdrawn(address indexed auditor, uint256 amount, uint256 remaining);
    event Slashed(address indexed auditor, uint256 amount, address indexed recipient);
    event ReputationChanged(address indexed auditor, int256 delta, int256 total);
    event SubmissionLocked(address indexed auditor, uint256 active);
    event SubmissionUnlocked(address indexed auditor, uint256 active);

    modifier onlyOperator() {
        if (msg.sender != operator) revert NotOperator();
        _;
    }

    modifier onlyDisputeResolution() {
        if (msg.sender != disputeResolution) revert NotDisputeResolution();
        _;
    }

    constructor(address _operator) {
        if (_operator == address(0)) revert ZeroAddress();
        operator = _operator;
    }

    /// @notice Binds the DisputeResolution contract. Can only happen once.
    function bindDisputeResolution(address _disputeResolution) external onlyOperator {
        if (disputeResolution != address(0)) revert AlreadyBound();
        if (_disputeResolution == address(0)) revert ZeroAddress();
        disputeResolution = _disputeResolution;
        emit DisputeResolutionBound(_disputeResolution);
    }

    /// @notice Deposits ETH as stake for the caller.
    function stake() external payable {
        if (msg.value == 0) revert ZeroAmount();
        stakeOf[msg.sender] += msg.value;
        emit Staked(msg.sender, msg.value, stakeOf[msg.sender]);
    }

    /// @notice True when the auditor's stake meets the payout threshold.
    function isEligible(address auditor) public view returns (bool) {
        return stakeOf[auditor] >= REQUIRED_STAKE;
    }

    /// @notice Withdraws part or all of the caller's stake. Blocked while the
    /// caller has an open submission.
    function withdraw(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (activeSubmissions[msg.sender] != 0) revert ActiveSubmissions();

        uint256 available = stakeOf[msg.sender];
        if (amount > available) revert InsufficientStake(available, amount);

        // Effects before the external call.
        stakeOf[msg.sender] = available - amount;
        emit Withdrawn(msg.sender, amount, stakeOf[msg.sender]);

        _send(msg.sender, amount);
    }

    /// @notice Marks a submission as open for an auditor, blocking withdrawal.
    /// @dev Reverts with StakeBelowRequired unless the auditor's stake meets
    /// REQUIRED_STAKE at the time of the call, so the operator cannot open a
    /// submission for an unstaked auditor. The check is made only here: a
    /// slash can take the stake below the threshold while submissions are
    /// open, and those stay open until unlockSubmission closes them.
    function lockSubmission(address auditor) external onlyOperator {
        uint256 staked = stakeOf[auditor];
        if (staked < REQUIRED_STAKE) revert StakeBelowRequired(auditor, staked);
        activeSubmissions[auditor] += 1;
        emit SubmissionLocked(auditor, activeSubmissions[auditor]);
    }

    /// @notice Closes one open submission for an auditor.
    /// @dev Deliberately has no stake check: a submission opened before a
    /// slash must stay closable whatever the stake is now.
    function unlockSubmission(address auditor) external onlyOperator {
        if (activeSubmissions[auditor] == 0) revert NoActiveSubmission();
        activeSubmissions[auditor] -= 1;
        emit SubmissionUnlocked(auditor, activeSubmissions[auditor]);
    }

    /// @notice Takes up to `amount` from an auditor's stake and sends it to
    /// `recipient`. Floors at zero, so a slash larger than the stake takes the
    /// whole stake. Returns the amount actually taken.
    function slash(address auditor, uint256 amount, address recipient)
        external
        onlyDisputeResolution
        returns (uint256 taken)
    {
        if (amount == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint256 available = stakeOf[auditor];
        taken = amount > available ? available : amount;

        // Effects before the external call.
        stakeOf[auditor] = available - taken;
        emit Slashed(auditor, taken, recipient);

        _send(recipient, taken);
    }

    /// @notice Applies a reputation change. Positive for a won dispute,
    /// negative for a lost one.
    function adjustReputation(address auditor, int256 delta) external onlyDisputeResolution {
        reputation[auditor] += delta;
        emit ReputationChanged(auditor, delta, reputation[auditor]);
    }

    function _send(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
