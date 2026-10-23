/** Groups of data the interface reloads when `GET /api/events` reports a change. */
export const CHANGE_SCOPES = ['tasks', 'autopilot', 'instructions', 'docs', 'workers', 'tags', 'settings', 'backups'] as const;
export type ChangeScope = (typeof CHANGE_SCOPES)[number];

/** First event of every stream. `instance` changes whenever the service reopens its database. */
export interface ReadyEvent { instance: string; revision: number; }
/** Changes grouped over a short window; `revision` is the latest one included. */
export interface ChangeEvent { revision: number; scopes: ChangeScope[]; }
