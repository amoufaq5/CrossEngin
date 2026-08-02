"use client";

import { ReferencePicker } from "@/components/ReferencePicker";
import type { UiFieldSchema, UiSchema } from "@/lib/schema";

const INPUT_BASE =
  "w-full rounded-lg border px-3 py-2 text-sm outline-none transition disabled:bg-surface-soft disabled:text-ink-faint";

export function FieldInput({
  field,
  value,
  onChange,
  disabled,
  invalid,
  describedById,
  schema,
}: {
  field: UiFieldSchema;
  value: string | boolean;
  onChange: (v: string | boolean) => void;
  disabled?: boolean;
  invalid?: boolean;
  /** id of the element describing this field's error, for aria-describedby when invalid. */
  describedById?: string;
  schema?: UiSchema | null;
}) {
  const ro = disabled === true || field.readOnly === true;
  const INPUT_CLASS = `${INPUT_BASE} ${invalid === true ? "border-red-400 focus:border-red-500" : "border-line focus:border-brand"}`;
  // Screen-reader hooks applied to the standard inputs (text/select/textarea).
  const a11y = {
    "aria-invalid": invalid === true ? true : undefined,
    "aria-describedby": invalid === true ? describedById : undefined,
  } as const;

  if (field.input === "reference" && field.referenceTarget && schema !== undefined) {
    return (
      <ReferencePicker
        target={field.referenceTarget}
        value={String(value ?? "")}
        onChange={onChange}
        disabled={ro}
        required={field.required}
        schema={schema}
      />
    );
  }

  if (field.input === "boolean") {
    return (
      <label className="inline-flex items-center gap-2 text-sm text-ink">
        <input
          type="checkbox"
          className="h-4 w-4 rounded border-line text-brand focus:ring-brand"
          checked={value === true || value === "true"}
          disabled={ro}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span className="text-ink-muted">{field.label}</span>
      </label>
    );
  }

  if (field.input === "select") {
    return (
      <select className={INPUT_CLASS} value={String(value ?? "")} disabled={ro} {...a11y} onChange={(e) => onChange(e.target.value)}>
        {!field.required && <option value="">—</option>}
        {(field.enumValues ?? []).map((opt) => (
          <option key={opt} value={opt}>
            {opt.replace(/_/g, " ")}
          </option>
        ))}
      </select>
    );
  }

  if (field.input === "textarea") {
    return (
      <textarea
        className={`${INPUT_CLASS} min-h-[80px]`}
        value={String(value ?? "")}
        disabled={ro}
        {...a11y}
        onChange={(e) => onChange(e.target.value)}
      />
    );
  }

  const htmlType =
    field.input === "number"
      ? "number"
      : field.input === "date"
        ? "date"
        : field.input === "datetime"
          ? "datetime-local"
          : field.input === "email"
            ? "email"
            : "text";

  return (
    <input
      type={htmlType}
      className={INPUT_CLASS}
      value={String(value ?? "")}
      disabled={ro}
      {...a11y}
      placeholder={field.input === "reference" ? `${field.referenceTarget ?? ""} id` : undefined}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}
