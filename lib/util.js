function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function now() {
  return new Date().toISOString();
}

function httpError(status, message, details) {
  const error = new Error(message);
  error.status = status;
  if (details) Object.assign(error, details);
  return error;
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) throw httpError(400, `缺少字段：${missing.join(", ")}`);
}

module.exports = { makeId, now, httpError, required };
