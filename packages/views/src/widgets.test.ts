import { describe, expect, it } from "vitest";
import { assertFirstPartyWidget, CustomWidgetDeclarationSchema } from "./widgets.js";

describe("CustomWidgetDeclarationSchema", () => {
  it("parses a first-party barcode widget", () => {
    const w = CustomWidgetDeclarationSchema.parse({
      package: "@crossengin/widget-barcode",
      render: "BarcodeScanner",
      appliesTo: { field: "barcode", entity: "Prescription" },
    });
    expect(w.fallbackRender).toBe("text");
    expect(w.capacitorOnly).toBe(false);
  });

  it("supports applying by fieldKind", () => {
    expect(() =>
      CustomWidgetDeclarationSchema.parse({
        package: "@crossengin/widget-signature",
        render: "SignaturePad",
        appliesTo: { fieldKind: "signature" },
        capacitorOnly: true,
      }),
    ).not.toThrow();
  });

  it("rejects an empty appliesTo", () => {
    expect(() =>
      CustomWidgetDeclarationSchema.parse({
        package: "@crossengin/widget-x",
        render: "X",
        appliesTo: {},
      }),
    ).toThrow(/at least one of field/);
  });

  it("rejects non-PascalCase render", () => {
    expect(() =>
      CustomWidgetDeclarationSchema.parse({
        package: "@crossengin/widget-x",
        render: "barcodeScanner",
        appliesTo: { field: "x" },
      }),
    ).toThrow();
  });

  it("rejects malformed package", () => {
    expect(() =>
      CustomWidgetDeclarationSchema.parse({
        package: "Bad Pkg Name",
        render: "X",
        appliesTo: { field: "x" },
      }),
    ).toThrow();
  });
});

describe("assertFirstPartyWidget", () => {
  it("passes for @crossengin packages", () => {
    const w = CustomWidgetDeclarationSchema.parse({
      package: "@crossengin/widget-barcode",
      render: "X",
      appliesTo: { field: "x" },
    });
    expect(() => assertFirstPartyWidget(w)).not.toThrow();
  });

  it("throws for third-party packages", () => {
    const w = CustomWidgetDeclarationSchema.parse({
      package: "third-party",
      render: "X",
      appliesTo: { field: "x" },
    });
    expect(() => assertFirstPartyWidget(w)).toThrow(/not first-party/);
  });
});
