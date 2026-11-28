export function violatesUnique(error: unknown, constraint: string): boolean {
  return postgresErrorCode(error) === '23505' && constraintName(error) === constraint;
}

export function postgresErrorCode(error: unknown): string | undefined {
  return readString(error, 'code');
}

function constraintName(error: unknown): string | undefined {
  return readString(error, 'constraint') ?? readString(error, 'constraint_name');
}

function readString(error: unknown, field: string): string | undefined {
  if (!isPlain(error)) return undefined;
  const direct = error[field];
  if (typeof direct === 'string') return direct;
  return readString(error.cause, field);
}

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
