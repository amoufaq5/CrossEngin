/**
 * With platform review required, a freshly created proposal defaults to
 * `review_status = 'not_required'` — and the activation gate denies anything that
 * is not `approved`. Without enrolment a tenant's proposal would be permanently
 * unactivatable AND invisible to the reviewer's pending queue. This wraps the
 * proposal store so every new proposal is enrolled as `pending` on creation.
 */
export interface EnrolmentProposal {
  readonly id: string;
  readonly tenantId: string;
}

export interface EnrolmentProposalStore<T extends EnrolmentProposal> {
  create(tenantId: string, input: never): Promise<T>;
}

export interface ReviewEnroller {
  markPending(tenantId: string, id: string): Promise<unknown>;
}

export interface EnrolReviewOptions {
  readonly enroller: ReviewEnroller;
  /** A failed enrolment must not lose the proposal; it is reported, not thrown. */
  readonly onError?: (err: unknown, proposalId: string) => void;
}

/**
 * Returns a store whose `create` also enrols the new proposal into the review
 * queue. Every other method is passed through untouched.
 */
export function enrolNewProposalsForReview<S extends { create(tenantId: string, input: never): Promise<EnrolmentProposal> }>(
  store: S,
  opts: EnrolReviewOptions,
): S {
  const wrapped: S = Object.create(store) as S;
  const create = store.create.bind(store) as S["create"];
  Object.defineProperty(wrapped, "create", {
    value: async (tenantId: string, input: never): Promise<EnrolmentProposal> => {
      const proposal = await create(tenantId, input);
      try {
        await opts.enroller.markPending(proposal.tenantId, proposal.id);
      } catch (err) {
        opts.onError?.(err, proposal.id);
      }
      return proposal;
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  return wrapped;
}
