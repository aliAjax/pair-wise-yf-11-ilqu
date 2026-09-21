# 古籍拓片缺损修补API

纯后端零依赖Node服务，使用 `data/db.json` 持久化拓片、缺损项、修补批次，以及数字化送扫 / 完整性校验 / 调阅冻结闭环数据。

## 启动

```bash
PORT=3020 node server.js
```

## 模块划分

- `modules/rubbings.js` — 拓片生命周期：结项、资料确认、归档前置
- `modules/scanBatches.js` — 扫描批次模块：送扫、上传、补扫、版本与只读状态
- `modules/integrity.js` — 完整性校验模块：校验和比对、整批隔离、补扫出新版本
- `modules/access.js` — 调阅冻结模块：隔离冻结、访问记录（拒绝时不写记录）

## 主要接口

修补闭环：

- `GET /health`、`GET /rubbings`、`POST /rubbings`
- `GET/POST /rubbings/:id/damages`
- `GET /damages?status=&type=`、`PATCH /damages/:id`
- `GET/POST /batches`、`GET /batches/:id`、`POST /batches/:id/complete`

送扫前置：

- `POST /rubbings/:id/close` — 所有缺损修复后结项
- `POST /rubbings/:id/materials` — 核验并确认资料齐全（含修复后照片）
- `POST /rubbings/:id/archive` — 结项且资料齐全后归档

数字化送扫：

- `GET /rubbings/:id/scan-batches` — 按版本列出扫描批次
- `POST /rubbings/:id/scan-batches` — 送扫（仅已结项且资料齐全）
- `GET /scan-batches/:id`
- `POST /scan-batches/:id/files` — 上传扫描文件（含 checksum）

完整性校验：

- `POST /scan-batches/:id/verify` — 提交期望文件清单 `{expectedFiles:[{name,checksum}]}`
- `POST /scan-batches/:id/rescan` — 隔离批次补扫，可一并提交 `expectedFiles` 立即校验

调阅：

- `POST /rubbings/:id/access` — 调阅申请（可指定 `batchId` 查阅旧版本）
- `GET /access-records?rubbingId=&batchId=`

## 业务规则

1. **送扫条件**：只有 `projectStatus=closed`（已结项）且资料齐全（基础字段完整、每项缺损均有修复后照片）的拓片才能送扫，否则 `409`。
2. **重复送扫**：同一拓片存在未完成扫描批次（待扫描/待校验/隔离中）时重复送扫返回 `409`，原批次与扫描状态不变。
3. **校验和异常**：期望清单与实际文件存在缺失、多余或校验和不一致时，**整批隔离**（`quarantined`）；隔离期间调阅返回 `409` 且**不产生访问记录**。
4. **补扫一致**：对隔离批次补扫并校验通过后，生成**新版本**（`completed`），原批次变为 `superseded`（**只读**，再变更返回 `409`），调阅自动解冻。
5. **旧拓片迁移**：数据文件中缺少 `projectStatus / materialsComplete / archived` 字段的旧拓片，按未归档处理（`open / false / false`）并在首次读取时写回 `data/db.json`。

## 闭环示例

```bash
# 1. 完成修补并结项、确认资料
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_1 \
  -H 'Content-Type: application/json' \
  -d '{"status":"repaired","afterPhotoUrl":"https://example.local/after-1.jpg"}'
curl -X PATCH http://127.0.0.1:3020/damages/damage_demo_2 \
  -H 'Content-Type: application/json' \
  -d '{"status":"repaired","afterPhotoUrl":"https://example.local/after-2.jpg"}'
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/close
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/materials

# 2. 送扫、上传扫描文件
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/scan-batches \
  -H 'Content-Type: application/json' -d '{"requestedBy":"数字化组"}'
curl -X POST http://127.0.0.1:3020/scan-batches/<scanId>/files \
  -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"01.tif","checksum":"sha256:aaa"}]}'

# 3. 校验（异常 -> 整批隔离，调阅 409；补扫一致 -> 新版本、旧版本只读）
curl -X POST http://127.0.0.1:3020/scan-batches/<scanId>/verify \
  -H 'Content-Type: application/json' \
  -d '{"expectedFiles":[{"name":"01.tif","checksum":"sha256:bbb"}]}'
curl -X POST http://127.0.0.1:3020/scan-batches/<scanId>/rescan \
  -H 'Content-Type: application/json' \
  -d '{"files":[{"name":"01.tif","checksum":"sha256:bbb"}],"expectedFiles":[{"name":"01.tif","checksum":"sha256:bbb"}]}'

# 4. 调阅与访问记录
curl -X POST http://127.0.0.1:3020/rubbings/rubbing_demo/access \
  -H 'Content-Type: application/json' -d '{"requester":"张三","purpose":"研究"}'
curl 'http://127.0.0.1:3020/access-records?rubbingId=rubbing_demo'
```
