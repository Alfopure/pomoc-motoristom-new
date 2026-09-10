/** Bounded recursive-descent arithmetic; no executable expressions or identifiers. */
export function calculateExpression(input: string): number {
  if (input.length > 300) throw new Error("Výraz je príliš dlhý.");
  const expression = input.replaceAll(",", ".").replaceAll("×", "*").replaceAll("÷", "/").replaceAll("−", "-");
  const tokens = expression.match(/(?:\d+(?:\.\d*)?|\.\d+)|[()+*/-]|\S/g) ?? [];
  let cursor = 0;
  let depth = 0;
  function primary(): number {
    if (++depth > 40) throw new Error("Príliš veľa zátvoriek.");
    const token = tokens[cursor++];
    let value: number;
    if (token === "+" || token === "-") value = (token === "-" ? -1 : 1) * primary();
    else if (token === "(") {
      value = sum();
      if (tokens[cursor++] !== ")") throw new Error("Skontrolujte zátvorky.");
    } else if (token && /^(?:\d+(?:\.\d*)?|\.\d+)$/.test(token)) value = Number(token);
    else throw new Error("Zadajte čísla a znamienka +, −, ×, ÷.");
    depth--;
    return value;
  }
  function product(): number {
    let value = primary();
    while (tokens[cursor] === "*" || tokens[cursor] === "/") {
      const operation = tokens[cursor++];
      const right = primary();
      if (operation === "/" && right === 0) throw new Error("Nulou sa nedá deliť.");
      value = operation === "*" ? value * right : value / right;
    }
    return value;
  }
  function sum(): number {
    let value = product();
    while (tokens[cursor] === "+" || tokens[cursor] === "-") {
      const operation = tokens[cursor++];
      const right = product();
      value = operation === "+" ? value + right : value - right;
    }
    return value;
  }
  const result = sum();
  if (cursor !== tokens.length) throw new Error("Skontrolujte zápis výrazu.");
  if (!Number.isFinite(result)) throw new Error("Výsledok je mimo rozsahu kalkulačky.");
  return Number(result.toPrecision(12));
}
