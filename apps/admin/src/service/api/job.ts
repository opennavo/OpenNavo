import type { DataOf, QueryOf, Schemas } from '@/typings/api/opennavo';
import { request } from '../request';

// Job center (07 §7.9).

export const fetchJobRuns = (params: QueryOf<'listJobRuns'>) =>
  request<DataOf<'listJobRuns'>>({ url: '/jobs/runs', params });

export const fetchJobRun = (id: number) => request<DataOf<'getJobRun'>>({ url: `/jobs/runs/${id}` });

export const fetchQueues = () => request<DataOf<'listQueues'>>({ url: '/jobs/queues' });

export const triggerJob = (jobType: Schemas['TriggerJobType']) =>
  request<DataOf<'triggerJob'>>({ url: `/jobs/trigger/${jobType}`, method: 'post' });
