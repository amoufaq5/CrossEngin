import { describe, expect, it } from "vitest";

import {
  DESIGN_OUTPUT_SHAPES,
  DESIGN_OUTPUT_WRAPPERS,
  classifyDesignOutput,
  isUnreadableDesignOutput,
  looksLikeManifest,
} from "./design-output.js";

const MANIFEST = {
  manifestVersion: "1.0",
  meta: { name: "Bike Shop", slug: "generated/bike-shop", version: "0.1.0" },
  entities: [{ name: "Bike", fields: [{ name: "label", type: { kind: "text" } }] }],
};
const MANIFEST_JSON = JSON.stringify(MANIFEST, null, 2);

describe("constants", () => {
  it("names eight shapes and three wrappers, all distinct", () => {
    expect(new Set(DESIGN_OUTPUT_SHAPES).size).toBe(DESIGN_OUTPUT_SHAPES.length);
    expect(DESIGN_OUTPUT_SHAPES).toHaveLength(8);
    expect(DESIGN_OUTPUT_WRAPPERS).toEqual(["none", "code_fence", "surrounding_prose"]);
  });

  it("treats every shape but manifest_shaped_object as unreadable", () => {
    for (const shape of DESIGN_OUTPUT_SHAPES) {
      expect(isUnreadableDesignOutput(shape)).toBe(shape !== "manifest_shaped_object");
    }
  });
});

describe("looksLikeManifest", () => {
  it("accepts an object with entities", () => {
    expect(looksLikeManifest({ entities: [] })).toBe(true);
  });

  it("accepts meta + manifestVersion without entities", () => {
    expect(looksLikeManifest({ meta: {}, manifestVersion: "1.0" })).toBe(true);
  });

  it("rejects meta alone and an unrelated object", () => {
    expect(looksLikeManifest({ meta: {} })).toBe(false);
    expect(looksLikeManifest({ answer: 42 })).toBe(false);
  });
});

describe("classifyDesignOutput — the five real failure modes land in distinct buckets", () => {
  it("a markdown fence is code_fence, and the manifest is recovered intact", () => {
    const d = classifyDesignOutput(`\`\`\`json\n${MANIFEST_JSON}\n\`\`\``);
    expect(d.shape).toBe("manifest_shaped_object");
    expect(d.wrapper).toBe("code_fence");
    expect(d.object).toEqual(MANIFEST);
  });

  it("leading prose then JSON is surrounding_prose, and the manifest is recovered intact", () => {
    const d = classifyDesignOutput(
      `Sure! Here is the manifest you asked for.\n\n${MANIFEST_JSON}\n\nLet me know if you want changes.`,
    );
    expect(d.shape).toBe("manifest_shaped_object");
    expect(d.wrapper).toBe("surrounding_prose");
    expect(d.object).toEqual(MANIFEST);
  });

  it("JSON cut off mid-object is truncated_json and recovers nothing", () => {
    const d = classifyDesignOutput(MANIFEST_JSON.slice(0, MANIFEST_JSON.length - 40));
    expect(d.shape).toBe("truncated_json");
    expect(d.wrapper).toBe("none");
    expect(d.object).toBeNull();
    expect(d.detail).toMatch(/cut off/);
  });

  it("an array where an object was wanted is array_not_object, not its first element", () => {
    const d = classifyDesignOutput(JSON.stringify([MANIFEST]));
    expect(d.shape).toBe("array_not_object");
    expect(d.object).toBeNull();
    expect(d.detail).toMatch(/array of 1 item/);
  });

  it("valid JSON that is not a manifest is object_not_manifest, and keeps the object", () => {
    const d = classifyDesignOutput('{"answer": "I would need more detail about your business."}');
    expect(d.shape).toBe("object_not_manifest");
    expect(d.object).toEqual({ answer: "I would need more detail about your business." });
    expect(d.detail).toMatch(/no manifest keys/);
  });
});

describe("classifyDesignOutput — remaining shapes", () => {
  it("a bare manifest object has no wrapper", () => {
    const d = classifyDesignOutput(MANIFEST_JSON);
    expect(d.shape).toBe("manifest_shaped_object");
    expect(d.wrapper).toBe("none");
  });

  it("whitespace only is empty", () => {
    expect(classifyDesignOutput("   \n\t ").shape).toBe("empty");
    expect(classifyDesignOutput("").shape).toBe("empty");
  });

  it("pure prose is no_json", () => {
    const d = classifyDesignOutput(
      "I'm sorry, I can't design a schema without knowing your industry.",
    );
    expect(d.shape).toBe("no_json");
    expect(d.detail).toMatch(/prose/);
  });

  it("a top-level string or number is scalar_not_object", () => {
    expect(classifyDesignOutput('"a manifest"').shape).toBe("scalar_not_object");
    expect(classifyDesignOutput("42").shape).toBe("scalar_not_object");
    expect(classifyDesignOutput("null").shape).toBe("scalar_not_object");
  });

  it("balanced brackets that do not parse are malformed_json, never repaired", () => {
    const d = classifyDesignOutput('{"entities": [{"name": "Bike",}]}');
    expect(d.shape).toBe("malformed_json");
    expect(d.object).toBeNull();
  });

  it("bare keys are malformed_json", () => {
    expect(classifyDesignOutput("{entities: []}").shape).toBe("malformed_json");
  });

  it("single-quoted JSON is malformed_json rather than silently corrected", () => {
    expect(classifyDesignOutput("{'entities': []}").shape).toBe("malformed_json");
  });

  it("a brace inside a string does not end the object", () => {
    const d = classifyDesignOutput('{"entities": [], "note": "closing } brace"}');
    expect(d.shape).toBe("manifest_shaped_object");
    expect(d.object).toEqual({ entities: [], note: "closing } brace" });
  });

  it("an escaped quote inside a string does not end the string", () => {
    const d = classifyDesignOutput('{"entities": [], "note": "a \\" and a } here"}');
    expect(d.shape).toBe("manifest_shaped_object");
  });

  it("a fenced truncated object reports the fence and the truncation together", () => {
    const d = classifyDesignOutput('```json\n{"entities": [{"name": "Bi');
    expect(d.shape).toBe("truncated_json");
    expect(d.wrapper).toBe("code_fence");
  });

  it("prose before a truncated object still reads as surrounding_prose", () => {
    const d = classifyDesignOutput('Here you go:\n{"entities": [');
    expect(d.shape).toBe("truncated_json");
    expect(d.wrapper).toBe("surrounding_prose");
  });

  it("a fenced array is still array_not_object — wrapper and shape are independent", () => {
    const d = classifyDesignOutput('```\n[{"entities": []}]\n```');
    expect(d.shape).toBe("array_not_object");
    expect(d.wrapper).toBe("code_fence");
  });

  it("prose outside a fence does not downgrade the fence diagnosis", () => {
    const d = classifyDesignOutput(`Here it is:\n\`\`\`json\n${MANIFEST_JSON}\n\`\`\`\nDone.`);
    expect(d.wrapper).toBe("code_fence");
    expect(d.shape).toBe("manifest_shaped_object");
  });

  it("an object nested inside an array is never mistaken for the whole design", () => {
    const d = classifyDesignOutput(`[\n${MANIFEST_JSON}\n]`);
    expect(d.shape).toBe("array_not_object");
  });

  it("an unclosed fence with no JSON at all is no_json, not truncated", () => {
    expect(classifyDesignOutput("```\nI need more information").shape).toBe("no_json");
  });

  it("honours an injected recognizer", () => {
    const d = classifyDesignOutput('{"answer": 1}', { recognize: () => true });
    expect(d.shape).toBe("manifest_shaped_object");
  });
});
