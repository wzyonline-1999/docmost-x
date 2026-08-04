import { describe, expect, it } from "vitest";
import {
  getDefaultTemplateVariables,
  renameTemplateVariableInContent,
  renameTemplateVariableInText,
} from "./template-variable-utils";

describe("template variable defaults", () => {
  it("keeps explicit defaults and initializes required empty values", () => {
    expect(
      getDefaultTemplateVariables({
        type: "object",
        additionalProperties: false,
        properties: {
          summary: { type: "string", default: "Ready" },
          notes: { type: "string", "x-docmost-type": "markdown" },
          approved: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
          optional: { type: "string" },
        },
        required: ["notes", "approved", "tags"],
      }),
    ).toEqual({
      summary: "Ready",
      notes: "",
      approved: false,
      tags: [],
    });
  });
});

describe("template variable rename helpers", () => {
  it("renames exact inline and Markdown placeholders", () => {
    expect(
      renameTemplateVariableInText(
        "{{ project }} / {{{project}}} / {{projectCode}}",
        "project",
        "projectName",
      ),
    ).toBe("{{projectName}} / {{{projectName}}} / {{projectCode}}");
  });

  it("renames placeholders recursively without mutating the source document", () => {
    const source = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "Hello {{name}}" }],
        },
      ],
    };

    const result = renameTemplateVariableInContent(source, "name", "owner");

    expect(result.content?.[0].content?.[0].text).toBe("Hello {{owner}}");
    expect(source.content[0].content[0].text).toBe("Hello {{name}}");
  });
});
