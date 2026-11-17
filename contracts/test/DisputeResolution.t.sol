// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test, Vm} from "forge-std/Test.sol";
import {AuditorStaking} from "../src/AuditorStaking.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {DisputeResolution} from "../src/DisputeResolution.sol";

/// @dev Developer that re-enters openDispute() when it receives the slashed
/// stake. The re-entry must fail, which makes the ruling revert.
contract ReentrantDeveloper {
    BountyEscrow public immutable escrow;
    DisputeResolution public immutable dr;

    bytes32 internal contractId;
    bytes32 internal findingId;

    constructor(BountyEscrow _escrow, DisputeResolution _dr) {
        escrow = _escrow;
        dr = _dr;
    }

    function fund(bytes32 _contractId, uint256 deadline) external payable {
        contractId = _contractId;
        escrow.fund{value: msg.value}(_contractId, deadline);
    }

    function open(bytes32 _findingId) external {
        findingId = _findingId;
        dr.openDispute(contractId, _findingId, "dispute");
    }

    receive() external payable {
        dr.openDispute(contractId, findingId, "again");
    }
}

contract DisputeResolutionTest is Test {
    AuditorStaking internal staking;
    BountyEscrow internal escrow;
    DisputeResolution internal dr;

    // This test contract is the operator (backend) and deployer.
    address internal arbiter = makeAddr("arbiter");
    address internal developer = makeAddr("developer");
    address internal auditor = makeAddr("auditor");
    address internal auditor2 = makeAddr("auditor2");
    address internal stranger = makeAddr("stranger");

    bytes32 internal constant CONTRACT_ID = keccak256("contract-1");
    bytes32 internal constant FINDING_1 = keccak256("finding-1");
    bytes32 internal constant FINDING_2 = keccak256("finding-2");

    uint256 internal constant WINDOW = 3 days;
    uint256 internal constant REFUND_DELAY = 3 hours;
    uint256 internal constant BOUNTY = 2 ether;

    uint256 internal deadline;

    // Mirrors the contracts' events for vm.expectEmit (solc 0.8.19 cannot
    // emit `Contract.Event` directly).
    event DisputeOpened(
        bytes32 indexed key,
        bytes32 indexed contractId,
        bytes32 indexed findingId,
        address developer,
        address auditor,
        uint256 ruleBy,
        string reason
    );
    event DisputeRuled(bytes32 indexed key, bool auditorWon, uint256 slashed);
    event DisputeLapsed(bytes32 indexed key);
    event DisputeResolutionBound(address indexed disputeResolution);
    event Frozen(bytes32 indexed contractId, bytes32 indexed findingId);
    event Unfrozen(bytes32 indexed contractId, bytes32 indexed findingId, bool auditorWon, uint256 verifiedAt);
    event VerificationCleared(bytes32 indexed contractId, bytes32 indexed findingId);
    event Slashed(address indexed auditor, uint256 amount, address indexed recipient);
    event ReputationChanged(address indexed auditor, int256 delta, int256 total);

    function setUp() public {
        staking = new AuditorStaking(address(this));
        escrow = new BountyEscrow(address(this), staking, WINDOW, REFUND_DELAY);
        dr = new DisputeResolution(arbiter, staking, escrow);

        staking.bindDisputeResolution(address(dr));
        escrow.bindDisputeResolution(address(dr));

        vm.deal(developer, 10 ether);
        vm.deal(stranger, 10 ether);
        vm.deal(auditor, 5 ether);
        vm.deal(auditor2, 5 ether);

        // The auditor meets REQUIRED_STAKE, so the finding can be paid (R9).
        vm.prank(auditor);
        staking.stake{value: 1 ether}();

        deadline = vm.getBlockTimestamp() + 30 days;
    }

    function _fund() internal {
        vm.prank(developer);
        escrow.fund{value: BOUNTY}(CONTRACT_ID, deadline);
    }

    /// @dev Funds, records one submission and verifies FINDING_1 for `auditor`.
    function _verified() internal {
        _fund();
        escrow.recordSubmission(CONTRACT_ID);
        escrow.recordVerification(CONTRACT_ID, FINDING_1, auditor);
    }

    /// @dev Developer opens a dispute on FINDING_1.
    function _open() internal {
        vm.prank(developer);
        dr.openDispute(CONTRACT_ID, FINDING_1, "reason");
    }

    // --- construction ---

    function test_constructor_rejectsZeroArbiter() public {
        vm.expectRevert(DisputeResolution.ZeroAddress.selector);
        new DisputeResolution(address(0), staking, escrow);
    }

    function test_constructor_rejectsZeroStakingOrEscrow() public {
        vm.expectRevert(DisputeResolution.ZeroAddress.selector);
        new DisputeResolution(arbiter, AuditorStaking(address(0)), escrow);

        vm.expectRevert(DisputeResolution.ZeroAddress.selector);
        new DisputeResolution(arbiter, staking, BountyEscrow(address(0)));
    }

    // --- opening a dispute (R21) ---

    function test_openDispute_onlyDeveloper() public {
        _verified();

        vm.prank(stranger);
        vm.expectRevert(DisputeResolution.NotDeveloper.selector);
        dr.openDispute(CONTRACT_ID, FINDING_1, "reason");
    }

    function test_openDispute_recordsDispute() public {
        _verified();
        _open();

        (address dev, address aud, uint256 ruleBy, bool resolved) =
            dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        assertEq(dev, developer);
        assertEq(aud, auditor);
        assertEq(ruleBy, vm.getBlockTimestamp() + dr.RULING_WINDOW());
        assertFalse(resolved);
    }

    function test_openDispute_freezesPayout() public {
        _verified();
        _open();

        vm.warp(vm.getBlockTimestamp() + WINDOW);
        vm.expectRevert(BountyEscrow.FrozenBounty.selector);
        escrow.payout(CONTRACT_ID, FINDING_1, auditor);
    }

    function test_openDispute_rejectsSecondDisputeOnSameFinding() public {
        _verified();
        _open();

        vm.prank(developer);
        vm.expectRevert(DisputeResolution.DisputeExists.selector);
        dr.openDispute(CONTRACT_ID, FINDING_1, "again");
    }

    function test_openDispute_rejectsAfterChallengeWindow() public {
        _verified();
        vm.warp(vm.getBlockTimestamp() + WINDOW);

        vm.prank(developer);
        vm.expectRevert(BountyEscrow.ChallengeWindowClosed.selector);
        dr.openDispute(CONTRACT_ID, FINDING_1, "late");
    }

    function test_openDispute_rejectsUnverifiedBounty() public {
        _fund();
        vm.prank(developer);
        vm.expectRevert(BountyEscrow.NoVerifiedFinding.selector);
        dr.openDispute(CONTRACT_ID, FINDING_1, "reason");
    }

    function test_openDispute_rejectsWrongFinding() public {
        _verified();
        vm.prank(developer);
        vm.expectRevert(BountyEscrow.FindingMismatch.selector);
        dr.openDispute(CONTRACT_ID, FINDING_2, "reason");
    }

    // --- ruling (arbiter only, within 3 days) ---

    function test_rule_onlyArbiter() public {
        _verified();
        _open();

        vm.prank(stranger);
        vm.expectRevert(DisputeResolution.NotArbiter.selector);
        dr.rule(CONTRACT_ID, FINDING_1, true);
    }

    function test_rule_rejectsUnknownDispute() public {
        _verified();

        vm.prank(arbiter);
        vm.expectRevert(DisputeResolution.DisputeNotFound.selector);
        dr.rule(CONTRACT_ID, FINDING_1, true);
    }

    function test_rule_auditorWins_restartsWindowAndRaisesReputation() public {
        _verified();
        _open();

        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, true);

        // The finding is still verified, with a fresh challenge window (M1 US7.3).
        (,,,,,, address aud,, ) = escrow.bounties(CONTRACT_ID);
        assertEq(aud, auditor);
        (,,,,,,, uint256 verifiedAt,) = escrow.bounties(CONTRACT_ID);
        assertEq(verifiedAt, vm.getBlockTimestamp());

        // No slash on a win.
        assertEq(staking.stakeOf(auditor), 1 ether);
        assertEq(staking.reputation(auditor), 1);

        // Payment waits for the new window, then succeeds.
        vm.expectRevert(abi.encodeWithSelector(BountyEscrow.ChallengeWindowOpen.selector, verifiedAt + WINDOW));
        escrow.payout(CONTRACT_ID, FINDING_1, auditor);

        vm.warp(verifiedAt + WINDOW);
        escrow.payout(CONTRACT_ID, FINDING_1, auditor);
        assertEq(escrow.pendingPayouts(auditor), BOUNTY);
    }

    function test_rule_auditorLoses_slashesHalfStakeAndRejectsFinding() public {
        _verified();
        _open();

        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, false);

        // 50% of the 1 ETH stake goes to the developer.
        assertEq(staking.stakeOf(auditor), 0.5 ether);
        assertEq(developer.balance, 8.5 ether); // 10 - 2 funded + 0.5 slashed
        assertEq(staking.reputation(auditor), -1);

        // The finding is rejected, so the bounty is open for another verification.
        (,,,,, bytes32 finding,,,) = escrow.bounties(CONTRACT_ID);
        assertEq(finding, bytes32(0));
    }

    function test_rule_rejectsAfterRulingWindow() public {
        _verified();
        _open();

        (,, uint256 ruleBy,) = dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        vm.warp(ruleBy + 1);

        vm.prank(arbiter);
        vm.expectRevert(DisputeResolution.RulingWindowClosed.selector);
        dr.rule(CONTRACT_ID, FINDING_1, true);
    }

    function test_rule_allowedAtExactRulingDeadline() public {
        _verified();
        _open();

        (,, uint256 ruleBy,) = dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        vm.warp(ruleBy);

        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, true);
    }

    function test_rule_rejectsSecondRuling() public {
        _verified();
        _open();

        vm.startPrank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, true);
        vm.expectRevert(DisputeResolution.AlreadyResolved.selector);
        dr.rule(CONTRACT_ID, FINDING_1, false);
        vm.stopPrank();
    }

    function test_rule_lostDisputeReentrancyFails() public {
        ReentrantDeveloper attacker = new ReentrantDeveloper(escrow, dr);
        vm.deal(address(attacker), 10 ether);

        attacker.fund{value: BOUNTY}(CONTRACT_ID, deadline);
        escrow.recordSubmission(CONTRACT_ID);
        escrow.recordVerification(CONTRACT_ID, FINDING_1, auditor);
        attacker.open(FINDING_1);

        // The slash pays the attacker, whose receive hook tries to re-open a
        // dispute. That re-entry reverts, so the slash send fails and the
        // whole ruling reverts.
        vm.prank(arbiter);
        vm.expectRevert(AuditorStaking.TransferFailed.selector);
        dr.rule(CONTRACT_ID, FINDING_1, false);

        assertEq(staking.stakeOf(auditor), 1 ether);
    }

    // --- lapse (arbiter missed the ruling window) ---

    function test_lapse_revertsBeforeRulingWindowEnds() public {
        _verified();
        _open();

        (,, uint256 ruleBy,) = dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(DisputeResolution.RulingWindowOpen.selector, ruleBy));
        dr.lapse(CONTRACT_ID, FINDING_1);
    }

    function test_lapse_auditorWinsWithoutReputationChange() public {
        _verified();
        _open();

        (,, uint256 ruleBy,) = dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        vm.warp(ruleBy + 1);

        // Anyone can trigger it.
        vm.prank(stranger);
        dr.lapse(CONTRACT_ID, FINDING_1);

        assertEq(staking.reputation(auditor), 0);
        assertEq(staking.stakeOf(auditor), 1 ether);
        (,,,,,,, uint256 verifiedAt,) = escrow.bounties(CONTRACT_ID);
        assertEq(verifiedAt, vm.getBlockTimestamp());
    }

    function test_lapse_rejectsAfterRuling() public {
        _verified();
        _open();

        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, true);

        (,, uint256 ruleBy,) = dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        vm.warp(ruleBy + 1);
        vm.expectRevert(DisputeResolution.AlreadyResolved.selector);
        dr.lapse(CONTRACT_ID, FINDING_1);
    }

    function test_lapse_rejectsUnknownDispute() public {
        vm.expectRevert(DisputeResolution.DisputeNotFound.selector);
        dr.lapse(CONTRACT_ID, FINDING_1);
    }

    function test_lapse_thenNoSecondDisputeOnSameFinding() public {
        _verified();
        _open();

        (,, uint256 ruleBy,) = dr.disputes(dr.disputeKey(CONTRACT_ID, FINDING_1));
        vm.warp(ruleBy + 1);
        dr.lapse(CONTRACT_ID, FINDING_1);

        vm.prank(developer);
        vm.expectRevert(DisputeResolution.DisputeExists.selector);
        dr.openDispute(CONTRACT_ID, FINDING_1, "again");
    }

    // --- events ---

    function test_openDispute_emitsDisputeOpenedAndFrozen() public {
        _verified();
        bytes32 key = dr.disputeKey(CONTRACT_ID, FINDING_1);
        uint256 ruleBy = vm.getBlockTimestamp() + dr.RULING_WINDOW();

        vm.expectEmit(true, true, false, false, address(escrow));
        emit Frozen(CONTRACT_ID, FINDING_1);
        vm.expectEmit(true, true, true, true, address(dr));
        emit DisputeOpened(key, CONTRACT_ID, FINDING_1, developer, auditor, ruleBy, "reason");
        _open();
    }

    function test_rule_auditorWins_emitsEvents() public {
        _verified();
        _open();
        bytes32 key = dr.disputeKey(CONTRACT_ID, FINDING_1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Unfrozen(CONTRACT_ID, FINDING_1, true, vm.getBlockTimestamp());
        vm.expectEmit(true, false, false, true, address(staking));
        emit ReputationChanged(auditor, 1, 1);
        vm.expectEmit(true, false, false, true, address(dr));
        emit DisputeRuled(key, true, 0);
        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, true);
    }

    function test_rule_auditorLoses_emitsEvents() public {
        _verified();
        _open();
        bytes32 key = dr.disputeKey(CONTRACT_ID, FINDING_1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Unfrozen(CONTRACT_ID, FINDING_1, false, 0);
        vm.expectEmit(true, true, false, false, address(escrow));
        emit VerificationCleared(CONTRACT_ID, FINDING_1);
        vm.expectEmit(true, true, false, true, address(staking));
        emit Slashed(auditor, 0.5 ether, developer);
        vm.expectEmit(true, false, false, true, address(staking));
        emit ReputationChanged(auditor, -1, -1);
        vm.expectEmit(true, false, false, true, address(dr));
        emit DisputeRuled(key, false, 0.5 ether);
        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, false);
    }

    function test_lapse_emitsDisputeLapsed() public {
        _verified();
        _open();
        bytes32 key = dr.disputeKey(CONTRACT_ID, FINDING_1);
        (,, uint256 ruleBy,) = dr.disputes(key);
        vm.warp(ruleBy + 1);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit Unfrozen(CONTRACT_ID, FINDING_1, true, ruleBy + 1);
        vm.expectEmit(true, false, false, false, address(dr));
        emit DisputeLapsed(key);
        vm.prank(stranger);
        dr.lapse(CONTRACT_ID, FINDING_1);
    }

    function test_bind_emitsDisputeResolutionBoundOnBothContracts() public {
        AuditorStaking s = new AuditorStaking(address(this));
        BountyEscrow e = new BountyEscrow(address(this), s, WINDOW, REFUND_DELAY);
        DisputeResolution d = new DisputeResolution(arbiter, s, e);

        vm.expectEmit(true, false, false, false, address(s));
        emit DisputeResolutionBound(address(d));
        s.bindDisputeResolution(address(d));

        vm.expectEmit(true, false, false, false, address(e));
        emit DisputeResolutionBound(address(d));
        e.bindDisputeResolution(address(d));
    }

    /// @dev A losing auditor with no stake left is not slashed, but still
    /// loses reputation and the ruling reports zero slashed.
    function test_rule_auditorLosesWithNoStake_skipsSlash() public {
        // auditor2 is eligible at verification time, then withdraws everything.
        vm.prank(auditor2);
        staking.stake{value: 0.1 ether}();
        _fund();
        escrow.recordSubmission(CONTRACT_ID);
        escrow.recordVerification(CONTRACT_ID, FINDING_1, auditor2);
        vm.prank(auditor2);
        staking.withdraw(0.1 ether);
        _open();

        bytes32 key = dr.disputeKey(CONTRACT_ID, FINDING_1);
        vm.recordLogs();
        vm.expectEmit(true, false, false, true, address(dr));
        emit DisputeRuled(key, false, 0);
        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, false);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        bytes32 slashedSig = keccak256("Slashed(address,uint256,address)");
        for (uint256 i = 0; i < logs.length; i++) {
            assertTrue(logs[i].topics.length == 0 || logs[i].topics[0] != slashedSig);
        }
        assertEq(staking.reputation(auditor2), -1);
    }

    // --- fuzz ---

    /// @dev A lost dispute moves exactly SLASH_PERCENT of any stake from the
    /// auditor to the developer.
    function testFuzz_rule_auditorLoses_slashesHalf(uint256 staked) public {
        staked = bound(staked, staking.REQUIRED_STAKE(), 1_000_000 ether);
        vm.deal(auditor2, staked);
        vm.prank(auditor2);
        staking.stake{value: staked}();

        _fund();
        escrow.recordSubmission(CONTRACT_ID);
        escrow.recordVerification(CONTRACT_ID, FINDING_1, auditor2);
        _open();

        uint256 devBefore = developer.balance;
        vm.prank(arbiter);
        dr.rule(CONTRACT_ID, FINDING_1, false);

        uint256 slashed = staked * dr.SLASH_PERCENT() / 100;
        assertEq(staking.stakeOf(auditor2), staked - slashed);
        assertEq(developer.balance, devBefore + slashed);
    }
}
