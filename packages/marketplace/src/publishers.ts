import { ed25519PublicKeyFingerprint, isEd25519PublicKeyBase64 } from "@crossengin/crypto";

import { PACK_AUTHOR_KINDS, type PackAuthorKind, type PackManifest } from "./packs.js";
import type { PackSignature } from "./registry.js";
import { packManifestDigest, verifyPackReleaseSignature } from "./signing.js";

/**
 * A publisher key the platform has pinned: which pack ids it may sign and which author kind a pack
 * it signs may claim.
 *
 * A pack signature verified against a key carried beside it proves only that whoever produced the
 * bundle held *some* key, which every author does. The trust anchor has to be a key the platform
 * chose, so a signature is verified against the registry entry its fingerprint names and the
 * manifest's own `author.kind` is checked against what that entry was registered as — otherwise a
 * `community` author claims `crossengin_official` and `requiresElevatedReview` exempts them.
 */
export interface PackPublisher {
  /** A reverse-DNS pack-id prefix; the publisher may sign exactly the pack ids it covers. */
  readonly namespace: string;
  readonly authorKind: PackAuthorKind;
  readonly publicKeyBase64: string;
  readonly fingerprint: string;
}

const NAMESPACE_REGEX = /^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*){0,3}$/;

export const PUBLISHER_REFUSALS = [
  "legacy_signature_form",
  "publisher_unregistered",
  "pack_outside_publisher_namespace",
  "author_kind_not_registered",
  "signature_invalid",
  "release_pack_mismatch",
  "release_manifest_mismatch",
  "release_version_mismatch",
  "release_bundle_mismatch",
] as const;
export type PublisherRefusal = (typeof PUBLISHER_REFUSALS)[number];

export class PackPublisherRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PackPublisherRegistryError";
  }
}

/** Whether `namespace` covers `packId`: equal, or a dotted prefix of it. */
export function namespaceCovers(namespace: string, packId: string): boolean {
  return packId === namespace || packId.startsWith(`${namespace}.`);
}

/**
 * Parses one `--pack-publisher-key` value, `<namespace>:<authorKind>:<publicKeyBase64>`.
 *
 * The key is last because it is the one field that is opaque to a reader; neither of the other two
 * fields nor the base64 alphabet can contain a colon, so the split is unambiguous.
 */
export function parsePackPublisherSpec(spec: string): PackPublisher {
  const parts = spec.split(":");
  if (parts.length !== 3) {
    throw new PackPublisherRegistryError(
      `publisher key spec must be <namespace>:<authorKind>:<publicKeyBase64>, got ${parts.length.toString()} field(s)`,
    );
  }
  const [namespace, authorKind, publicKeyBase64] = parts as [string, string, string];
  if (!NAMESPACE_REGEX.test(namespace)) {
    throw new PackPublisherRegistryError(
      `publisher namespace '${namespace}' must be a reverse-DNS prefix (e.g. 'com.acme')`,
    );
  }
  if (!(PACK_AUTHOR_KINDS as readonly string[]).includes(authorKind)) {
    throw new PackPublisherRegistryError(
      `publisher author kind '${authorKind}' must be one of ${PACK_AUTHOR_KINDS.join(", ")}`,
    );
  }
  if (!isEd25519PublicKeyBase64(publicKeyBase64)) {
    throw new PackPublisherRegistryError(
      `publisher key for namespace '${namespace}' is not a base64 Ed25519 public key (32 bytes)`,
    );
  }
  return {
    namespace,
    authorKind: authorKind as PackAuthorKind,
    publicKeyBase64,
    fingerprint: ed25519PublicKeyFingerprint(publicKeyBase64),
  };
}

/**
 * The platform's pinned publisher keys.
 *
 * Construction refuses two shapes that would make a signature's owner ambiguous: two *different*
 * namespaces where one covers the other (a pack id would then belong to two publishers, so either
 * could sign over the other's versions), and one namespace registered under two author kinds. One
 * namespace under several keys of the same kind is allowed, because that is how a key is rotated.
 */
export class PackPublisherRegistry {
  private readonly byFingerprint = new Map<string, PackPublisher>();
  private readonly entries: readonly PackPublisher[];

  constructor(entries: readonly PackPublisher[]) {
    for (const e of entries) {
      const prior = this.byFingerprint.get(e.fingerprint);
      if (prior !== undefined) {
        throw new PackPublisherRegistryError(
          `publisher key ${e.fingerprint.slice(0, 12)}… is registered twice (namespaces '${prior.namespace}' and '${e.namespace}')`,
        );
      }
      for (const other of this.byFingerprint.values()) {
        if (other.namespace === e.namespace) {
          if (other.authorKind !== e.authorKind) {
            throw new PackPublisherRegistryError(
              `publisher namespace '${e.namespace}' is registered as both '${other.authorKind}' and '${e.authorKind}'`,
            );
          }
        } else if (namespaceCovers(other.namespace, e.namespace) || namespaceCovers(e.namespace, other.namespace)) {
          throw new PackPublisherRegistryError(
            `publisher namespaces '${other.namespace}' and '${e.namespace}' overlap, so one pack id would have two publishers`,
          );
        }
      }
      this.byFingerprint.set(e.fingerprint, e);
    }
    this.entries = [...entries];
  }

  get size(): number {
    return this.entries.length;
  }

  list(): readonly PackPublisher[] {
    return this.entries;
  }

  publisherFor(fingerprint: string): PackPublisher | undefined {
    return this.byFingerprint.get(fingerprint);
  }
}

export type PublisherVerification =
  | { readonly ok: true; readonly publisher: PackPublisher }
  | { readonly ok: false; readonly refusal: PublisherRefusal; readonly detail: string };

/** The release facts a caller holds beside the manifest, which the signed release must name. */
export interface SubmittedRelease {
  readonly version: string;
  readonly bundleSha256: string;
}

/**
 * Verifies a pack release's signature against the registry, in the order whose first failure is the
 * most useful thing to tell an operator: is the signature in a form this build verifies at all, is
 * the signer known, may it sign this pack id, may the manifest claim this author kind, does the
 * signature verify over the release it carries — and only then, whether that release is the one being
 * submitted.
 *
 * The claim comparison comes after verification on purpose: before it, the claim is whatever the
 * caller typed, so "you signed 1.0.0 and submitted 1.0.1" would be a statement about a value nobody
 * signed. After it, each mismatch is a true statement about what the publisher released, and is the
 * replay ADR-0452 measured — a captured signature re-filed under another version, bundle or manifest.
 */
export function verifyPackPublisher(input: {
  readonly manifest: PackManifest;
  readonly signature: PackSignature;
  readonly registry: PackPublisherRegistry;
  readonly submitted: SubmittedRelease;
}): PublisherVerification {
  const release = input.signature.release;
  if (release === undefined) {
    return {
      ok: false,
      refusal: "legacy_signature_form",
      detail:
        "the signature covers the manifest alone, which this build refuses: re-sign the release (pack id, version, manifest digest and bundle digest) with signPackRelease",
    };
  }
  const publisher = input.registry.publisherFor(input.signature.publicKeyFingerprint);
  if (publisher === undefined) {
    return {
      ok: false,
      refusal: "publisher_unregistered",
      detail: `signing key ${input.signature.publicKeyFingerprint.slice(0, 12)}… is not a registered publisher key`,
    };
  }
  if (!namespaceCovers(publisher.namespace, input.manifest.id)) {
    return {
      ok: false,
      refusal: "pack_outside_publisher_namespace",
      detail: `pack '${input.manifest.id}' is outside the signing publisher's namespace '${publisher.namespace}'`,
    };
  }
  if (input.manifest.author.kind !== publisher.authorKind) {
    return {
      ok: false,
      refusal: "author_kind_not_registered",
      detail: `manifest claims author kind '${input.manifest.author.kind}' but the publisher is registered as '${publisher.authorKind}'`,
    };
  }
  if (!verifyPackReleaseSignature({ signature: input.signature, publicKeyBase64: publisher.publicKeyBase64 })) {
    return { ok: false, refusal: "signature_invalid", detail: "pack signature failed verification against the registered key" };
  }
  if (release.packId !== input.manifest.id) {
    return {
      ok: false,
      refusal: "release_pack_mismatch",
      detail: `the signed release is for pack '${release.packId}', not '${input.manifest.id}'`,
    };
  }
  // Digests are not echoed: a mismatch says only that the bytes differ, and the caller holds both.
  if (release.manifestSha256 !== packManifestDigest(input.manifest)) {
    return {
      ok: false,
      refusal: "release_manifest_mismatch",
      detail: "the submitted manifest is not the manifest the release was signed over",
    };
  }
  if (release.version !== input.submitted.version) {
    return {
      ok: false,
      refusal: "release_version_mismatch",
      detail: `the signed release is version '${release.version}', not '${input.submitted.version}'`,
    };
  }
  if (release.bundleSha256 !== input.submitted.bundleSha256) {
    return {
      ok: false,
      refusal: "release_bundle_mismatch",
      detail: "the submitted bundleSha256 is not the bundle digest the release was signed over",
    };
  }
  return { ok: true, publisher };
}
