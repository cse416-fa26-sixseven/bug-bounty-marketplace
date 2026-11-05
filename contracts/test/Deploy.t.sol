// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Test} from "forge-std/Test.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {AuditorStaking} from "../src/AuditorStaking.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";

contract DeployTest is Test {
    Deploy internal script;

    address internal operator = makeAddr("operator");
    address internal arbiter = makeAddr("arbiter");

    uint256 internal constant WINDOW = 3 days;
    uint256 internal constant REFUND_DELAY = 3 hours;

    function setUp() public {
        script = new Deploy();
    }

    function _config() internal view returns (Deploy.Config memory) {
        return Deploy.Config({
            deployer: operator,
            operator: operator,
            arbiter: arbiter,
            challengeWindow: WINDOW,
            refundDelay: REFUND_DELAY
        });
    }

    function test_deploy_deploysAllThree() public {
        Deploy.Deployment memory d = script.deploy(_config());

        assertGt(address(d.staking).code.length, 0);
        assertGt(address(d.escrow).code.length, 0);
        assertGt(address(d.disputeResolution).code.length, 0);
    }

    function test_deploy_bindsDisputeResolution() public {
        Deploy.Deployment memory d = script.deploy(_config());

        assertEq(d.staking.disputeResolution(), address(d.disputeResolution));
        assertEq(d.escrow.disputeResolution(), address(d.disputeResolution));
    }

    function test_deploy_wiresRolesAndParams() public {
        Deploy.Deployment memory d = script.deploy(_config());

        assertEq(d.staking.operator(), operator);
        assertEq(d.escrow.operator(), operator);
        assertEq(address(d.escrow.staking()), address(d.staking));
        assertEq(d.escrow.challengeWindow(), WINDOW);
        assertEq(d.escrow.refundDelay(), REFUND_DELAY);

        assertEq(d.disputeResolution.arbiter(), arbiter);
        assertEq(address(d.disputeResolution.staking()), address(d.staking));
        assertEq(address(d.disputeResolution.escrow()), address(d.escrow));
    }

    function test_deploy_contractsCreatedByDeployer() public {
        uint64 nonce = vm.getNonce(operator);
        Deploy.Deployment memory d = script.deploy(_config());

        assertEq(address(d.staking), vm.computeCreateAddress(operator, nonce));
        assertEq(address(d.escrow), vm.computeCreateAddress(operator, nonce + 1));
        assertEq(address(d.disputeResolution), vm.computeCreateAddress(operator, nonce + 2));
    }

    function test_deploy_bindingsAreFinal() public {
        Deploy.Deployment memory d = script.deploy(_config());

        vm.startPrank(operator);
        vm.expectRevert(AuditorStaking.AlreadyBound.selector);
        d.staking.bindDisputeResolution(address(1));
        vm.expectRevert(BountyEscrow.AlreadyBound.selector);
        d.escrow.bindDisputeResolution(address(1));
        vm.stopPrank();
    }

    function test_deploy_revertsWhenOperatorIsNotBroadcaster() public {
        Deploy.Config memory cfg = _config();
        cfg.deployer = makeAddr("someoneElse");

        vm.expectRevert(bytes("Deploy: OPERATOR must equal the broadcaster (bindDisputeResolution is onlyOperator)"));
        script.deploy(cfg);
    }

    function test_requireDistinctArbiter_revertsWhenArbiterIsOperator() public {
        Deploy.Config memory cfg = _config();
        cfg.arbiter = operator;

        vm.expectRevert(bytes("Deploy: ARBITER must differ from OPERATOR"));
        script.requireDistinctArbiter(cfg);
    }

    function test_requireDistinctArbiter_passesWithASeparateArbiter() public view {
        script.requireDistinctArbiter(_config());
    }
}
