import type { Entity } from "@crossengin/types/meta-schema";
import { CycleDetectedError } from "./errors.js";

export function topologicalSort(entities: readonly Entity[]): readonly Entity[] {
  const byName = new Map(entities.map((e) => [e.name, e]));
  const visited = new Set<string>();
  const visiting = new Set<string>();
  const result: Entity[] = [];

  function visit(name: string, path: readonly string[]): void {
    if (visited.has(name)) return;
    if (visiting.has(name)) {
      const cycleStart = path.indexOf(name);
      const cycle = [...path.slice(cycleStart), name];
      throw new CycleDetectedError(cycle);
    }

    const entity = byName.get(name);
    if (entity === undefined) return;

    visiting.add(name);

    for (const field of entity.fields) {
      if (field.type.kind === "reference" && field.type.target !== entity.name) {
        visit(field.type.target, [...path, name]);
      }
    }

    visiting.delete(name);
    visited.add(name);
    result.push(entity);
  }

  for (const entity of entities) {
    visit(entity.name, []);
  }

  return result;
}
