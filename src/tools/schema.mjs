/**
 * Small but strict JSON-schema validator for tool inputs. Supports the subset
 * used by the tool definitions (object/string/number/integer/boolean/array,
 * required, enum, min/max, additionalProperties:false, items, pattern,
 * minLength/maxLength). Unknown keywords are ignored.
 */

const TYPE_CHECKS = {
  object: (value) => value !== null && typeof value === 'object' && !Array.isArray(value),
  array: (value) => Array.isArray(value),
  string: (value) => typeof value === 'string',
  number: (value) => typeof value === 'number' && Number.isFinite(value),
  integer: (value) => typeof value === 'number' && Number.isInteger(value),
  boolean: (value) => typeof value === 'boolean',
  null: (value) => value === null,
};

export function validateSchema(schema, value, pointer = 'input') {
  const errors = [];
  walk(schema, value, pointer, errors);
  return errors;
}

function walk(schema, value, pointer, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const ok = types.some((type) => TYPE_CHECKS[type]?.(value) ?? true);
    if (!ok) {
      errors.push(`${pointer} must be ${types.join(' or ')}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((allowed) => allowed === value)) {
    errors.push(`${pointer} must be one of: ${schema.enum.join(', ')}`);
  }

  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      errors.push(`${pointer} must be at least ${schema.minLength} characters`);
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      errors.push(`${pointer} must be at most ${schema.maxLength} characters`);
    }
    if (typeof schema.pattern === 'string') {
      try {
        if (!new RegExp(schema.pattern).test(value)) errors.push(`${pointer} does not match the required pattern`);
      } catch {
        /* invalid schema pattern: ignore */
      }
    }
  }

  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) errors.push(`${pointer} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) errors.push(`${pointer} must be <= ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      errors.push(`${pointer} must contain at least ${schema.minItems} items`);
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      errors.push(`${pointer} must contain at most ${schema.maxItems} items`);
    }
    if (schema.items) {
      value.forEach((item, index) => walk(schema.items, item, `${pointer}[${index}]`, errors));
    }
  }

  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const properties = schema.properties ?? {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    for (const key of required) {
      if (value[key] === undefined || value[key] === null) errors.push(`${pointer}.${key} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        walk(properties[key], child, `${pointer}.${key}`, errors);
      } else if (schema.additionalProperties === false) {
        errors.push(`${pointer}.${key} is not allowed`);
      }
    }
  }
}

export class ToolValidationError extends Error {
  constructor(message, issues = []) {
    super(message);
    this.name = 'ToolValidationError';
    this.code = 'INVALID_TOOL_INPUT';
    this.issues = issues;
  }
}
