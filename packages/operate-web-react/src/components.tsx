import type {
  CalendarModel,
  DashboardModel,
  DetailModel,
  FormFieldModel,
  FormModel,
  KanbanModel,
  MapModel,
  PivotModel,
  TableModel,
  WebAppModel,
} from "@crossengin/operate-web";
import type { FormEvent, JSX, ReactNode } from "react";

/**
 * Presentational, framework-pure React components over the `operate-web` view
 * models. They render *intent* the compiler already shaped + redacted: only the
 * columns / fields / sections the model carries are emitted, so a field the
 * caller can't read is structurally absent from the markup (the compiler dropped
 * it before the component ever saw it). No data fetching, no client state, no
 * effects — these render deterministically to static markup via
 * `react-dom/server`.
 */

/** Coerces an unknown record value into a display string for static markup. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

export interface AppShellProps {
  readonly app: WebAppModel;
  /** Base path the nav links are built under (default `/app`). */
  readonly basePath?: string;
  /** Optional page body rendered inside the shell's main region. */
  readonly children?: ReactNode;
}

/**
 * The app chrome: a title bar + a nav listing every entity in the model (one
 * link per entity to its table surface), wrapping an optional page body.
 */
export function AppShell({ app, basePath = "/app", children }: AppShellProps): JSX.Element {
  return (
    <div className="ce-app">
      <header className="ce-app-header">
        <h1 className="ce-app-title">{app.title}</h1>
      </header>
      <nav className="ce-app-nav" aria-label="Entities">
        <ul>
          {app.nav.map((entry) => (
            <li key={entry.entity}>
              <a href={`${basePath}/${entry.entity}`} data-entity={entry.entity}>
                {entry.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>
      <main className="ce-app-main">{children}</main>
    </div>
  );
}

export interface TableViewProps {
  readonly model: TableModel;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** Base path used to link each row to its detail surface (default `/app`). */
  readonly basePath?: string;
}

/**
 * Renders a `TableModel` + a page of row records into a semantic `<table>`. The
 * header comes from the model's columns (already redacted), and each body row
 * pulls only those same columns from the record — so a redacted column never
 * appears as a header *or* a cell.
 */
export function TableView({ model, rows, basePath = "/app" }: TableViewProps): JSX.Element {
  const hasRowLink = model.rowActions.some((a) => a.kind === "openRecord");
  return (
    <section className="ce-table" data-entity={model.entity}>
      <h2 className="ce-table-title">{model.title}</h2>
      <table>
        <thead>
          <tr>
            {model.columns.map((col) => (
              <th key={col.field} data-field={col.field} scope="col">
                {col.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const id = displayValue(row["id"]);
            return (
              <tr key={id.length > 0 ? id : `row-${String(index)}`}>
                {model.columns.map((col) => {
                  const text = displayValue(row[col.field]);
                  return (
                    <td key={col.field} data-field={col.field}>
                      {hasRowLink && col === model.columns[0] && id.length > 0 ? (
                        <a href={`${basePath}/${model.entity}/${id}`}>{text}</a>
                      ) : (
                        text
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export interface KanbanViewProps {
  readonly model: KanbanModel;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** Base path used to link each card to its detail surface (default `/app`). */
  readonly basePath?: string;
}

/**
 * Renders a `KanbanModel` + a page of records into a board: one column per
 * declared state, each holding the cards whose `stateField` value matches. A
 * card shows only the model's (already redacted) `cardFields`, and links to the
 * record's detail. Records whose state matches no column are dropped (the board
 * shows the declared lanes only).
 */
export function KanbanView({ model, rows, basePath = "/app" }: KanbanViewProps): JSX.Element {
  return (
    <section className="ce-kanban" data-entity={model.entity} data-state-field={model.stateField}>
      <h2 className="ce-kanban-title">{model.title}</h2>
      <div className="ce-kanban-board">
        {model.columns.map((col) => {
          const cards = rows.filter((r) => displayValue(r[model.stateField]) === col.state);
          return (
            <div
              key={col.state}
              className="ce-kanban-column"
              data-state={col.state}
              {...(col.color !== undefined ? { style: { borderTopColor: col.color } } : {})}
            >
              <h3 className="ce-kanban-column-title">
                {col.label}
                <span className="ce-kanban-count"> ({String(cards.length)}{col.wipLimit !== undefined ? `/${String(col.wipLimit)}` : ""})</span>
              </h3>
              <ul className="ce-kanban-cards">
                {cards.map((row, index) => {
                  const id = displayValue(row["id"]);
                  return (
                    <li key={id.length > 0 ? id : `card-${String(index)}`} className="ce-kanban-card" data-id={id}>
                      {id.length > 0 ? (
                        <a href={`${basePath}/${model.entity}/${id}`}>
                          <KanbanCardFields model={model} row={row} />
                        </a>
                      ) : (
                        <KanbanCardFields model={model} row={row} />
                      )}
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function KanbanCardFields({
  model,
  row,
}: {
  readonly model: KanbanModel;
  readonly row: Readonly<Record<string, unknown>>;
}): JSX.Element {
  return (
    <dl className="ce-kanban-card-fields">
      {model.cardFields.map((field) => (
        <div key={field.field} className="ce-kanban-card-field" data-field={field.field}>
          <dt>{field.label}</dt>
          <dd>{displayValue(row[field.field])}</dd>
        </div>
      ))}
    </dl>
  );
}

export interface CalendarViewProps {
  readonly model: CalendarModel;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  /** Base path used to link each event to its detail surface (default `/app`). */
  readonly basePath?: string;
}

/**
 * Renders a `CalendarModel` + a page of records into an agenda list: one entry
 * per record, ordered by its `startField`, showing the title + start (+ end /
 * color when the model carries those — redacted-aware, so an axis the viewer
 * can't read is simply absent). A full calendar grid is a later refinement; the
 * agenda is the framework-neutral SSR baseline.
 */
export function CalendarView({ model, rows, basePath = "/app" }: CalendarViewProps): JSX.Element {
  const events = [...rows].sort((a, b) =>
    displayValue(a[model.startField]).localeCompare(displayValue(b[model.startField])),
  );
  return (
    <section className="ce-calendar" data-entity={model.entity} data-default-view={model.defaultView}>
      <h2 className="ce-calendar-title">{model.title}</h2>
      <ul className="ce-calendar-agenda">
        {events.map((row, index) => {
          const id = displayValue(row["id"]);
          const title = displayValue(row[model.titleField]);
          const start = displayValue(row[model.startField]);
          const end = model.endField !== undefined ? displayValue(row[model.endField]) : "";
          const color = model.colorField !== undefined ? displayValue(row[model.colorField]) : "";
          return (
            <li key={id.length > 0 ? id : `event-${String(index)}`} className="ce-calendar-event" data-id={id}>
              <time className="ce-calendar-start" dateTime={start}>{start}</time>
              {end.length > 0 ? <time className="ce-calendar-end" dateTime={end}>{end}</time> : null}
              {color.length > 0 ? <span className="ce-calendar-color" data-color={color} /> : null}
              <span className="ce-calendar-event-title">
                {id.length > 0 ? <a href={`${basePath}/${model.entity}/${id}`}>{title}</a> : title}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface MapViewProps {
  readonly model: MapModel;
  readonly rows: readonly Readonly<Record<string, unknown>>[];
  readonly basePath?: string;
}

/**
 * Renders a `MapModel` + a page of records as the SSR baseline: the declared
 * layers + a marker list (one entry per record, showing its geo value, optional
 * label / color, linked to detail). A tiled map needs a client renderer
 * (Leaflet/MapLibre) — the accessible list is the framework-neutral fallback the
 * server can produce, and the hook a client map enhances.
 */
export function MapView({ model, rows, basePath = "/app" }: MapViewProps): JSX.Element {
  return (
    <section className="ce-map" data-entity={model.entity} data-geo-field={model.geoField} data-zoom={String(model.defaultZoom)}>
      <h2 className="ce-map-title">{model.title}</h2>
      <ul className="ce-map-layers" aria-label="Layers">
        {model.layers.map((l) => (
          <li key={l.id} className="ce-map-layer" data-layer={l.id} data-kind={l.kind}>{l.label}</li>
        ))}
      </ul>
      <ul className="ce-map-markers">
        {rows.map((row, index) => {
          const id = displayValue(row["id"]);
          const geo = displayValue(row[model.geoField]);
          const label = model.markerLabelField !== undefined ? displayValue(row[model.markerLabelField]) : geo;
          const color = model.markerColorField !== undefined ? displayValue(row[model.markerColorField]) : "";
          return (
            <li key={id.length > 0 ? id : `marker-${String(index)}`} className="ce-map-marker" data-id={id} data-geo={geo}>
              {color.length > 0 ? <span className="ce-map-marker-color" data-color={color} /> : null}
              {id.length > 0 ? <a href={`${basePath}/${model.entity}/${id}`}>{label}</a> : label}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

export interface DashboardViewProps {
  readonly model: DashboardModel;
}

/**
 * Renders a `DashboardModel` as a 12-column CSS grid of widget placeholders.
 * Each cell is positioned from its `x/y/w/h`; a report-backed widget shows its
 * kind + report id (the data isn't executed server-side — report-data execution
 * is a deferred item), a markdown widget its body, a divider its label. Only the
 * cells the viewer may see are present (the compiler dropped the rest).
 */
export function DashboardView({ model }: DashboardViewProps): JSX.Element {
  return (
    <section className="ce-dashboard" data-entity={model.entity} data-layout={model.layout}>
      <h2 className="ce-dashboard-title">{model.title}</h2>
      <div
        className="ce-dashboard-grid"
        style={{ display: "grid", gridTemplateColumns: "repeat(12, 1fr)", gap: "0.5rem" }}
      >
        {model.cells.map((cell, index) => (
          <div
            key={`${String(cell.x)}-${String(cell.y)}-${String(index)}`}
            className="ce-dashboard-cell"
            data-widget={cell.widget.kind}
            style={{
              gridColumn: `${String(cell.x + 1)} / span ${String(cell.w)}`,
              gridRow: `${String(cell.y + 1)} / span ${String(cell.h)}`,
            }}
          >
            <div className="ce-widget" data-kind={cell.widget.kind}>
              {cell.widget.title !== undefined ? <h3 className="ce-widget-title">{cell.widget.title}</h3> : null}
              {cell.widget.report !== undefined ? (
                <p className="ce-widget-report" data-report={cell.widget.report}>{`${cell.widget.kind}: ${cell.widget.report}`}</p>
              ) : null}
              {cell.widget.body !== undefined ? <div className="ce-widget-markdown">{cell.widget.body}</div> : null}
              {cell.widget.label !== undefined ? <hr className="ce-widget-divider" aria-label={cell.widget.label} /> : null}
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

export interface PivotViewProps {
  readonly model: PivotModel;
}

/**
 * Renders a `PivotModel` as a placeholder referencing its report + reshape flag.
 * The pivot aggregation isn't executed server-side (report-data execution is a
 * deferred item); this is the SSR descriptor a client pivot table enhances.
 */
export function PivotView({ model }: PivotViewProps): JSX.Element {
  return (
    <section className="ce-pivot" data-entity={model.entity} data-report={model.reportRef} data-reshape={model.allowReshape ? "true" : "false"}>
      <h2 className="ce-pivot-title">{model.title}</h2>
      <p className="ce-pivot-report">{model.reportLabel ?? model.reportRef}</p>
      <p className="ce-pivot-reshape">{model.allowReshape ? "Reshape: allowed" : "Reshape: locked"}</p>
    </section>
  );
}

export interface DetailViewProps {
  readonly model: DetailModel;
  /** The record's values; the model's field values are preferred when present. */
  readonly record?: Readonly<Record<string, unknown>>;
}

/**
 * Renders a `DetailModel` into one `<section>` per detail section, each a
 * `<dl>` of label/value pairs. A field's value comes from the model when the
 * compiler bound a record into it, else from the supplied `record`. Only the
 * model's (redacted) fields are rendered.
 */
export function DetailView({ model, record }: DetailViewProps): JSX.Element {
  return (
    <article className="ce-detail" data-entity={model.entity}>
      <h2 className="ce-detail-title">{model.title}</h2>
      {model.sections.map((section, sectionIndex) => (
        <section key={`${section.title}-${String(sectionIndex)}`} className="ce-detail-section">
          <h3>{section.title}</h3>
          <dl>
            {section.fields.map((field) => {
              const value =
                "value" in field ? field.value : record !== undefined ? record[field.field] : undefined;
              return (
                <div key={field.field} className="ce-detail-row" data-field={field.field}>
                  <dt>{field.label}</dt>
                  <dd>{displayValue(value)}</dd>
                </div>
              );
            })}
          </dl>
        </section>
      ))}
    </article>
  );
}

/** The HTML input `type` a form field's render hint maps to. */
function inputTypeFor(type: FormFieldModel["type"]): string {
  switch (type) {
    case "integer":
    case "decimal":
    case "currency_amount":
      return "number";
    case "date":
      return "date";
    case "time":
      return "time";
    case "datetime":
      return "datetime-local";
    case "email":
      return "email";
    case "phone":
      return "tel";
    case "url":
      return "url";
    default:
      return "text";
  }
}

export interface FormViewProps {
  readonly model: FormModel;
  /** The path the form POSTs to (default `/app/:entity` for create; the no-JS fallback). */
  readonly action?: string;
  /** Prefill values keyed by field name (an edit form). */
  readonly values?: Readonly<Record<string, unknown>>;
  /** When set, the form submits via this handler (the hydrated client) instead of a native POST. */
  readonly onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Disables the submit button while a write is in flight. */
  readonly submitting?: boolean;
  /** An optional status / error node rendered under the actions. */
  readonly statusNode?: ReactNode;
}

/** Coerces a prefill value into the string an input's `defaultValue` expects. */
function prefillString(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString();
  return JSON.stringify(value);
}

/**
 * Renders a `FormModel` into a `<form>` with one labelled control per field.
 * A read-only field's control is `disabled`; a required field is marked
 * `required` and flagged in its label. `long_text` renders a `<textarea>`,
 * `boolean` a checkbox, `enum` a `<select>` over its declared values, else a
 * typed `<input>`. Only the model's (redacted) fields appear. When `values` is
 * supplied (an edit form) each control is prefilled. When `onSubmit` is supplied
 * (the hydrated client) the form submits through it; otherwise it falls back to
 * a native POST to `action`.
 */
export function FormView({ model, action, values, onSubmit, submitting, statusNode }: FormViewProps): JSX.Element {
  const formAction = action ?? `/app/${model.entity}`;
  return (
    <form
      className="ce-form"
      data-entity={model.entity}
      data-mode={model.mode}
      method="post"
      action={formAction}
      {...(onSubmit !== undefined ? { onSubmit } : {})}
    >
      <h2 className="ce-form-title">{model.title}</h2>
      {model.fields.map((field) => {
        const controlId = `field-${field.field}`;
        const enumRule = field.validations.find((v) => v.kind === "enum");
        return (
          <div key={field.field} className="ce-form-field" data-field={field.field}>
            <label htmlFor={controlId}>
              {field.label}
              {field.required ? <span className="ce-required" aria-hidden="true"> *</span> : null}
            </label>
            {renderControl(field, controlId, enumRule, values?.[field.field])}
          </div>
        );
      })}
      <div className="ce-form-actions">
        <button type="submit" disabled={submitting === true || model.fields.every((f) => f.readOnly)}>
          {model.mode === "create" ? "Create" : "Save"}
        </button>
      </div>
      {statusNode !== undefined ? <div className="ce-form-status" role="status">{statusNode}</div> : null}
    </form>
  );
}

function renderControl(
  field: FormFieldModel,
  controlId: string,
  enumRule: { kind: "enum"; values: readonly string[] } | undefined,
  prefill: unknown,
): JSX.Element {
  if (field.type === "enum" && enumRule !== undefined) {
    return (
      <select
        id={controlId}
        name={field.field}
        disabled={field.readOnly}
        required={field.required}
        defaultValue={prefill !== undefined ? prefillString(prefill) : ""}
      >
        <option value="" disabled>
          Select…
        </option>
        {enumRule.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  if (field.type === "long_text" || field.type === "json") {
    return (
      <textarea
        id={controlId}
        name={field.field}
        disabled={field.readOnly}
        required={field.required}
        defaultValue={prefillString(prefill)}
      />
    );
  }
  if (field.type === "boolean") {
    return (
      <input
        id={controlId}
        name={field.field}
        type="checkbox"
        disabled={field.readOnly}
        defaultChecked={prefill === true || prefill === "true"}
      />
    );
  }
  return (
    <input
      id={controlId}
      name={field.field}
      type={inputTypeFor(field.type)}
      disabled={field.readOnly}
      required={field.required}
      defaultValue={prefillString(prefill)}
    />
  );
}
