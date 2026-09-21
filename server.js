const http = require("http");

const { readDb, writeDb } = require("./lib/db");
const { createError } = require("./lib/utils");
const rubbings = require("./modules/rubbings");
const scanBatches = require("./modules/scanBatches");
const integrity = require("./modules/integrity");
const access = require("./modules/access");

const PORT = Number(process.env.PORT || 3020);

const routes = [
  // 修补闭环
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  // 拓片生命周期：结项 / 资料确认 / 归档
  "POST /rubbings/:id/close",
  "POST /rubbings/:id/materials",
  "POST /rubbings/:id/archive",
  // 扫描批次模块
  "GET /rubbings/:id/scan-batches",
  "POST /rubbings/:id/scan-batches",
  "GET /scan-batches/:id",
  "POST /scan-batches/:id/files",
  // 完整性校验模块
  "POST /scan-batches/:id/verify",
  "POST /scan-batches/:id/rescan",
  // 调阅冻结模块
  "POST /rubbings/:id/access",
  "GET /access-records?rubbingId=&batchId="
];

function send(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

async function parseBody(req) {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw createError(400, "请求体必须是合法JSON");
  }
}

function required(body, fields) {
  const missing = fields.filter((field) => body[field] === undefined || body[field] === "");
  if (missing.length) {
    throw createError(400, `缺少字段：${missing.join(", ")}`);
  }
}

function makeId(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function enrichBatch(db, batch) {
  const damages = db.damages.filter((item) => batch.damageIds.includes(item.id));
  return {
    ...batch,
    damages,
    total: damages.length,
    repaired: damages.filter((item) => item.status === "repaired").length,
    pending: damages.filter((item) => item.status !== "repaired").length
  };
}

function enrichRubbing(db, rubbing) {
  const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
  const scanList = scanBatches.listByRubbing(db, rubbing.id);
  const latest = scanList.length ? scanList[scanList.length - 1] : null;
  return {
    ...rubbing,
    damageCount: damages.length,
    pendingDamages: damages.filter((item) => item.status !== "repaired").length,
    scanBatchCount: scanList.length,
    latestScanVersion: latest ? latest.version : null,
    latestScanStatus: latest ? latest.status : null,
    // 最新批次隔离 => 调阅冻结
    accessFrozen: latest ? latest.status === scanBatches.STATUS.QUARANTINED : false
  };
}

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    return send(res, 200, { data: db.rubbings.map((rubbing) => enrichRubbing(db, rubbing)) });
  }

  if (req.method === "POST" && pathname === "/rubbings") {
    const body = await parseBody(req);
    required(body, ["code", "source", "paperSize"]);
    const rubbing = {
      id: makeId("rubbing"),
      code: body.code,
      source: body.source,
      paperSize: body.paperSize,
      note: body.note || "",
      projectStatus: "open",
      materialsComplete: false,
      archived: false,
      createdAt: new Date().toISOString()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    return send(res, 201, { data: enrichRubbing(db, rubbing) });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    rubbings.getById(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    rubbings.getById(db, rubbingId);
    const body = await parseBody(req);
    required(body, ["position", "type", "beforePhotoUrl"]);
    const damage = {
      id: makeId("damage"),
      rubbingId,
      position: body.position,
      type: body.type,
      beforePhotoUrl: body.beforePhotoUrl,
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: new Date().toISOString(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  if (req.method === "GET" && pathname === "/damages") {
    const status = url.searchParams.get("status");
    const type = url.searchParams.get("type");
    const data = db.damages.filter((item) => (!status || item.status === status) && (!type || item.type === type));
    return send(res, 200, { data });
  }

  const damagePatchMatch = pathname.match(/^\/damages\/([^/]+)$/);
  if (damagePatchMatch && req.method === "PATCH") {
    const damage = db.damages.find((item) => item.id === damagePatchMatch[1]);
    if (!damage) return send(res, 404, { error: "缺损项不存在" });
    const body = await parseBody(req);
    Object.assign(damage, {
      position: body.position ?? damage.position,
      type: body.type ?? damage.type,
      beforePhotoUrl: body.beforePhotoUrl ?? damage.beforePhotoUrl,
      afterPhotoUrl: body.afterPhotoUrl ?? damage.afterPhotoUrl,
      status: body.status ?? damage.status,
      repairNote: body.repairNote ?? damage.repairNote
    });
    damage.repairedAt = damage.status === "repaired" ? new Date().toISOString() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) {
      return send(res, 400, { error: "damageIds必须是非空数组" });
    }
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: new Date().toISOString(),
      completedAt: null
    };
    db.batches.push(batch);
    db.damages.forEach((damage) => {
      if (body.damageIds.includes(damage.id)) {
        damage.batchId = batch.id;
        damage.status = "in_repair";
      }
    });
    await writeDb(db);
    return send(res, 201, { data: enrichBatch(db, batch) });
  }

  const batchMatch = pathname.match(/^\/batches\/([^/]+)$/);
  if (batchMatch && req.method === "GET") {
    const batch = db.batches.find((item) => item.id === batchMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  const completeMatch = pathname.match(/^\/batches\/([^/]+)\/complete$/);
  if (completeMatch && req.method === "POST") {
    const batch = db.batches.find((item) => item.id === completeMatch[1]);
    if (!batch) return send(res, 404, { error: "修补批次不存在" });
    const body = await parseBody(req);
    const results = Array.isArray(body.results) ? body.results : [];
    batch.status = "completed";
    batch.completedAt = new Date().toISOString();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = new Date().toISOString();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  // ===== 拓片生命周期：结项 / 资料确认 / 归档 =====

  const closeMatch = pathname.match(/^\/rubbings\/([^/]+)\/close$/);
  if (closeMatch && req.method === "POST") {
    const rubbing = rubbings.closeProject(db, closeMatch[1]);
    await writeDb(db);
    return send(res, 200, { data: enrichRubbing(db, rubbing) });
  }

  const materialsMatch = pathname.match(/^\/rubbings\/([^/]+)\/materials$/);
  if (materialsMatch && req.method === "POST") {
    const rubbing = rubbings.confirmMaterials(db, materialsMatch[1]);
    await writeDb(db);
    return send(res, 200, { data: enrichRubbing(db, rubbing) });
  }

  const archiveMatch = pathname.match(/^\/rubbings\/([^/]+)\/archive$/);
  if (archiveMatch && req.method === "POST") {
    const rubbing = rubbings.archive(db, archiveMatch[1]);
    await writeDb(db);
    return send(res, 200, { data: enrichRubbing(db, rubbing) });
  }

  // ===== 扫描批次模块 =====

  const scanListMatch = pathname.match(/^\/rubbings\/([^/]+)\/scan-batches$/);
  if (scanListMatch && req.method === "GET") {
    const rubbingId = scanListMatch[1];
    rubbings.getById(db, rubbingId);
    const data = scanBatches.listByRubbing(db, rubbingId).map((batch) => scanBatches.enrich(db, batch));
    return send(res, 200, { data });
  }

  if (scanListMatch && req.method === "POST") {
    const body = await parseBody(req);
    // 仅已结项且资料齐全可送扫；未完成扫描重复送扫抛 409，原批次与状态不变（此处尚未写库）
    const batch = scanBatches.submitForScan(db, scanListMatch[1], body);
    await writeDb(db);
    return send(res, 201, { data: scanBatches.enrich(db, batch) });
  }

  const scanBatchMatch = pathname.match(/^\/scan-batches\/([^/]+)$/);
  if (scanBatchMatch && req.method === "GET") {
    const batch = scanBatches.getById(db, scanBatchMatch[1]);
    return send(res, 200, { data: scanBatches.enrich(db, batch) });
  }

  const filesMatch = pathname.match(/^\/scan-batches\/([^/]+)\/files$/);
  if (filesMatch && req.method === "POST") {
    const body = await parseBody(req);
    const files = integrity.normalizeFiles(body.files);
    const batch = scanBatches.uploadFiles(db, filesMatch[1], files);
    await writeDb(db);
    return send(res, 200, { data: scanBatches.enrich(db, batch) });
  }

  // ===== 完整性校验模块 =====

  const verifyMatch = pathname.match(/^\/scan-batches\/([^/]+)\/verify$/);
  if (verifyMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["expectedFiles"]);
    const result = integrity.verify(db, verifyMatch[1], body.expectedFiles);
    await writeDb(db);
    if (!result.passed) {
      // HTTP 仍为 200：校验和异常是业务结果，批次已整批隔离；具体状态看 body
      return send(res, 200, {
        passed: false,
        data: scanBatches.enrich(db, result.batch),
        mismatches: result.mismatches
      });
    }
    return send(res, 200, {
      passed: true,
      data: scanBatches.enrich(db, result.newBatch || result.batch),
      previousVersion: result.newBatch ? scanBatches.enrich(db, result.batch) : null
    });
  }

  const rescanMatch = pathname.match(/^\/scan-batches\/([^/]+)\/rescan$/);
  if (rescanMatch && req.method === "POST") {
    const body = await parseBody(req);
    required(body, ["files"]);
    const result = integrity.rescan(db, rescanMatch[1], body);
    await writeDb(db);
    if (result.passed === false) {
      // 补扫仍不一致：继续隔离
      return send(res, 200, {
        passed: false,
        data: scanBatches.enrich(db, result.batch),
        mismatches: result.mismatches
      });
    }
    if (result.newBatch) {
      // 补扫一致：新版本可用，旧版本只读
      return send(res, 201, {
        passed: true,
        data: scanBatches.enrich(db, result.newBatch),
        previousVersion: scanBatches.enrich(db, result.batch)
      });
    }
    return send(res, 200, {
      quarantined: true,
      message: "补扫文件已接收，等待完整性校验",
      data: scanBatches.enrich(db, result.batch)
    });
  }

  // ===== 调阅冻结模块 =====

  const accessMatch = pathname.match(/^\/rubbings\/([^/]+)\/access$/);
  if (accessMatch && req.method === "POST") {
    const body = await parseBody(req);
    // 隔离/无可用版本时抛 409，requestAccess 在检查通过后才写访问记录
    const result = access.requestAccess(db, accessMatch[1], body);
    await writeDb(db);
    return send(res, 201, {
      data: {
        record: result.record,
        batch: scanBatches.enrich(db, result.batch),
        rubbingCode: result.rubbingCode
      }
    });
  }

  if (req.method === "GET" && pathname === "/access-records") {
    const rubbingId = url.searchParams.get("rubbingId");
    const batchId = url.searchParams.get("batchId");
    return send(res, 200, { data: access.listRecords(db, { rubbingId, batchId }) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => send(res, error.status || 500, { error: error.message || "服务器错误" }));
});

server.listen(PORT, () => {
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
