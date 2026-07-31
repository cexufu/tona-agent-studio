const { RuntimeToolError } = require("./runtime-v2");

const objectSchema = { type: "object", additionalProperties: false };
const scalarSchema = { type: ["string", "number", "boolean", "null"] };

function validTimeZone(timeZone) {
  try { new Intl.DateTimeFormat("en-US", { timeZone }).format(); return true; } catch { return false; }
}

function requireTimeZone(value) {
  const timeZone = String(value || "UTC");
  if (!validTimeZone(timeZone)) throw new RuntimeToolError("INVALID_TIME_ZONE", `Unknown IANA time zone: ${timeZone}`, { category: "validation" });
  return timeZone;
}

function formatInstant(date, timeZone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZoneName: "longOffset"
  }).formatToParts(date).reduce((result, part) => ({ ...result, [part.type]: part.value }), {});
  return {
    iso: date.toISOString(),
    local: `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`,
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
    offset: String(parts.timeZoneName || "GMT+00:00").replace("GMT", "") || "+00:00",
    timeZone
  };
}

function parseDate(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RuntimeToolError("INVALID_DATE", `Invalid ISO date/time: ${value}`, { category: "validation" });
  return date;
}

function tokenizeExpression(expression) {
  const tokens = [];
  const source = String(expression).replace(/\s+/g, "");
  let index = 0;
  while (index < source.length) {
    const number = source.slice(index).match(/^(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/i);
    if (number) { tokens.push({ type: "number", value: Number(number[0]) }); index += number[0].length; continue; }
    const name = source.slice(index).match(/^[A-Za-z_][A-Za-z0-9_]*/);
    if (name) { tokens.push({ type: "name", value: name[0].toLowerCase() }); index += name[0].length; continue; }
    if ("+-*/%^(),".includes(source[index])) { tokens.push({ type: source[index], value: source[index] }); index += 1; continue; }
    throw new RuntimeToolError("INVALID_EXPRESSION", `Unsupported token near '${source.slice(index, index + 12)}'.`, { category: "validation" });
  }
  return tokens;
}

function evaluateExpression(expression) {
  const tokens = tokenizeExpression(expression);
  let cursor = 0;
  const functions = {
    abs: Math.abs, sqrt: Math.sqrt, floor: Math.floor, ceil: Math.ceil, round: Math.round,
    sin: Math.sin, cos: Math.cos, tan: Math.tan, log: Math.log10, ln: Math.log,
    min: Math.min, max: Math.max, pow: Math.pow
  };
  const constants = { pi: Math.PI, e: Math.E };
  const peek = () => tokens[cursor];
  const take = (type) => {
    const token = tokens[cursor];
    if (!token || (type && token.type !== type)) throw new RuntimeToolError("INVALID_EXPRESSION", `Expected '${type || "value"}'.`, { category: "validation" });
    cursor += 1;
    return token;
  };
  function primary() {
    if (peek()?.type === "number") return take("number").value;
    if (peek()?.type === "(") { take("("); const value = add(); take(")"); return value; }
    if (peek()?.type === "name") {
      const name = take("name").value;
      if (Object.prototype.hasOwnProperty.call(constants, name) && peek()?.type !== "(") return constants[name];
      if (!functions[name] || peek()?.type !== "(") throw new RuntimeToolError("INVALID_EXPRESSION", `Unsupported function or constant: ${name}`, { category: "validation" });
      take("(");
      const args = [];
      if (peek()?.type !== ")") { args.push(add()); while (peek()?.type === ",") { take(","); args.push(add()); } }
      take(")");
      return functions[name](...args);
    }
    throw new RuntimeToolError("INVALID_EXPRESSION", "Expected a number, constant, function, or parenthesized expression.", { category: "validation" });
  }
  function unary() { if (peek()?.type === "+") { take("+"); return unary(); } if (peek()?.type === "-") { take("-"); return -unary(); } return primary(); }
  function power() { const left = unary(); return peek()?.type === "^" ? (take("^"), left ** power()) : left; }
  function multiply() { let value = power(); while (["*", "/", "%"].includes(peek()?.type)) { const op = take().type; const right = power(); value = op === "*" ? value * right : op === "/" ? value / right : value % right; } return value; }
  function add() { let value = multiply(); while (["+", "-"].includes(peek()?.type)) { const op = take().type; const right = multiply(); value = op === "+" ? value + right : value - right; } return value; }
  const value = add();
  if (cursor !== tokens.length) throw new RuntimeToolError("INVALID_EXPRESSION", "Unexpected trailing expression content.", { category: "validation" });
  if (!Number.isFinite(value)) throw new RuntimeToolError("NON_FINITE_RESULT", "The calculation did not produce a finite number.", { category: "validation" });
  return value;
}

const units = {
  length: { m: 1, km: 1000, cm: 0.01, mm: 0.001, mi: 1609.344, yd: 0.9144, ft: 0.3048, in: 0.0254 },
  mass: { kg: 1, g: 0.001, mg: 0.000001, lb: 0.45359237, oz: 0.028349523125 },
  volume: { l: 1, ml: 0.001, "m3": 1000, gal_us: 3.785411784 },
  time: { ms: 0.001, s: 1, min: 60, h: 3600, day: 86400 },
  data: { b: 1, kb: 1000, mb: 1e6, gb: 1e9, kib: 1024, mib: 1048576, gib: 1073741824 }
};

function convertUnit(value, from, to) {
  const source = String(from).toLowerCase();
  const target = String(to).toLowerCase();
  if (["c", "f", "k"].includes(source) || ["c", "f", "k"].includes(target)) {
    if (!["c", "f", "k"].includes(source) || !["c", "f", "k"].includes(target)) throw new RuntimeToolError("INCOMPATIBLE_UNITS", "Temperature can only convert between C, F, and K.", { category: "validation" });
    const celsius = source === "c" ? value : source === "f" ? (value - 32) * 5 / 9 : value - 273.15;
    return { value: target === "c" ? celsius : target === "f" ? celsius * 9 / 5 + 32 : celsius + 273.15, dimension: "temperature" };
  }
  const dimension = Object.keys(units).find((key) => units[key][source] !== undefined && units[key][target] !== undefined);
  if (!dimension) throw new RuntimeToolError("INCOMPATIBLE_UNITS", `Cannot convert ${from} to ${to}.`, { category: "validation" });
  return { value: value * units[dimension][source] / units[dimension][target], dimension };
}

function parseCsv(text, delimiter = ",") {
  const rows = [];
  let row = [], field = "", quoted = false;
  const source = String(text).replace(/^\uFEFF/, "");
  for (let index = 0; index <= source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (char === '"' && source[index + 1] === '"') { field += '"'; index += 1; }
      else if (char === '"') quoted = false;
      else if (char === undefined) throw new RuntimeToolError("INVALID_CSV", "CSV contains an unterminated quoted field.", { category: "validation" });
      else field += char;
    } else if (char === '"' && field === "") quoted = true;
    else if (char === delimiter) { row.push(field); field = ""; }
    else if (char === "\n" || char === undefined) { row.push(field.replace(/\r$/, "")); rows.push(row); row = []; field = ""; }
    else field += char;
  }
  if (!rows.length || !rows[0].some(Boolean)) return [];
  const headers = rows.shift();
  if (new Set(headers).size !== headers.length) throw new RuntimeToolError("INVALID_CSV", "CSV headers must be unique.", { category: "validation" });
  return rows.filter((item) => item.some((value) => value !== "")).map((values) => Object.fromEntries(headers.map((header, index) => [header, values[index] ?? ""])));
}

function compare(left, operator, right) {
  if (operator === "eq") return left === right;
  if (operator === "ne") return left !== right;
  if (operator === "contains") return String(left ?? "").includes(String(right));
  if (operator === "gt") return Number(left) > Number(right);
  if (operator === "gte") return Number(left) >= Number(right);
  if (operator === "lt") return Number(left) < Number(right);
  if (operator === "lte") return Number(left) <= Number(right);
  return false;
}

function tableTransform(input) {
  let rows;
  if (input.format === "csv") rows = parseCsv(input.data, input.delimiter || ",");
  else if (input.format === "json") {
    try { rows = typeof input.data === "string" ? JSON.parse(input.data) : input.data; } catch { throw new RuntimeToolError("INVALID_JSON", "Input is not valid JSON.", { category: "validation" }); }
  } else rows = input.data;
  if (!Array.isArray(rows) || rows.some((row) => !row || typeof row !== "object" || Array.isArray(row))) throw new RuntimeToolError("INVALID_TABLE", "Table data must be an array of objects.", { category: "validation" });
  if (rows.length > 10000) throw new RuntimeToolError("TABLE_TOO_LARGE", "Table operations support at most 10,000 rows.", { category: "validation" });
  let result = rows.map((row) => ({ ...row }));
  const validationErrors = [];
  for (const operation of input.operations || []) {
    const type = operation.type;
    if (!["filter", "sort", "select", "validate", "aggregate"].includes(type)) throw new RuntimeToolError("INVALID_TABLE_OPERATION", `Unsupported table operation: ${type || "missing"}.`, { category: "validation" });
    if (["filter", "sort"].includes(type) && typeof operation.field !== "string") throw new RuntimeToolError("INVALID_TABLE_OPERATION", `${type} requires a field.`, { category: "validation" });
    if (type === "filter" && !["eq", "neq", "contains", "gt", "gte", "lt", "lte"].includes(operation.operator)) throw new RuntimeToolError("INVALID_TABLE_OPERATION", "filter requires a supported operator.", { category: "validation" });
    if (type === "sort" && operation.direction !== undefined && !["asc", "desc"].includes(operation.direction)) throw new RuntimeToolError("INVALID_TABLE_OPERATION", "sort direction must be asc or desc.", { category: "validation" });
    if (type === "select" && !Array.isArray(operation.fields)) throw new RuntimeToolError("INVALID_TABLE_OPERATION", "select requires a fields array.", { category: "validation" });
    if (type === "validate" && !Array.isArray(operation.required)) throw new RuntimeToolError("INVALID_TABLE_OPERATION", "validate requires a required array.", { category: "validation" });
    if (type === "aggregate" && (!Array.isArray(operation.metrics) || !operation.metrics.length || operation.metrics.some((metric) => !metric || !["count", "sum", "avg", "min", "max"].includes(metric.op) || typeof metric.as !== "string" || (metric.op !== "count" && typeof metric.field !== "string")))) throw new RuntimeToolError("INVALID_TABLE_OPERATION", "aggregate requires valid metrics.", { category: "validation" });
    if (operation.type === "filter") result = result.filter((row) => compare(row[operation.field], operation.operator, operation.value));
    if (operation.type === "sort") result.sort((a, b) => { const left = a[operation.field], right = b[operation.field]; const compared = typeof left === "number" && typeof right === "number" ? left - right : String(left ?? "").localeCompare(String(right ?? ""), "en", { numeric: true }); return operation.direction === "desc" ? -compared : compared; });
    if (operation.type === "select") result = result.map((row) => Object.fromEntries(operation.fields.filter((field) => Object.prototype.hasOwnProperty.call(row, field)).map((field) => [field, row[field]])));
    if (operation.type === "validate") result.forEach((row, index) => { for (const field of operation.required || []) if (row[field] === undefined || row[field] === null || row[field] === "") validationErrors.push({ row: index, field, code: "required" }); });
    if (operation.type === "aggregate") {
      const groups = new Map();
      for (const row of result) { const key = operation.groupBy ? String(row[operation.groupBy] ?? "") : "__all__"; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); }
      result = [...groups].map(([key, group]) => {
        const output = operation.groupBy ? { [operation.groupBy]: key } : {};
        for (const metric of operation.metrics) {
          const values = group.map((row) => Number(row[metric.field])).filter(Number.isFinite);
          output[metric.as] = metric.op === "count" ? group.length : metric.op === "sum" ? values.reduce((a, b) => a + b, 0) : metric.op === "avg" ? (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null) : metric.op === "min" ? (values.length ? Math.min(...values) : null) : (values.length ? Math.max(...values) : null);
        }
        return output;
      });
    }
  }
  return { rows: result, rowCount: result.length, valid: validationErrors.length === 0, validationErrors };
}

const basePolicy = { timeoutMs: 5000, retries: 0, idempotent: true, rateLimit: { maxCalls: 120, windowMs: 60000 } };
const deterministicTools = [
  {
    id: "datetime_now", name: "当前日期与时间", category: "deterministic", risk: "read", status: "ready", description: "按 IANA 时区返回可验证的当前日期与时间。", policy: basePolicy,
    inputSchema: { ...objectSchema, properties: { timeZone: { type: "string", minLength: 1, maxLength: 80 } } },
    outputSchema: { ...objectSchema, required: ["iso", "local", "date", "time", "offset", "timeZone"], properties: { iso: { type: "string" }, local: { type: "string" }, date: { type: "string" }, time: { type: "string" }, offset: { type: "string" }, timeZone: { type: "string" } } },
    handler(input, context) { return formatInstant(new Date(Number(context.clock?.() ?? Date.now())), requireTimeZone(input.timeZone)); }
  },
  {
    id: "datetime_calculate", name: "日期计算", category: "deterministic", risk: "read", status: "ready", description: "执行日期加减或两个时刻之间的差值计算。", policy: basePolicy,
    inputSchema: { ...objectSchema, required: ["operation", "date"], properties: { operation: { enum: ["add", "difference"] }, date: { type: "string", minLength: 1 }, otherDate: { type: "string" }, amount: { type: "number" }, unit: { enum: ["millisecond", "second", "minute", "hour", "day", "week"] }, timeZone: { type: "string" } } },
    outputSchema: { ...objectSchema, required: ["operation", "unit", "value"], properties: { operation: { type: "string" }, unit: { type: "string" }, value: { type: "number" }, result: { type: "object" } } },
    handler(input) { const first = parseDate(input.date); const unit = input.unit || "day"; const factors = { millisecond: 1, second: 1000, minute: 60000, hour: 3600000, day: 86400000, week: 604800000 }; if (input.operation === "difference") { const second = parseDate(input.otherDate); return { operation: "difference", unit, value: (second - first) / factors[unit] }; } const amount = Number(input.amount); if (!Number.isFinite(amount)) throw new RuntimeToolError("INVALID_AMOUNT", "Date addition requires a finite amount.", { category: "validation" }); const result = new Date(first.getTime() + amount * factors[unit]); return { operation: "add", unit, value: amount, result: formatInstant(result, requireTimeZone(input.timeZone)) }; }
  },
  {
    id: "math_calculate", name: "数学计算", category: "deterministic", risk: "read", status: "ready", description: "使用受限表达式解析器进行确定性数学计算，不执行代码。", policy: basePolicy,
    inputSchema: { ...objectSchema, required: ["expression"], properties: { expression: { type: "string", minLength: 1, maxLength: 1000 } } },
    outputSchema: { ...objectSchema, required: ["expression", "value"], properties: { expression: { type: "string" }, value: { type: "number" } } },
    handler(input) { return { expression: input.expression, value: evaluateExpression(input.expression) }; }
  },
  {
    id: "unit_convert", name: "单位换算", category: "deterministic", risk: "read", status: "ready", description: "换算长度、质量、体积、时间、数据量与温度单位。", policy: basePolicy,
    inputSchema: { ...objectSchema, required: ["value", "from", "to"], properties: { value: { type: "number" }, from: { type: "string", minLength: 1 }, to: { type: "string", minLength: 1 } } },
    outputSchema: { ...objectSchema, required: ["inputValue", "from", "to", "value", "dimension"], properties: { inputValue: { type: "number" }, from: { type: "string" }, to: { type: "string" }, value: { type: "number" }, dimension: { type: "string" } } },
    handler(input) { return { inputValue: input.value, from: input.from, to: input.to, ...convertUnit(input.value, input.from, input.to) }; }
  },
  {
    id: "statistics_basic", name: "基础统计", category: "deterministic", risk: "read", status: "ready", description: "计算计数、和、均值、中位数、最小值、最大值与总体/样本标准差。", policy: basePolicy,
    inputSchema: { ...objectSchema, required: ["values"], properties: { values: { type: "array", minItems: 1, maxItems: 10000, items: { type: "number" } } } },
    outputSchema: { ...objectSchema, required: ["count", "sum", "mean", "median", "min", "max", "populationStdDev", "sampleStdDev"], properties: { count: { type: "integer" }, sum: { type: "number" }, mean: { type: "number" }, median: { type: "number" }, min: { type: "number" }, max: { type: "number" }, populationStdDev: { type: "number" }, sampleStdDev: { type: ["number", "null"] } } },
    handler(input) { const sorted = [...input.values].sort((a, b) => a - b); const count = sorted.length, sum = sorted.reduce((a, b) => a + b, 0), mean = sum / count, variance = sorted.reduce((total, value) => total + (value - mean) ** 2, 0); return { count, sum, mean, median: count % 2 ? sorted[(count - 1) / 2] : (sorted[count / 2 - 1] + sorted[count / 2]) / 2, min: sorted[0], max: sorted.at(-1), populationStdDev: Math.sqrt(variance / count), sampleStdDev: count > 1 ? Math.sqrt(variance / (count - 1)) : null }; }
  },
  {
    id: "table_transform", name: "JSON/CSV 表格处理", category: "deterministic", risk: "read", status: "ready", description: "解析 JSON/CSV，并进行筛选、排序、字段选择、聚合与必填校验。", policy: { ...basePolicy, timeoutMs: 10000, rateLimit: { maxCalls: 60, windowMs: 60000 } },
    inputSchema: { ...objectSchema, required: ["format", "data", "operations"], properties: { format: { enum: ["json", "csv", "rows"] }, data: { type: ["string", "array"] }, delimiter: { type: "string", minLength: 1, maxLength: 1 }, operations: { type: "array", maxItems: 20, items: { type: "object" } } } },
    outputSchema: { ...objectSchema, required: ["rows", "rowCount", "valid", "validationErrors"], properties: { rows: { type: "array", items: { type: "object" } }, rowCount: { type: "integer" }, valid: { type: "boolean" }, validationErrors: { type: "array", items: { type: "object" } } } },
    handler: tableTransform
  }
];

module.exports = { deterministicTools, evaluateExpression, convertUnit, parseCsv, tableTransform };
