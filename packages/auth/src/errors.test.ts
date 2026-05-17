import { describe, expect, it } from "vitest";
import { RoleInheritanceCycleError, UnknownRoleError } from "./errors.js";

describe("UnknownRoleError", () => {
  it("is an Error subclass with the right name", () => {
    const err = new UnknownRoleError("admin");
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("UnknownRoleError");
  });

  it("includes the role name in the message", () => {
    const err = new UnknownRoleError("admin");
    expect(err.message).toBe("unknown role 'admin'");
  });

  it("exposes the role name as a readable property", () => {
    const err = new UnknownRoleError("editor");
    expect(err.roleName).toBe("editor");
  });
});

describe("RoleInheritanceCycleError", () => {
  it("is an Error subclass with the right name", () => {
    const err = new RoleInheritanceCycleError(["a", "b", "a"]);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RoleInheritanceCycleError");
  });

  it("formats the cycle as an arrow-joined path", () => {
    const err = new RoleInheritanceCycleError(["editor", "admin", "owner", "editor"]);
    expect(err.message).toBe("role inheritance cycle: editor -> admin -> owner -> editor");
  });

  it("exposes the cycle path as a readable property", () => {
    const cycle = ["a", "b", "c", "a"];
    const err = new RoleInheritanceCycleError(cycle);
    expect(err.cycle).toEqual(cycle);
  });

  it("handles a self-cycle (single-element repeat)", () => {
    const err = new RoleInheritanceCycleError(["x", "x"]);
    expect(err.message).toBe("role inheritance cycle: x -> x");
  });
});
