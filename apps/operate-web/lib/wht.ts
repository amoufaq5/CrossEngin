export type WhtStatus = "certified" | "partial" | "uncertified";

export interface WhtReconRow {
  readonly invoiceId: string;
  readonly number: string;
  readonly currency: string | null;
  readonly withheld: number;
  readonly certified: number;
  readonly gap: number;
  readonly status: WhtStatus;
}

export interface WhtReconciliation {
  readonly totals: { readonly withheld: number; readonly certified: number; readonly uncertified: number };
  readonly rows: readonly WhtReconRow[];
}
