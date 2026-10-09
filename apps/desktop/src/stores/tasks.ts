import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { Kind, Task, TaskLogEvent, TaskOp, TaskOptions, TaskTarget, TaskTrigger } from '@/ipc/bindings';
import { commands, packageKey, unwrap } from '@/ipc/client';
import { useInstallConfirmStore } from './installConfirm';
import { useLibraryStore } from './library';
import { useUpdatesStore } from './updates';
import { useRunningAppsStore } from './runningApps';

/** Log lines retained per task in the UI (full logs remain in task log files, 06 §6.4). */
const LOG_LIMIT = 200;

/** Task queue (06 §9): task:updated pushes state, task:log pushes logs; completed tasks leave the active list. */
export const useTasksStore = defineStore('tasks', () => {
  const active = ref<Task[]>([]);
  const logs = ref<Record<string, string[]>>({});
  /** Recently completed tasks in this session, for completion notices and the Updates page's just-now section. */
  const finished = ref<Task[]>([]);

  const running = computed(() => active.value.find(task => task.state === 'running'));
  const queued = computed(() => active.value.filter(task => task.state === 'queued'));
  const forPackage = (kind: Kind, token: string) =>
    active.value.find(task => task.target?.kind === kind && task.target.token === token);

  async function load() {
    active.value = await unwrap(commands.taskListActive());
  }

  function applyUpdate(task: Task | null) {
    if (!task) return;
    const index = active.value.findIndex(item => item.id === task.id);
    if (task.state === 'queued' || task.state === 'running') {
      if (index >= 0) active.value.splice(index, 1, task);
      else active.value.push(task);
      return;
    }
    if (index >= 0) active.value.splice(index, 1);
    finished.value = [task, ...finished.value.filter(item => item.id !== task.id)].slice(0, 20);
  }

  function appendLog(event: TaskLogEvent) {
    const lines = [...(logs.value[event.id] ?? []), ...event.lines];
    logs.value[event.id] = lines.slice(-LOG_LIMIT);
  }

  let upgradeTail: Promise<unknown> = Promise.resolve();

  function upgrade(targets: TaskTarget[], trigger: TaskTrigger, options: TaskOptions, batch: boolean): Promise<Task[]> {
    // Process repeated clicks in order; never replace an unanswered confirmation.
    const result = upgradeTail.then(async () => {
      const unique = [...new Map(targets.map(target => [packageKey(target.kind, target.token), target])).values()];
      const existing = unique.flatMap(target => {
        const task = forPackage(target.kind, target.token);
        return task ? [task] : [];
      });
      const fresh = unique.filter(target => !forPackage(target.kind, target.token));
      if (!fresh.length) return existing;
      const unattended = trigger === 'schedule' || trigger === 'bundle';
      const runningApps = unattended ? [] : await unwrap(commands.appsRunning(fresh));
      const choice = runningApps.length
        ? await useRunningAppsStore().ask(runningApps, batch)
        : { action: 'skip' as const, reopen: false };
      if (choice.action === 'cancel') return [];
      const runningKeys = new Set(runningApps.map(app => packageKey(app.target.kind, app.target.token)));
      const created = [...existing];
      for (const target of fresh) {
        const wasRunning = runningKeys.has(packageKey(target.kind, target.token));
        if (wasRunning && choice.action === 'skip') continue;
        const quitRunning = wasRunning && choice.action === 'quit' && !unattended;
        created.push(
          await unwrap(
            commands.taskEnqueue(
              'upgrade',
              target,
              {
                ...options,
                quitRunning,
                reopen: quitRunning && choice.reopen
              },
              trigger
            )
          )
        );
      }
      return created;
    });
    upgradeTail = result.catch(() => undefined);
    return result;
  }

  let installTail: Promise<unknown> = Promise.resolve();
  const installing = new Map<string, Promise<Task | null>>();
  function install(target: TaskTarget, trigger: TaskTrigger, options: TaskOptions): Promise<Task | null> {
    const key = packageKey(target.kind, target.token);
    const pending = installing.get(key);
    if (pending) return pending;
    const result = installTail.then(async () => {
      const existing = forPackage(target.kind, target.token);
      if (existing) return existing;
      const check = await unwrap(commands.installPreflight(target));
      if (check.status === 'managed') {
        await useLibraryStore().refresh();
        await useUpdatesStore().load();
        return null;
      }
      let adopt = false;
      if (check.status === 'conflict' || check.status === 'blocked') {
        if (trigger === 'schedule') return null;
        adopt = await useInstallConfirmStore().ask(check);
        if (!adopt) return null;
      }
      // Old task arguments or caller-supplied adopt cannot replace consent for this action.
      const task = await unwrap(commands.taskEnqueue('install', target, { ...options, adopt }, trigger));
      applyUpdate(task);
      return task;
    });
    installing.set(key, result);
    installTail = result.catch(() => undefined);
    void result.finally(() => installing.delete(key)).catch(() => undefined);
    return result;
  }

  async function enqueue(
    op: TaskOp,
    target: TaskTarget | null,
    trigger: TaskTrigger = 'manual',
    options: TaskOptions = {}
  ) {
    if (op === 'install' && target) return install(target, trigger, options);
    if (op === 'upgrade' && target) return (await upgrade([target], trigger, options, false))[0] ?? null;
    return unwrap(commands.taskEnqueue(op, target, options, trigger));
  }

  function enqueueMany(op: TaskOp, targets: TaskTarget[], trigger: TaskTrigger = 'manual', options: TaskOptions = {}) {
    if (op === 'install') {
      return Promise.all(targets.map(target => install(target, trigger, options))).then(tasks =>
        tasks.filter((task): task is Task => task !== null)
      );
    }
    if (op === 'upgrade') return upgrade(targets, trigger, options, true);
    return unwrap(commands.taskEnqueueMany(op, targets, options, trigger));
  }

  function cancel(id: string) {
    return unwrap(commands.taskCancel(id));
  }

  return {
    active,
    logs,
    finished,
    running,
    queued,
    forPackage,
    load,
    applyUpdate,
    appendLog,
    enqueue,
    enqueueMany,
    cancel
  };
});
