// Minimal JSON-schema subset used to validate tool arguments and structured outputs.
// Supports: type (string|number|integer|boolean|object|array|null), properties, required,
// items, enum, additionalProperties:false. Enough for tool calling without a dependency.

const TYPE_CHECKS = {
  string: (v) => typeof v === 'string',
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  integer: (v) => Number.isInteger(v),
  boolean: (v) => typeof v === 'boolean',
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
  array: (v) => Array.isArray(v),
  null: (v) => v === null,
};

/**
 * @param {object} schema
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]} list of errors, empty when valid
 */
export function validate(schema, value, path = '$') {
  if (!schema || typeof schema !== 'object') return [];
  const errors = [];

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => TYPE_CHECKS[t]?.(value))) {
      return [`${path}: expected ${types.join('|')}, got ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value}`];
    }
  }

  if (schema.enum && !schema.enum.some((e) => e === value)) {
    errors.push(`${path}: must be one of ${JSON.stringify(schema.enum)}`);
  }

  if (TYPE_CHECKS.object(value)) {
    for (const key of schema.required || []) {
      if (!(key in value)) errors.push(`${path}.${key}: required`);
    }
    const props = schema.properties || {};
    for (const [key, sub] of Object.entries(props)) {
      if (key in value) errors.push(...validate(sub, value[key], `${path}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value)) {
        if (!(key in props)) errors.push(`${path}.${key}: not allowed`);
      }
    }
  }

  if (Array.isArray(value) && schema.items) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${path}[${i}]`)));
  }

  return errors;
}
