import {
  ActionIcon,
  Button,
  Group,
  NumberInput,
  Paper,
  Select,
  Stack,
  Switch,
  TagsInput,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core";
import {
  IconBraces,
  IconCodePlus,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  ITemplateInputSchema,
  ITemplateVariableDefinition,
} from "@/features/template/types/template.types";
import { TEMPLATE_VARIABLE_NAME_PATTERN } from "@/features/template/utils/template-variable-utils";
import classes from "./template-schema-editor.module.css";

type UiVariableType =
  | "text"
  | "markdown"
  | "number"
  | "integer"
  | "boolean"
  | "list";

interface TemplateSchemaEditorProps {
  schema: ITemplateInputSchema;
  onChange: (schema: ITemplateInputSchema) => void;
  onInsert: (name: string, markdown: boolean) => void;
  onRename: (oldName: string, nextName: string) => void;
  readOnly?: boolean;
}

export function TemplateSchemaEditor({
  schema,
  onChange,
  onInsert,
  onRename,
  readOnly = false,
}: TemplateSchemaEditorProps) {
  const { t } = useTranslation();
  const required = new Set(schema.required ?? []);

  const updateProperty = (
    name: string,
    definition: ITemplateVariableDefinition,
  ) => {
    onChange({
      ...schema,
      properties: { ...schema.properties, [name]: definition },
    });
  };

  const renameProperty = (oldName: string, nextName: string) => {
    const properties = Object.fromEntries(
      Object.entries(schema.properties).map(([name, definition]) => [
        name === oldName ? nextName : name,
        definition,
      ]),
    );
    onChange({
      ...schema,
      properties,
      required: [...required].map((name) =>
        name === oldName ? nextName : name,
      ),
    });
    onRename(oldName, nextName);
  };

  const addVariable = () => {
    let index = Object.keys(schema.properties).length + 1;
    while (schema.properties[`variable${index}`]) index += 1;
    const name = `variable${index}`;
    onChange({
      ...schema,
      properties: {
        ...schema.properties,
        [name]: { type: "string", title: name },
      },
    });
  };

  const removeVariable = (name: string) => {
    const { [name]: _removed, ...properties } = schema.properties;
    onChange({
      ...schema,
      properties,
      required: [...required].filter((item) => item !== name),
    });
  };

  const toggleRequired = (name: string, checked: boolean) => {
    const next = new Set(required);
    checked ? next.add(name) : next.delete(name);
    onChange({ ...schema, required: [...next] });
  };

  return (
    <Stack gap="sm">
      <Group justify="space-between" align="flex-start">
        <div>
          <Text fw={600} size="sm">
            {t("Variables")}
          </Text>
          <Text size="xs" c="dimmed">
            {t("Inputs AI must provide when it uses this template.")}
          </Text>
        </div>
        <Button
          variant="default"
          size="xs"
          leftSection={<IconPlus size={14} />}
          onClick={addVariable}
          disabled={readOnly || Object.keys(schema.properties).length >= 50}
        >
          {t("Add variable")}
        </Button>
      </Group>

      {Object.keys(schema.properties).length === 0 ? (
        <Paper withBorder p="md" radius="sm">
          <Group gap="sm" wrap="nowrap">
            <IconBraces size={20} />
            <Text size="sm" c="dimmed">
              {t("This template does not require any variables.")}
            </Text>
          </Group>
        </Paper>
      ) : (
        Object.entries(schema.properties).map(([name, definition]) => (
          <VariableCard
            key={name}
            name={name}
            names={Object.keys(schema.properties)}
            definition={definition}
            required={required.has(name)}
            onRename={renameProperty}
            onUpdate={(value) => updateProperty(name, value)}
            onRequiredChange={(checked) => toggleRequired(name, checked)}
            onInsert={onInsert}
            onDelete={() => removeVariable(name)}
            readOnly={readOnly}
          />
        ))
      )}
    </Stack>
  );
}

function VariableCard({
  name,
  names,
  definition,
  required,
  onRename,
  onUpdate,
  onRequiredChange,
  onInsert,
  onDelete,
  readOnly,
}: {
  name: string;
  names: string[];
  definition: ITemplateVariableDefinition;
  required: boolean;
  onRename: (oldName: string, nextName: string) => void;
  onUpdate: (definition: ITemplateVariableDefinition) => void;
  onRequiredChange: (checked: boolean) => void;
  onInsert: (name: string, markdown: boolean) => void;
  onDelete: () => void;
  readOnly: boolean;
}) {
  const { t } = useTranslation();
  const [nameDraft, setNameDraft] = useState(name);
  const [nameError, setNameError] = useState<string | null>(null);

  const commitName = () => {
    const nextName = nameDraft.trim();
    if (!TEMPLATE_VARIABLE_NAME_PATTERN.test(nextName)) {
      setNameError(
        t(
          "Variable names must start with a letter and contain only letters, numbers, dots, hyphens, or underscores.",
        ),
      );
      return;
    }
    if (nextName !== name && names.includes(nextName)) {
      setNameError(t("Variable name already exists"));
      return;
    }
    setNameError(null);
    setNameDraft(nextName);
    if (nextName !== name) onRename(name, nextName);
  };

  return (
    <Paper withBorder p="sm" radius="sm">
      <Stack gap="sm">
        <div className={classes.variableGrid}>
          <TextInput
            label={t("Variable name")}
            value={nameDraft}
            error={nameError}
            onChange={(event) => {
              setNameDraft(event.currentTarget.value);
              setNameError(null);
            }}
            onBlur={commitName}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            maxLength={64}
            readOnly={readOnly}
          />
          <TextInput
            label={t("Label")}
            value={definition.title ?? ""}
            onChange={(event) =>
              onUpdate({ ...definition, title: event.currentTarget.value })
            }
            readOnly={readOnly}
          />
          <Select
            label={t("Type")}
            value={toUiType(definition)}
            data={[
              { value: "text", label: t("Text") },
              { value: "markdown", label: "Markdown" },
              { value: "number", label: t("Number") },
              { value: "integer", label: t("Integer") },
              { value: "boolean", label: t("Boolean") },
              { value: "list", label: t("Text list") },
            ]}
            onChange={(value) =>
              onUpdate(changeVariableType(definition, value as UiVariableType))
            }
            allowDeselect={false}
            disabled={readOnly}
          />
        </div>

        <TextInput
          label={t("Description")}
          value={definition.description ?? ""}
          onChange={(event) =>
            onUpdate({ ...definition, description: event.currentTarget.value })
          }
          readOnly={readOnly}
        />

        <DefaultValueField
          definition={definition}
          onChange={(value) => onUpdate({ ...definition, default: value })}
          disabled={readOnly}
        />

        <Group justify="space-between" wrap="nowrap">
          <Switch
            label={t("Required")}
            checked={required}
            onChange={(event) => onRequiredChange(event.currentTarget.checked)}
            disabled={readOnly}
          />
          <Group gap={4} wrap="nowrap">
            <Tooltip label={t("Insert variable at cursor")}>
              <ActionIcon
                variant="subtle"
                aria-label={t("Insert variable at cursor")}
                onClick={() =>
                  onInsert(name, definition["x-docmost-type"] === "markdown")
                }
                disabled={readOnly}
              >
                <IconCodePlus size={17} />
              </ActionIcon>
            </Tooltip>
            <Tooltip label={t("Delete variable")}>
              <ActionIcon
                variant="subtle"
                color="red"
                aria-label={t("Delete variable")}
                onClick={onDelete}
                disabled={readOnly}
              >
                <IconTrash size={17} />
              </ActionIcon>
            </Tooltip>
          </Group>
        </Group>
      </Stack>
    </Paper>
  );
}

function DefaultValueField({
  definition,
  onChange,
  disabled,
}: {
  definition: ITemplateVariableDefinition;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const { t } = useTranslation();
  if (definition.type === "boolean") {
    return (
      <Switch
        label={t("Default value")}
        checked={Boolean(definition.default)}
        onChange={(event) => onChange(event.currentTarget.checked)}
        disabled={disabled}
      />
    );
  }
  if (definition.type === "number" || definition.type === "integer") {
    return (
      <NumberInput
        label={t("Default value")}
        value={typeof definition.default === "number" ? definition.default : ""}
        allowDecimal={definition.type === "number"}
        onChange={(value) => onChange(value === "" ? undefined : value)}
        disabled={disabled}
      />
    );
  }
  if (definition.type === "array") {
    return (
      <TagsInput
        label={t("Default value")}
        value={
          Array.isArray(definition.default)
            ? definition.default.map(String)
            : []
        }
        onChange={onChange}
        clearable
        disabled={disabled}
      />
    );
  }
  if (definition["x-docmost-type"] === "markdown") {
    return (
      <Textarea
        label={t("Default value")}
        value={typeof definition.default === "string" ? definition.default : ""}
        onChange={(event) => onChange(event.currentTarget.value || undefined)}
        autosize
        minRows={3}
        readOnly={disabled}
      />
    );
  }
  return (
    <TextInput
      label={t("Default value")}
      value={typeof definition.default === "string" ? definition.default : ""}
      onChange={(event) => onChange(event.currentTarget.value || undefined)}
      readOnly={disabled}
    />
  );
}

function toUiType(definition: ITemplateVariableDefinition): UiVariableType {
  if (definition["x-docmost-type"] === "markdown") return "markdown";
  if (definition.type === "array") return "list";
  if (definition.type === "string") return "text";
  return definition.type;
}

function fromUiType(type: UiVariableType): ITemplateVariableDefinition {
  if (type === "markdown") {
    return { type: "string", "x-docmost-type": "markdown" };
  }
  if (type === "list") return { type: "array", items: { type: "string" } };
  if (type === "text") return { type: "string" };
  return { type };
}

function changeVariableType(
  definition: ITemplateVariableDefinition,
  type: UiVariableType,
): ITemplateVariableDefinition {
  const next = fromUiType(type);
  if (definition.title !== undefined) next.title = definition.title;
  if (definition.description !== undefined) {
    next.description = definition.description;
  }
  if (isCompatibleDefault(definition.default, next)) {
    next.default = definition.default;
  }
  return next;
}

function isCompatibleDefault(
  value: unknown,
  definition: ITemplateVariableDefinition,
): boolean {
  if (value === undefined) return false;
  if (definition.type === "string") return typeof value === "string";
  if (definition.type === "boolean") return typeof value === "boolean";
  if (definition.type === "array") return Array.isArray(value);
  if (definition.type === "integer") return Number.isInteger(value);
  return typeof value === "number" && Number.isFinite(value);
}
