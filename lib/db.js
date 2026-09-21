const { readFile, writeFile, mkdir } = require("fs/promises");
const path = require("path");
const { now } = require("./util");

const DB_FILE = path.join(__dirname, "..", "data", "db.json");

const initialData = {
  rubbings: [
    {
      id: "rubbing_demo",
      code: "TP-清-014",
      source: "地方碑刻残页",
      paperSize: "42x68cm",
      note: "边缘有旧折痕（旧拓片，未录入结项信息）",
      createdAt: "2026-06-16T00:00:00.000Z"
    },
    {
      id: "rubbing_demo_done",
      code: "TP-清-031",
      source: "馆藏石刻整拓",
      paperSize: "58x96cm",
      note: "已结项、资料齐全，可送扫",
      projectStatus: "closed",
      materialsComplete: true,
      archiveStatus: "archived",
      archivedAt: "2026-08-02T00:00:00.000Z",
      createdAt: "2026-06-20T00:00:00.000Z"
    }
  ],
  damages: [
    {
      id: "damage_demo_1",
      rubbingId: "rubbing_demo",
      position: "左上角第3列题字旁",
      type: "虫蛀孔",
      beforePhotoUrl: "https://example.local/before-014-1.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    },
    {
      id: "damage_demo_2",
      rubbingId: "rubbing_demo",
      position: "下边缘中央",
      type: "撕裂",
      beforePhotoUrl: "https://example.local/before-014-2.jpg",
      afterPhotoUrl: "",
      status: "pending",
      repairNote: "",
      batchId: null,
      createdAt: "2026-06-16T00:00:00.000Z",
      repairedAt: null
    }
  ],
  batches: [],
  scanBatches: [],
  accessRecords: []
};

// 旧拓片缺少数字化归档字段：按「未归档」处理，结项与资料齐全默认不满足
function normalizeRubbing(rubbing) {
  if (rubbing.projectStatus === undefined) rubbing.projectStatus = "open";
  if (rubbing.materialsComplete === undefined) rubbing.materialsComplete = false;

  const canArchive = rubbing.projectStatus === "closed" && rubbing.materialsComplete === true;
  if (rubbing.archiveStatus === undefined || rubbing.archiveStatus === null) {
    rubbing.archiveStatus = canArchive ? "archived" : "unarchived";
  }
  if (canArchive && rubbing.archiveStatus !== "archived") {
    rubbing.archiveStatus = "archived";
  }
  if (canArchive && !rubbing.archivedAt) rubbing.archivedAt = now();
  if (!canArchive && rubbing.archiveStatus === "archived") rubbing.archiveStatus = "unarchived";
  if (!canArchive) rubbing.archivedAt = null;
  return rubbing;
}

function normalize(data) {
  if (!Array.isArray(data.scanBatches)) data.scanBatches = [];
  if (!Array.isArray(data.accessRecords)) data.accessRecords = [];
  data.rubbings.forEach(normalizeRubbing);
  return data;
}

async function ensureDb() {
  await mkdir(path.dirname(DB_FILE), { recursive: true });
  try {
    JSON.parse(await readFile(DB_FILE, "utf8"));
  } catch {
    await writeFile(DB_FILE, JSON.stringify(initialData, null, 2));
  }
}

// 启动时执行一次：旧拓片按未归档处理，归档状态写回数据文件
async function migrateLegacyData() {
  await ensureDb();
  const data = normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
  return data;
}

async function readDb() {
  await ensureDb();
  const data = normalize(JSON.parse(await readFile(DB_FILE, "utf8")));
  return data;
}

// 迁移与业务写入统一走该方法，旧拓片的未归档状态会落到数据文件
async function writeDb(data) {
  normalize(data);
  await writeFile(DB_FILE, JSON.stringify(data, null, 2));
}

function findRubbing(db, rubbingId) {
  const rubbing = db.rubbings.find((item) => item.id === rubbingId);
  if (!rubbing) {
    const error = new Error("拓片不存在");
    error.status = 404;
    throw error;
  }
  return rubbing;
}

// 拓片当前是否存在未完成的扫描批次
function findUnfinishedScanBatch(db, rubbingId) {
  return db.scanBatches.find(
    (batch) => batch.rubbingId === rubbingId && (batch.status === "scanning" || batch.status === "quarantined")
  );
}

module.exports = {
  DB_FILE,
  initialData,
  normalize,
  normalizeRubbing,
  ensureDb,
  migrateLegacyData,
  readDb,
  writeDb,
  findRubbing,
  findUnfinishedScanBatch
};
