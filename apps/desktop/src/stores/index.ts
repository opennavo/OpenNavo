import { watch } from 'vue';
import { events } from '@/ipc/client';
import { useCatalogStore } from './catalog';
import { useEnvStore } from './env';
import { useLibraryStore } from './library';
import { useNamesStore } from './names';
import { usePermissionPromptStore } from './permissionPrompt';
import { usePermissionsStore } from './permissions';
import { useSettingsStore } from './settings';
import { useTasksStore } from './tasks';
import { useUpdatesStore } from './updates';

export {
  useCatalogStore,
  useEnvStore,
  useLibraryStore,
  usePermissionPromptStore,
  usePermissionsStore,
  useSettingsStore,
  useTasksStore,
  useUpdatesStore
};

/** Subscribe to Rust events (06 §5.3) and load initial state once before mounting. */
export async function startLocalState() {
  const env = useEnvStore();
  const catalog = useCatalogStore();
  const library = useLibraryStore();
  const updates = useUpdatesStore();
  const tasks = useTasksStore();
  const settings = useSettingsStore();
  const names = useNamesStore();
  const prompt = usePermissionPromptStore();
  const permissions = usePermissionsStore();

  await Promise.all([
    events.taskUpdated.listen(event => {
      tasks.applyUpdate(event.payload);
      prompt.observe(event.payload);
    }),
    events.permissionsChanged.listen(event => permissions.apply(event.payload)),
    events.taskLog.listen(event => tasks.appendLog(event.payload)),
    events.libraryChanged.listen(() => void library.load().catch(() => undefined)),
    events.updatesChanged.listen(() => void updates.load().catch(() => undefined)),
    events.catalogSynced.listen(event => {
      catalog.status = event.payload;
      catalog.revision += 1;
      void names.refresh().catch(() => undefined);
      void catalog.loadCategories().catch(() => undefined);
    }),
    events.envChanged.listen(event => {
      env.info = event.payload;
    }),
    events.localeChanged.listen(() => {
      void settings.load().catch(() => undefined);
      void catalog.loadCategories().catch(() => undefined);
    })
  ]);

  // Returning from System Settings: stop guidance waiting and read current permissions (06 §12.7).
  window.addEventListener('focus', () => void permissions.returned());

  // Changing automatic checks or their schedule changes the next check time.
  watch(
    () => [settings.value?.autoCheck, settings.value?.checkTime],
    (next, previous) => {
      if (previous.some(item => item !== undefined)) void updates.loadStatus().catch(() => undefined);
    }
  );

  // Independent reads: a failure affects only its own region, which renders its own error or empty state.
  await Promise.allSettled([
    env.detect(),
    catalog.loadStatus(),
    catalog.loadCategories(),
    library.load(),
    updates.load(),
    tasks.load(),
    settings.load(),
    permissions.refresh()
  ]);
}

/** Permission overlay (06 §12.7): the guide capability permits only permission/language reads and permission-change events during guidance. */
export async function startGuideState() {
  const permissions = usePermissionsStore();
  await events.permissionsChanged.listen(event => permissions.apply(event.payload));
  await permissions.refresh().catch(() => undefined);
}

/**
 * Menu-bar popover (06 §4.2): tray capability permits only installed, update, and task-queue commands.
 * Read only those three; catalog sync rereads previously queried names/icons without calling catalog status/category commands.
 */
export async function startTrayState() {
  const library = useLibraryStore();
  const updates = useUpdatesStore();
  const tasks = useTasksStore();
  const names = useNamesStore();

  await Promise.all([
    events.taskUpdated.listen(event => tasks.applyUpdate(event.payload)),
    events.libraryChanged.listen(() => void library.load().catch(() => undefined)),
    events.updatesChanged.listen(() => void updates.load().catch(() => undefined)),
    events.catalogSynced.listen(() => void names.refresh().catch(() => undefined))
  ]);
  await Promise.allSettled([library.load(), updates.load(), tasks.load()]);
}
