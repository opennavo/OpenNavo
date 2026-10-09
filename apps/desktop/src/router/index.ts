import { createRouter, createWebHashHistory } from 'vue-router';
import type { RouteRecordRaw } from 'vue-router';

declare module 'vue-router' {
  interface RouteMeta {
    /** Highlighted sidebar navigation item; group detail/search subpages under their top-level destination. */
    nav?: 'discover' | 'categories' | 'rankings' | 'brewfile' | 'installed' | 'updates' | 'settings';
    /** Render without the app shell (Welcome, menu-bar popover). */
    bare?: boolean;
  }
}

// Page-specific right statistics rails (08 §9.1: Discover, Installed, Updates), supplied by named rail views.
const DiscoverRail = () => import('@/components/rails/DiscoverRail.vue');
const LibraryRail = () => import('@/components/rails/LibraryRail.vue');
const UpdatesRail = () => import('@/components/rails/UpdatesRail.vue');

export const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/discover' },
  {
    path: '/discover',
    name: 'discover',
    components: {
      default: () => import('@/pages/DiscoverPage.vue'),
      rail: DiscoverRail
    },
    meta: { nav: 'discover' }
  },
  {
    path: '/categories',
    name: 'categories',
    component: () => import('@/pages/CategoriesPage.vue'),
    meta: { nav: 'categories' }
  },
  {
    path: '/categories/:slug',
    name: 'category',
    component: () => import('@/pages/CategoryPage.vue'),
    props: true,
    meta: { nav: 'categories' }
  },
  {
    path: '/rankings',
    name: 'rankings',
    component: () => import('@/pages/RankingsPage.vue'),
    meta: { nav: 'rankings' }
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/pages/SearchPage.vue'),
    meta: { nav: 'discover' }
  },
  {
    // Cask-only catalog (ADR-018): command-line tool URLs fall through to Discover.
    path: '/package/:kind(cask)/:token',
    component: () => import('@/pages/package/PackageLayout.vue'),
    props: true,
    meta: { nav: 'discover' },
    children: [
      {
        path: '',
        name: 'package',
        component: () => import('@/pages/package/PackageOverview.vue')
      },
      {
        path: 'versions',
        name: 'package-versions',
        component: () => import('@/pages/package/PackageVersions.vue')
      },
      {
        path: 'dependencies',
        name: 'package-dependencies',
        component: () => import('@/pages/package/PackageDependencies.vue')
      },
      {
        path: 'details',
        name: 'package-details',
        component: () => import('@/pages/package/PackageDetails.vue')
      }
    ]
  },
  {
    path: '/collections',
    name: 'collections',
    component: () => import('@/pages/CollectionsPage.vue'),
    meta: { nav: 'discover' }
  },
  {
    path: '/collections/:slug',
    name: 'collection',
    component: () => import('@/pages/CollectionPage.vue'),
    props: true,
    meta: { nav: 'discover' }
  },
  {
    path: '/brewfile',
    name: 'brewfile',
    component: () => import('@/pages/BrewfilePage.vue'),
    meta: { nav: 'brewfile' }
  },
  {
    path: '/installed',
    name: 'installed',
    components: {
      default: () => import('@/pages/InstalledPage.vue'),
      rail: LibraryRail
    },
    meta: { nav: 'installed' }
  },
  {
    path: '/updates',
    name: 'updates',
    components: {
      default: () => import('@/pages/UpdatesPage.vue'),
      rail: UpdatesRail
    },
    meta: { nav: 'updates' }
  },
  {
    path: '/history',
    name: 'history',
    redirect: '/updates'
  },
  {
    path: '/settings/:section(general|mirrors|homebrew|privacy|about)?',
    name: 'settings',
    component: () => import('@/pages/SettingsPage.vue'),
    meta: { nav: 'settings' }
  },
  {
    path: '/welcome',
    name: 'welcome',
    component: () => import('@/pages/WelcomePage.vue'),
    meta: { bare: true }
  },
  // Permission guidance overlay (06 §12.7), displayed below System Settings.
  {
    path: '/permission-guide/:pane(app_management|full_disk_access)',
    name: 'permission-guide',
    component: () => import('@/pages/PermissionGuidePage.vue'),
    meta: { bare: true }
  },
  // Menu-bar popover (06 §4.2), without sidebar or toolbar.
  {
    path: '/tray',
    name: 'tray',
    component: () => import('@/pages/TrayPage.vue'),
    meta: { bare: true }
  },
  { path: '/:pathMatch(.*)*', redirect: '/discover' }
];

// No server routing on desktop; use hash history (06 §2).
// Pages scroll in AppShell's <main>, not the window; AppShell resets scroll on navigation.
export const router = createRouter({ history: createWebHashHistory(), routes });
