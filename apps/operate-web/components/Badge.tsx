import { badgeTone, titleCase } from "@/lib/format";

export function Badge({ value }: { value: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${badgeTone(value)}`}
    >
      {titleCase(value)}
    </span>
  );
}
