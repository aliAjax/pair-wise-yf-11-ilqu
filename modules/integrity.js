// 业务模块：完整性校验
// 独立负责扫描影像的校验和计算与整批比对。
// 校验和不一致（或缺少校验和）时判定为异常，由调用方对整批执行隔离。
const crypto = require("crypto");
const { httpError, required } = require("../lib/util");

function calcChecksum(content) {
  return crypto.createHash("sha256").update(String(content)).digest("hex");
}

function assertScanItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw httpError(400, "items必须是非空数组，每项包含 page 与 content");
  }
  items.forEach((item, index) => {
    if (item.page === undefined || item.page === null || item.content === undefined || item.content === null) {
      throw httpError(400, `第${index + 1}项缺少字段：page, content`);
    }
  });
}

// 为扫描影像计算校验和（送扫登记时使用）
function buildChecksums(items) {
  return items.map((item) => ({
    page: String(item.page),
    checksum: calcChecksum(item.content)
  }));
}

// 整批校验：缺校验和或缺影像均视为异常；任意一页不一致则整批异常
function verifyBatch(storedItems, submittedItems) {
  const anomalies = [];

  if (!Array.isArray(storedItems) || storedItems.length === 0) {
    anomalies.push({ page: null, reason: "批次缺少已登记的影像记录" });
  }
  if (!Array.isArray(submittedItems) || submittedItems.length === 0) {
    anomalies.push({ page: null, reason: "未提交待校验影像" });
  }
  if (anomalies.length) return { ok: false, anomalies };

  const submittedByPage = new Map();
  submittedItems.forEach((item) => submittedByPage.set(String(item.page), item));

  for (const stored of storedItems) {
    const submitted = submittedByPage.get(String(stored.page));
    if (!submitted) {
      anomalies.push({ page: stored.page, reason: "缺少该页扫描影像" });
      continue;
    }
    if (!submitted.checksum) {
      anomalies.push({ page: stored.page, reason: "未提供校验和" });
      continue;
    }
    if (!stored.checksum) {
      anomalies.push({ page: stored.page, reason: "原批次未登记校验和" });
      continue;
    }
    if (stored.checksum !== submitted.checksum) {
      anomalies.push({
        page: stored.page,
        reason: "校验和不一致",
        expected: stored.checksum,
        actual: submitted.checksum
      });
    }
  }

  const storedPages = new Set(storedItems.map((item) => String(item.page)));
  submittedItems.forEach((item) => {
    if (!storedPages.has(String(item.page))) {
      anomalies.push({ page: String(item.page), reason: "该页不属于原扫描批次" });
    }
  });

  return { ok: anomalies.length === 0, anomalies };
}

module.exports = { calcChecksum, assertScanItems, buildChecksums, verifyBatch };
