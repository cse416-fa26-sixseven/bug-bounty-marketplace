// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {AuditorStaking} from "../src/AuditorStaking.sol";

/// @dev Tries to re-enter withdraw() from its receive hook. The re-entry must
/// fail, which makes the outer withdraw() revert with TransferFailed.
contract ReentrantWithdrawer {
    AuditorStaking public immutable staking;

    constructor(AuditorStaking _staking) {
        staking = _staking;
    }

    function deposit() external payable {
        staking.stake{value: msg.value}();
    }

    function attack(uint256 amount) external {
        staking.withdraw(amount);
    }

    receive() external payable {
        staking.withdraw(msg.value);
    }
}

contract AuditorStakingTest is Test {
    AuditorStaking internal staking;

    // This test contract is the operator (deployer).
    address internal dispute = makeAddr("dispute");
    address internal auditor = makeAddr("auditor");
    address internal recipient = makeAddr("recipient");

    // Mirrors AuditorStaking's events for vm.expectEmit (solc 0.8.19 cannot
    // emit `AuditorStaking.Event` directly).
    event DisputeResolutionBound(address indexed disputeResolution);
    event Staked(address indexed auditor, uint256 amount, uint256 total);
    event Withdrawn(address indexed auditor, uint256 amount, uint256 remaining);
    event Slashed(address indexed auditor, uint256 amount, address indexed recipient);
    event ReputationChanged(address indexed auditor, int256 delta, int256 total);
    event SubmissionLocked(address indexed auditor, uint256 active);
    event SubmissionUnlocked(address indexed auditor, uint256 active);

    function setUp() public {
        staking = new AuditorStaking(address(this));
        staking.bindDisputeResolution(dispute);
        vm.deal(auditor, 10 ether);
    }

    function _stake(address who, uint256 amount) internal {
        vm.prank(who);
        staking.stake{value: amount}();
    }

    // --- construction and binding ---

    function test_constructor_rejectsZeroOperator() public {
        vm.expectRevert(AuditorStaking.ZeroAddress.selector);
        new AuditorStaking(address(0));
    }

    function test_bind_onlyOperator() public {
        AuditorStaking fresh = new AuditorStaking(address(this));
        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.NotOperator.selector);
        fresh.bindDisputeResolution(dispute);
    }

    function test_bind_onlyOnce() public {
        vm.expectRevert(AuditorStaking.AlreadyBound.selector);
        staking.bindDisputeResolution(makeAddr("other"));
    }

    function test_bind_rejectsZeroAddress() public {
        AuditorStaking fresh = new AuditorStaking(address(this));
        vm.expectRevert(AuditorStaking.ZeroAddress.selector);
        fresh.bindDisputeResolution(address(0));
    }

    // --- staking and eligibility (R9) ---

    function test_stake_recordsAmount() public {
        _stake(auditor, 1 ether);
        assertEq(staking.stakeOf(auditor), 1 ether);
        assertEq(address(staking).balance, 1 ether);
    }

    function test_stake_rejectsZero() public {
        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.ZeroAmount.selector);
        staking.stake{value: 0}();
    }

    function test_isEligible_requiresRequiredStake() public {
        assertFalse(staking.isEligible(auditor));

        _stake(auditor, staking.REQUIRED_STAKE() - 1);
        assertFalse(staking.isEligible(auditor));

        _stake(auditor, 1);
        assertTrue(staking.isEligible(auditor));
    }

    // --- withdrawal ---

    function test_withdraw_partial() public {
        _stake(auditor, 1 ether);

        vm.prank(auditor);
        staking.withdraw(0.4 ether);

        assertEq(staking.stakeOf(auditor), 0.6 ether);
        assertEq(auditor.balance, 9.4 ether);
    }

    function test_withdraw_full() public {
        _stake(auditor, 1 ether);

        vm.prank(auditor);
        staking.withdraw(1 ether);

        assertEq(staking.stakeOf(auditor), 0);
        assertEq(auditor.balance, 10 ether);
    }

    function test_withdraw_rejectsMoreThanStake() public {
        _stake(auditor, 1 ether);

        vm.prank(auditor);
        vm.expectRevert(
            abi.encodeWithSelector(AuditorStaking.InsufficientStake.selector, 1 ether, 2 ether)
        );
        staking.withdraw(2 ether);
    }

    function test_withdraw_rejectsZero() public {
        _stake(auditor, 1 ether);

        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.ZeroAmount.selector);
        staking.withdraw(0);
    }

    function test_withdraw_blockedWhileSubmissionOpen() public {
        _stake(auditor, 1 ether);
        staking.lockSubmission(auditor);

        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.ActiveSubmissions.selector);
        staking.withdraw(1 ether);
    }

    function test_withdraw_allowedAfterSubmissionClosed() public {
        _stake(auditor, 1 ether);
        staking.lockSubmission(auditor);
        staking.unlockSubmission(auditor);

        vm.prank(auditor);
        staking.withdraw(1 ether);
        assertEq(staking.stakeOf(auditor), 0);
    }

    function test_withdraw_reentrancyFails() public {
        ReentrantWithdrawer attacker = new ReentrantWithdrawer(staking);
        vm.deal(address(attacker), 1 ether);
        attacker.deposit{value: 1 ether}();

        // The re-entrant withdraw sees an empty stake and reverts. The
        // low-level send in the outer withdraw then fails.
        vm.expectRevert(AuditorStaking.TransferFailed.selector);
        attacker.attack(1 ether);

        assertEq(staking.stakeOf(address(attacker)), 1 ether);
    }

    // --- submission locks (operator only) ---

    function test_lockSubmission_onlyOperator() public {
        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.NotOperator.selector);
        staking.lockSubmission(auditor);
    }

    function test_unlockSubmission_onlyOperator() public {
        _stake(auditor, 0.1 ether);
        staking.lockSubmission(auditor);

        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.NotOperator.selector);
        staking.unlockSubmission(auditor);
    }

    function test_unlockSubmission_rejectsWhenNoneOpen() public {
        vm.expectRevert(AuditorStaking.NoActiveSubmission.selector);
        staking.unlockSubmission(auditor);
    }

    function test_lockSubmission_countsNestedSubmissions() public {
        _stake(auditor, 0.1 ether);
        staking.lockSubmission(auditor);
        staking.lockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 2);

        staking.unlockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 1);
    }

    // --- stake required to lock ---

    function test_lockSubmission_rejectsUnstakedAuditor() public {
        vm.expectRevert(abi.encodeWithSelector(AuditorStaking.StakeBelowRequired.selector, auditor, 0));
        staking.lockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 0);
    }

    function test_lockSubmission_rejectsStakeBelowRequired() public {
        _stake(auditor, 0.1 ether - 1);

        vm.expectRevert(
            abi.encodeWithSelector(AuditorStaking.StakeBelowRequired.selector, auditor, 0.1 ether - 1)
        );
        staking.lockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 0);
    }

    function test_lockSubmission_allowedAtExactlyRequiredStake() public {
        _stake(auditor, staking.REQUIRED_STAKE());

        staking.lockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 1);
    }

    function test_lockSubmission_rejectsAfterWithdrawBelowRequired() public {
        _stake(auditor, 0.1 ether);
        vm.prank(auditor);
        staking.withdraw(1);

        vm.expectRevert(
            abi.encodeWithSelector(AuditorStaking.StakeBelowRequired.selector, auditor, 0.1 ether - 1)
        );
        staking.lockSubmission(auditor);
    }

    function test_unlockSubmission_allowedAfterSlashBelowRequired() public {
        _stake(auditor, 0.1 ether);
        staking.lockSubmission(auditor);
        staking.lockSubmission(auditor);

        vm.prank(dispute);
        staking.slash(auditor, 0.05 ether, recipient);
        assertFalse(staking.isEligible(auditor));

        // Locks opened before the slash are still closable, down to zero.
        staking.unlockSubmission(auditor);
        staking.unlockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 0);

        // And the remaining stake is withdrawable once they are closed.
        vm.prank(auditor);
        staking.withdraw(0.05 ether);
        assertEq(staking.stakeOf(auditor), 0);
    }

    function test_lockSubmission_rejectsRelockAfterSlashBelowRequired() public {
        _stake(auditor, 0.1 ether);
        staking.lockSubmission(auditor);

        vm.prank(dispute);
        staking.slash(auditor, 0.05 ether, recipient);

        // The open lock stays, but no further one can be opened.
        vm.expectRevert(abi.encodeWithSelector(AuditorStaking.StakeBelowRequired.selector, auditor, 0.05 ether));
        staking.lockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 1);

        // Topping the stake back up makes the auditor lockable again.
        _stake(auditor, 0.05 ether);
        staking.lockSubmission(auditor);
        assertEq(staking.activeSubmissions(auditor), 2);
    }

    // --- slashing (DisputeResolution only) ---

    function test_slash_onlyDisputeResolution() public {
        _stake(auditor, 1 ether);

        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.NotDisputeResolution.selector);
        staking.slash(auditor, 0.5 ether, recipient);
    }

    function test_slash_sendsToRecipient() public {
        _stake(auditor, 1 ether);

        vm.prank(dispute);
        uint256 taken = staking.slash(auditor, 0.3 ether, recipient);

        assertEq(taken, 0.3 ether);
        assertEq(staking.stakeOf(auditor), 0.7 ether);
        assertEq(recipient.balance, 0.3 ether);
    }

    function test_slash_floorsAtZero() public {
        _stake(auditor, 0.5 ether);

        vm.prank(dispute);
        uint256 taken = staking.slash(auditor, 5 ether, recipient);

        assertEq(taken, 0.5 ether);
        assertEq(staking.stakeOf(auditor), 0);
        assertEq(recipient.balance, 0.5 ether);
    }

    function test_slash_rejectsZeroAmountAndRecipient() public {
        _stake(auditor, 1 ether);

        vm.startPrank(dispute);
        vm.expectRevert(AuditorStaking.ZeroAmount.selector);
        staking.slash(auditor, 0, recipient);

        vm.expectRevert(AuditorStaking.ZeroAddress.selector);
        staking.slash(auditor, 0.1 ether, address(0));
        vm.stopPrank();
    }

    // --- reputation (DisputeResolution only) ---

    function test_adjustReputation_isSigned() public {
        vm.prank(dispute);
        staking.adjustReputation(auditor, 1);
        vm.prank(dispute);
        staking.adjustReputation(auditor, -3);

        assertEq(staking.reputation(auditor), -2);
    }

    function test_adjustReputation_onlyDisputeResolution() public {
        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.NotDisputeResolution.selector);
        staking.adjustReputation(auditor, 1);
    }

    function test_slash_beforeBindingFails() public {
        AuditorStaking fresh = new AuditorStaking(address(this));
        vm.expectRevert(AuditorStaking.NotDisputeResolution.selector);
        fresh.slash(auditor, 1, recipient);
    }

    // --- stake() while locked / after slash ---

    function test_stake_allowedWhileSubmissionLocked() public {
        _stake(auditor, 0.1 ether);
        staking.lockSubmission(auditor);

        // Locking only blocks withdrawal; topping up still works.
        _stake(auditor, 0.2 ether);
        assertEq(staking.stakeOf(auditor), 0.3 ether);
        assertEq(staking.activeSubmissions(auditor), 1);

        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.ActiveSubmissions.selector);
        staking.withdraw(0.1 ether);
    }

    function test_stake_afterSlashRestoresEligibility() public {
        _stake(auditor, 0.1 ether);
        vm.prank(dispute);
        staking.slash(auditor, 0.05 ether, recipient);
        assertFalse(staking.isEligible(auditor));

        _stake(auditor, 0.05 ether);
        assertEq(staking.stakeOf(auditor), 0.1 ether);
        assertTrue(staking.isEligible(auditor));
    }

    function test_stake_afterFullSlashStartsFromZero() public {
        _stake(auditor, 0.5 ether);
        vm.prank(dispute);
        staking.slash(auditor, 10 ether, recipient);
        assertEq(staking.stakeOf(auditor), 0);

        _stake(auditor, 0.2 ether);
        assertEq(staking.stakeOf(auditor), 0.2 ether);
    }

    function test_stake_rejectsZeroWhileLocked() public {
        _stake(auditor, 0.1 ether);
        staking.lockSubmission(auditor);
        vm.prank(auditor);
        vm.expectRevert(AuditorStaking.ZeroAmount.selector);
        staking.stake{value: 0}();
    }

    // --- events ---

    function test_bind_emitsDisputeResolutionBound() public {
        AuditorStaking fresh = new AuditorStaking(address(this));
        vm.expectEmit(true, false, false, false, address(fresh));
        emit DisputeResolutionBound(dispute);
        fresh.bindDisputeResolution(dispute);
    }

    function test_stake_emitsStaked() public {
        vm.expectEmit(true, false, false, true, address(staking));
        emit Staked(auditor, 0.3 ether, 0.3 ether);
        _stake(auditor, 0.3 ether);

        vm.expectEmit(true, false, false, true, address(staking));
        emit Staked(auditor, 0.2 ether, 0.5 ether);
        _stake(auditor, 0.2 ether);
    }

    function test_withdraw_emitsWithdrawn() public {
        _stake(auditor, 1 ether);

        vm.expectEmit(true, false, false, true, address(staking));
        emit Withdrawn(auditor, 0.4 ether, 0.6 ether);
        vm.prank(auditor);
        staking.withdraw(0.4 ether);
    }

    function test_lockUnlock_emitSubmissionEvents() public {
        _stake(auditor, 0.1 ether);

        vm.expectEmit(true, false, false, true, address(staking));
        emit SubmissionLocked(auditor, 1);
        staking.lockSubmission(auditor);

        vm.expectEmit(true, false, false, true, address(staking));
        emit SubmissionLocked(auditor, 2);
        staking.lockSubmission(auditor);

        vm.expectEmit(true, false, false, true, address(staking));
        emit SubmissionUnlocked(auditor, 1);
        staking.unlockSubmission(auditor);
    }

    function test_slash_emitsSlashedWithAmountTaken() public {
        _stake(auditor, 0.5 ether);

        // The event carries the floored amount, not the requested one.
        vm.expectEmit(true, true, false, true, address(staking));
        emit Slashed(auditor, 0.5 ether, recipient);
        vm.prank(dispute);
        staking.slash(auditor, 2 ether, recipient);
    }

    function test_adjustReputation_emitsReputationChanged() public {
        vm.expectEmit(true, false, false, true, address(staking));
        emit ReputationChanged(auditor, 2, 2);
        vm.prank(dispute);
        staking.adjustReputation(auditor, 2);

        vm.expectEmit(true, false, false, true, address(staking));
        emit ReputationChanged(auditor, -5, -3);
        vm.prank(dispute);
        staking.adjustReputation(auditor, -5);
    }

    // --- fuzz ---

    /// @dev Stake then withdraw conserves ETH for any amount and split.
    function testFuzz_stakeWithdraw_conservesBalance(uint256 amount, uint256 out) public {
        amount = bound(amount, 1, 1_000_000 ether);
        out = bound(out, 1, amount);
        address who = makeAddr("fuzz-auditor");
        vm.deal(who, amount);

        _stake(who, amount);
        assertEq(address(staking).balance, amount);
        assertEq(staking.isEligible(who), amount >= staking.REQUIRED_STAKE());

        vm.prank(who);
        staking.withdraw(out);

        assertEq(staking.stakeOf(who), amount - out);
        assertEq(who.balance, out);
        assertEq(address(staking).balance, amount - out);
    }

    /// @dev Slash takes min(stake, requested), sends exactly that to the
    /// recipient and leaves the rest staked.
    function testFuzz_slash_floorsAndConserves(uint256 staked, uint256 requested) public {
        staked = bound(staked, 1, 1_000_000 ether);
        requested = bound(requested, 1, 2_000_000 ether);
        address who = makeAddr("fuzz-auditor");
        vm.deal(who, staked);
        _stake(who, staked);

        vm.prank(dispute);
        uint256 taken = staking.slash(who, requested, recipient);

        uint256 expected = requested > staked ? staked : requested;
        assertEq(taken, expected);
        assertEq(staking.stakeOf(who), staked - expected);
        assertEq(recipient.balance, expected);
        assertEq(address(staking).balance, staked - expected);
    }
}
