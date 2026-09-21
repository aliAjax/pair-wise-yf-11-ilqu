const http = require("http");
const { readDb, writeDb, findRubbing, findUnfinishedScanBatch, migrateLegacyData } = require("./lib/db");
const { now, required, httpError } = require("./lib/util");
const scanBatches = require("./modules/scanBatches");
const accessControl = require("./modules/access");

const PORT = Number(process.env.PORT || 3020);

const routes = [
  "GET /health",
  "GET /rubbings",
  "POST /rubbings",
  "PATCH /rubbings/:id",
  "GET /rubbings/:id/damages",
  "POST /rubbings/:id/damages",
  "GET /damages?status=&type=",
  "PATCH /damages/:id",
  "GET /batches",
  "POST /batches",
  "GET /batches/:id",
  "POST /batches/:id/complete",
  "GET /scan-batches?rubbingId=",
  "POST /rubbings/:id/scan-batches",
  "GET /scan-batches/:id",
  "POST /scan-batches/:id/verify",
  "POST /scan-batches/:id/rescan",
  "POST /accesses",
  "GET /accesses?rubbingId=&scanBatchId="
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
    throw httpError(400, "请求体必须是合法JSON");
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

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const db = await readDb();

  if (req.method === "GET" && pathname === "/health") {
    return send(res, 200, { ok: true, service: "rubbing-repair-api", routes });
  }

  if (req.method === "GET" && pathname === "/rubbings") {
    const data = db.rubbings.map((rubbing) => {
      const damages = db.damages.filter((item) => item.rubbingId === rubbing.id);
      const unfinishedScan = findUnfinishedScanBatch(db, rubbing.id);
      return {
        ...rubbing,
        damageCount: damages.length,
        pendingDamages: damages.filter((item) => item.status !== "repaired").length,
        scanReady: rubbing.projectStatus === "closed" && rubbing.materialsComplete === true,
        unfinishedScanBatchId: unfinishedScan ? unfinishedScan.id : null,
        scanStatus: unfinishedScan ? unfinishedScan.status : null
      };
    });
    return send(res, 200, { data });
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
      projectStatus: body.projectStatus || "open",
      materialsComplete: body.materialsComplete === true,
      createdAt: now()
    };
    db.rubbings.push(rubbing);
    await writeDb(db);
    const created = findRubbing(db, rubbing.id);
    return send(res, 201, { data: created });
  }

  const rubbingMatch = pathname.match(/^\/rubbings\/([^/]+)$/);
  if (rubbingMatch && req.method === "PATCH") {
    const rubbing = findRubbing(db, rubbingMatch[1]);
    const body = await parseBody(req);
    if (body.projectStatus !== undefined) {
      if (!["open", "closed"].includes(body.projectStatus)) {
        throw httpError(400, "projectStatus 仅支持 open / closed");
      }
      rubbing.projectStatus = body.projectStatus;
    }
    if (body.materialsComplete !== undefined) {
      rubbing.materialsComplete = body.materialsComplete === true;
    }
    if (body.note !== undefined) rubbing.note = body.note;
    await writeDb(db); // 归档状态随结项/资料齐全自动重算并写回数据文件
    return send(res, 200, { data: findRubbing(db, rubbing.id) });
  }

  const rubbingDamagesMatch = pathname.match(/^\/rubbings\/([^/]+)\/damages$/);
  if (rubbingDamagesMatch && req.method === "GET") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
    return send(res, 200, { data: db.damages.filter((item) => item.rubbingId === rubbingId) });
  }

  if (rubbingDamagesMatch && req.method === "POST") {
    const rubbingId = rubbingDamagesMatch[1];
    findRubbing(db, rubbingId);
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
      createdAt: now(),
      repairedAt: null
    };
    db.damages.push(damage);
    await writeDb(db);
    return send(res, 201, { data: damage });
  }

  // 数字化送扫：POST /rubbings/:id/scan-batches
  const rubbingScanMatch = pathname.match(/^\/rubbings\/([^/]+)\/scan-batches$/);
  if (rubbingScanMatch && req.method === "POST") {
    const rubbing = findRubbing(db, rubbingScanMatch[1]);
    const body = await parseBody(req);
    const batch = scanBatches.createBatch(db, rubbing, body);
    await writeDb(db);
    return send(res, 201, { data: scanBatches.serialize(db, batch) });
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
    damage.repairedAt = damage.status === "repaired" ? now() : damage.repairedAt;
    await writeDb(db);
    return send(res, 200, { data: damage });
  }

  if (req.method === "GET" && pathname === "/batches") {
    return send(res, 200, { data: db.batches.map((batch) => enrichBatch(db, batch)) });
  }

  if (req.method === "POST" && pathname === "/batches") {
    const body = await parseBody(req);
    required(body, ["name", "damageIds"]);
    if (!Array.isArray(body.damageIds) || body.damageIds.length === 0) return send(res, 400, { error: "damageIds必须是非空数组" });
    const invalid = body.damageIds.filter((id) => !db.damages.find((damage) => damage.id === id));
    if (invalid.length) return send(res, 400, { error: `缺损项不存在：${invalid.join(", ")}` });
    const batch = {
      id: makeId("batch"),
      name: body.name,
      status: "open",
      damageIds: body.damageIds,
      note: body.note || "",
      createdAt: now(),
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
    batch.completedAt = now();
    batch.note = body.note ?? batch.note;
    db.damages.forEach((damage) => {
      if (!batch.damageIds.includes(damage.id)) return;
      const result = results.find((item) => item.damageId === damage.id) || {};
      damage.status = "repaired";
      damage.afterPhotoUrl = result.afterPhotoUrl || body.defaultAfterPhotoUrl || damage.afterPhotoUrl;
      damage.repairNote = result.repairNote || body.defaultRepairNote || damage.repairNote;
      damage.repairedAt = now();
    });
    await writeDb(db);
    return send(res, 200, { data: enrichBatch(db, batch) });
  }

  // ===== 数字化送扫 / 完整性校验 / 调阅冻结 =====

  if (req.method === "GET" && pathname === "/scan-batches") {
    const rubbingId = url.searchParams.get("rubbingId");
    return send(res, 200, { data: scanBatches.listBatches(db, { rubbingId }) });
  }

  const scanBatchMatch = pathname.match(/^\/scan-batches\/([^/]+)$/);
  if (scanBatchMatch && req.method === "GET") {
    const batch = scanBatches.getBatch(db, scanBatchMatch[1]);
    return send(res, 200, { data: scanBatches.serialize(db, batch) });
  }

  const verifyMatch = pathname.match(/^\/scan-batches\/([^/]+)\/verify$/);
  if (verifyMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { batch, result } = scanBatches.verify(db, verifyMatch[1], body);
    await writeDb(db);
    if (!result.ok) {
      return send(res, 200, {
        data: scanBatches.serialize(db, batch),
        verification: { passed: false, anomalies: result.anomalies }
      });
    }
    return send(res, 200, {
      data: scanBatches.serialize(db, batch),
      verification: { passed: true, anomalies: [] }
    });
  }

  const rescanMatch = pathname.match(/^\/scan-batches\/([^/]+)\/rescan$/);
  if (rescanMatch && req.method === "POST") {
    const body = await parseBody(req);
    const { batch } = scanBatches.rescan(db, rescanMatch[1], body);
    await writeDb(db);
    return send(res, 200, {
      data: scanBatches.serialize(db, batch),
      verification: { passed: true, newVersion: batch.currentVersion, anomalies: [] }
    });
  }

  if (req.method === "POST" && pathname === "/accesses") {
    const body = await parseBody(req);
    const record = accessControl.access(db, body); // 隔离/未就绪时抛 409，前面的记录不会落库
    await writeDb(db);
    const batch = scanBatches.getBatch(db, record.scanBatchId);
    return send(res, 201, {
      data: record,
      scanBatch: { id: batch.id, status: batch.status, version: record.version }
    });
  }

  if (req.method === "GET" && pathname === "/accesses") {
    const rubbingId = url.searchParams.get("rubbingId");
    const scanBatchId = url.searchParams.get("scanBatchId");
    return send(res, 200, { data: accessControl.listAccessRecords(db, { rubbingId, scanBatchId }) });
  }

  return send(res, 404, { error: "接口不存在", routes });
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((error) => {
    const body = { error: error.message || "服务器错误" };
    if (error.code) body.code = error.code;
    if (error.anomalies) body.anomalies = error.anomalies;
    send(res, error.status || 500, body);
  });
});

server.listen(PORT, async () => {
  await migrateLegacyData(); // 旧拓片按未归档处理并写回数据文件
  console.log(`Rubbing repair API running at http://127.0.0.1:${PORT}`);
});
