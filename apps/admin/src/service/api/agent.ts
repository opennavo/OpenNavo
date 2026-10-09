import type { BodyOf, DataOf, QueryOf } from '@/typings/api/opennavo';
import { request } from '../request';

// System → Agent access (07 §10.2, 11 §2.2): global switch, limits, clients, tokens.

export const fetchAgentSettings = () => request<DataOf<'getAgentSettings'>>({ url: '/agent/settings' });

export const updateAgentSettings = (data: BodyOf<'updateAgentSettings'>) =>
  request<DataOf<'updateAgentSettings'>>({ url: '/agent/settings', method: 'put', data });

export const fetchAgentClients = (params: QueryOf<'listAgentClients'>) =>
  request<DataOf<'listAgentClients'>>({ url: '/agent/clients', params });

export const createAgentClient = (data: BodyOf<'createAgentClient'>) =>
  request<DataOf<'createAgentClient'>>({ url: '/agent/clients', method: 'post', data });

export const updateAgentClient = (id: number, data: BodyOf<'updateAgentClient'>) =>
  request<DataOf<'updateAgentClient'>>({ url: `/agent/clients/${id}`, method: 'put', data });

export const fetchAgentTokens = (clientId: number, params: QueryOf<'listAgentTokens'>) =>
  request<DataOf<'listAgentTokens'>>({ url: `/agent/clients/${clientId}/tokens`, params });

/** Creation response is the only plaintext token disclosure. */
export const createAgentToken = (clientId: number, data: BodyOf<'createAgentToken'>) =>
  request<DataOf<'createAgentToken'>>({ url: `/agent/clients/${clientId}/tokens`, method: 'post', data });

export const updateAgentToken = (id: number, data: BodyOf<'updateAgentToken'>) =>
  request<DataOf<'updateAgentToken'>>({ url: `/agent/tokens/${id}`, method: 'put', data });

export const revokeAgentToken = (id: number) =>
  request<DataOf<'revokeAgentToken'>>({ url: `/agent/tokens/${id}/revoke`, method: 'post' });

// Operations → Agent and AI logs (07 §10.4, 11 §4).

export const fetchAgentCalls = (params: QueryOf<'listAgentCalls'>) =>
  request<DataOf<'listAgentCalls'>>({ url: '/agent/calls', params });

export const fetchAgentCall = (id: number) => request<DataOf<'getAgentCall'>>({ url: `/agent/calls/${id}` });
