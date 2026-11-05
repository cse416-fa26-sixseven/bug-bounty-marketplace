import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Contract } from "@bbm/shared";
import { getAddress, isAddress } from "viem";
import type { Auth } from "../auth/session.js";
import type { ChainActions } from "../chain/actions.js";
import {
  BOUNTY_STATE_CLOSED,
  BOUNTY_STATE_NONE,
  BOUNTY_STATE_OPEN,
  type BountyEscrowPort,
} from "../chain/bounty-escrow.js";
import { onchainId } from "../chain/ids.js";
import { InvalidTransitionError } from "../status/transitions.js";
import type { ContractRepository } from "./repository.js";

export interface ContractLifecycleDeps {
  contracts: ContractRepository;
  bountyEscrow: Pick<BountyEscrowPort, "readBounty">;
  auth: Auth;
  now: () => Date;
  /** Releases an auditor's claim lock on a closed bounty. */
  chainActions?: Pick<ChainActions, "releaseClaimLock">;
}

/**
 * Developer actions whose transaction the developer signs in their own wallet
 * (fund, deleteBounty, refund). Each route confirms the result on-chain before
 * changing the API's records, and is idempotent.
 */
export function registerContractLifecycleRoutes(
  app: FastifyInstance,
  deps: ContractLifecycleDeps,
): void {
  const { contracts, bountyEscrow, auth, now } = deps;

  /** The contract, if the signed-in wallet is its developer; otherwise sends 401/403/404. */
  async function developersContract(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ): Promise<Contract | undefined> {
    const address = auth.requireSession(request, reply);
    if (!address) return undefined;
    const contract = await contracts.findContractById(request.params.id, now());
    if (!contract) {
      void reply.code(404).send({ error: "Contract not found" });
      return undefined;
    }
    if (
      !isAddress(contract.developerAddress) ||
      getAddress(contract.developerAddress) !== address
    ) {
      void reply.code(403).send({ error: "only the contract's developer can do this" });
      return undefined;
    }
    return contract;
  }

  app.post<{ Params: { id: string } }>("/api/contracts/:id/funded", async (request, reply) => {
    const contract = await developersContract(request, reply);
    if (!contract) return reply;
    // A cancelled (Expired) or Resolved contract is never listed again, even
    // if a bounty reached the chain after the cancel; the developer deletes it.
    if (contract.status !== "Open" && contract.status !== "Claimed") {
      return reply.code(409).send({ error: "contract is not open" });
    }
    // Only an analysed contract is fundable: one that failed analysis (it does
    // not compile) never reaches auditors. A bounty funded on-chain anyway can
    // still be deleted by the developer.
    if (!(await contracts.isAnalysisDone(contract.id))) {
      return reply.code(409).send({ error: "analysis not finished" });
    }
    const bounty = await contracts.findBounty(contract.id);
    const onchain = await bountyEscrow.readBounty(onchainId(contract.id));
    const matches =
      bounty !== null &&
      onchain.state === BOUNTY_STATE_OPEN &&
      getAddress(onchain.developer) === getAddress(contract.developerAddress) &&
      onchain.amount === BigInt(bounty.amount);
    if (!matches) return reply.code(409).send({ error: "bounty not funded on-chain" });
    const at = now();
    const storedDeadline = BigInt(Math.floor(Date.parse(contract.deadline) / 1000));
    if (onchain.deadline === storedDeadline) {
      await contracts.markFunded(contract.id, at);
    } else {
      // Funding waits for the analysis, so the upload's deadline may have
      // passed: the developer funds with a later one and the API adopts it.
      // Only a later deadline, still in the future, is adopted; a bounty
      // already funded keeps its terms.
      const onchainDeadline = new Date(Number(onchain.deadline) * 1000);
      if (
        (await contracts.isFunded(contract.id)) ||
        onchain.deadline < storedDeadline ||
        onchainDeadline <= at
      ) {
        return reply.code(409).send({ error: "bounty not funded on-chain" });
      }
      await contracts.markFunded(contract.id, at, onchainDeadline);
    }
    return (await contracts.findContractById(contract.id, at)) ?? contract;
  });

  for (const action of ["cancel", "reclaim"] as const) {
    app.post<{ Params: { id: string } }>(`/api/contracts/:id/${action}`, async (request, reply) => {
      const contract = await developersContract(request, reply);
      if (!contract) return reply;
      const onchain = await bountyEscrow.readBounty(onchainId(contract.id));
      // Funding waits for the analysis, so a contract may never have been
      // funded (still analysing, or the analysis failed): cancelling it needs
      // no on-chain step. Nor does a bounty someone else funded under this
      // contract's id: it is not the developer's, and they could neither
      // delete it nor fund their own.
      const ours =
        onchain.state !== BOUNTY_STATE_NONE &&
        getAddress(onchain.developer) === getAddress(contract.developerAddress);
      const neverFunded = action === "cancel" && !ours && !(await contracts.isFunded(contract.id));
      // Otherwise the developer's own bounty must be closed on-chain: another
      // wallet's closed bounty says nothing about this developer's funds.
      const closedOurs = ours && onchain.state === BOUNTY_STATE_CLOSED;
      if (!closedOurs && !neverFunded) {
        return reply.code(409).send({
          error:
            action === "cancel" ? "bounty not deleted on-chain" : "bounty not refunded on-chain",
        });
      }
      // The bounty is closed, so an auditor's claim on it is moot: release the
      // stake lock first, or it would stay locked once the claim is cleared.
      // Even a finding still awaiting its verdict cannot be verified or paid
      // any more, so its lock goes too (the expiry sweep would keep it).
      if (deps.chainActions) {
        try {
          await deps.chainActions.releaseClaimLock(contract.id);
        } catch (err) {
          request.log.error({ err, contractId: contract.id }, "releasing the claim lock failed");
          return reply
            .code(502)
            .send({ error: "could not release the auditor's claim lock; try again" });
        }
      }
      try {
        return await contracts.setContractStatus(contract.id, "Expired", now());
      } catch (err) {
        if (err instanceof InvalidTransitionError)
          return reply.code(409).send({ error: err.message });
        throw err;
      }
    });
  }
}
