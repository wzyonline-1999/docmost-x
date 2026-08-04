import {
  NumberInput,
  Stack,
  Switch,
  TagsInput,
  Textarea,
  TextInput,
} from "@mantine/core";
import type {
  ITemplateInputSchema,
  ITemplateVariableDefinition,
} from "@/features/template/types/template.types";

interface TemplateVariableFormProps {
  schema: ITemplateInputSchema;
  values: Record<string, unknown>;
  onChange: (values: Record<string, unknown>) => void;
  disabled?: boolean;
}

export function TemplateVariableForm({
  schema,
  values,
  onChange,
  disabled,
}: TemplateVariableFormProps) {
  const required = new Set(schema.required ?? []);
  const update = (name: string, value: unknown) =>
    onChange({ ...values, [name]: value });

  return (
    <Stack gap="md">
      {Object.entries(schema.properties).map(([name, definition]) => (
        <VariableField
          key={name}
          name={name}
          definition={definition}
          required={required.has(name)}
          value={values[name]}
          onChange={(value) => update(name, value)}
          disabled={disabled}
        />
      ))}
    </Stack>
  );
}

function VariableField({
  name,
  definition,
  required,
  value,
  onChange,
  disabled,
}: {
  name: string;
  definition: ITemplateVariableDefinition;
  required: boolean;
  value: unknown;
  onChange: (value: unknown) => void;
  disabled?: boolean;
}) {
  const shared = {
    label: definition.title || name,
    description: definition.description,
    required,
    disabled,
  };

  if (definition.type === "boolean") {
    return (
      <Switch
        {...shared}
        checked={Boolean(value)}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
    );
  }
  if (definition.type === "number" || definition.type === "integer") {
    return (
      <NumberInput
        {...shared}
        value={typeof value === "number" ? value : ""}
        allowDecimal={definition.type === "number"}
        onChange={(next) => onChange(next === "" ? undefined : next)}
      />
    );
  }
  if (definition.type === "array") {
    return (
      <TagsInput
        {...shared}
        value={Array.isArray(value) ? value.map(String) : []}
        onChange={onChange}
        clearable
      />
    );
  }
  if (definition["x-docmost-type"] === "markdown") {
    return (
      <Textarea
        {...shared}
        value={typeof value === "string" ? value : ""}
        onChange={(event) => onChange(event.currentTarget.value)}
        autosize
        minRows={4}
      />
    );
  }
  return (
    <TextInput
      {...shared}
      value={typeof value === "string" ? value : ""}
      onChange={(event) => onChange(event.currentTarget.value)}
    />
  );
}
