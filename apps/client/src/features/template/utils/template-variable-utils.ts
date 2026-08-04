import type { JSONContent } from "@tiptap/core";
import type { ITemplateInputSchema } from "@/features/template/types/template.types";

export const TEMPLATE_VARIABLE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;

export function getDefaultTemplateVariables(
  schema: ITemplateInputSchema,
): Record<string, unknown> {
  const required = new Set(schema.required ?? []);
  return Object.fromEntries(
    Object.entries(schema.properties).flatMap(([name, definition]) => {
      if (definition.default !== undefined) {
        return [[name, definition.default]];
      }
      if (!required.has(name)) return [];
      if (definition.type === "boolean") return [[name, false]];
      if (definition.type === "array") return [[name, []]];
      if (definition.type === "string") return [[name, ""]];
      return [];
    }),
  );
}

export function renameTemplateVariableInText(
  value: string,
  oldName: string,
  nextName: string,
): string {
  const escapedName = oldName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const block = new RegExp(`\\{\\{\\{\\s*${escapedName}\\s*\\}\\}\\}`, "g");
  const inline = new RegExp(`\\{\\{\\s*${escapedName}\\s*\\}\\}`, "g");
  return value
    .replace(block, `{{{${nextName}}}}`)
    .replace(inline, `{{${nextName}}}`);
}

export function renameTemplateVariableInContent(
  content: JSONContent,
  oldName: string,
  nextName: string,
): JSONContent {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;

    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [
        key,
        key === "text" && typeof child === "string"
          ? renameTemplateVariableInText(child, oldName, nextName)
          : visit(child),
      ]),
    );
  };

  return visit(content) as JSONContent;
}
