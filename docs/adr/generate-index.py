#!/usr/bin/env python3
"""Regenerates docs/adr/index.md from the ADR files. Run after adding or re-statusing an ADR."""
import re, pathlib, sys

adr_dir = pathlib.Path(__file__).resolve().parent
rows = []
for p in sorted(adr_dir.glob("[0-9][0-9][0-9][0-9]-*.md")):
    if p.name.startswith("0000-"): continue
    text = p.read_text()
    m = re.search(r"^#\s*ADR-(\d{4}):\s*(.+?)\s*$", text, re.M)
    if not m:
        print("no title:", p.name); sys.exit(1)
    num, title = m.group(1), m.group(2)
    title = title.replace("\\<", "<")
    phase = "—"
    pm = re.search(r"\s*\((Phase [^)]+)\)\s*$", title)
    if pm:
        phase = pm.group(1)
        title = title[: pm.start()].strip()
    def field(name, default):
        fm = re.search(r"^\|\s*\*\*" + name + r"\*\*\s*\|\s*(.+?)\s*\|\s*$", text, re.M)
        return fm.group(1).strip() if fm else default
    status = field("Status", "Proposed")
    date = field("Date", "")
    rows.append((num, p.name, title, phase, status, date))

template = adr_dir / "0000-template.md"
tpl_row = ("0000", template.name, "_Template_", "—", "Proposed", "YYYY-MM-DD")
rows = [r for r in rows if r[0] != "0000"]
rows.insert(0, tpl_row)

# The template row is counted, as the committed index counted it: its header read "293 records" for
# 292 ADRs plus the template, and the template is Proposed. Keeping that convention means the number
# only moves when an ADR is added.
counted = rows
accepted = sum(1 for r in counted if r[4] == "Accepted")
proposed = sum(1 for r in counted if r[4] == "Proposed")
other = len(counted) - accepted - proposed

head = f"""# ADR index

{len(counted)} records. Generated from the ADR files themselves — regenerate rather than
hand-edit, so a title or status change in an ADR cannot silently drift from this table:
`python3 docs/adr/generate-index.py`.

- **Accepted:** {accepted}  **Proposed:** {proposed}
- ADRs **0080–0085** were reserved by ADR-0077 for Phase 3 P3–P8 and never written;
  those milestones landed under other numbers. The gap is permanent and intentional.
- ADR-0046 is the Phase 2 plan; **ADR-0077 is the Phase 3 plan (P1–P8)**. Phase 4 has no
  plan ADR — it has proceeded one shipped increment at a time since ADR-0236.

| # | Title | Phase | Status | Date |
|---|---|---|---|---|
"""
if other:
    head = head.replace(f"**Proposed:** {proposed}", f"**Proposed:** {proposed}  **Other:** {other}")

body = "".join(
    f"| [{n}]({fn}) | {t} | {ph} | {st} | {d} |\n" for n, fn, t, ph, st, d in rows
)
(adr_dir / "index.md").write_text(head + body)
print(f"{len(counted)} records, {accepted} accepted, {proposed} proposed, {other} other")
