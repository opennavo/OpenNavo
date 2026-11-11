# 开发者地图 API

公开端点已并入 `apps/server/api/public.openapi.yaml`，管理端端点已并入 `apps/server/api/admin.openapi.yaml`；Go 契约（`gen/publicapi`、`gen/adminapi`）、TypeScript 类型（`packages/api`）和 MCP 操作清单都从这两份 spec 生成。Web、桌面和后台按本文件调用。

## 公开读取

### `GET /api/v1/developer-map?locale=zh-CN`

```json
{
  "code": "0000",
  "data": {
    "generatedAt": "2026-11-11T04:18:58Z",
    "totals": { "developers": 1284, "located": 1058, "apps": 7712, "locatedApps": 1058, "places": 24, "countries": 46 },
    "places": [
      {
        "key": "bay-area",
        "kind": "city",
        "name": "旧金山",
        "countryCode": "US",
        "region": "americas",
        "lat": 37.7749,
        "lng": -122.4194,
        "developers": 342,
        "apps": 486,
        "installs30d": 2380000,
        "topDevelopers": [{ "name": "Ghostty", "apps": 1, "installs30d": 420000 }]
      }
    ],
    "countries": [{ "code": "US", "developers": 486, "apps": 4210, "installs30d": 9200000 }],
    "recentDevelopers": [{ "name": "Vercel", "cityKey": "bay-area", "city": "旧金山", "countryCode": "US", "apps": 2, "updatedAt": "2026-11-10T10:00:00Z" }]
  }
}
```

### `GET /api/v1/developer-picks?locale=zh-CN&limit=4`

返回 `[{ "package": PackageSummary, "quote": string, "publishedAt": string }]`。缓存按 link 能力分桶：带 `X-OpenNavo-Caps: link` 的客户端会看到已发布的 link App，旧客户端不会。

## 公开写入

### `POST /api/v1/developer/fetch`

```json
{ "url": "https://github.com/owner/app" }
```

支持 GitHub 仓库、App Store 和官网；返回 `source/name/summary/description/developer/homepage/repoUrl/downloadUrl/iconUrl/version/minMacos/category/license/warnings`。
只允许公开 http(s)；拒绝 localhost、私有 IP、非 http(s)。服务端未注入抓取客户端时返回 500，不会在测试或空部署里访问外网。

### `POST /api/v1/developer/submissions`

```json
{
  "kind": "new | claim | location",
  "sourceKind": "github | appstore | website",
  "sourceUrl": "https://github.com/owner/app",
  "packageKind": "cask",
  "packageToken": "ghostty",
  "payload": { "name": "Ghostty", "countryCode": "US", "city": "San Francisco" },
  "contactEmail": "dev@example.com",
  "proof": "https://github.com/ghostty-org/ghostty",
  "website": ""
}
```

成功：

```json
{
  "code": "0000",
  "data": {
    "id": 3,
    "reference": "DS-000003",
    "token": "example-receipt-token-0000000001",
    "statusUrl": "https://opennavo.com/developer-map?tab=submit&submission=example-receipt-token-0000000001"
  }
}
```

`claim/location` 必须带 `packageKind + packageToken`；`location` 的 payload 至少要有两位 `countryCode`。`proof` 可选，不做自动验证。
匿名、限流、honeypot（`website` 非空时返回空回执、不落库）。创建时写入 `submitted` 事件。

### `GET /api/v1/developer/submissions/{token}`

用回执里的 32 位 token 查状态，不需要账号；响应 `Cache-Control: no-store`。

```json
{
  "code": "0000",
  "data": {
    "reference": "DS-000003",
    "kind": "new",
    "status": "published",
    "createdAt": "2026-11-10T10:00:00Z",
    "updatedAt": "2026-11-11T10:00:00Z",
    "decidedAt": "2026-11-11T10:00:00Z",
    "decisionNote": "Approved after a quick look.",
    "package": { "kind": "link", "token": "ghostty", "name": "Ghostty" },
    "events": [
      { "status": "submitted", "actor": "developer", "createdAt": "2026-11-10T10:00:00Z" },
      { "status": "published", "note": "Approved after a quick look.", "actor": "admin", "createdAt": "2026-11-11T10:00:00Z" }
    ]
  }
}
```

未知或格式错误的 token 返回 404。**不发邮件**：开发者凭回执 token 回到状态页查看进度；审核备注和时间线都在这里。

## 发布行为

`PATCH /admin-api/developer/submissions/:id` 的 `status=published` 现在是一个完整闭环：

1. `new` 且没有 `packageId`：按 payload 自动创建 `link` package（token 由名称生成、冲突自动加后缀），写 `packages`、`link_apps`、`package_i18n`（`manual`/`human`）、`package_meta.developer/icon_url/repo_url`、主分类和搜索索引。
2. 已关联 package：`ApplyDeveloperPayload` 写回 payload；cask 保留 Homebrew 的 homepage/version，只更新展示文案、开发者、图标、分类。
3. 有 `countryCode` 时写 `package_locations`（`approved`、`self`）。
4. `feature=true` 时写 `developer_picks`。
5. 状态变化写 `developer_submission_events`；不做邮件通知，开发者凭回执 token 在状态页查看。
6. `dryRun=true` 只返回预览，不建 package、不写库。

## 后台审核（需 admin JWT + `catalog:package:edit`）

- `GET /admin-api/developer/submissions?status=&q=&limit=`（`q` 匹配邮箱、payload 名称或 `DS-000123`）
- `GET /admin-api/developer/submissions/:id`
- `PATCH /admin-api/developer/submissions/:id?dryRun=true|false`

```json
{
  "status": "published",
  "decisionNote": "ok",
  "payload": { "countryCode": "US", "city": "San Francisco", "lat": 37.77, "lng": -122.42 },
  "packageKind": "cask",
  "packageToken": "ghostty",
  "feature": true,
  "quote": "A fast native terminal.",
  "sort": 1
}
```

- `GET /admin-api/developer/picks`：精选列表（含未上架），按 `sort` 排序
- `POST /admin-api/developer/picks` `{ packageKind, packageToken, quote, sort, active }`
- 管理端 MCP 工具：`developer_submissions_list`、`developer_submission_get`、`developer_submission_update`、`developer_pick_set`（`dry_run` 已生效）。

## 数据表

- `package_locations`：一个 App 一行；`status=approved` 才进地图
- `developer_submissions`：new / claim / location 三类线索；`public_token` 是匿名查询凭证
- `developer_submission_events`：状态时间线
- `developer_picks`：发现页开发者精选
- `package_meta.icon_url`：外部图标兜底（没有上传到 CDN 时使用）

## 迁移

- `00132_developer_map.sql`：位置、提交、精选
- `00133_developer_publish.sql`：发布闭环、`public_token`、状态事件、`package_meta.icon_url`

## 仍未做

- 限流 / SSRF 回归自动化（honeypot 与字段校验已有单测）
- 数据保留与清理任务

## 审核原则

没有开发者账号，也没有域名 / GitHub / Team ID 自动验证。提交只需要联系邮箱；`proof` 是可选补充材料，仅供编辑参考。审核通过即发布，编辑可以修改任何字段。
