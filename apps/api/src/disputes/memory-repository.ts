import type { Dispute, DisputeRuling } from "@bbm/shared";
import type { DisputeRepository, LapseCandidate } from "./repository.js";

export class MemoryDisputeRepository implements DisputeRepository {
  private readonly byId = new Map<string, Dispute>();
  private readonly chainRefs = new Map<string, { contractId: string; ruleBy: Date | null }>();

  async create(dispute: Dispute & { contractId: string; ruleBy?: Date }): Promise<Dispute> {
    const existing = await this.findByFinding(dispute.findingId);
    if (existing) return existing;
    const { contractId, ruleBy, ...stored } = dispute;
    this.byId.set(stored.id, stored);
    this.chainRefs.set(stored.id, { contractId, ruleBy: ruleBy ?? null });
    return { ...stored };
  }

  async listLapseCandidates(cutoff: Date): Promise<LapseCandidate[]> {
    const out: LapseCandidate[] = [];
    for (const d of this.byId.values()) {
      const ref = this.chainRefs.get(d.id);
      if (d.ruling !== "Pending" || !ref) continue;
      if (ref.ruleBy && ref.ruleBy.getTime() >= cutoff.getTime()) continue;
      out.push({ id: d.id, findingId: d.findingId, contractId: ref.contractId, ruleBy: ref.ruleBy });
    }
    return out;
  }

  async setRuleBy(id: string, ruleBy: Date): Promise<void> {
    const ref = this.chainRefs.get(id);
    if (ref) ref.ruleBy = ruleBy;
  }

  async findById(id: string): Promise<Dispute | null> {
    const found = this.byId.get(id);
    return found ? { ...found } : null;
  }

  async findByFinding(findingId: string): Promise<Dispute | null> {
    for (const d of this.byId.values()) if (d.findingId === findingId) return { ...d };
    return null;
  }

  async list(ruling?: DisputeRuling): Promise<Dispute[]> {
    return [...this.byId.values()]
      .filter((d) => !ruling || d.ruling === ruling)
      .sort((a, b) => b.openedAt.localeCompare(a.openedAt))
      .map((d) => ({ ...d }));
  }

  async setRuling(id: string, ruling: Exclude<DisputeRuling, "Pending">, arbiterId: string, at: Date): Promise<Dispute | null> {
    const d = this.byId.get(id);
    if (!d || d.ruling !== "Pending") return null;
    const ruled = { ...d, ruling, arbiterId, ruledAt: at.toISOString() };
    this.byId.set(id, ruled);
    return { ...ruled };
  }
}
