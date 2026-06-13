import type { ProposalGateDecision } from "./proposal-gate.js";

/**
 * Renders a `ProposalGateDecision` as a short operator/CLI message: a headline per
 * decision kind, then the blocking/confirm reasons and any non-blocking warnings.
 */
export function formatProposalGate(decision: ProposalGateDecision): string {
  const lines: string[] = [];
  switch (decision.decision) {
    case "allow":
      lines.push("proposal allowed by the safety policy");
      break;
    case "confirm":
      lines.push("proposal requires explicit human confirmation before it proceeds");
      break;
    case "refuse":
      lines.push(
        decision.refusal !== null
          ? "proposal REFUSED — hard safety refusal (non-overridable)"
          : "proposal REFUSED by the safety policy",
      );
      break;
  }
  for (const reason of decision.reasons) lines.push(`  - ${reason}`);
  for (const warning of decision.warnings) lines.push(`  (warning) ${warning}`);
  if (decision.refusal !== null) lines.push(`  see: ${decision.refusal.citation}`);
  return lines.join("\n");
}
