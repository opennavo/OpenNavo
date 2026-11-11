# 开发者提交（位置 + 上架）· 方案

> 目标：开发者只贴一个链接（GitHub / App Store / 官网），我们自动抓取；开发者可以修改，后台也可以修改；审核通过后发布，并进入发现页「开发者精选」。
>
> 「开发者精选」放在发现模块、**热门 App 上方**。

---

## 0. 一句话流程

```
一个链接 → 自动抓取 → 开发者可编辑 → 提交
→ 后台可编辑 → 审核通过 → 发布（link / cask）→ 开发者精选
```

开发者不用填十几个字段；抓取不到的部分再手动补。

---

## 1. 双端入口

### 网页

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 开发者地图 | 侧边栏「开发者地图」 | `/developer-map`：地图 / 提交 App / 认领与更新 / 文档 四个 tab |
| 提交 App | 开发者地图 → 提交 App tab | 链接优先；也可以 `?view=submit` 直达 |
| 认领已有 App | 开发者地图 → 认领 tab / App 详情「这是你的 App？」 | `/developer-map` 内切换，或带 token 打开 |
| 认领与更新 | 开发者地图 → 认领与更新 tab | 先选择 App；勾选「更新开发者位置」后填国家/城市；补充材料可选；按 App 记录 |
| 我的提交 | 开发者地图 → 文档 tab 的提交状态 | 登录后查看进度、补充材料 |

### 客户端

| 入口 | 位置 | 行为 |
| --- | --- | --- |
| 开发者地图 | 侧边栏「开发者地图」 | 默认浏览器打开 `/developer-map`；提交/认领/位置/文档在同一页 tabs |
| 认领这个 App | App 详情操作菜单 | 读取本机签名 `teamId` / `bundleId`，带 proof 打开认领 tab |
| 认领 / 更新位置 / 状态 | 开发者地图 → 认领与更新 / 文档 tab | 打开网页 |

- v1 客户端不重做表单，只做入口、上下文和「本机签名证明」；表单、上传、审核、i18n 只有一份。
- v2 可选 Tauri 内嵌 webview 或原生表单，复用同一套公开 API。

---

## 2. 提交体验：链接优先

```
┌ 提交 App                                                        ┐
│ 贴一个 GitHub、App Store 或官网链接，我们自动抓取；你可以修改后再提交。 │
│                                                                │
│ [GitHub] [App Store] [官网]                                     │
│ [ https://github.com/ghostty-org/ghostty        ] [抓取信息]    │
│ 只读取公开信息：名称、简介、图标、版本和开发者。                  │
├────────────────────────────────────────────────────────────────┤
│ 正在抓取…                                                       │
├────────────────────────────────────────────────────────────────┤
│ 抓取到的信息  [自动抓取]                                         │
│ App 名称 [Ghostty]          分类 [终端与 Shell]                  │
│ 一句话简介 [Fast, native terminal emulator for macOS.]           │
│ 开发者 [Ghostty]             国家 [美国]   城市 [西雅图]          │
│ 官网 [https://ghostty.org]   下载 [自动抓取或手动填写]            │
│ GitHub [https://github.com/ghostty-org/ghostty]                 │
│ 图标 [从链接抓取] [替换]                                         │
│ 截图 [0 张，可稍后补]                                            │
│                                                                │
│ 归属验证 [GitHub 仓库] [官网域名]                                 │
│ ☑ 我确认拥有发布权，并授权展示图标、截图和简介                    │
│                                  [提交审核]                      │
└────────────────────────────────────────────────────────────────┘
```

- 三个 tab 只影响抓取方式和验证提示；链接本身自动识别（github.com / apps.apple.com / 其他）。
- 抓取失败：直接显示空表单，开发者手动填。
- 所有抓取到的字段都可以编辑；表单有「自动抓取」标记，提交后编辑再核对。
- 草稿自动保存；提交成功页显示「预计 3–5 个工作日」。

### 可编辑字段

| 分组 | 字段 |
| --- | --- |
| 基本信息 | App 名称、分类、一句话简介、详细描述 |
| 开发者 | 开发者 / 公司、国家、城市（可选）、是否远程 |
| 链接 | 官网、下载链接、GitHub Repo、App Store 链接 |
| 媒体 | 图标、截图（可稍后补）、版本 |
| 授权 | 发布权、展示图标/截图/简介的授权 |

---

## 3. 自动抓取

| 来源 | 抓什么 | 备注 |
| --- | --- | --- |
| **GitHub** | `api.github.com/repos/{owner}/{repo}`：名称、description、homepage、owner、license、默认分支；README 提取长描述；latest release 取版本和下载 asset；owner avatar / repo social preview 作为图标兜底 | 图标不一定是 App 图标，允许开发者替换；不写入仓库 |
| **App Store** | `itunes.apple.com/lookup?id=...` 或 `bundleId`：trackName、sellerName、description、artworkUrl512、version、minimumOsVersion、sellerUrl、genres | 字段最完整；图标直接用 artwork |
| **官网** | 抓 HTML：`og:title`、`og:description`、`og:image`、JSON-LD `SoftwareApplication` / `Organization`、favicon、下载链接 | 兜底方案；解析失败就让开发者手动填 |

- 抓取结果存 `app_submissions.payload.fetched`，同时保留 `source_url`、`source_kind`、`fetched_at` 和原始快照，便于后台核对。
- 抓取只读公开信息，不执行页面 JS，不提交表单，不写入来源站点。
- 服务端抓取：限制协议、超时、响应大小、域名/IP（防 SSRF）；失败不阻塞手动填写。
- 抓取结果可缓存 24 小时；同一链接重复提交直接复用。

---

## 4. 后台编辑与审核

```
draft → submitted → in_review → changes_requested → approved → published
                               → rejected / withdrawn
```

- 后台队列：状态、类型（new / claim / location）、来源、重复项、SLA。
- 详情：开发者提交的字段 + 抓取原始快照 + 线上当前页面 + 证据 + 消息。
- **后台可以编辑所有字段**：名称、简介、分类、图标、截图、开发者、位置、链接、标签。
- 通过 new：
  - 不在 Homebrew：调用现有 `addLinkPackage` 创建 link 页（homepage / downloadUrl / githubRepo / teamId / bundleIds / pricing）。
  - 符合 Homebrew：编辑提 cask PR，记录 PR 链接；合并后同步。
- 通过 claim：更新包 meta、图标、截图、开发者位置，打「开发者已认领」。
- 通过 location：写 `package_locations`（按 App），清地图缓存。
- 发布时设置 `developer_pick = true`，进入「开发者精选」。
- 邮件通知 + 状态页 + 审计；保留提交快照和字段变化。

---

## 5. 开发者精选

### 位置

发现页，分类 chips 之后、**热门 App 上方**：

```
分类 chips
开发者精选   由开发者提交、认领并维护            查看全部 →
[Ghostty] [Maestri] [massCode]
热门 App
最近更新
合集
```

### 数据

新增 `developer_picks`（或 `packages.developer_pick` + `developer_pick_at`）：

| 字段 | 说明 |
| --- | --- |
| `package_id` | 发布后的包 |
| `submission_id` | 来源提交，便于追溯 |
| `developer_id` / `account_id` | 认领的开发者 |
| `quote` | 开发者一句话（可选） |
| `sort` | 编辑排序 |
| `active` | 是否展示 |
| `published_at` | 发布/入选时间 |

### API / 前端

- `/home` 增加 `developerPicks`（3–4 个），排在 `popularApps` 之前；全量列表 `/developer-picks`。
- 共享 `OnDiscoverView` 增加 `developerPicks` section，放在 popular 之前；网页和客户端自动一致。
- 卡片：coral 轻渐变 + 发丝边框、「开发者精选」标、开发者名/城市、一句话 quote、「已认领」标、「本周新上架」/「已认领」。
- 只展示已审核通过的开发者提交；编辑可以 feature/unfeature；没有数据时整段隐藏，不占位。
- 与「本周精选」区分：后者是编辑精选 feature，前者是开发者自荐/认领。

### 规则

- 一个 App 只能有一条 active pick；同一开发者最多 2 条，避免刷屏。
- 排序：`published_at` 新→旧，编辑可置顶；热门 App 里已出现的也可以同时出现在精选（不同叙事），但编辑可排除重复。
- 入选后开发者可以更新简介/截图/位置，但不能自己改精选排序。

---

## 6. 数据模型

```
developer_accounts (id, github_id, email, display_name, avatar_url, status, ...)
developer_identities (account_id, provider, subject, email)
app_submissions (
  id, account_id, kind,            -- new | claim | location
  status, source_kind, source_url,
  package_id NULL, token,
  payload JSONB,                   -- fetched + edited fields
  fetched_at, reviewer_id, decision_note,
  published_package_id NULL,
  created_at, updated_at, submitted_at, decided_at
)
app_submission_messages (id, submission_id, author_type, author_id, body, created_at)
package_locations (package_id/token 唯一，country_code, city, remote, source admin|self, status approved|pending)
developer_picks (package_id, submission_id, developer_id, quote, sort, active, published_at)
```

- 位置以 `package_locations` 为 canonical（一个 App 一行）；编辑用 MCP `package_location_set`，开发者在 `/developer-map?tab=claim` 的「认领与更新」里先选 App、勾选「更新开发者位置」再提交。
- 发布时把 `app_submissions.payload` 写入 `packages` / `link_apps` / `package_meta`，并创建 `developer_picks`。
- 复用 `addLinkPackage`、`updatePackageMeta`；新增 admin 权限 `catalog:submission:view/review`。

---

## 7. 安全、反滥用、隐私

- 每账号每天 3 次提交、每 IP 每小时 10 次；邮箱验证、honeypot、失败后 captcha。
- 上传只允许图片，限制大小/尺寸、去 EXIF；图标/截图可由服务端抓取并转存。
- 抓取：只读、超时、大小限制、协议白名单、防 SSRF；不执行 JS、不写来源站点。
- 归属：不做账号或自动验证；所有提交人工审核，编辑可修改后发布，未审核不公开。
- 提交默认私有；通过后才公开；支持删除/导出；不展示联系人邮箱和街道地址。
- 授权条款：发布权、图标/截图/简介展示授权；保留 takedown/DMCA。

---

## 8. i18n / SEO / 通知

- 网页 10 种语言、客户端 6 种；开发者填写的名称/简介是 source，目录侧继续走现有翻译流程。
- `/developer-map` 可索引；提交/认领/位置/文档是同一页的 tabs，不为每个 tab 生成独立 URL。API/MCP 文档链接保留。
- 开发者精选是普通链接，可抓取；`/developer-picks` 全量页可索引（后续）。
- 邮件：提交成功、需要修改、通过、拒绝、发布；客户端深链回 App。

---

## 9. 分期

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| 1 | `app_submissions`、链接优先表单、GitHub/App Store/官网抓取、后台队列 | 2 周 |
| 2 | 后台编辑 + 审核动作 + `addLinkPackage` / cask PR + 发布 | 1 周 |
| 3 | 开发者精选表 + `/home` + 发现页 section（热门 App 上方） | 3 天 |
| 4 | 认领 + 位置 + 客户端入口（可选补充材料，不做验证） | 1 周 |
| 5 | 通知、状态页、i18n、反滥用、审计 | 1 周 |
| 6 | 可选：内嵌表单、MCP 审核工具、cask PR 自动化 | 后续 |

---

## 10. 待拍板

1. 上架政策：只做 link，还是同时接 cask PR？（建议两者都接，编辑决定）
2. 自动抓取优先级：GitHub / App Store / 官网；图标抓不到时用 owner avatar 还是要求开发者上传？
3. 开发者精选：编辑手动选，还是所有审核通过的都自动进、按发布时间轮换？
4. 验证门槛：GitHub / 域名 / App Store / 签名，四选一还是允许人工兜底？
5. 客户端：v1 打开网页（推荐），还是必须内嵌原生表单？
6. 审核 SLA / 负责人。
