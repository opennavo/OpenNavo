export default {
  brewfile: {
    installTitle: '安装清单中的软件',
    title: '我的清单',
    description: '软件先加入清单，再统一安装或导出。清单仅保存在本机。',
    count: '{count} 项',
    emptyTitle: '清单是空的',
    emptyDescription: '在软件详情页点击「加入清单」，或从已安装软件的更多菜单中添加。',
    browse: '去发现',
    fileTitle: '由 OpenNavo 生成',
    download: '导出 Brewfile',
    moveUp: '上移 {name}',
    moveDown: '下移 {name}',
    remove: '从清单移除 {name}',
    add: '加入清单',
    inList: '已在清单中',
    removeShort: '从清单移除',
    added: '已加入我的清单',
    full: '清单最多 200 项，请先移除一些软件。',
    saveFailed: '无法保存或读取清单，请检查本机存储后重试。',
    install: '安装 {count} 个软件',
    installHint: '自动跳过已安装、正在安装及不可用的软件。',
    copy: '复制 Brewfile',
    exported: 'Brewfile 已导出'
  },
  app: {
    name: 'OpenNavo'
  },
  nav: {
    browse: '浏览',
    mine: '我的',
    discover: '发现',
    categories: '分类',
    rankings: '排行榜',
    installed: '已安装',
    updates: '更新',
    history: '更新记录',
    settings: '设置',
    updatesBadge: '{count} 个可用更新'
  },
  env: {
    label: 'Homebrew',
    checking: '正在检测…',
    checkingHint: '读取本机 Homebrew 环境',
    ready: 'Homebrew 可用',
    noBrew: '未安装 Homebrew',
    noBrewHint: '点击开始安装',
    version: '{version} · {arch}',
    mirrors: {
      official: '官方源',
      tuna: '清华 TUNA 镜像',
      ustc: '中科大 USTC 镜像',
      aliyun: '阿里云镜像'
    }
  },
  toolbar: {
    back: '后退',
    forward: '前进',
    search: '搜索 {count} 个 App',
    searchShort: '搜索 App',
    taskRunning: '{action} {name}',
    taskQueued: '另有 {count} 个排队'
  },
  rail: {
    title: '概览',
    subtitle: '本机 Homebrew 状态',
    installed: '已安装',
    updates: '可更新',
    updatesHint: '下载约 {size}',
    updatesNone: '全部是最新',
    disk: '磁盘占用',
    diskHint: '含缓存 {size}',
    lastCheck: '上次检查',
    lastCheckAuto: '每天 {time} 自动',
    lastCheckManual: '未开启自动检查',
    never: '尚未检查',
    weeklyTop: '本周热门',
    weeklyTopHint: '近 30 天 App 安装量'
  },
  common: {
    empty: '暂无内容',
    refreshFailed: '部分内容加载失败，已保留上次成功加载的内容。',
    notFound: '内容不存在或已下架',
    loadMore: '加载更多',
    viewAll: '查看全部',
    viewRankings: '查看排行榜',
    retry: '重试',
    loading: '正在加载…',
    more: '更多操作',
    copy: '复制',
    copied: '已复制',
    cancel: '取消',
    close: '关闭',
    count: '{count} 个'
  },
  offline: {
    title: '无法连接 OpenNavo 服务',
    description: '正在显示本地目录；截图、版本记录与合集需要联网后查看。'
  },
  discover: {
    featured: '本周精选',
    viewDetails: '查看详情',
    allCategories: '全部',
    categoriesLabel: '分类',
    popularApps: '热门 App',
    popularAppsHint: '近 30 天 Homebrew 安装量',
    recentlyUpdated: '最近更新',
    recentlyUpdatedHint: '最近发布新版本的 App',
    collections: '合集',
    installCollection: '一键安装合集',
    collectionCount: '{title} {count} 款'
  },
  categories: {
    title: '分类',
    subtitle: '{count} 个分类，按用途浏览',
    packages: '{count} 个',
    empty: '这个分类下还没有包',
    sortLabel: '排序',
    sorts: {
      popular: '热门',
      updated: '最近更新',
      name: '名称'
    }
  },
  rankings: {
    title: '排行榜',
    subtitle: '按 Homebrew 官方安装统计，每天更新',
    periodLabel: '统计周期',
    periods: {
      installs30d: '30 天',
      installs90d: '90 天',
      installs365d: '一年'
    },
    noStats: '暂无统计'
  },
  search: {
    title: '搜索',
    results: '「{q}」的 {count} 个结果',
    empty: '没有找到「{q}」',
    emptyHint: '换个关键词，或试试英文名、拼音缩写',
    alias: '别名：{name}',
    prompt: '输入名称、用途或命令开始搜索'
  },
  collections: {
    title: '合集',
    subtitle: '编辑挑选的软件组合，一次装好',
    empty: '还没有合集',
    items: '{count} 款',
    install: '一键安装合集',
    installTitle: '安装合集「{title}」',
    installDescription: '将依次安装 {count} 个包，已安装的会跳过。',
    installConfirm: '开始安装',
    allInstalled: '合集里的包都已安装',
    installed: '已安装',
    queued: '已加入队列：{count} 个',
    offline: '合集需要联网后查看'
  },
  package: {
    arch: {
      arm64: 'Apple 芯片',
      x86_64: 'Intel'
    },
    autoUpdates: '自带更新',
    disabled: '已停用',
    deprecated: '已弃用',
    homepage: '主页',
    fromTap: '来自',
    stats: {
      label: '数据',
      installs30d: '近 30 天安装',
      rank: '{kind}榜第 {rank}',
      installs365d: '近一年安装',
      total365: '365 天累计',
      latest: '最新版本',
      size: '下载大小',
      cadence: '更新节奏',
      releases30d: '近 30 天 {count} 个版本'
    },
    cadence: {
      daily: '每天',
      weekly: '每周',
      biweekly: '每两周',
      monthly: '每月',
      irregular: '不定期'
    },
    tabs: {
      label: '详情页签',
      overview: '概览',
      versions: '版本记录',
      dependencies: '依赖与冲突',
      details: '安装细节'
    },
    disabledNotice: 'Homebrew 已停用此包：{reason}',
    deprecatedNotice: 'Homebrew 已弃用此包：{reason}',
    noReason: '未说明原因',
    replacement: '替代：{token}',
    release: {
      new: '新版本',
      title: '{version} 更新内容',
      translated: '已译为中文',
      source: {
        github_release: '来自 GitHub Release',
        sparkle: '来自应用内更新源',
        webpage: '来自官网更新页',
        manual: '人工整理',
        editorial: 'OpenNavo 编辑',
        homebrew: '来自 Homebrew 提交记录'
      },
      viewAll: '查看全部 {count} 个版本',
      noNotes: '这个版本没有单独的更新说明。',
      emptyTitle: '还没有版本记录',
      prerelease: '预发布',
      filterLabel: '版本筛选',
      filterAll: '全部 {count}',
      filterWithNotes: '有更新说明 {count}',
      filterMine: '我装过的 {count}',
      languageLabel: '正文语言',
      languageTranslated: '中文',
      languageOriginal: '原文',
      mineEmpty: '已加载的版本里没有你装过的',
      count30d: '近 30 天',
      count30dUnit: '个版本',
      cadenceHint: {
        daily: '几乎每天发布',
        weekly: '大约每周发布',
        biweekly: '大约两周发布一次',
        monthly: '大约每月发布',
        irregular: '发布时间不固定'
      },
      brewLabel: 'Homebrew 收录',
      brewSync: '≈ 同步',
      brewLater: '晚 {time}',
      brewEarlier: '早 {time}',
      brewHint: '{earlier}/{compared} 个早于上游',
      lagMinutes: '{n} 分钟',
      lagHours: '{n} 小时',
      lagDays: '{n} 天',
      sourcesTitle: '数据来源',
      sourceInfo: {
        webpage: {
          title: '官网更新页',
          body: '从开发者官网的更新说明页提取要点'
        },
        github_release: {
          title: 'GitHub Releases',
          body: '项目在 GitHub 发布的版本说明与发布时间'
        },
        sparkle: {
          title: '应用内更新源',
          body: 'App 内置更新检查使用的 Sparkle appcast'
        },
        manual: { title: '人工整理', body: '编辑根据官方公告整理' },
        editorial: {
          title: 'OpenNavo 编辑',
          body: 'OpenNavo 根据官方信息撰写的更新说明'
        },
        homebrew: {
          title: 'Homebrew 提交记录',
          body: 'Homebrew 仓库里该包的版本更新提交，得到收录时间'
        },
        local: { title: '本机记录', body: '你在 OpenNavo 里的每次安装和更新' }
      },
      localUpgrade: '你在 {time} 通过 OpenNavo 从 {from} 更新到此版本 · 用时 {duration}',
      localInstall: '你在 {time} 通过 OpenNavo 安装了此版本 · 用时 {duration}',
      notify: '有新版本时通知我',
      notifyHint: '所有 App 共用 · 系统通知 + 菜单栏角标',
      pin: '固定在当前版本',
      pinHint: '等同 brew pin，「全部更新」时跳过',
      pinHintSelfUpdate: '等同 brew pin；但 {name} 自带的更新器仍可能自行升级'
    },
    monthly: {
      title: '月均安装量',
      d30: '近 30 天',
      avg90: '近 90 天月均',
      avg365: '近一年月均',
      full: '{count} 次',
      trend: {
        rising: '近期安装在增长',
        slowing: '近期安装在放缓，多数老用户靠应用自带更新升级',
        steady: '安装量保持稳定'
      }
    },
    related: '相似应用',
    screenshots: '截图',
    caveats: '注意事项',
    info: {
      homepage: '主页',
      binaries: '附带命令',
      autoUpdates: '自动更新',
      autoYes: '应用自带（auto_updates）',
      autoNo: '由 Homebrew 更新',
      uninstall: '卸载时',
      arch: '架构',
      minMacos: '最低系统',
      license: '许可证'
    },
    deps: {
      macos: '系统要求',
      formulae: '依赖的命令行工具',
      casks: '依赖的 App',
      emptyTitle: '没有依赖',
      emptyDescription: '安装时不会附带安装其他包。',
      runtime: '运行时依赖',
      build: '构建依赖',
      other: '其他：',
      type: {
        runtime: '运行时',
        build: '构建',
        test: '测试',
        optional: '可选',
        recommended: '推荐',
        usesFromMacos: '使用系统自带',
        cask: 'App'
      },
      conflicts: '冲突',
      dependents: '被 {count} 个包依赖'
    },
    details: {
      tap: '来源仓库',
      names: '其他名称',
      location: '安装位置',
      pkgs: '安装包',
      kegOnly: 'keg-only',
      kegOnlyValue: '不链接到 /opt/homebrew，需要手动加入 PATH',
      download: '下载地址',
      source: 'Homebrew 定义文件',
      repo: '源代码'
    },
    installed: '已安装 {version}',
    installedSelfUpdated: '已安装 {version}（应用已自行更新）',
    installedAt: '安装于 {date}',
    updateTo: '更新到 {version}',
    open: '打开',
    getNeedsBrew: '先安装 Homebrew',
    actions: {
      label: '更多操作',
      uninstall: '卸载',
      reinstall: '重新安装',
      pin: '固定版本',
      unpin: '取消固定',
      reveal: '在访达中显示',
      copyCommand: '复制 brew 命令',
      web: '在网页上查看'
    },
    uninstallConfirm: {
      title: '卸载 {name}？',
      description: '将执行 {command}。',
      zap: '同时删除应用数据（--zap）',
      confirm: '卸载'
    },
    commandCopied: '已复制 brew 命令',
    offline: '联网后可查看截图与更多信息',
    notFound: '本地目录里没有这个包',
    pinned: '已固定',
    localSince: '你在 {date} 更新到此版本'
  },
  library: {
    title: '已安装',
    summary: '{count} 项 · 占用 {size}',
    summaryCount: '{count} 项',
    filterPlaceholder: '筛选已安装…',
    refresh: '刷新',
    empty: '还没有通过 Homebrew 安装的软件',
    emptyFiltered: '没有符合条件的项目',
    columns: {
      name: '名称',
      version: '版本',
      size: '大小',
      installedAt: '安装于',
      status: '状态',
      actions: '操作'
    },
    status: {
      installed: '已安装',
      latest: '最新',
      outdated: '可更新',
      pinned: '已固定',
      selfUpdated: '最新（应用已自行更新）',
      running: '更新中 {percent}',
      runningUnknown: '处理中',
      queued: '排队中',
      unknown: '未知'
    },
    dependency: '依赖 · 被 {names} 使用',
    storage: {
      title: '存储',
      total: '共 {size}',
      caption: '磁盘占用',
      apps: 'App',
      cache: '下载缓存'
    },
    cleanup: {
      title: '清理缓存',
      description: '旧版本和下载缓存，等同 brew cleanup。',
      button: '释放 {size}',
      none: '没有可清理的缓存'
    },
    backup: {
      title: '备份与迁移',
      description: '把所有包导出为 Brewfile，换新 Mac 时一键恢复。',
      export: '导出',
      restore: '恢复',
      exported: '已导出 {count} 个包'
    },
    restore: {
      title: '从 Brewfile 恢复',
      summary: '可安装 {ready} 个 · 已安装 {installed} 个 · 暂不支持 {unsupported} 个',
      install: '安装 {count} 个',
      status: {
        ready: '可安装',
        installed: '已安装',
        skipped: '无需操作',
        unsupported: '暂不支持',
        invalid: '无效',
        not_found: '找不到'
      }
    },
    health: {
      title: '健康检查',
      ok: 'brew doctor 没有发现问题',
      warnings: '{count} 条警告',
      run: '运行检查',
      running: '正在检查…'
    }
  },
  updates: {
    title: '更新',
    summary: '{count} 个可用更新 · 下载约 {size}',
    summaryNone: '全部是最新',
    lastCheck: '上次检查 {time}',
    check: '检查更新',
    checking: '正在检查…',
    updateAll: '全部更新',
    changelog: '更新内容',
    update: '更新',
    ignore: '忽略此版本',
    ignored: '已忽略 {name} {version}',
    pinned: '已固定，不会更新',
    patch: '补丁',
    empty: '所有软件都是最新的',
    emptyHint: '有新版本时会在这里列出',
    queued: '已加入队列：{count} 个',
    history: {
      title: '更新记录',
      subtitle: '本机 · 近 30 天 {count} 次',
      filterLabel: '结果',
      all: '全部',
      succeeded: '成功',
      failed: '失败',
      today: '今天 · {date}',
      yesterday: '昨天 · {date}',
      viewLog: '查看日志',
      retry: '重试',
      canceled: '已取消',
      batch: '{action} {count} 个{kind}',
      empty: '还没有更新记录'
    },
    month: {
      title: '本月',
      since: '{date} 至今',
      updated: '已更新',
      updatedUnit: '次',
      successRate: '成功率',
      successHint: '失败 {count} 次'
    },
    auto: {
      title: '自动更新',
      subtitle: '由后台助手按计划执行',
      check: '每天 {time} 检查',
      checkHint: 'brew update + outdated',
      casks: '自动安装 App 更新',
      casksHint: '关闭时只发通知',
      greedy: '包含自带更新的 App',
      greedyHint: '等同 --greedy'
    },
    mirror: {
      switch: '切换',
      latency: '全部走镜像 · {ms} ms'
    },
    next: {
      today: '今天 {time}',
      tomorrow: '明天 {time}',
      title: '下次检查',
      text: '{time}。若 Mac 处于睡眠，唤醒后补做检查。',
      off: '自动检查已关闭，可以在设置中开启。'
    },
    log: {
      title: '{name} 的日志',
      empty: '没有日志'
    }
  },
  history: {
    clear: '清空记录',
    clearDescription: '确定清空全部更新记录吗？此操作不可恢复，不影响已安装的 App 和正在进行的任务。',
    cleared: '更新记录已清空',
    title: '更新记录',
    subtitle: '本机所有安装、更新与卸载',
    search: '按名称筛选',
    exportCsv: '导出 CSV',
    exported: '已导出 {count} 条记录',
    empty: '还没有记录',
    duration: '{time}'
  },
  settings: {
    title: '设置',
    sections: {
      general: '通用',
      mirrors: '下载源',
      homebrew: 'Homebrew',
      privacy: '隐私',
      about: '关于'
    },
    general: {
      followSystem: '跟随系统（当前：{language}）',
      systemDialogsRestartHint: '系统对话框重启后切换语言。',
      language: '界面语言',
      launchAtLogin: '登录时启动',
      launchAtLoginHint: '启动后只显示菜单栏图标',
      keepInMenuBar: '关闭窗口后留在菜单栏',
      trayShowCount: '菜单栏显示可更新数量',
      notifyUpdates: '有可用更新时发通知',
      zapByDefault: '卸载时默认同时删除应用数据',
      zapByDefaultHint: '等同 brew uninstall --zap',
      updates: '检查更新',
      autoCheck: '每天自动检查更新',
      checkTime: '检查时间',
      runBrewUpdate: '检查前先更新 Homebrew 索引',
      runBrewUpdateHint: 'brew update'
    },
    mirrors: {
      title: '下载源',
      description: '同时作用于 API 元数据、Bottle 二进制包和 brew 自身的 Git 仓库。',
      copyEnv: '复制终端环境变量',
      envCopied: '已复制，可粘贴到终端或 shell 配置',
      envHint: '只影响 OpenNavo 发起的 brew；需要在终端里使用同一个源时复制下面的变量。'
    },
    homebrew: {
      path: 'brew 路径',
      auto: '自动检测',
      version: '版本',
      prefix: '安装前缀',
      analytics: '向 Homebrew 发送匿名统计',
      analyticsFollow: '跟随 brew 自身的设置',
      analyticsOff: '关闭（HOMEBREW_NO_ANALYTICS=1）',
      missing: '没有找到 Homebrew',
      install: '安装 Homebrew'
    },
    privacy: {
      crashReports: '发送匿名崩溃报告',
      crashReportsHint: '默认关闭；开启后只上传崩溃时的调用栈',
      appManagement: 'App 管理',
      appManagementHint: '更新和卸载 App 时需要',
      fullDiskAccess: '完全磁盘访问权限',
      fullDiskAccessHint: '卸载时一并删除应用数据需要',
      enable: '开启',
      waiting: '等待开启…',
      granted: '已开启',
      denied: '未开启',
      unknown: '无法检测',
      clearSearch: '清除最近搜索'
    },
    about: {
      openSource: '开源帮助',
      view: '查看',
      draft: '待审',
      version: '版本 {version}',
      website: '网站',
      feedback: '反馈问题',
      privacy: '隐私说明',
      catalog: '本地目录：{count} 个包，同步于 {time}',
      sync: '立即同步'
    },
    saved: '已保存'
  },
  mirrors: {
    official: '官方源',
    probe: '重新测速',
    probing: '正在测速…',
    fastest: '最快',
    recommended: '推荐',
    unavailable: '不可用',
    configFailed: '暂时拿不到镜像列表，现在只能使用官方源。',
    slowOfficial: '官方源响应较慢（{official}），{name} 只需 {latency}。',
    failedOfficial: '官方源无法连接，{name} 可以连接（{latency}）。',
    useSuggested: '改用{name}',
    selectedFailed: '所选下载源测速失败，安装可能会失败。'
  },
  welcome: {
    title: '欢迎使用 OpenNavo',
    subtitle: '开始前先检查一下这台 Mac，只需几秒。',
    checks: '环境检测',
    checking: '正在检测…',
    detectFailed: '检测没有完成。',
    redetect: '重新检测',
    macos: 'macOS {version} · {arch}',
    macosOk: '符合要求',
    clt: 'Xcode 命令行工具',
    cltOk: '已安装',
    cltMissing: '安装 Homebrew 时会一并安装',
    homebrew: 'Homebrew',
    homebrewOk: '{version} · {prefix}',
    homebrewMissing: '未找到，{prefix} 为空',
    source: {
      title: '下载源',
      official: '官方源安装',
      mirror: '其他镜像安装',
      mirrorMissing: '暂时拿不到镜像列表',
      retry: '重试',
      hint: '之后的安装和更新也会使用这个下载源，可以在「设置 → 下载源」里换成其他镜像。',
      hintBrew: 'OpenNavo 安装和更新 App 时使用这个下载源，不读取终端里设置的镜像变量。'
    },
    install: '安装 Homebrew',
    passwordHint: '安装需要管理员密码，系统会弹出对话框；OpenNavo 不会保存密码。',
    skip: '跳过，先随便看看',
    failed: {
      title: 'Homebrew 没有装好',
      E_SUDO: '没有输入管理员密码，安装已取消。',
      E_DOWNLOAD: '安装脚本下载失败，可以换一个下载源再试。',
      viewLog: '查看日志',
      logTitle: '安装 Homebrew 的日志'
    },
    permissions: {
      title: '权限',
      required: '必需',
      optional: '可选',
      enable: '开启',
      waiting: '等待开启…',
      granted: '已开启',
      confirm: '我已开启',
      startHint: '开启「App 管理」后即可开始使用。',
      appManagement: {
        title: '允许 OpenNavo 管理 App',
        body: '更新和卸载 App 时需要。',
        enable: '开启 App 管理'
      },
      fullDiskAccess: {
        title: '完全磁盘访问权限',
        body: '卸载时一并删除应用数据需要，可以以后再开。',
        enable: '开启完全磁盘访问权限'
      }
    },
    done: '开始使用',
    arch: {
      arm64: 'Apple 芯片',
      x86_64: 'Intel'
    }
  },
  permission: {
    relaunch: {
      body: '已在系统设置中开启，重新打开 OpenNavo 后生效。',
      action: '重新打开'
    },
    guide: {
      appManagement: 'App 管理',
      fullDiskAccess: '完全磁盘访问权限',
      dragTitle: '把 OpenNavo 拖到上方的列表',
      plusTitle: '点按列表下方的「+」，选择 OpenNavo',
      toggleHint: '列表里已有 OpenNavo 时，打开它旁边的开关即可。',
      dragLabel: '拖动 OpenNavo 图标',
      close: '关闭',
      done: {
        appManagement: '已允许 OpenNavo 管理 App',
        fullDiskAccess: '已开启完全磁盘访问权限'
      },
      doneHint: '如果系统提示「退出并重新打开」，点它即可。'
    },
    prompt: {
      appManagement: {
        title: '需要允许 OpenNavo 管理 App',
        body: 'macOS 阻止了 OpenNavo 修改下面的 App。开启「App 管理」后重试。'
      },
      fullDiskAccess: {
        title: '需要完全磁盘访问权限',
        body: '下面的 App 已经移除，但应用数据还没删：删除这些数据需要「完全磁盘访问权限」。开启后重试即可完成卸载。'
      },
      enable: '开启',
      waiting: '等待开启…',
      retry: '重试',
      retryAll: '全部重试',
      later: '稍后'
    },
    uninstall: {
      title: '删除应用数据需要「完全磁盘访问权限」',
      body: '开启后再卸载；也可以取消勾选，只卸载 App。'
    }
  },
  deeplink: {
    installTitle: '安装 {name}？',
    installDescription: '网页请求在这台 Mac 上安装它。确认后将执行下面的命令；取消则不做任何操作。',
    installConfirm: '安装',
    formulaUnsupported: 'OpenNavo 只收录 App（Homebrew Cask），这个链接指向的是命令行工具。'
  },
  tray: {
    available: '{count} 个可用更新',
    upToDate: '全部是最新的',
    upToDateHint: '有新版本时会显示在这里',
    running: {
      upgrade: '正在更新 {name}',
      install: '正在安装 {name}',
      uninstall: '正在卸载 {name}',
      other: '正在处理 {name}'
    },
    queued: '另有 {count} 个任务排队',
    update: '更新',
    updateAll: '全部更新（{count}）',
    more: '还有 {count} 个，在 OpenNavo 中查看',
    open: '打开 OpenNavo',
    settings: '设置',
    queuedToast: '已加入队列'
  },
  quit: {
    title: '还有 {n} 个任务没有完成',
    description: '退出会中断正在进行的安装，已完成的不受影响。',
    confirm: '仍要退出',
    cancel: '继续运行'
  },
  restore: {
    title: '上次有 {n} 个任务没有完成',
    description: '继续会按原来的顺序执行；放弃会取消这些任务。',
    resume: '继续',
    discard: '放弃'
  },
  updater: {
    title: '客户端更新',
    current: '当前版本 {version}',
    check: '检查更新',
    latest: '已是最新版本',
    available: '新版本 {version}',
    install: '下载并安装',
    downloading: '正在下载 {percent}',
    installed: '已安装，重新启动后生效',
    restart: '重新启动',
    busy: '有任务正在进行，完成后再重新启动',
    failed: '检查更新失败'
  },
  palette: {
    placeholder: '搜索 App 或操作',
    apps: 'App',
    actions: '操作',
    navigation: '跳转',
    open: '打开',
    install: '安装',
    update: '更新 {name}',
    reveal: '在访达中显示 {name}',
    viewAll: '查看「{q}」的全部结果',
    goTo: '前往{page}',
    installedVersion: '已安装 {version}',
    updatable: '可更新',
    copied: '已复制 {command}'
  },
  tasks: {
    ops: {
      install: '安装',
      upgrade: '更新',
      uninstall: '卸载',
      reinstall: '重新安装',
      pin: '固定版本',
      unpin: '取消固定',
      cleanup: '清理缓存',
      update: '更新 Homebrew',
      install_homebrew: '安装 Homebrew'
    },
    running: {
      install: '正在安装 {name}',
      upgrade: '正在更新 {name}',
      uninstall: '正在卸载 {name}',
      reinstall: '正在重新安装 {name}',
      pin: '正在固定 {name}',
      unpin: '正在取消固定 {name}',
      cleanup: '正在清理缓存',
      update: '正在更新 Homebrew',
      install_homebrew: '正在安装 Homebrew'
    },
    phases: {
      preparing: '准备',
      fetching: '获取信息',
      downloading: '下载',
      installing: '安装',
      linking: '链接',
      cleaning: '清理',
      uninstalling: '卸载',
      updating: '更新索引',
      finishing: '完成'
    },
    step: '第 {index} 步，共 {count} 步：{phase}',
    remaining: '剩余约 {time}',
    queue: '排队中',
    oneAtATime: 'brew 一次只运行一个任务',
    triggers: {
      manual: '手动',
      schedule: '自动',
      deeplink: '网页',
      bundle: '批量',
      retry: '重试'
    },
    succeeded: '{name} {action}完成',
    failed: '{name} {action}失败'
  },
  errors: {
    E_APP_RUNNING: '应用正在运行，已暂缓更新；退出后可再次更新',
    E_APP_QUIT_FAILED: '应用未退出，已暂缓更新；请保存工作并退出后重试',
    E_APP_CHECK_FAILED: '无法检查应用运行状态，已暂缓更新；请刷新已安装列表后重试',

    actionFailed: '操作没有完成',
    E_BREW_NOT_FOUND: '需要先安装 Homebrew',
    E_INVALID_ARG: '参数无效',
    E_CHECKSUM: '下载中断：SHA-256 校验不一致',
    E_DOWNLOAD: '下载失败，请检查网络或切换下载源',
    E_APP_EXISTS: '安装位置已存在同名 App，本次操作未完成；请查看日志。安装任务重试时会重新检查并请求接管确认',
    E_NOT_FOUND: '在 Homebrew 中找不到这个包',
    E_DISABLED: 'Homebrew 已停用此包',
    E_LOCKED: '另一个 Homebrew 进程正在运行，稍后自动重试',
    E_PERMISSION: '没有权限修改该 App，需要在系统设置中允许',
    E_FULL_DISK_ACCESS: '删除应用数据需要「完全磁盘访问权限」',
    E_SUDO: '需要管理员密码',
    E_MACOS_VERSION: '系统版本不满足要求',
    E_REQUIRED_BY: '有其他包依赖它，不能卸载',
    E_CONFLICT: '与已安装的包冲突',
    E_INTERRUPTED: '任务被中断',
    E_TIMEOUT: '长时间没有响应',
    E_UNKNOWN: '操作失败，可以查看日志',
    E_NETWORK: '无法连接 OpenNavo 服务'
  },
  installConfirm: {
    title: '接管现有 {name}？',
    description: '检测到安装位置已存在 App。确认后将尝试交由 Homebrew 管理，成功后可通过 OpenNavo 更新和卸载。',
    matchHint: '只有现有应用与安装包内容一致时才能接管；不一致时会失败，不会强制覆盖。',
    confirm: '确认接管',
    blockedTitle: '暂时无法安装 {name}',
    blockedDescription: '无法确认安装位置或现有应用的状态。未执行安装或接管，请检查应用与安装信息后重试。'
  },
  runningApps: {
    title: '应用正在运行',
    description: '请先保存工作，再退出应用进行更新。',
    batchDescription: '以下应用正在运行，请先保存工作。你可以跳过这些应用，或退出后一起更新。',
    later: '稍后',
    skip: '跳过这些应用',
    quit: '退出并更新',
    quitAll: '退出这些应用并更新',
    reopen: '更新成功后重新打开',
    quitHint: '如果应用未退出或你取消退出，将暂缓该项更新，不会强制关闭。',
    deferred: '已暂缓'
  },
  page: {
    comingSoon: '页面内容在后续任务中接入。'
  }
};
