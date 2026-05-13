import { z } from "zod";

const PACKAGE_REGEX = /^(?:@[a-z0-9][a-z0-9-]*\/)?[a-z0-9][a-z0-9-]*$/;
const RENDER_NAME_REGEX = /^[A-Z][A-Za-z0-9]*$/;

export const CustomWidgetDeclarationSchema = z.object({
  package: z.string().regex(PACKAGE_REGEX, {
    message: "package must be an npm-style id (e.g., '@crossengin/widget-barcode')",
  }),
  render: z.string().regex(RENDER_NAME_REGEX, {
    message: "render must be a PascalCase component name",
  }),
  appliesTo: z
    .object({
      field: z.string().min(1).optional(),
      entity: z.string().min(1).optional(),
      fieldKind: z.string().min(1).optional(),
    })
    .refine(
      (v) => v.field !== undefined || v.entity !== undefined || v.fieldKind !== undefined,
      { message: "appliesTo must specify at least one of field, entity, or fieldKind" },
    ),
  capacitorOnly: z.boolean().default(false),
  requiresPermission: z.string().min(1).optional(),
  fallbackRender: z.enum(["text", "json", "hidden"]).default("text"),
});
export type CustomWidgetDeclaration = z.infer<typeof CustomWidgetDeclarationSchema>;

const FIRST_PARTY_PACKAGE_REGEX = /^@crossengin\/[a-z0-9][a-z0-9-]*$/;

export function assertFirstPartyWidget(widget: CustomWidgetDeclaration): void {
  if (!FIRST_PARTY_PACKAGE_REGEX.test(widget.package)) {
    throw new Error(
      `custom widget package '${widget.package}' is not first-party (must be @crossengin/*)`,
    );
  }
}
