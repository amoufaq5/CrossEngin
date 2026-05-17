declare const __brand: unique symbol;
type Brand<T, B> = T & { readonly [__brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type UserId = Brand<string, "UserId">;
export type RequestId = Brand<string, "RequestId">;
export type ManifestId = Brand<string, "ManifestId">;
