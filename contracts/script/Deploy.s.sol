// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {Script} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {AuditorStaking} from "../src/AuditorStaking.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {DisputeResolution} from "../src/DisputeResolution.sol";

/// @title Deploy
/// @notice Deploys and wires AuditorStaking, BountyEscrow and DisputeResolution.
///
/// Wiring order:
///   1. AuditorStaking(operator)
///   2. BountyEscrow(operator, staking, challengeWindow, refundDelay)
///   3. DisputeResolution(arbiter, staking, escrow)
///   4. staking.bindDisputeResolution(dr) and escrow.bindDisputeResolution(dr)
///
/// Step 4 is onlyOperator, so the operator must be the broadcaster.
///
/// Environment (all optional):
///   DEPLOYER_PRIVATE_KEY  key to broadcast with. Unset or 0 uses the CLI
///                         sender (`--private-key`, `--sender`, or the default).
///   OPERATOR              backend operator. Defaults to the broadcaster.
///   ARBITER               dispute arbiter. Defaults to the broadcaster.
///   CHALLENGE_WINDOW      seconds before a verified finding can be paid. Default 3 days.
///   REFUND_DELAY          seconds after the deadline before a refund. Default 3 hours.
///   REQUIRE_DISTINCT_ARBITER  true: refuse when ARBITER equals OPERATOR.
///                         Default false (Anvil uses one key for both).
///   WRITE_DEPLOYMENTS     write deployments/<chainid>.json (addresses, settings
///                         and deployBlock) after a real
///                         broadcast (`--broadcast`). Default true. Dry runs
///                         and tests never write.
contract Deploy is Script {
    uint256 internal constant DEFAULT_CHALLENGE_WINDOW = 3 days;
    uint256 internal constant DEFAULT_REFUND_DELAY = 3 hours;

    struct Config {
        /// Account that sends every transaction.
        address deployer;
        address operator;
        address arbiter;
        uint256 challengeWindow;
        uint256 refundDelay;
    }

    struct Deployment {
        AuditorStaking staking;
        BountyEscrow escrow;
        DisputeResolution disputeResolution;
    }

    /// @notice Reads the environment, deploys, and records the addresses.
    function run() external returns (Deployment memory d) {
        Config memory cfg = readConfig();
        // Public networks (the Sepolia deploy workflow) need a separate
        // arbiter: one key must not both verify and rule (ADR 0005).
        if (vm.envOr("REQUIRE_DISTINCT_ARBITER", false)) {
            require(cfg.arbiter != cfg.operator, "Deploy: ARBITER must differ from OPERATOR");
        }
        d = deploy(cfg);

        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (broadcasting && vm.envOr("WRITE_DEPLOYMENTS", true)) {
            writeDeployment(cfg, d);
        }
    }

    /// @notice Builds the config from environment variables and defaults.
    function readConfig() public returns (Config memory cfg) {
        uint256 key = vm.envOr("DEPLOYER_PRIVATE_KEY", uint256(0));
        // With a key, register it as a wallet so startBroadcast(address) can
        // sign. Without one, forge sets msg.sender to the CLI sender.
        address deployer = key == 0 ? msg.sender : vm.rememberKey(key);

        cfg = Config({
            deployer: deployer,
            operator: vm.envOr("OPERATOR", deployer),
            arbiter: vm.envOr("ARBITER", deployer),
            challengeWindow: vm.envOr("CHALLENGE_WINDOW", DEFAULT_CHALLENGE_WINDOW),
            refundDelay: vm.envOr("REFUND_DELAY", DEFAULT_REFUND_DELAY)
        });
    }

    /// @notice Deploys and wires the three contracts as `cfg.deployer`.
    /// Has no side effects outside the chain, so tests can call it directly.
    function deploy(Config memory cfg) public returns (Deployment memory d) {
        require(
            cfg.operator == cfg.deployer,
            "Deploy: OPERATOR must equal the broadcaster (bindDisputeResolution is onlyOperator)"
        );

        vm.startBroadcast(cfg.deployer);
        d.staking = new AuditorStaking(cfg.operator);
        d.escrow = new BountyEscrow(cfg.operator, d.staking, cfg.challengeWindow, cfg.refundDelay);
        d.disputeResolution = new DisputeResolution(cfg.arbiter, d.staking, d.escrow);
        d.staking.bindDisputeResolution(address(d.disputeResolution));
        d.escrow.bindDisputeResolution(address(d.disputeResolution));
        vm.stopBroadcast();
    }

    /// @notice Writes deployments/<chainid>.json.
    function writeDeployment(Config memory cfg, Deployment memory d) internal {
        string memory key = "deployment";
        vm.serializeUint(key, "chainId", block.chainid);
        // The fork's head while the script ran: the deploy transactions land at
        // or after it, so the API's event indexer can start here (testnets).
        vm.serializeUint(key, "deployBlock", block.number);
        vm.serializeAddress(key, "operator", cfg.operator);
        vm.serializeAddress(key, "arbiter", cfg.arbiter);
        vm.serializeUint(key, "challengeWindow", cfg.challengeWindow);
        vm.serializeUint(key, "refundDelay", cfg.refundDelay);
        vm.serializeAddress(key, "auditorStaking", address(d.staking));
        vm.serializeAddress(key, "bountyEscrow", address(d.escrow));
        string memory json = vm.serializeAddress(key, "disputeResolution", address(d.disputeResolution));

        string memory path = string.concat(vm.projectRoot(), "/deployments/", vm.toString(block.chainid), ".json");
        vm.writeJson(json, path);
    }
}
