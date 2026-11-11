# 开发者地图 · 方案

## 实现状态

- [x] `00132_developer_map.sql`：`package_locations`、`developer_submissions`、`developer_picks`
- [x] `00133_developer_publish.sql`：发布闭环、`public_token`、状态事件、`package_meta.icon_url`
- [x] `GET /api/v1/developer-map`：城市聚合、国家、最近加入、totals
- [x] `GET /api/v1/developer-picks`：发现页开发者精选（按 link 能力分桶缓存）
- [x] Web `/developer-map`：地图 / 提交 App / 认领与更新 / 文档 四个 tab
- [x] 发现页「开发者精选」在热门 App 上方
- [x] Web 侧边栏「开发者地图」、i18n、SSR、类型检查、单测
- [x] 真实 API + PostgreSQL 迁移 + E2E fixtures 验证
- [x] P2：提交/认领表单、自动抓取、后台审核/发布（API + Web）
- [x] P3：桌面客户端入口/页面、发现页精选、公开 MCP `developer_map`、后台审核 API
- [x] 桌面原生提交 / 认领 / 状态查询表单（不再跳转网页）
- [x] 管理后台审核 UI（Developer → Submissions；编辑 payload/状态/package/精选）
- [x] 管理端 MCP 审核工具（list/get/update/pick，`dry_run` 生效）
- [x] 后台「开发者精选」管理页（排序 / quote / 上下架）
- [x] 后台提交列表按邮箱 / DS 编号 / App 名称搜索
- [x] 公共开发者 API 并入 `public.openapi.yaml`，生成 Go/TS 契约；手写路由删除
- [x] 新 App 审核通过自动创建 link package，并写回名称/简介/开发者/图标/分类/位置
- [x] 提交状态页：`GET /developer/submissions/{token}` + 提交 tab 查询面板 + 回执 token（不发邮件）
- [x] 回归：发布闭环 integration test、Web/后台 Playwright 用例、honeypot/邮箱/来源/体积/SSRF 私网单测
- [x] 开发者文案翻译：Web/桌面/后台的 10 个语言（含 zh-Hant）
- [x] 数据保留：每日 cleanup 清理 365 天前的 rejected 提交与状态事件

### 仍未做

- 代码提交与 PR

### 审核原则

不做开发者账号，也不做域名 / GitHub / Team ID 自动验证。所有提交都是匿名的，进入后台后由编辑审核；编辑可以修改任何字段、合并到已有 App，或直接拒绝。审核通过即发布，发布即进入开发者精选候选。


> 在网页和 macOS 客户端的侧边栏「发现」下面新增「开发者地图」导航项，进入一个独立的开发者地理分布页面：
> 用一张世界地图说明这些 App 背后的开发者/团队分布在哪里。
>
> 配套高保真原型：`docs/design/developer-map/index.html`（可直接打开，或用本地静态服务访问）。

---

## 1. 为什么放在导航里，而不是发现页底部

发现页回答「有什么 App」：热门、最近更新、合集、分类。它没有回答「这些 App 是谁做的、来自哪里」。

开发者地图补的是这一层：

- **可信度**：知道 App 来自哪个团队、哪个城市，比一个陌生图标更容易建立信任。
- **发现**：从「城市 → 开发者 → App」反向逛目录，是一条新的探索路径。
- **差异化**：不是又一张 App 网格，而是目录的「制造者视角」，和排行榜/分类不重复。
- **可运营**：城市、国家、团队都可以被编辑精选、做专题（例如「欧洲独立开发者」「亚洲 AI 团队」）。

放在「发现」下面，而不是发现页最底部：

- 它是**浏览入口**，不是发现页的附属模块；用户应该能像打开分类/排行榜一样直接进入。
- 页面需要**完整的地图、全部城市、数据说明和 SEO 落点**，塞在发现页底部会让首屏过长。
- 侧边栏是全局的，网页和客户端可以共用同一个位置和同一个页面结构。

---

## 2. 放在哪里

### 导航位置

侧边栏「浏览」组，紧跟「发现」：

```
浏览
  发现
  开发者地图   ← 新增
  全部应用     ← 仅网页
  分类
  排行榜
  最近更新
  文章
清单
  合集
  我的清单
```

- 网页：`apps/web/app/composables/useSiteNav.ts` 的 `browse` 组里，`discover` 之后插入 `item('developer-map', '/developer-map', 'lucide:map')`；`section` 的路径判断加上 `developer-map`。
- 客户端：`apps/desktop/src/components/shell/AppSidebar.vue` 的 `browse` 组里，`discover` 之后插入 `item('developer-map', 'lucide:map', t('nav.developerMap'))`。
- 移动端网页：`SiteCompactBar` 的菜单数据复用 `useSiteNav()`，自动带上这一项。
- 路由：网页 `/developer-map`，客户端 `/developer-map`；选中态由现有 nav 逻辑处理。
- 图标：`lucide:map`（与现有 17px 线性图标一致）。
- i18n：`nav.developerMap` + 页面文案，网页 10 个站点语言、客户端 6 个语言。

### 页面结构

开发者地图现在是所有开发者功能的唯一入口，页内用 tabs 承载：

```
[地图] [提交 App] [认领与更新] [文档]
```

- 「地图」：世界地图 + 城市榜 + 全部城市。
- 「提交 App」：一个链接（GitHub / App Store / 官网）+ 自动抓取 + 可编辑表单。
- 「认领与更新」：客户端签名 proof + 选择 App；勾选「更新开发者位置」后填国家/城市。
- 「文档」：API / MCP 文档、提交状态、上架方式。

完整提交流程见 `docs/design/developer-submission/PLAN.md`。

```
┌ 开发者地图                                          [数据说明] [报告错误] ┐
│ 7,712 个 App 背后的 1,284 位开发者，来自 46 个国家的 24 个主要城市。              │
│ 1,284 收录开发者   1,058 已定位   24 主要城市   46 国家/地区                    │
│ ┌────────────────────────────────────────────────────────────────────────────┐ │
│ │ [开发者|安装量]                              [全球|美洲|欧洲|亚太|其他]     │ │
│ │                                                                            │ │
│ │                · 世界地图（国家热力 + 城市气泡）                             │ │
│ │      ● 旧金山湾区 342       ● 伦敦 82       ● 北京 68                       │ │
│ │                                                                            │ │
│ │  ●●● 圆点大小 = 开发者数量                              更新于 11 月 10 日  │ │
│ ├────────────────────────────────────────────────────────────────────────────┤ │
│ │ 开发者最多的城市                            [城市|国家]  已定位 1,058/1,284  │ │
│ │ 01 旧金山湾区 342   02 西雅图 108   03 伦敦 82                              │ │
│ │ 04 北京 68          05 东京 60      06 悉尼 48                              │ │
│ └────────────────────────────────────────────────────────────────────────────┘ │
│ 全部城市  按开发者数量排序 · 24 个                                   导出 CSV ↓ │
│ [旧金山湾区 342] [西雅图 108] [伦敦 82] [北京 68]  … 4 列 × 6 行               │
└────────────────────────────────────────────────────────────────────────────────┘
```

右栏（288px，和现有页面一致）：

- **数据说明**：只使用公开团队所在地、覆盖率、更新频率、来源链接。
- **开发者最多的国家**：Top 6 国家 + 开发者数 + App 数。
- **最近加入**：本周新增/更新的 4 位开发者 + 所在城市。

### 视觉规则

- 地图底色是卡片的深色渐变，海洋不额外上色；国家用极低对比的填充 + 1px 发丝描边。
- 有数据的国家按开发者数量叠一层 coral（`#FF7356`）透明热力，最深约 30%，让圆点仍是第一层信息。
- 城市是 coral 圆点：核心点 + 外发光 + 可选脉冲；点半径按开发者数（或安装量）开方缩放。
- 只给全球前 6 个城市显示常驻标签；选中地区或国家时隐藏标签，避免欧洲一片字叠字。
- 数字全部用 tabular-nums；地图标签 10.5px、城市名 13px、页面标题 28px、统计数字 18px。
- 浅色主题使用 `#EE5533`，热力透明度整体降低；地图沿用 `--on-*` token，不引入第二套颜色。

### 响应式

- 内容宽度 ≥ 900px：页面标题 + 统计一行，地图全宽（按 1000:420 比例，最高 620px），全部城市 4 列，右栏 288px。
- 640–900px：页面标题和操作按钮换行，地图保持全宽，全部城市 2 列，右栏移到主内容下方。
- < 640px：地图固定 230px，隐藏常驻标签和地区筛选（地区下钻用国家榜代替）；全部城市 1 列；页面标题 24px。
- 客户端窗口 < 1240px 时右侧统计栏本来就会收起，页面只受内容宽度影响。

---

## 3. 交互

| 操作 | 结果 |
| --- | --- |
| hover 城市点 / 榜单行 | 另一侧同步高亮 + 浮层（城市、国家、开发者数、App 数、Top 3 团队） |
| 点击城市点 / 榜单行 | 下方榜单切换为该城市的开发者列表（返回按钮回到城市榜） |
| 点击「全部城市」卡片 | 选中该城市，滚动回地图并打开开发者列表 |
| 点击空白 | 取消选中 |
| `开发者 / 安装量` | 改变圆点大小、标签数值和榜单排序 |
| `全球 / 美洲 / 欧洲 / 亚太 / 其他` | 非当前区域淡出，榜单过滤，并清除已选中的国家/城市 |
| `城市 / 国家` | 榜单在城市榜和国家榜之间切换，与地图热力对应；点国家可继续下钻到城市 |
| 键盘 | Tab 到地图圆点，Enter / Space 选中，Esc 取消；榜单和「全部城市」本身是完整键盘入口 |
| 页面操作 | `数据说明` 跳到右栏说明 / 打开说明弹层；`报告错误` 进反馈表单；`导出 CSV` 下载城市表 |

### 空 / 加载 / 离线

- 加载：固定高度骨架（地图轮廓 + 6 行榜单 + 城市网格），不产生 CLS。
- 无数据或覆盖率不足：不渲染空地图，显示「开发者地图正在整理中」的说明卡。
- 客户端离线：读本地缓存的上一份地图数据，页面顶部显示「离线数据 · 更新于 X」；没有缓存则整页显示离线提示。
- 减少动态：关闭脉冲和过渡，只保留选中态。

### 可访问性

- 页面只有一个可见 H1（开发者地图）；地图 SVG 是 `role="group"`，真正的地图操作入口是榜单和「全部城市」按钮。
- 城市点用 `<g role="button" tabindex="0">`，Enter/Space 选中，Esc 取消；focus-visible 用 coral 描边。
- 颜色不是唯一编码：区域、数量都有文本；热力有数值 tooltip。
- 对比度：地图上的 10.5px 标签用 `--on-text-secondary`，不放在热力最深的国家上；必要时加 1px 暗色 text-shadow。

---

## 4. 数据：人工补 + 开发者自助

位置数据以 `package_locations` 为 canonical（一个 App 一行），两条写入路径：

- **编辑人工**：后台 / MCP `package_location_set`
- **开发者自助**：`/developer-map?tab=claim`（先选 App；域名/GitHub 验证，或人工审核），见 `docs/design/developer-submission/PLAN.md`

不做抓取、不做推断；只存国家/城市，不存街道地址。

### 字段

| 字段 | 说明 |
| --- | --- |
| `package_id` / `token` | 这个位置属于哪个 App（唯一） |
| `developer_name` | App 当前的开发者名（只读展示，不参与归属） |
| `country_code` | ISO 3166-1 alpha-2，**必填** |
| `city` / `city_key` | 可选；填了画城市点，不填画国家代表点 |
| `region` | `americas` / `europe` / `apac` / `other` |
| `lat` / `lng` | 城市中心，或国家代表点（Natural Earth `LABEL_X/Y`） |
| `source` | `admin` / `self` |
| `status` | `approved` / `pending` / `rejected` |
| `confidence` | `verified` / `self_reported` / `probable` |
| `evidence_url` | 可选的补充材料链接（只给审核参考，不做自动验证） |
| `verified_by` / `verified_at` | 审核人 / 时间 |

- 一个 `package_id` 只保留一条 `approved`（唯一索引）。
- 只填国家也能上线：地图按国家代表点画一个点，榜单显示国家；填了城市再升级为城市点。
- 每个 App 一行；同一开发者的多个 App 可以分别提交/更新位置。

### 写入流程

1. **编辑人工**：后台包详情或 MCP `package_location_set`，写 `source=admin`、`status=approved`、`confidence=verified`。
2. **开发者自助**：`/developer-map?tab=claim` 先选择 App，再提交位置；域名/GitHub 证明通过可直接 `approved`，否则 `pending` 人工审核。
3. **审核**：后台通过/拒绝；拒绝写原因，开发者可修改后重提。
4. **地图**：只读 `status='approved'`；写操作后清 `/developer-map` 缓存。

### MCP 契约

- **写**：`package_location_set(package, country, city, status?)`，admin 权限；一次写一个 App，`package` 可用 token。
- **读**：`package_get` 返回的 `meta.developerCountry` / `meta.developerCity`；或新增 `developer_get`。
- `package_update_meta` 仍可接受 `developerCountry` / `developerCity` 作为快捷字段，服务端同步到 `package_locations`；canonical 仍是表。

### 地图口径

- **有 city**：城市点（现有设计）。
- **只有 country**：国家代表点 + 国家标签；榜单显示「国家/地区」。
- **没有值**：不画点，计入「未定位」。
- 国家榜由 `package_locations` 直接 rollup；城市榜只统计有 city 的。城市里的「开发者数」由这些 App 的 `developer` 去重得到。
- 覆盖率 = 有值的 App / 总 App；页面显示「已定位 X / Y」，开发者数按 App 的 developer 去重。

### 隐私

- 只收团队/公司公开所在地，不推断个人；个人开发者只填国家也可以。
- 不展示街道地址；地图只到城市/国家。
- 开发者自助提交默认只对审核可见；通过后才公开。
- 纠错：后台直接改；公开页保留「报告错误」入口（可选）。

### 工作量

- 不再需要抓取/审核流水线；主要开发量在 `package_locations` 表、后台/MCP 写入、自助提交页和审核队列。
- 数据填充：编辑先补头部，开发者自助覆盖长尾；地图只展示 approved。
- 后续按新增/错误增量维护。

---

## 5. API

### 页面主接口

`GET /developer-map?locale=zh-CN` → 页面一次拿全：

```jsonc
{
  "generatedAt": "2026-11-10T08:00:00Z",
  "totals": { "developers": 1284, "located": 1058, "apps": 7712, "places": 24, "countries": 46 },
  "places": [
    {
      "key": "bay-area",
      "kind": "city",              // city | country；只有国家时用 country
      "name": "旧金山湾区",
      "countryCode": "US",
      "countryName": "美国",
      "region": "americas",
      "lat": 37.77, "lng": -122.42,
      "developers": 342,
      "apps": 486,
      "installs30d": 1820000,
      "topDevelopers": [
        { "name": "Anthropic", "apps": 2, "installs30d": 420000 },
        { "name": "OpenAI", "apps": 3, "installs30d": 380000 }
      ]
    },
    {
      "key": "US",
      "kind": "country",           // 没填 city 时
      "name": "美国",
      "countryCode": "US",
      "countryName": "美国",
      "region": "americas",
      "lat": 39.8, "lng": -98.6,  // 国家代表点
      "developers": 486,
      "apps": 4210,
      "installs30d": 5240000,
      "topDevelopers": []
    }
  ],
  "countries": [
    { "code": "US", "name": "美国", "developers": 486, "apps": 4210 }
  ],
  "recentDevelopers": [
    { "name": "Vercel", "placeKey": "bay-area", "countryCode": "US", "apps": 2, "joinedAt": "2026-11-08" }
  ]
}
```

- 缓存：`s-maxage=300, stale-while-revalidate=3600`，ETag；和开发者位置写操作一起失效。
- 本地化：`name` 随 `locale` 返回；国家名用 `Intl.DisplayNames` 或现有 i18n；城市名进入翻译表。
- 客户端：响应缓存到本地 catalog store；离线读缓存并标记。
- 如果以后要在发现页放一张小预告卡，再给 `/home` 加轻量 `developerMap` 摘要；v1 页面不需要。

### CSV

`GET /developer-map?format=csv` → 地区、国家、开发者数、App 数、安装量、最后更新；用于「导出 CSV」和编辑校对。

---

## 6. 前端落地

### 共享组件

新增：

- `packages/ui/src/components/OnDeveloperMap.vue`：地图卡片（地图 + 榜单 + 指标/地区切换）。
- `packages/ui/src/components/OnDeveloperPlaceGrid.vue`：全部地区 4 列网格（city 显示城市，country 显示国家）。
- `packages/ui/src/components/OnDeveloperMapRail.vue`：数据说明 + 国家榜 + 最近加入。
- 构建期生成的 `world-map.ts`（Natural Earth 110m，投影后的 path 字符串）由 `OnDeveloperMap` 引入。

```ts
interface OnDeveloperMapProps {
  places: DeveloperMapPlace[];
  countries: DeveloperMapCountry[];
  totals: DeveloperMapTotals;
  labels: OnDeveloperMapLabels;
  interactive?: boolean;
}
```

- 不引入 Leaflet/MapLibre：无瓦片请求、可 SSR、可完全贴合设计系统、体积可控。
- 地图只负责呈现和命中；筛选、排序、选中状态在组件内，榜单和城市网格是主要交互面。

### 页面与路由

**网页**

- `apps/web/app/pages/developer-map.vue`：`definePageMeta({ rail: 'developer-map' })`；`useAsyncData` 请求 `/developer-map`；H1 + 简介 + `OnDeveloperMap` + `OnDeveloperCityGrid`；`link-as=NuxtLink`。
- `apps/web/app/components/layout/SiteDeveloperMapRail.vue`：右栏；`useSiteNav` 的 `section` 识别 `developer-map`。
- `apps/web/app/composables/useSiteNav.ts`：`discover` 后插入导航项；`section` 路径判断加上 `developer-map`。
- 移动端菜单复用 `useSiteNav`，自动出现。

**客户端**

- `apps/desktop/src/pages/DeveloperMapPage.vue` + 路由 `/developer-map` + `meta.rail`。
- `apps/desktop/src/components/shell/AppSidebar.vue`：`discover` 后插入导航项。
- `apps/desktop/src/components/rails/DeveloperMapRail.vue`：右栏；离线时显示缓存标记。
- `apps/desktop/src/composables/useDeveloperMap.ts`：API 请求 + 本地缓存 + `peek` 离线回退。

**共用**

- 页面顶部操作：`数据说明` 打开说明弹层/锚点；`报告错误` 进 `/feedback?topic=developer-location`；`导出 CSV` 走 `format=csv`。
- 埋点：`developer_map_view`、`developer_map_city_select`、`developer_map_region`、`developer_map_metric`、`developer_map_csv`、`developer_map_submit`。

### SEO

- `/developer-map` 是可索引页面：H1 + 简介 + 服务端渲染的城市/开发者列表 + `ItemList` / `Place` 结构化数据。
- 不要把每个城市做成独立薄页面；用一个页面 + 锚点（`#city-bay-area`），后续有足够内容再拆城市页。
- 站点地图加入 `/developer-map`；App 详情页可以加「开发者所在地」链接，形成内链。

---

## 7. 性能与 SEO

- **零地图库**：内联 SVG（gzip 后 < 40KB）+ 组件 JS < 15KB；无第三方 tile、无 WebGL。
- 地图卡片在首屏内：固定高度骨架、`content-visibility: auto`；地图 path 用 `vector-effect="non-scaling-stroke"`。
- 图标：城市/开发者列表用字母块，不加载几十张 logo；App 卡片沿用现有图标管线。
- 页面可索引：H1 + 简介 + 城市/开发者列表（SSR）+ `ItemList` / `Place` 结构化数据；发现页只放导航入口，不重复内容。
- 不把地图做成图片：文字和链接必须可被抓取、可被读屏。

---

## 8. 验证

- 单元：归一化/别名、城市聚合、国家 rollup、覆盖率阈值、投影函数。
- 视觉回归：1440 / 1024 / 390；深色 / 浅色；有数据 / 空 / 离线。
- E2E：导航入口与选中态、hover 联动、点击城市、返回、区域筛选、metric 切换、全部城市卡片、键盘操作、Esc 取消。
- a11y：axe（无严重项）、键盘走查、200% 缩放、reduced motion。
- 性能：Lighthouse 不因地图掉分；CLS = 0；地图 SVG 解码 < 16ms。
- 数据：抽查 30 个头部开发者的来源链接；覆盖率报表；纠错流程。

---

## 9. 分阶段

| 阶段 | 内容 | 预估 |
| --- | --- | --- |
| 1 | 数据表 + 归一化 + 头部 500 人工核验 + 导入脚本 | 1 周 |
| 2 | 聚合 API + 缓存 + 覆盖率门槛 + CSV | 3 天 |
| 3 | `OnDeveloperMap` / 城市网格 / 页面 + 网页路由和导航 | 1 周 |
| 4 | 客户端路由、导航、右栏 + 离线缓存 | 3 天 |
| 5 | SEO / a11y / 测试 / 数据说明页 | 1 周 |
| 6 | 灰度（flag）、数据监控、正式发布 | 3 天 |

---

## 10. 待拍板

1. `developer_country` 必填、`developer_city` 可选（本方案），还是两级都要求填？
2. 同一个 developer 的多个 App 填了不同国家：最新非空值优先，还是后台直接阻止发布？
3. 只有国家时，代表点用首都/最大城市坐标，还是国家几何中心？
4. 城市名是否需要 10 种语言全翻译，还是跟随国家名用 `Intl.DisplayNames` + 英文城市名？
5. 「报告错误」入口现在做，还是 v1 只留后台直接改？
