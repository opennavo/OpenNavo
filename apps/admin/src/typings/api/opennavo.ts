// Always import admin API types from generated contracts; never handwrite them (07 §3, 04 §7.1).
import type { AdminComponents, AdminOperations } from '@opennavo/api';

export type Schemas = AdminComponents['schemas'];

type Operation = keyof AdminOperations;
type JsonContent<T> = T extends { content: { 'application/json': infer Body } } ? Body : never;

/** Operation query parameters (contract parameters.query). */
export type QueryOf<K extends Operation> = NonNullable<AdminOperations[K]['parameters']['query']>;

/** Operation JSON request body. */
export type BodyOf<K extends Operation> = JsonContent<NonNullable<AdminOperations[K]['requestBody']>>;

/** Successful operation data from {code, msg, data}; request layer already unwraps the envelope. */
export type DataOf<K extends Operation> =
  JsonContent<AdminOperations[K]['responses'][200]> extends { data?: infer Data } ? NonNullable<Data> : never;

/** One paginated list row. */
export type RecordOf<K extends Operation> = DataOf<K> extends { records: Array<infer Row> } ? Row : never;
