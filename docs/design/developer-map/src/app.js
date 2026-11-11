/* OpenNavo · Developer Map proposal · vanilla JS, no dependencies. */
(() => {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const SVG_W = 1000;
  const SVG_H = 420;
  const LAT_TOP = 84;
  const LAT_BOT = -56;

  const fmt = (n) => n.toLocaleString('zh-CN');

  const fmtCompact = (n) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(n >= 10000000 ? 0 : 1)}M`;
    if (n >= 1000) return `${Math.round(n / 1000)}K`;
    return String(n);
  };

  const pad2 = (n) => String(n).padStart(2, '0');

  const shade = (hex, amount) => {
    const value = hex.replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const num = parseInt(full, 16);
    const ch = [(num >> 16) & 255, (num >> 8) & 255, num & 255].map((c) =>
      Math.max(0, Math.min(255, Math.round(c + 255 * amount)))
    );
    return `#${ch.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
  };

  /* ---------------------------------------------------------------- data */

  const APPS = {
    codex: {
      name: 'Codex',
      summary: '在终端中理解代码、修改项目并运行测试的 OpenAI 开源 AI 编程助手。',
      installs: '99,604',
      version: '0.161.0',
      icon: 'openai',
      tile: '#F4F4F4',
      fg: '#141414',
      pad: 8
    },
    'claude-code': {
      name: 'Claude Code',
      summary: 'Anthropic 的 AI 编程助手，在终端中理解代码库、修改文件、运行命令。',
      installs: '32,347',
      version: '2.1.285',
      icon: 'claude',
      tile: '#F6EFE7',
      fg: '#D97757',
      pad: 8
    },
    gcloud: {
      name: 'Google Cloud CLI',
      summary: '管理 Google Cloud 项目、云资源和应用的命令行工具集。',
      installs: '28,769',
      version: '588.0.0',
      icon: 'gcloud',
      tile: '#FFFFFF',
      pad: 6
    },
    libreoffice: {
      name: 'LibreOffice',
      summary: '免费开源的跨平台办公套件，包含文字处理、电子表格、演示和绘图。',
      installs: '29,205',
      version: '26.8.0',
      icon: 'libreoffice',
      tile: '#F4F4F4',
      fg: '#18A303',
      pad: 8
    },
    'android-sdk': {
      name: 'Android SDK Platform-Tools',
      summary: 'Google 的命令行工具，用于连接 Android 设备、调试应用、传输文件。',
      installs: '25,209',
      version: '37.0.1',
      icon: 'android',
      tile: '#F4F4F4',
      pad: 7
    },
    docker: {
      name: 'Docker Desktop',
      summary: '使用桌面仪表板、Docker CLI、Compose 和集成的本地开发环境。',
      installs: '22,172',
      version: '4.94.0',
      icon: 'docker',
      tile: '#FFFFFF',
      pad: 5
    },
    librewolf: {
      name: 'LibreWolf',
      summary: 'Community Firefox-based browser with privacy-focused defaults.',
      installs: '1,216',
      version: '157.0.1',
      icon: 'librewolf',
      tile: '#EFF4FA',
      fg: '#00A0FF',
      pad: 8
    },
    maestri: {
      name: 'Maestri',
      summary: 'Canvas for agent orchestration.',
      installs: '31',
      version: '0.50.0',
      letter: 'M',
      tileFrom: '#7C5CFF',
      tileTo: '#4B2FC4'
    },
    masscode: {
      name: 'massCode',
      summary: 'Developer workspace for code snippets, notes and HTTP requests.',
      installs: '38',
      version: '6.1.0',
      letter: 'M',
      tileFrom: '#F2A25C',
      tileTo: '#C9772F'
    },
    melodics: {
      name: 'Melodics',
      summary: 'Helps you learn to play your instrument.',
      installs: '5',
      version: '5.0.1553',
      letter: 'M',
      tileFrom: '#3EDC84',
      tileTo: '#159A46'
    },
    ollama: {
      name: 'Ollama',
      summary: '用于运行和管理支持 AI 模型的桌面聊天、CLI 和本地 API。',
      installs: '4,766',
      version: '0.40.1',
      icon: 'ollama',
      tile: '#F4F4F4',
      fg: '#161616',
      pad: 7
    },
    'ollama-cli': {
      name: 'Ollama CLI',
      summary: 'Ollama 命令行发行版，用于运行开放模型、管理本地推理并提供 REST API。',
      installs: '185',
      version: '0.40.1',
      letter: '>_',
      mono: true,
      tileFrom: '#3B3B3B',
      tileTo: '#1B1B1B'
    },
    ghostty: {
      name: 'Ghostty',
      summary: 'Fast, native terminal emulator with a focused, minimal interface.',
      installs: '3,102',
      version: '1.3.1',
      icon: 'ghostty',
      tile: '#1C1C1C',
      fg: '#EDEDED',
      pad: 8
    },
    vscode: {
      name: 'Visual Studio Code',
      summary: 'Code editing. Redefined.',
      installs: '88,120',
      version: '1.140.1',
      icon: 'vscode',
      tile: '#FFFFFF',
      pad: 2
    },
    warp: {
      name: 'Warp',
      summary: 'The agentic development environment.',
      installs: '12,480',
      version: '0.2026.01',
      icon: 'warp',
      tile: '#10363F',
      fg: '#2EE6C5',
      pad: 7
    },
    raycast: {
      name: 'Raycast',
      summary: 'Your shortcut to everything.',
      installs: '46,200',
      version: '1.99.0',
      icon: 'raycast',
      tile: '#2A1919',
      fg: '#FF6363',
      pad: 7
    }
  };

  const POPULAR = ['codex', 'claude-code', 'gcloud', 'libreoffice', 'android-sdk', 'docker'];
  const RECENT = ['librewolf', 'maestri', 'masscode', 'melodics', 'ollama', 'ollama-cli'];
  const WEEKLY = [
    { key: 'codex', value: '10万' },
    { key: 'claude-code', value: '3.2万' },
    { key: 'libreoffice', value: '2.9万' },
    { key: 'gcloud', value: '2.9万' }
  ];
  const COLLECTIONS = [
    {
      title: '独立开发者的 Mac 工具箱',
      sub: '编辑器、终端、数据库和一点点魔法。',
      count: 18,
      apps: ['vscode', 'ghostty', 'docker', 'ollama', 'raycast']
    },
    {
      title: 'AI 编程工作流',
      sub: '从补全到 Agent，把 AI 放进每天的开发循环。',
      count: 12,
      apps: ['codex', 'claude-code', 'ollama', 'warp']
    },
    {
      title: '终端里的生产力',
      sub: 'Shell、CLI，以及让命令行更好用的工具。',
      count: 9,
      apps: ['ghostty', 'ollama-cli', 'docker', 'gcloud', 'vscode']
    }
  ];

  const DEVELOPER_PICKS = [
    {
      key: 'ghostty',
      by: 'Ghostty 团队',
      place: '美国 · 西雅图',
      when: '本周新上架',
      quote: '我们把 Ghostty 做成一个原生、快速的终端，希望更多 Mac 用户能用上。'
    },
    {
      key: 'maestri',
      by: 'Maestri 团队',
      place: '美国 · 旧金山',
      when: '本周新上架',
      quote: 'Maestri 是为 agent 工作流做的画布，开发者精选让它被更多人看到。'
    },
    {
      key: 'masscode',
      by: 'massCode 团队',
      place: '德国 · 柏林',
      when: '已认领',
      quote: '代码片段、笔记和 API 请求都在一个地方，欢迎来试试。'
    }
  ];

  const CITIES = [
    {
      key: 'bay-area',
      name: '旧金山湾区',
      country: '美国',
      cc: 'US',
      region: 'americas',
      lat: 37.77,
      lng: -122.42,
      devs: 342,
      apps: 486,
      installs: 1824000,
      label: 'end',
      top: [
        { n: 'Anthropic', a: 2, c: '#D97757' },
        { n: 'OpenAI', a: 3, c: '#10A37F' },
        { n: 'Google', a: 4, c: '#4285F4' },
        { n: 'GitHub', a: 2, c: '#6E7681' },
        { n: 'Figma', a: 1, c: '#F24E1E' },
        { n: 'Notion', a: 1, c: '#EDEDED', dark: true }
      ]
    },
    {
      key: 'seattle',
      name: '西雅图',
      country: '美国',
      cc: 'US',
      region: 'americas',
      lat: 47.606,
      lng: -122.332,
      devs: 108,
      apps: 143,
      installs: 1208000,
      label: 'start',
      top: [
        { n: 'Microsoft', a: 6, c: '#2F6FED' },
        { n: 'Amazon', a: 3, c: '#FF9900' }
      ]
    },
    {
      key: 'london',
      name: '伦敦',
      country: '英国',
      cc: 'GB',
      region: 'europe',
      lat: 51.507,
      lng: -0.128,
      devs: 82,
      apps: 96,
      installs: 412000,
      label: 'middle-above',
      top: [
        { n: 'Raycast', a: 1, c: '#FF6363' },
        { n: 'Snyk', a: 2, c: '#4C4A73' },
        { n: 'Monzo', a: 1, c: '#FF4F40' }
      ]
    },
    {
      key: 'beijing',
      name: '北京',
      country: '中国',
      cc: 'CN',
      region: 'apac',
      lat: 39.904,
      lng: 116.407,
      devs: 68,
      apps: 84,
      installs: 386000,
      label: 'start',
      top: [
        { n: 'ByteDance', a: 4, c: '#1F1F1F', dark: true },
        { n: 'Xiaomi', a: 2, c: '#FF6900' },
        { n: 'Baidu', a: 2, c: '#2932E1' }
      ]
    },
    {
      key: 'tokyo',
      name: '东京',
      country: '日本',
      cc: 'JP',
      region: 'apac',
      lat: 35.676,
      lng: 139.65,
      devs: 60,
      apps: 71,
      installs: 274000,
      label: 'start-below',
      top: [
        { n: 'LINE', a: 2, c: '#06C755' },
        { n: 'Rakuten', a: 1, c: '#BF0000' },
        { n: 'Sony', a: 1, c: '#1F1F1F', dark: true }
      ]
    },
    {
      key: 'sydney',
      name: '悉尼',
      country: '澳大利亚',
      cc: 'AU',
      region: 'apac',
      lat: -33.869,
      lng: 151.209,
      devs: 48,
      apps: 57,
      installs: 251000,
      label: 'start',
      top: [
        { n: 'Atlassian', a: 3, c: '#2681FF' },
        { n: 'Sublime HQ', a: 1, c: '#FF9800' },
        { n: 'Canva', a: 1, c: '#00C4CC' }
      ]
    },
    {
      key: 'prague',
      name: '布拉格',
      country: '捷克',
      cc: 'CZ',
      region: 'europe',
      lat: 50.075,
      lng: 14.438,
      devs: 44,
      apps: 52,
      installs: 196000,
      label: 'end',
      top: [
        { n: 'JetBrains', a: 5, c: '#FE315D' },
        { n: 'Avast', a: 2, c: '#FF7800' }
      ]
    },
    {
      key: 'kyiv',
      name: '基辅',
      country: '乌克兰',
      cc: 'UA',
      region: 'europe',
      lat: 50.45,
      lng: 30.523,
      devs: 38,
      apps: 44,
      installs: 171000,
      label: 'start',
      top: [
        { n: 'MacPaw', a: 4, c: '#FF6B35' },
        { n: 'Readdle', a: 3, c: '#E64B3C' }
      ]
    },
    {
      key: 'nyc',
      name: '纽约',
      country: '美国',
      cc: 'US',
      region: 'americas',
      lat: 40.713,
      lng: -74.006,
      devs: 36,
      apps: 48,
      installs: 168000,
      label: 'start',
      top: [
        { n: 'Warp', a: 1, c: '#01A4FF' },
        { n: 'MongoDB', a: 2, c: '#00ED64' }
      ]
    },
    {
      key: 'berlin',
      name: '柏林',
      country: '德国',
      cc: 'DE',
      region: 'europe',
      lat: 52.52,
      lng: 13.405,
      devs: 30,
      apps: 36,
      installs: 142000,
      label: 'start',
      top: [
        { n: 'Pitch', a: 1, c: '#FF4D4D' },
        { n: 'Ableton', a: 1, c: '#1F1F1F', dark: true },
        { n: 'Native Instruments', a: 1, c: '#FF5A00' }
      ]
    },
    {
      key: 'toronto',
      name: '多伦多',
      country: '加拿大',
      cc: 'CA',
      region: 'americas',
      lat: 43.653,
      lng: -79.383,
      devs: 28,
      apps: 33,
      installs: 130000,
      label: 'end',
      top: [
        { n: '1Password', a: 2, c: '#1A8CFF' },
        { n: 'Shopify', a: 1, c: '#95BF47' }
      ]
    },
    {
      key: 'paris',
      name: '巴黎',
      country: '法国',
      cc: 'FR',
      region: 'europe',
      lat: 48.857,
      lng: 2.352,
      devs: 26,
      apps: 31,
      installs: 121000,
      label: 'start',
      top: [
        { n: 'Dashlane', a: 1, c: '#0E353D' },
        { n: 'Algolia', a: 1, c: '#003DFF' }
      ]
    },
    {
      key: 'amsterdam',
      name: '阿姆斯特丹',
      country: '荷兰',
      cc: 'NL',
      region: 'europe',
      lat: 52.368,
      lng: 4.904,
      devs: 24,
      apps: 29,
      installs: 118000,
      label: 'start',
      top: [
        { n: 'Elastic', a: 3, c: '#005571' },
        { n: 'Adyen', a: 1, c: '#0ABF53' }
      ]
    },
    {
      key: 'vienna',
      name: '维也纳',
      country: '奥地利',
      cc: 'AT',
      region: 'europe',
      lat: 48.208,
      lng: 16.374,
      devs: 20,
      apps: 24,
      installs: 92000,
      label: 'end',
      top: [
        { n: 'Objective Development', a: 2, c: '#1F6FEB' },
        { n: 'fournova', a: 1, c: '#F5A623' }
      ]
    },
    {
      key: 'the-hague',
      name: '海牙',
      country: '荷兰',
      cc: 'NL',
      region: 'europe',
      lat: 52.07,
      lng: 4.301,
      devs: 18,
      apps: 21,
      installs: 76000,
      label: 'end',
      top: [{ n: 'Sketch', a: 1, c: '#FDB300' }]
    },
    {
      key: 'nottingham',
      name: '诺丁汉',
      country: '英国',
      cc: 'GB',
      region: 'europe',
      lat: 52.955,
      lng: -1.158,
      devs: 16,
      apps: 19,
      installs: 64000,
      label: 'start',
      top: [{ n: 'Serif', a: 3, c: '#1B72BE' }]
    },
    {
      key: 'seoul',
      name: '首尔',
      country: '韩国',
      cc: 'KR',
      region: 'apac',
      lat: 37.567,
      lng: 126.978,
      devs: 14,
      apps: 18,
      installs: 63000,
      label: 'start',
      top: [
        { n: 'Naver', a: 2, c: '#03C75A' },
        { n: 'Toss', a: 1, c: '#3182F6' }
      ]
    },
    {
      key: 'hangzhou',
      name: '杭州',
      country: '中国',
      cc: 'CN',
      region: 'apac',
      lat: 30.274,
      lng: 120.155,
      devs: 12,
      apps: 15,
      installs: 58000,
      label: 'start',
      top: [
        { n: 'Alibaba', a: 2, c: '#FF6A00' },
        { n: 'NetEase', a: 2, c: '#DE1616' }
      ]
    },
    {
      key: 'shenzhen',
      name: '深圳',
      country: '中国',
      cc: 'CN',
      region: 'apac',
      lat: 22.543,
      lng: 114.058,
      devs: 10,
      apps: 12,
      installs: 54000,
      label: 'start',
      top: [
        { n: 'Tencent', a: 3, c: '#0052D9' },
        { n: 'DJI', a: 1, c: '#1F1F1F', dark: true }
      ]
    },
    {
      key: 'melbourne',
      name: '墨尔本',
      country: '澳大利亚',
      cc: 'AU',
      region: 'apac',
      lat: -37.814,
      lng: 144.963,
      devs: 9,
      apps: 11,
      installs: 39000,
      label: 'start',
      top: [{ n: 'Envato', a: 1, c: '#81B441' }]
    },
    {
      key: 'chennai',
      name: '金奈',
      country: '印度',
      cc: 'IN',
      region: 'apac',
      lat: 13.083,
      lng: 80.27,
      devs: 8,
      apps: 9,
      installs: 33000,
      label: 'start',
      top: [
        { n: 'Zoho', a: 2, c: '#DC3E35' },
        { n: 'Freshworks', a: 1, c: '#00B4D8' }
      ]
    },
    {
      key: 'tel-aviv',
      name: '特拉维夫',
      country: '以色列',
      cc: 'IL',
      region: 'other',
      lat: 32.085,
      lng: 34.781,
      devs: 7,
      apps: 8,
      installs: 28000,
      label: 'start',
      top: [{ n: 'monday.com', a: 1, c: '#FF3D57' }]
    },
    {
      key: 'milan',
      name: '米兰',
      country: '意大利',
      cc: 'IT',
      region: 'europe',
      lat: 45.464,
      lng: 9.19,
      devs: 5,
      apps: 6,
      installs: 24000,
      label: 'start',
      top: [{ n: 'Bending Spoons', a: 2, c: '#7B61FF' }]
    },
    {
      key: 'stockholm',
      name: '斯德哥尔摩',
      country: '瑞典',
      cc: 'SE',
      region: 'europe',
      lat: 59.329,
      lng: 18.069,
      devs: 5,
      apps: 6,
      installs: 22000,
      label: 'end',
      top: [
        { n: 'Spotify', a: 1, c: '#1DB954' },
        { n: 'King', a: 1, c: '#FFC300' }
      ]
    }
  ];

  const COUNTRIES = [
    { cc: 'US', name: '美国', devs: 486, apps: 4210 },
    { cc: 'GB', name: '英国', devs: 98, apps: 356 },
    { cc: 'CN', name: '中国', devs: 90, apps: 388 },
    { cc: 'JP', name: '日本', devs: 60, apps: 274 },
    { cc: 'AU', name: '澳大利亚', devs: 57, apps: 251 },
    { cc: 'CZ', name: '捷克', devs: 44, apps: 196 },
    { cc: 'NL', name: '荷兰', devs: 42, apps: 188 },
    { cc: 'UA', name: '乌克兰', devs: 38, apps: 171 },
    { cc: 'DE', name: '德国', devs: 30, apps: 142 },
    { cc: 'CA', name: '加拿大', devs: 28, apps: 130 },
    { cc: 'FR', name: '法国', devs: 26, apps: 121 },
    { cc: 'AT', name: '奥地利', devs: 20, apps: 92 },
    { cc: 'KR', name: '韩国', devs: 14, apps: 64 },
    { cc: 'IN', name: '印度', devs: 8, apps: 38 },
    { cc: 'IL', name: '以色列', devs: 7, apps: 33 },
    { cc: 'IT', name: '意大利', devs: 5, apps: 24 },
    { cc: 'SE', name: '瑞典', devs: 5, apps: 24 }
  ];

  const RECENT_DEVELOPERS = [
    { n: 'Vercel', city: '旧金山湾区', a: 2, c: '#EDEDED', dark: true },
    { n: 'Raycast', city: '伦敦', a: 1, c: '#FF6363' },
    { n: 'Sketch', city: '海牙', a: 1, c: '#FDB300' },
    { n: 'Bending Spoons', city: '米兰', a: 2, c: '#7B61FF' }
  ];

  const REGION_LABEL = { americas: '美洲', europe: '欧洲', apac: '亚太', other: '其他' };

  /* ---------------------------------------------------------------- state */

  const state = {
    view: 'map',
    mapTab: 'map',
    metric: 'developers',
    region: 'all',
    tab: 'cities',
    selectedCity: null,
    selectedCountry: null
  };

  const proj = (lng, lat) => [
    ((lng + 180) / 360) * SVG_W,
    ((LAT_TOP - lat) / (LAT_TOP - LAT_BOT)) * SVG_H
  ];

  const cityRadius = (city) => {
    if (state.metric === 'developers') return 3 + Math.sqrt(city.devs) * 0.65;
    return 3 + Math.sqrt(city.installs / 1000) * 0.32;
  };

  const metricValue = (city) => (state.metric === 'developers' ? city.devs : city.installs);

  const metricLabel = () => (state.metric === 'developers' ? '开发者' : '安装量');

  const formatMetric = (city) =>
    state.metric === 'developers' ? String(city.devs) : fmtCompact(city.installs);

  const byMetric = (a, b) => metricValue(b) - metricValue(a);

  const cityByKey = (key) => CITIES.find((city) => city.key === key);

  const countryByCode = (cc) => COUNTRIES.find((country) => country.cc === cc);

  const visibleCities = () =>
    CITIES.filter((city) => {
      if (state.region !== 'all' && city.region !== state.region) return false;
      if (state.selectedCountry && city.cc !== state.selectedCountry) return false;
      return true;
    });

  /* ---------------------------------------------------------------- icons + cards */

  const icon = (name, cls = '') =>
    `<svg class="${cls}" viewBox="0 0 24 24" aria-hidden="true"><use href="#ic-${name}"/></svg>`;

  const appIcon = (key, extra = '') => {
    const app = APPS[key];
    if (!app) return '';
    if (app.icon) {
      return `<span class="app-icon ${extra}" style="background:${app.tile};color:${app.fg || 'inherit'};padding:${app.pad}px">${icon(app.icon)}</span>`;
    }
    return `<span class="app-icon is-letter ${extra}" style="--tile-from:${app.tileFrom};--tile-to:${app.tileTo}${
      app.mono ? ';font-family:var(--on-font-family-mono);font-size:12px' : ''
    }"><span class="letter">${app.letter}</span></span>`;
  };

  const appCard = (key, order) => {
    const app = APPS[key];
    const stats =
      order === 'recent'
        ? [
            ['版本', app.version],
            ['30 天安装', app.installs]
          ]
        : [
            ['30 天安装', app.installs],
            ['版本', app.version]
          ];
    return `<article class="app-card">
      <div class="app-head">
        ${appIcon(key)}
        <div class="app-body">
          <a class="app-name" href="#">${app.name}</a>
          <p class="app-summary">${app.summary}</p>
        </div>
      </div>
      <div class="app-foot">
        ${stats
          .map(
            ([label, value]) =>
              `<div class="app-stat"><span class="label">${label}</span><span class="value">${value}</span></div>`
          )
          .join('')}
        <button type="button" class="get-btn">获取</button>
      </div>
    </article>`;
  };

  const rankRow = (entry) => {
    const app = APPS[entry.key];
    return `<li class="rank-row">
      <span class="rank-num">${entry.rank}</span>
      ${appIcon(entry.key)}
      <span class="rank-main"><span class="rank-name">${app.name}</span><span class="rank-sub">${app.summary}</span></span>
      <span class="rank-value">${entry.value}</span>
    </li>`;
  };

  const collectionCard = (collection, index) => `<article class="collection-card">
    <div class="collection-icons">${collection.apps.map((key) => appIcon(key)).join('')}</div>
    <h3>${collection.title}</h3>
    <p class="sub">${collection.sub}</p>
    <div class="collection-more">查看 ${collection.count} 个 App</div>
  </article>`;

  const pickCard = (pick) => {
    const ap = APPS[pick.key];
    return `<article class="pick-card">
      <div class="pick-top">
        <span class="pick-label">${icon('badge-check')}开发者精选</span>
        <span class="pick-when">${pick.when}</span>
      </div>
      <div class="pick-app">
        ${appIcon(pick.key)}
        <div class="pick-app-main">
          <a class="pick-name" href="#">${ap.name}</a>
          <p class="pick-summary">${ap.summary}</p>
        </div>
      </div>
      <p class="pick-quote">“${pick.quote}”</p>
      <div class="pick-foot">
        <span class="pick-dev">${pick.by} · ${pick.place}</span>
        <span class="pick-claimed">${icon('check')}已认领</span>
      </div>
    </article>`;
  };

  const renderPage = () => {
    document.getElementById('developerPicks').innerHTML = DEVELOPER_PICKS.map(pickCard).join('');
    document.getElementById('popularGrid').innerHTML = POPULAR.map((key) => appCard(key, 'popular')).join('');
    document.getElementById('recentGrid').innerHTML = RECENT.map((key) => appCard(key, 'recent')).join('');
    document.getElementById('collectionGrid').innerHTML = COLLECTIONS.map(collectionCard).join('');
    document.getElementById('railWeekly').innerHTML = WEEKLY.map((entry, index) =>
      rankRow({ ...entry, rank: index + 1 })
    ).join('');
    document.getElementById('railCollectionIcons').innerHTML = COLLECTIONS[0].apps
      .map((key) => appIcon(key))
      .join('');
  };

  const renderCityGrid = () => {
    const grid = document.getElementById('cityGrid');
    const sorted = CITIES.slice().sort((a, b) => b.devs - a.devs);
    const max = sorted[0]?.devs || 1;
    grid.innerHTML = sorted
      .map(
        (city, index) => `<button type="button" class="city-card" data-city="${city.key}" aria-pressed="false">
        <span class="city-card-rank">${pad2(index + 1)}</span>
        <span class="city-card-main"><span class="city-card-name">${city.name}</span><span class="city-card-meta">${
          city.country
        } · ${city.apps} 个 App</span></span>
        <span class="city-card-value">${city.devs}</span>
        <span class="city-card-bar" style="--w:${Math.max(4, (city.devs / max) * 100).toFixed(1)}%"></span>
      </button>`
      )
      .join('');
  };

  const syncCityGrid = () => {
    document.querySelectorAll('#cityGrid .city-card').forEach((card) => {
      const active = card.dataset.city === state.selectedCity;
      card.classList.toggle('is-active', active);
      card.setAttribute('aria-pressed', String(active));
    });
  };

  /* ---------------------------------------------------------------- map */

  const svg = document.getElementById('dmWorld');
  const map = document.getElementById('dmMap');
  const tip = document.getElementById('dmTip');
  const cityLayer = document.getElementById('dmCities');
  const labelLayer = document.getElementById('dmLabels');

  const mapPoint = (x, y) => {
    const svgRect = svg.getBoundingClientRect();
    const mapRect = map.getBoundingClientRect();
    const scale = Math.min(svgRect.width / SVG_W, svgRect.height / SVG_H);
    const offsetX = svgRect.left - mapRect.left + (svgRect.width - SVG_W * scale) / 2;
    const offsetY = svgRect.top - mapRect.top + (svgRect.height - SVG_H * scale) / 2;
    return { x: offsetX + x * scale, y: offsetY + y * scale };
  };

  const placeTip = (x, y, mode = 'above') => {
    const mapRect = map.getBoundingClientRect();
    const width = tip.offsetWidth || 232;
    const height = tip.offsetHeight || 120;
    let left = x - width / 2;
    let top = mode === 'above' ? y - height - 14 : y + 16;
    left = Math.max(8, Math.min(mapRect.width - width - 8, left));
    if (top < 8) top = y + 16;
    if (top + height > mapRect.height - 8) top = Math.max(8, y - height - 14);
    tip.style.left = `${left}px`;
    tip.style.top = `${top}px`;
  };

  const tipMarkup = (city) => {
    const developers = city.top
      .slice(0, 3)
      .map(
        (dev) =>
          `<span class="mini" style="background:linear-gradient(160deg,${dev.c},${shade(dev.c, -0.2)});${
            dev.dark ? 'color:#141414;text-shadow:none' : ''
          }">${dev.n.slice(0, 1)}</span>`
      )
      .join('');
    return `<div class="dm-tip-head"><b>${city.name}</b><span>${city.country}</span></div>
      <div class="dm-tip-stats"><div><b>${city.devs}</b><span>开发者</span></div><div><b>${city.apps}</b><span>App</span></div></div>
      <div class="dm-tip-devs">${developers}<span class="more">还有 ${Math.max(0, city.devs - city.top.length)} 位</span></div>
      <div class="dm-tip-cta">点击查看开发者 →</div>`;
  };

  const showCityTip = (city) => {
    tip.innerHTML = tipMarkup(city);
    tip.classList.add('is-on');
    const [x, y] = proj(city.lng, city.lat);
    const point = mapPoint(x, y);
    placeTip(point.x, point.y, 'above');
  };

  const showCountryTip = (path, clientX, clientY) => {
    const count = Number(path.dataset.count || 0);
    if (!count) return hideTip();
    const name = path.dataset.name || '';
    const apps = path.dataset.apps || '';
    tip.innerHTML = `<div class="dm-tip-head"><b>${name}</b><span>${path.dataset.cc || ''}</span></div>
      <div class="dm-tip-stats"><div><b>${fmt(count)}</b><span>开发者</span></div><div><b>${fmt(
        Number(apps)
      )}</b><span>App</span></div></div>
      <div class="dm-tip-cta">点击国家查看城市 →</div>`;
    tip.classList.add('is-on');
    const mapRect = map.getBoundingClientRect();
    placeTip(clientX - mapRect.left, clientY - mapRect.top, 'cursor');
  };

  const hideTip = () => {
    tip.classList.remove('is-on');
  };

  const cityAria = (city) => `${city.name}，${city.devs} 位开发者，${city.apps} 个 App`;

  const renderCities = () => {
    cityLayer.innerHTML = CITIES.map((city) => {
      const [x, y] = proj(city.lng, city.lat);
      const raw = cityRadius(city);
      const r = Math.round(raw * 10) / 10;
      const dimmed =
        (state.region !== 'all' && city.region !== state.region) ||
        (state.selectedCountry && city.cc !== state.selectedCountry) ||
        (state.selectedCity && city.key !== state.selectedCity);
      const selected = state.selectedCity === city.key;
      return `<g class="dm-city${selected ? ' is-selected' : ''}${dimmed ? ' is-dimmed' : ''}${
        city.key === 'bay-area' ? ' is-top' : ''
      }" data-key="${city.key}" transform="translate(${x.toFixed(1)} ${y.toFixed(1)})" tabindex="0" role="button" aria-label="${cityAria(
        city
      )}" aria-pressed="${selected}">
        <g class="dm-city-scale">
          <circle class="dm-halo" r="${(r * 3.1).toFixed(1)}"></circle>
          <circle class="dm-pulse" r="${(r + 3).toFixed(1)}"></circle>
          <circle class="dm-dot" style="r:${r}px"></circle>
          <circle class="dm-hit" r="${Math.max(r + 9, 16).toFixed(1)}"></circle>
        </g>
      </g>`;
    }).join('');
    syncCityGrid();
  };

  const renderLabels = () => {
    const showLabels = state.region === 'all' && !state.selectedCountry;
    const pool = showLabels
      ? CITIES.slice()
          .sort(byMetric)
          .slice(0, 6)
      : [];
    labelLayer.innerHTML = pool
      .map((city) => {
        const [x, y] = proj(city.lng, city.lat);
        let anchor = 'start';
        let dx = 12;
        let dy = 4;
        if (city.label === 'end') {
          anchor = 'end';
          dx = -12;
        } else if (city.label === 'middle-above') {
          anchor = 'middle';
          dx = 0;
          dy = -13;
        } else if (city.label === 'start-below') {
          dy = 16;
        }
        const muted = state.selectedCity && state.selectedCity !== city.key ? ' is-muted' : '';
        return `<text class="dm-label${muted}" x="${(x + dx).toFixed(1)}" y="${(y + dy).toFixed(
          1
        )}" text-anchor="${anchor}">${city.name}<tspan class="count" dx="5">${formatMetric(city)}</tspan></text>`;
      })
      .join('');
  };

  /* ---------------------------------------------------------------- panel */

  const grid = document.getElementById('dmGrid');
  const detail = document.getElementById('dmDetail');
  const panelTitle = document.getElementById('dmPanelTitle');
  const tabs = document.querySelector('.dm-tabs');
  const coverage = document.getElementById('dmCoverage');
  const gridWrap = document.getElementById('dmGridWrap');

  const devChip = (dev) => `<a class="dm-dev" href="#" aria-label="${dev.n}，${dev.a} 个 App">
    <span class="dm-tile" style="--tile-from:${dev.c};--tile-to:${shade(dev.c, -0.2)};${
      dev.dark ? 'color:#141414;text-shadow:none' : ''
    }">${dev.n.slice(0, 1)}</span>
    <span class="dm-dev-main"><span class="dm-dev-name">${dev.n}</span><span class="dm-dev-meta">${dev.a} 个 App</span></span>
  </a>`;

  const renderPanel = () => {
    if (state.selectedCity) {
      const city = cityByKey(state.selectedCity);
      tabs.hidden = true;
      coverage.hidden = true;
      gridWrap.hidden = true;
      detail.hidden = false;
      panelTitle.classList.add('is-detail');
      panelTitle.innerHTML = `<button type="button" class="dm-back" data-back aria-label="返回城市榜">${icon(
        'arrow-left'
      )}</button><b>${city.name}</b><span class="sub">${city.country} · ${city.devs} 位开发者 · ${
        city.apps
      } 个 App</span>`;
      detail.innerHTML = `<div class="dm-dev-list">${city.top.map(devChip).join('')}</div>`;
      return;
    }

    panelTitle.classList.remove('is-detail');
    tabs.hidden = Boolean(state.selectedCountry);
    coverage.hidden = Boolean(state.selectedCountry);
    gridWrap.hidden = false;
    detail.hidden = true;

    if (state.selectedCountry) {
      const country = countryByCode(state.selectedCountry);
      const cities = visibleCities().slice().sort(byMetric);
      panelTitle.innerHTML = `<button type="button" class="dm-back" data-back aria-label="返回国家榜">${icon(
        'arrow-left'
      )}</button><b>${country.name}的城市</b><span class="sub">${cities.reduce(
        (sum, city) => sum + city.devs,
        0
      )} 位开发者</span>`;
      panelTitle.classList.add('is-detail');
      renderCityCells(cities, `${cities.length} 个城市`);
      return;
    }

    if (state.tab === 'countries') {
      panelTitle.textContent = '开发者最多的国家';
      renderCountryCells();
      return;
    }

    panelTitle.textContent = '开发者最多的城市';
    const cities = visibleCities().slice().sort(byMetric).slice(0, 6);
    renderCityCells(cities);
  };

  const renderCityCells = (cities, sub) => {
    const max = Math.max(...cities.map(metricValue), 1);
    grid.innerHTML = cities
      .map((city, index) => {
        const active = state.selectedCity === city.key;
        return `<button type="button" class="dm-cell${active ? ' is-active' : ''}" data-key="${city.key}" aria-pressed="${active}">
        <span class="dm-rank">${pad2(index + 1)}</span>
        <span class="dm-cell-main"><span class="dm-city-name">${city.name}</span><span class="dm-city-meta">${
          city.country
        } · ${city.apps} 个 App</span></span>
        <span class="dm-value">${formatMetric(city)}</span>
        <span class="dm-bar" style="--w:${Math.max(4, (metricValue(city) / max) * 100).toFixed(1)}%"></span>
      </button>`;
      })
      .join('');
    if (!cities.length) grid.innerHTML = `<div class="dm-empty">这个地区还没有已定位的开发者。</div>`;
    if (sub) coverage.textContent = sub;
  };

  const renderCountryCells = () => {
    const regionCodes =
      state.region === 'all'
        ? null
        : new Set(CITIES.filter((city) => city.region === state.region).map((city) => city.cc));
    const list = COUNTRIES.filter((country) => !regionCodes || regionCodes.has(country.cc)).slice(0, 6);
    const max = Math.max(...list.map((country) => country.devs), 1);
    grid.innerHTML = list
      .map(
        (country, index) => `<button type="button" class="dm-cell" data-cc="${country.cc}">
        <span class="dm-rank">${pad2(index + 1)}</span>
        <span class="dm-cell-main"><span class="dm-city-name"><span class="flag">${country.cc}</span>${
          country.name
        }</span><span class="dm-city-meta">${fmt(country.apps)} 个 App</span></span>
        <span class="dm-value">${fmt(country.devs)}</span>
        <span class="dm-bar" style="--w:${Math.max(4, (country.devs / max) * 100).toFixed(1)}%"></span>
      </button>`
      )
      .join('');
    coverage.textContent = '已定位 1,058 / 1,284';
  };

  const renderMapRail = () => {
    document.getElementById('railCountries').innerHTML = COUNTRIES.slice(0, 6)
      .map(
        (country, index) => `<li class="rank-row">
        <span class="rank-num">${index + 1}</span>
        <span class="country-tile">${country.cc}</span>
        <span class="rank-main"><span class="rank-name">${country.name}</span><span class="rank-sub">${fmt(
          country.apps
        )} 个 App</span></span>
        <span class="rank-value">${fmt(country.devs)}</span>
      </li>`
      )
      .join('');
    document.getElementById('railRecent').innerHTML = RECENT_DEVELOPERS.map(
      (dev) => `<li class="recent-dev">
      <span class="tile" style="--from:${dev.c};--to:${shade(dev.c, -0.2)};${
        dev.dark ? 'color:#141414;text-shadow:none' : ''
      }">${dev.n.slice(0, 1)}</span>
      <span class="main"><span class="name">${dev.n}</span><span class="meta">${dev.city} · ${
        dev.a
      } 个 App</span></span>
      <span class="when">本周</span>
    </li>`
    ).join('');
  };

  /* ---------------------------------------------------------------- interactions */

  const setMetric = (metric) => {
    state.metric = metric;
    document.querySelectorAll('.dm-seg button').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.metric === metric);
      button.setAttribute('aria-checked', String(button.dataset.metric === metric));
    });
    document.querySelector('.dm-legend span:last-child').textContent =
      metric === 'developers' ? '圆点大小 = 开发者数量' : '圆点大小 = 30 天安装量';
    renderCities();
    renderLabels();
    renderPanel();
  };

  const setRegion = (region) => {
    hideTip();
    state.region = region;
    state.selectedCountry = null;
    state.selectedCity = null;
    document.querySelectorAll('.dm-regions button').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.region === region);
      button.setAttribute('aria-checked', String(button.dataset.region === region));
    });
    renderCities();
    renderLabels();
    renderPanel();
  };

  const selectCity = (key) => {
    hideTip();
    if (!key) {
      state.selectedCity = null;
      renderCities();
      renderLabels();
      renderPanel();
      return;
    }
    state.selectedCity = state.selectedCity === key ? null : key;
    renderCities();
    renderLabels();
    renderPanel();
  };

  const selectCountry = (cc) => {
    hideTip();
    state.selectedCountry = cc;
    state.selectedCity = null;
    state.tab = 'countries';
    renderCities();
    renderLabels();
    renderPanel();
  };

  const back = () => {
    if (state.selectedCity) {
      state.selectedCity = null;
    } else if (state.selectedCountry) {
      state.selectedCountry = null;
      state.tab = 'countries';
    }
    renderCities();
    renderLabels();
    renderPanel();
  };

  const setTab = (tab) => {
    hideTip();
    state.tab = tab;
    state.selectedCountry = null;
    state.selectedCity = null;
    document.querySelectorAll('.dm-tabs button').forEach((button) => {
      const on = button.dataset.tab === tab;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-selected', String(on));
    });
    renderCities();
    renderLabels();
    renderPanel();
  };

  const bindMap = () => {
    cityLayer.addEventListener('mouseover', (event) => {
      const marker = event.target.closest('.dm-city');
      if (!marker) return;
      const city = cityByKey(marker.dataset.key);
      if (city) showCityTip(city);
    });
    cityLayer.addEventListener('mouseout', (event) => {
      const marker = event.target.closest('.dm-city');
      if (!marker) return;
      if (!marker.contains(event.relatedTarget)) hideTip();
    });
    cityLayer.addEventListener('focusin', (event) => {
      const marker = event.target.closest('.dm-city');
      if (!marker) return;
      const city = cityByKey(marker.dataset.key);
      if (city) showCityTip(city);
    });
    cityLayer.addEventListener('focusout', hideTip);
    cityLayer.addEventListener('click', (event) => {
      const marker = event.target.closest('.dm-city');
      if (!marker) return;
      event.stopPropagation();
      selectCity(marker.dataset.key);
    });
    cityLayer.addEventListener('keydown', (event) => {
      const marker = event.target.closest('.dm-city');
      if (!marker) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        selectCity(marker.dataset.key);
      }
      if (event.key === 'Escape') {
        hideTip();
        selectCity(null);
      }
    });

    const countries = document.getElementById('dmCountries');
    countries.addEventListener('mousemove', (event) => {
      const path = event.target.closest('.dm-land');
      if (!path) return;
      showCountryTip(path, event.clientX, event.clientY);
    });
    countries.addEventListener('mouseout', (event) => {
      if (event.target.closest('.dm-land')) hideTip();
    });
    countries.addEventListener('click', (event) => {
      const path = event.target.closest('.dm-land');
      if (!path) return;
      const count = Number(path.dataset.count || 0);
      if (!count) return;
      selectCountry(path.dataset.cc);
    });

    document.getElementById('dmGrid').addEventListener('click', (event) => {
      const cell = event.target.closest('.dm-cell');
      if (!cell) return;
      if (cell.dataset.cc) selectCountry(cell.dataset.cc);
      else if (cell.dataset.key) selectCity(cell.dataset.key);
    });

    document.getElementById('dmPanelTitle').addEventListener('click', (event) => {
      if (event.target.closest('[data-back]')) back();
    });

    document.querySelector('.dm-tabs').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) setTab(button.dataset.tab);
    });

    document.querySelector('.dm-seg').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) setMetric(button.dataset.metric);
    });

    document.querySelector('.dm-regions').addEventListener('click', (event) => {
      const button = event.target.closest('button');
      if (button) setRegion(button.dataset.region);
    });

    svg.addEventListener('click', (event) => {
      if (event.target.closest('.dm-city') || event.target.closest('.dm-land')) return;
      state.selectedCity = null;
      state.selectedCountry = null;
      hideTip();
      renderCities();
      renderLabels();
      renderPanel();
    });

    window.addEventListener('resize', () => {
      hideTip();
    });
  };

  /* ---------------------------------------------------------------- review chrome */

  const setMode = (mode) => {
    document.body.dataset.mode = mode;
    document.querySelectorAll('[data-control="mode"] button').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.value === mode);
    });
    hideTip();
  };

  const setTheme = (theme) => {
    document.documentElement.dataset.theme = theme;
    document.querySelectorAll('[data-control="theme"] button').forEach((button) => {
      button.classList.toggle('is-on', button.dataset.value === theme);
    });
  };

  const MAP_TABS = ['map', 'submit', 'claim', 'docs'];

  const setMapTab = (tab) => {
    const normalized = tab === 'location' ? 'claim' : tab;
    state.mapTab = MAP_TABS.includes(normalized) ? normalized : 'map';
    document.querySelectorAll('[data-map-panel]').forEach((panel) => {
      panel.hidden = panel.dataset.mapPanel !== state.mapTab;
    });
    document.querySelectorAll('.map-tabs button').forEach((button) => {
      const on = button.dataset.mapTab === state.mapTab;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-selected', String(on));
    });
    if (state.view === 'map') {
      const showRail = state.mapTab === 'map';
      document.getElementById('rail-map').hidden = !showRail;
      document.querySelector('.content-row').classList.toggle('no-rail', !showRail);
    }
    if (state.mapTab === 'submit' && !document.getElementById('submitSuccess').hidden) resetSubmitForm();
    hideTip();
    if (document.body.dataset.mode === 'desktop') {
      document.getElementById('main').scrollTo({ top: 0, behavior: 'auto' });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  };

  const setView = (view) => {
    state.view = view === 'map' ? 'map' : 'discover';
    document.querySelectorAll('.view').forEach((element) => {
      element.hidden = element.id !== `view-${state.view}`;
    });
    document.getElementById('rail-discover').hidden = state.view !== 'discover';
    if (state.view === 'map') {
      setMapTab(state.mapTab);
    } else {
      document.getElementById('rail-map').hidden = true;
      document.querySelector('.content-row').classList.remove('no-rail');
    }
    document.querySelectorAll('[data-nav]').forEach((link) => {
      const active = link.dataset.nav === state.view;
      link.classList.toggle('is-active', active);
      if (active) link.setAttribute('aria-current', 'page');
      else link.removeAttribute('aria-current');
    });
    hideTip();
    if (document.body.dataset.mode === 'desktop') {
      document.getElementById('main').scrollTo({ top: 0, behavior: 'auto' });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }
  };

  const focusMap = (smooth = true) => {
    if (state.view !== 'map' || state.mapTab !== 'map') {
      setView('map');
      setMapTab('map');
      requestAnimationFrame(() => focusMap(smooth));
      return;
    }
    const target = document.getElementById('devmap');
    if (!target) return;
    const behavior = smooth ? 'smooth' : 'auto';
    if (document.body.dataset.mode === 'desktop') {
      const main = document.getElementById('main');
      const top = target.getBoundingClientRect().top - main.getBoundingClientRect().top + main.scrollTop - 16;
      main.scrollTo({ top, behavior });
    } else {
      window.scrollTo({ top: target.getBoundingClientRect().top + window.scrollY - 70, behavior });
    }
  };

  const stopHashLinks = () => {
    document.addEventListener('click', (event) => {
      const link = event.target.closest('a[href="#"]');
      if (link) event.preventDefault();
    });
  };

  const bindNav = () => {
    document.querySelectorAll('[data-nav]').forEach((link) => {
      link.addEventListener('click', (event) => {
        event.preventDefault();
        if (link.dataset.nav === 'map') {
          setView('map');
          setMapTab('map');
        } else {
          setView('discover');
        }
      });
    });
    document.getElementById('cityGrid').addEventListener('click', (event) => {
      const card = event.target.closest('.city-card');
      if (!card) return;
      selectCity(card.dataset.city);
      document.getElementById('devmap').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  /* ---------------------------------------------------------------- developer pages */

  let toastTimer;
  let submitSource = 'github';

  const showToast = (message) => {
    const toast = document.getElementById('toast');
    document.getElementById('toastText').textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  };

  const markError = (element, on) => {
    const field = element.closest('.field');
    if (field) field.classList.toggle('has-error', Boolean(on));
  };

  const SOURCE_DATA = {
    github: {
      link: 'https://github.com/ghostty-org/ghostty',
      name: 'Ghostty',
      summary: 'Fast, native terminal emulator for macOS.',
      dev: 'Ghostty',
      country: 'US',
      city: '西雅图',
      homepage: 'https://ghostty.org',
      download: '',
      github: 'https://github.com/ghostty-org/ghostty',
      category: '终端与 Shell',
      verify: 'github',
      verifyHint: 'ghostty-org/ghostty · 用仓库 owner 账号登录即可',
      hint: '读取 GitHub 仓库、README 和最新 release',
      fetched: ['名称', '简介', '图标', '版本', '开发者', '仓库'],
      icon: { kind: 'brand', name: 'ghostty', bg: '#1C1C1C', fg: '#EDEDED' }
    },
    appstore: {
      link: 'https://apps.apple.com/app/example/id123456789',
      name: 'Example App',
      summary: 'A native Mac app for focused work.',
      dev: 'Example Labs',
      country: 'US',
      city: '旧金山',
      homepage: 'https://apps.apple.com/app/example/id123456789',
      download: 'https://apps.apple.com/app/example/id123456789',
      github: '',
      category: '效率',
      verify: 'domain',
      verifyHint: 'apps.apple.com · 可选补充域名或说明，编辑会人工核对',
      hint: '读取 App Store Lookup API 和开发者信息',
      fetched: ['名称', '简介', '图标', '版本', '开发者', 'App Store 链接'],
      icon: { kind: 'letter', letter: 'E', from: '#7C5CFF', to: '#4B2FC4' }
    },
    website: {
      link: 'https://example.com',
      name: 'Example App',
      summary: 'A native Mac app for focused work.',
      dev: 'Example Labs',
      country: 'US',
      city: '旧金山',
      homepage: 'https://example.com',
      download: '',
      github: '',
      category: '开发工具',
      verify: 'domain',
      verifyHint: 'example.com · 在官网加 TXT 或放 /.well-known/opennavo.txt',
      hint: '读取官网 Open Graph、JSON-LD 和下载链接',
      fetched: ['名称', '简介', '图标', '官网', '开发者'],
      icon: { kind: 'letter', letter: 'E', from: '#7C5CFF', to: '#4B2FC4' }
    }
  };

  const setIcon = (element, icon) => {
    if (!element) return;
    if (icon.kind === 'brand') {
      element.classList.remove('is-letter');
      element.style.background = icon.bg;
      element.style.padding = '7px';
      element.style.color = icon.fg || 'inherit';
      element.innerHTML = `<svg viewBox="0 0 24 24"><use href="#ic-${icon.name}"/></svg>`;
      return;
    }
    element.classList.add('is-letter');
    element.style.background = '';
    element.style.padding = '';
    element.style.color = '';
    element.style.setProperty('--tile-from', icon.from);
    element.style.setProperty('--tile-to', icon.to);
    element.innerHTML = `<span class="letter">${icon.letter}</span>`;
  };

  const resetSubmitForm = () => {
    document.getElementById('submitForm').hidden = true;
    document.getElementById('fetchStatus').hidden = true;
    document.getElementById('submitSuccess').hidden = true;
    document.getElementById('formError').hidden = true;
    document.querySelectorAll('.has-error').forEach((element) => element.classList.remove('has-error'));
    const link = document.getElementById('appLink');
    if (link) link.value = SOURCE_DATA[submitSource].link;
    document.querySelectorAll('.source-tabs button').forEach((button) => {
      const on = button.dataset.source === submitSource;
      button.classList.toggle('is-on', on);
      button.setAttribute('aria-selected', String(on));
    });
  };

  const bindSubmitForm = () => {
    const appLink = document.getElementById('appLink');
    const appName = document.getElementById('appName');
    const appSummary = document.getElementById('appSummary');
    const appCategory = document.getElementById('appCategory');
    const devName = document.getElementById('devName');
    const devCountry = document.getElementById('devCountry');
    const devCity = document.getElementById('devCity');
    const appHomepage = document.getElementById('appHomepage');
    const appDownload = document.getElementById('appDownload');
    const appGithub = document.getElementById('appGithub');
    const previewName = document.getElementById('previewName');
    const previewSummary = document.getElementById('previewSummary');
    const previewDev = document.getElementById('previewDev');
    const previewLoc = document.getElementById('previewLoc');
    const fetchButton = document.getElementById('fetchInfo');
    const fetchStatus = document.getElementById('fetchStatus');
    const form = document.getElementById('submitForm');
    const success = document.getElementById('submitSuccess');
    const terms = document.getElementById('terms');
    const formError = document.getElementById('formError');

    const updatePreview = () => {
      previewName.textContent = appName.value.trim() || '未命名 App';
      previewSummary.textContent = appSummary.value.trim() || '一句话简介会显示在这里。';
      previewDev.textContent = devName.value.trim() || '未填写';
      const country = devCountry.selectedOptions[0]?.textContent || '';
      const city = devCity.value.trim();
      previewLoc.textContent = [country, city].filter(Boolean).join(' · ') || '未填写';
    };

    [appName, appSummary, devName, devCity].forEach((input) => input.addEventListener('input', updatePreview));
    devCountry.addEventListener('change', updatePreview);
    appCategory.addEventListener('change', updatePreview);

    const setSource = (source, updateLink = true) => {
      submitSource = source;
      document.querySelectorAll('.source-tabs button').forEach((button) => {
        const on = button.dataset.source === source;
        button.classList.toggle('is-on', on);
        button.setAttribute('aria-selected', String(on));
      });
      if (updateLink) appLink.value = SOURCE_DATA[source].link;
      form.hidden = true;
      fetchStatus.hidden = true;
      success.hidden = true;
    };

    document.querySelectorAll('.source-tabs button').forEach((button) => {
      button.addEventListener('click', () => setSource(button.dataset.source));
    });

    appLink.addEventListener('input', () => {
      const value = appLink.value.toLowerCase();
      let source = 'website';
      if (value.includes('github.com')) source = 'github';
      else if (value.includes('apps.apple.com') || value.includes('itunes.apple.com')) source = 'appstore';
      if (source !== submitSource) setSource(source, false);
    });

    const fillForm = (data) => {
      appName.value = data.name;
      appSummary.value = data.summary;
      appCategory.value = data.category;
      devName.value = data.dev;
      devCountry.value = data.country;
      devCity.value = data.city;
      appHomepage.value = data.homepage;
      appDownload.value = data.download;
      appGithub.value = data.github;
      document.getElementById('verifyGithubHint').textContent = data.verifyHint;
      document.getElementById('verifyDomainHint').textContent = data.verifyHint;
      document.querySelectorAll('#verifyOptions .verify').forEach((option, index) => {
        const on = (data.verify === 'github' && index === 0) || (data.verify === 'domain' && index === 1);
        option.classList.toggle('is-on', on);
        const input = option.querySelector('input');
        if (input) input.checked = on;
      });
      document.getElementById('fetchedList').innerHTML = data.fetched
        .map((item) => `<li><svg class="icon"><use href="#ic-check"/></svg>${item}</li>`)
        .join('');
      setIcon(document.getElementById('previewIcon'), data.icon);
      setIcon(document.getElementById('fetchedIcon'), data.icon);
      form.hidden = false;
      updatePreview();
    };

    fetchButton.addEventListener('click', () => {
      const data = SOURCE_DATA[submitSource];
      fetchStatus.hidden = false;
      fetchButton.disabled = true;
      document.getElementById('fetchTitle').textContent = '正在抓取…';
      document.getElementById('fetchHint').textContent = data.hint;
      setTimeout(() => {
        fillForm(data);
        fetchStatus.hidden = true;
        fetchButton.disabled = false;
        form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 750);
    });

    terms.addEventListener('change', () => {
      terms.closest('.check')?.classList.remove('has-error');
      if (terms.checked) formError.hidden = true;
    });

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      let invalid = false;
      [appName, appSummary, devName, devCountry].forEach((field) => {
        const bad = !field.value.trim();
        markError(field, bad);
        invalid = invalid || bad;
      });
      if (!terms.checked) {
        invalid = true;
        terms.closest('.check')?.classList.add('has-error');
      }
      if (invalid) {
        formError.hidden = false;
        return;
      }
      formError.hidden = true;
      form.hidden = true;
      fetchStatus.hidden = true;
      success.hidden = false;
      document.getElementById('submitSuccessText').textContent =
        `我们已收到「${appName.value.trim()}」的提交，预计 3–5 个工作日。状态变化会发到 hello@example.com。`;
      if (document.body.dataset.mode === 'desktop') {
        document.getElementById('main').scrollTo({ top: 0, behavior: 'smooth' });
      } else {
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
      showToast('提交成功，已进入审核');
    });

    updatePreview();
  };

  const bindClaim = () => {
    const items = Array.from(document.querySelectorAll('#claimResults .claim-item'));
    const search = document.getElementById('claimSearch');
    const locationToggle = document.getElementById('claimLocationToggle');
    const locationFields = document.getElementById('claimLocationFields');
    const country = document.getElementById('claimCountry');
    const error = document.getElementById('claimError');
    let selected = items.find((item) => item.classList.contains('is-on')) || items[0];

    const select = (item) => {
      selected = item;
      items.forEach((other) => other.classList.toggle('is-on', other === item));
      document.getElementById('claimProof').textContent = item.dataset.claimProof || '';
      const verified = item.dataset.claimVerified === 'true';
      document.querySelector('.proof-box').classList.toggle('is-unverified', !verified);
      const badge = document.getElementById('claimProofBadge');
      badge.textContent = verified ? '已审核' : '待审核';
      badge.classList.toggle('success', verified);
      error.hidden = true;
    };

    items.forEach((item) => item.addEventListener('click', () => select(item)));
    search.addEventListener('input', () => {
      const query = search.value.trim().toLowerCase();
      items.forEach((item) => {
        item.hidden = Boolean(query) && !item.innerText.toLowerCase().includes(query);
      });
    });
    locationToggle.addEventListener('change', () => {
      locationFields.hidden = !locationToggle.checked;
      if (locationToggle.checked) error.hidden = true;
    });
    document.getElementById('claimSubmit').addEventListener('click', () => {
      if (!selected || (locationToggle.checked && !country.value)) {
        error.hidden = false;
        return;
      }
      error.hidden = true;
      showToast(`「${selected.dataset.claimName}」的认领与更新已提交，审核通过后会更新这个 App`);
    });
  };

  const bindDev = () => {
    document.querySelectorAll('.map-tabs button').forEach((button) => {
      button.addEventListener('click', () => setMapTab(button.dataset.mapTab));
    });
    document.querySelectorAll('[data-go]').forEach((button) => {
      button.addEventListener('click', () => {
        const target = button.dataset.go;
        if (['submit', 'claim', 'location'].includes(target)) {
          setView('map');
          setMapTab(target === 'location' ? 'claim' : target);
        } else if (target === 'developers') {
          setView('map');
          setMapTab('docs');
        } else if (target === 'map') {
          setView('map');
          setMapTab('map');
        } else if (target === 'discover') {
          setView('discover');
        }
        if (button.hasAttribute('data-reset-submit')) resetSubmitForm();
      });
    });
    bindSubmitForm();
    bindClaim();
  };

  const bindChrome = () => {
    document.querySelectorAll('[data-control="mode"] button').forEach((button) => {
      button.addEventListener('click', () => setMode(button.dataset.value));
    });
    document.querySelectorAll('[data-control="theme"] button').forEach((button) => {
      button.addEventListener('click', () => setTheme(button.dataset.value));
    });
    document.getElementById('focusMap').addEventListener('click', () => focusMap(true));
    document.getElementById('hideUi').addEventListener('click', () => {
      document.body.classList.add('ui-hidden');
      try {
        const url = new URL(location.href);
        url.searchParams.set('ui', '0');
        history.replaceState(null, '', url);
      } catch {
        /* file:// */
      }
    });
  };

  const setCounts = () => {
    document.querySelectorAll('[data-count]').forEach((node) => {
      node.textContent = Number(node.dataset.count).toLocaleString('zh-CN');
    });
  };

  /* ---------------------------------------------------------------- boot */

  const params = new URLSearchParams(location.search);
  const initialMode = params.get('mode') === 'desktop' ? 'desktop' : 'web';
  const initialTheme = params.get('theme') === 'light' ? 'light' : 'dark';

  setMode(initialMode);
  setTheme(initialTheme);
  if (params.get('ui') === '0') document.body.classList.add('ui-hidden');

  const requestedView = params.get('view');
  const requestedTab = params.get('tab');
  let initialView = 'map';
  let initialTab = 'map';
  if (requestedView === 'discover') initialView = 'discover';
  else if (['submit', 'claim', 'location'].includes(requestedView)) initialTab = requestedView === 'location' ? 'claim' : requestedView;
  else if (requestedView === 'developers') initialTab = 'docs';
  else if (['map', 'submit', 'claim', 'location', 'docs'].includes(requestedTab)) initialTab = requestedTab === 'location' ? 'claim' : requestedTab;
  state.mapTab = initialTab;

  renderPage();
  renderCityGrid();
  renderCities();
  renderLabels();
  renderPanel();
  renderMapRail();
  bindMap();
  bindChrome();
  bindNav();
  bindDev();
  stopHashLinks();
  setView(initialView);
  setCounts();

  if (params.get('focus') === 'map') {
    requestAnimationFrame(() => focusMap(false));
  }

  // Deep links for review: #dm-city=bay-area, #dm-country=US, #dm-tab=countries
  const hash = location.hash.replace('#', '');
  if (hash.startsWith('dm-city=')) {
    setView('map');
    setMapTab('map');
    selectCity(hash.split('=')[1]);
  } else if (hash.startsWith('dm-country=')) {
    setView('map');
    setMapTab('map');
    selectCountry(hash.split('=')[1]);
  } else if (hash === 'dm-tab=countries') {
    setView('map');
    setMapTab('map');
    setTab('countries');
  }
})();
