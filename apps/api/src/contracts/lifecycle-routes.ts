import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { Contract } from "@bbm/shared";
import { getAddress, isAddress } from "viem";
import type { Auth } from "../auth/session.js";
import type { ChainActions } from "../chain/actions.js";
import {
  BOUNTY_STATE_CLOSED,
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
    const bounty = await contracts.findBounty(contract.id);
    const onchain = await bountyEscrow.readBounty(onchainId(contract.id));
    const matches =
      bounty !== null &&
      onchain.state === BOUNTY_STATE_OPEN &&
      getAddress(onchain.developer) === getAddress(contract.developerAddress) &&
      onchain.amount === BigInt(bounty.amount) &&
      onchain.deadline === BigInt(Math.floor(Date.parse(contract.deadline) / 1000));
    if (!matches) return reply.code(409).send({ error: "bounty not funded on-chain" });
    await contracts.markFunded(contract.id, now());
    return contract;
  });

  for (const action of ["cancel", "reclaim"] as const) {
    app.post<{ Params: { id: string } }>(`/api/contracts/:id/${action}`, async (request, reply) => {
      const contract = await developersContract(request, reply);
      if (!contract) return reply;
      const onchain = await bountyEscrow.readBounty(onchainId(contract.id));
      if (onchain.state !== BOUNTY_STATE_CLOSED) {
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
