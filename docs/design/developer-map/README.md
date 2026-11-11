# 开发者地图 · 高保真原型

侧边栏「发现」下面的「开发者地图」页面，同时覆盖网页和 macOS 客户端两种外壳。

## 打开

`index.html` 是完全自包含的（设计 token、Inter 字体、世界地图、图标、样式和脚本全部内联），直接双击即可，不需要服务器：

```bash
open docs/design/developer-map/index.html
```

需要固定端口时：

```bash
cd docs/design/developer-map
python3 -m http.server 4173
# http://127.0.0.1:4173/index.html
```

## 评审快捷参数

默认打开「开发者地图」页面（侧边栏该项高亮）。点侧边栏的「发现」可以切回发现页，验证新导航项的位置。

| 参数 | 作用 |
| --- | --- |
| `?view=map` / `?view=discover` | 开发者地图页 / 发现页 |
| `?view=map&tab=map` / `submit` / `claim` / `docs` | 开发者地图页内的四个 tab；`location` 是 `claim` 的别名 |
| `?view=submit` / `?view=claim` / `?view=location` / `?view=developers` | 直达对应 tab 的别名 |
| `?mode=web` / `?mode=desktop` | 网页外壳 / macOS 客户端外壳 |
| `?theme=dark` / `?theme=light` | 深色 / 浅色 |
| `?ui=0` | 隐藏底部评审工具条（截图用） |
| `?focus=map` | 打开后直接定位到地图卡片 |
| `#dm-city=bay-area` | 直接打开旧金山湾区的开发者列表 |
| `#dm-country=US` | 直接打开美国的城市下钻 |
| `#dm-tab=countries` | 直接打开国家榜 |

例如：

```text
index.html?mode=desktop&theme=dark&ui=0
index.html?view=discover&ui=0
```

## 可以试的交互

- 侧边栏「发现」下面就是「开发者地图」；所有开发者功能都在这一页的 tab 里。页脚「开发者」打开「文档」tab。
- 开发者地图页 tab：地图 / 提交 App / 认领与更新 / 文档。提交、认领、位置、API/MCP 文档、上架方式都在同一页。
- 提交 App：只贴一个 GitHub / App Store / 官网链接，点「抓取信息」后自动填充名称、简介、开发者、位置、图标；所有字段可编辑，右侧实时预览，最后提交审核。
- 发现页：热门 App 上方新增「开发者精选」，展示开发者提交/认领的 App（coral 轻渐变、开发者 quote、「已认领」标）。
- 认领与更新：选择 App → 勾选要更新的内容 → 填国家/城市；补充材料可选，审核由编辑人工完成。
- 提交状态：提交成功后拿到 32 位回执 token，可在「提交 App」tab 下方查询审核进度、审核备注和已发布 App。
- hover 城市点 / 榜单行：浮层 + 双向高亮。
- 点击城市点、榜单行或「全部城市」卡片：下方切换为该城市的开发者列表，左上角返回。
- 「城市 / 国家」切换；点国家继续下钻到该国家的城市。
- 「开发者 / 安装量」：改变圆点大小、标签数值和榜单排序。
- 「全球 / 美洲 / 欧洲 / 亚太 / 其他」：非当前区域淡出，榜单过滤。
- 键盘：Tab 到地图圆点，Enter / Space 选中，Esc 取消；榜单和「全部城市」都是完整键盘入口。

## 文件

| 文件 | 说明 |
| --- | --- |
| `PLAN.md` | 导航位置、页面结构、数据、API、前端接入、性能、测试和分期方案 |
| `API.md` | 已实现的公开/管理端接口、发布闭环、通知与迁移 |
| `index.html` | 自包含高保真原型（用 `build.py` 生成，不要手改） |
| `src/style.css` | 原型样式（沿用 `packages/tokens` 的 token） |
| `src/body.html` | 页面结构（发现页 + 开发者地图页两个视图） |
| `src/app.js` | 数据、地图渲染、导航切换和交互 |
| `src/assets.json` | 世界地图路径、品牌图标、Inter 字体（构建输入） |
| `build.py` | 组装 `index.html` |
| `screenshots/` | 网页 / 客户端 / 浅色 / 移动端截图；`web-submission-status.png`、`desktop-status-native.png` 是状态查询面板 |

重新生成：

```bash
cd docs/design/developer-map
python3 build.py
```

## 说明

- 世界地图底图为 Natural Earth 110m（公共领域），已投影并内联，无第三方地图库、无瓦片请求。
- 品牌图标来自 Iconify，商标归各公司所有，仅用于界面提案。
- 城市、开发者、安装量是界面评审用的**示意数据**，不是线上真实统计；真实接入按 `PLAN.md` 第 4 节建 `package_locations`（一个 App 一行）：编辑通过后台或 MCP `package_location_set` 补，开发者在 `/developer-map?tab=claim` 的「认领与更新」里先选 App 再自助提交。只填国家也能出图（国家代表点）；原型里的城市点是 city 填了之后的完整形态。提交上架/认领的完整流程见 `docs/design/developer-submission/PLAN.md`。
- 原型只有「发现」和「开发者地图」两个视图；开发者地图页内用四个 tab 承载地图、提交、认领与更新、文档。侧边栏只有「开发者地图」一个开发者入口；发现页顶部是「开发者精选」。
- 发现页顶部的编辑精选 Hero 没有画，页面从分类 chips 开始；这次评审重点是开发者地图和开发者提交渠道。
