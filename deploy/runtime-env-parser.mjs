const envKeyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function serializeRuntimeEnv(env) {
  return `${Object.entries(env)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      if (!envKeyPattern.test(key)) {
        throw new Error(`Runtime environment contains invalid key ${key}.`);
      }
      return `${key}=${JSON.stringify(String(value))}`;
    })
    .join("\n")}\n`;
}

export function parseRuntimeEnv(contents) {
  if (typeof contents !== "string" || !contents.endsWith("\n")) {
    throw new Error("Runtime secret is incomplete.");
  }

  const parsed = Object.create(null);
  for (const [index, line] of contents.split("\n").entries()) {
    if (!line) continue;

    const separator = line.indexOf("=");
    if (separator < 1) {
      throw new Error(`Runtime secret line ${index + 1} is not KEY=value.`);
    }

    const key = line.slice(0, separator);
    const encoded = line.slice(separator + 1);
    if (!envKeyPattern.test(key)) {
      throw new Error(`Runtime secret line ${index + 1} has an invalid key.`);
    }
    if (Object.hasOwn(parsed, key)) {
      throw new Error(`Runtime secret contains duplicate key ${key}.`);
    }

    let value;
    try {
      value = JSON.parse(encoded);
    } catch {
      throw new Error(`Runtime secret line ${index + 1} is not JSON-quoted.`);
    }
    if (typeof value !== "string" || value.includes("\0")) {
      throw new Error(`Runtime secret line ${index + 1} is not a valid string.`);
    }
    parsed[key] = value;
  }

  return parsed;
}
