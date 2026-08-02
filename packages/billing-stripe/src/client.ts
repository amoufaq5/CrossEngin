import { StripeError, stripeErrorFromHttpResponse, stripeErrorFromNetworkError } from "./errors.js";
import { mapStripeCustomer, type StripeCustomer } from "./customers.js";
import { mapStripeSubscription, type StripeSubscription } from "./subscriptions.js";

export const STRIPE_API_BASE_URL = "https://api.stripe.com";

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface StripeClientOptions {
  readonly apiKey: string;
  readonly fetchImpl?: FetchLike;
  readonly baseUrl?: string;
}

export type FormValue = string | number | boolean;
export interface FormLike {
  readonly [key: string]: FormValue | FormLike | undefined;
}

export function encodeForm(form: FormLike): string {
  const parts: string[] = [];
  const walk = (prefix: string, value: FormValue | FormLike | undefined): void => {
    if (value === undefined) return;
    if (value !== null && typeof value === "object") {
      for (const [k, v] of Object.entries(value)) {
        walk(prefix === "" ? k : `${prefix}[${k}]`, v);
      }
      return;
    }
    parts.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(value))}`);
  };
  walk("", form);
  return parts.join("&");
}

export interface CreateCustomerInput {
  readonly email: string;
  readonly name?: string;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface CreateSubscriptionInput {
  readonly customerId: string;
  readonly priceId: string;
  readonly trialPeriodDays?: number;
}

export interface CancelSubscriptionOptions {
  readonly atPeriodEnd?: boolean;
}

export class StripeClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchLike;

  constructor(opts: StripeClientOptions) {
    if (opts.apiKey.length === 0) {
      throw new Error("StripeClient: apiKey is required");
    }
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl ?? STRIPE_API_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  }

  async createCustomer(input: CreateCustomerInput): Promise<StripeCustomer> {
    const form: FormLike = {
      email: input.email,
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    };
    const json = await this.request("POST", "/v1/customers", form);
    return mapStripeCustomer(json);
  }

  async createSubscription(input: CreateSubscriptionInput): Promise<StripeSubscription> {
    const form: FormLike = {
      customer: input.customerId,
      "items[0][price]": input.priceId,
      ...(input.trialPeriodDays !== undefined ? { trial_period_days: input.trialPeriodDays } : {}),
    };
    const json = await this.request("POST", "/v1/subscriptions", form);
    return mapStripeSubscription(json);
  }

  async getSubscription(id: string): Promise<StripeSubscription> {
    const json = await this.request("GET", `/v1/subscriptions/${encodeURIComponent(id)}`);
    return mapStripeSubscription(json);
  }

  async cancelSubscription(
    id: string,
    opts: CancelSubscriptionOptions = {},
  ): Promise<StripeSubscription> {
    const path = `/v1/subscriptions/${encodeURIComponent(id)}`;
    const json =
      opts.atPeriodEnd === true
        ? await this.request("POST", path, { cancel_at_period_end: true })
        : await this.request("DELETE", path);
    return mapStripeSubscription(json);
  }

  private async request(method: string, path: string, form?: FormLike): Promise<unknown> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.apiKey}`,
    };
    let body: string | undefined;
    if (form !== undefined) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = encodeForm(form);
    }
    let response: Awaited<ReturnType<FetchLike>>;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body });
    } catch (err) {
      throw stripeErrorFromNetworkError(err);
    }
    const text = await response.text();
    if (!response.ok) {
      throw stripeErrorFromHttpResponse({ status: response.status, body: text });
    }
    try {
      return JSON.parse(text) as unknown;
    } catch (err) {
      throw new StripeError({
        type: "api_error",
        message: `failed to parse Stripe response: ${err instanceof Error ? err.message : String(err)}`,
        httpStatus: response.status,
      });
    }
  }
}
