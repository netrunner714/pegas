#!/usr/bin/env bun
/**
 * Генератор эталонного example.json из schemas/pegas.json.
 *
 * RFC_UX_V3, решение №4: эталон — генерируемый артефакт схемы. Ручные правки запрещены;
 * источник значений — поле examples у каждого узла схемы.
 *
 * Правила обхода:
 * - object: обязательные поля (required) + $schema; значение каждого поля — из его examples;
 * - сценарная карта (additionalProperties → $ref): разворачивается по scenarios эталона;
 * - array: первый элемент examples;
 * - enum: первое значение;
 * - examples у родителя приоритетнее рекурсии.
 */
import fs from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const SCHEMA_PATH = path.join(REPO_ROOT, "schemas/pegas.json");
const EXAMPLE_PATH = path.join(REPO_ROOT, "example.json");

interface SchemaNode {
  type?: string;
  examples?: unknown[];
  enum?: unknown[];
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: SchemaNode | boolean;
  items?: SchemaNode;
  $ref?: string;
  $defs?: Record<string, SchemaNode>;
}

function deref(schema: SchemaNode, root: SchemaNode): SchemaNode {
  if (!schema.$ref) return schema;
  const refPath = schema.$ref.split("/").pop() ?? "";
  const target = root.$defs?.[refPath];
  return target ? { ...target, examples: schema.examples ?? target.examples } : schema;
}

function valueFromSchema(schema: SchemaNode, root: SchemaNode, scenarios: string[]): unknown {
  if (schema.examples && schema.examples.length > 0) return schema.examples[0];
  if (schema.enum && schema.enum.length > 0) return schema.enum[0];
  if (schema.type === "array") {
    const item = deref(schema.items ?? {}, root);
    const itemValue = valueFromSchema(item, root, scenarios);
    return itemValue === undefined ? [] : [itemValue];
  }
  if (schema.type === "object") {
    const out: Record<string, unknown> = {};
    for (const key of schema.required ?? Object.keys(schema.properties ?? {})) {
      const prop = deref(schema.properties?.[key] ?? {}, root);
      out[key] = valueFromSchema(prop, root, scenarios);
    }
    // Сценарная карта: additionalProperties → $ref на сценарный узел
    if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
      const scenarioSchema = deref(schema.additionalProperties, root);
      for (const sc of scenarios) {
        out[sc] = valueFromSchema(scenarioSchema, root, scenarios);
      }
    }
    return out;
  }
  return undefined;
}

function buildExample(schema: SchemaNode): Record<string, unknown> {
  const root = schema;
  const out: Record<string, unknown> = {};

  // $schema подсказка — первый ключ эталона
  out.$schema = "https://netrunner714.ru/schemas/pegas.json";

  for (const key of schema.required ?? []) {
    if (key === "$schema") continue;
    out[key] = valueFromSchema(deref(schema.properties?.[key] ?? {}, root), root, []);
  }

  const scenarios = (out.scenarios as string[]) ?? ["development"];

  // gateway: сценарная карта, собранная из $defs.gatewayScenario
  const gatewayProp = deref(schema.properties?.gateway ?? {}, root);
  const gatewayAddl = gatewayProp.additionalProperties;
  if (gatewayAddl && typeof gatewayAddl === "object") {
    const scenarioSchema = deref(gatewayAddl, root);
    const gateway: Record<string, unknown> = {};
    for (const sc of scenarios) {
      gateway[sc] = valueFromSchema(scenarioSchema, root, scenarios);
    }
    out.gateway = gateway;
  }

  // services: эталонная карта имя → сервис из examples свойства services схемы
  const servicesProp = deref(schema.properties?.services ?? {}, root);
  const servicesExample = (servicesProp.examples ?? [])[0];
  if (servicesExample && typeof servicesExample === "object" && !Array.isArray(servicesExample)) {
    out.services = servicesExample;
  }

  return out;
}

async function main(): Promise<void> {
  const raw = await fs.readFile(SCHEMA_PATH, "utf-8");
  const schema = JSON.parse(raw) as SchemaNode;
  const example = buildExample(schema);
  const content = JSON.stringify(example, null, 2) + "\n";
  await fs.writeFile(EXAMPLE_PATH, content, "utf-8");
  console.log(`✓ example.json перегенерирован из schemas/pegas.json (${content.length} байт)`);
}

main().catch((err) => {
  console.error("gen-example failed:", err);
  process.exit(1);
});
