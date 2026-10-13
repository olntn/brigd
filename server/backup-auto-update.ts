import type { Database } from 'bun:sqlite';
import type { BackupManager } from './backups';

export const BACKUP_AUTO_UPDATE_INTERVAL_MS = 5_000;

interface SnapshotSignature {
  database: Database;
  selectedId: string;
  totalChanges: number;
  dataVersion: number;
}

/** Refresh a selected snapshot after writes, including writes from another SQLite connection. */
export class BackupAutoUpdater {
  private timer: ReturnType<typeof setInterval> | undefined;
  private signature: SnapshotSignature | undefined;
  private updating = false;
  private retryNeeded = false;

  constructor(
    private readonly backups: BackupManager,
    private readonly database: () => Database,
    private readonly onError?: (error: unknown) => void,
  ) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => this.tick(), BACKUP_AUTO_UPDATE_INTERVAL_MS);
    this.timer.unref?.();
    // Startup can follow a restart or restoration: the new database may have different contents.
    this.tick();
  }

  stop(): void {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    // Restoration pauses before installing a snapshot; never overwrite its target here.
    this.signature = undefined;
    this.retryNeeded = false;
  }

  /** Call after workers stop writing, while their database connection is still open. */
  flush(): void { this.refresh(true); }

  tick(): void { this.refresh(false); }

  private refresh(force: boolean): void {
    if (this.updating) return;
    this.updating = true;
    try {
      const { selectedId, enabled } = this.backups.getAutoUpdate();
      if (!enabled || selectedId === null) {
        this.signature = undefined;
        this.retryNeeded = false;
        return;
      }
      const database = this.database();
      const { totalChanges } = database.query('SELECT total_changes() AS totalChanges').get() as { totalChanges: number };
      const { data_version: dataVersion } = database.query('PRAGMA data_version').get() as { data_version: number };
      const next = { database, selectedId, totalChanges, dataVersion };
      const previous = this.signature;
      if (!force && !this.retryNeeded && previous?.database === database && previous.selectedId === selectedId &&
          previous.totalChanges === totalChanges && previous.dataVersion === dataVersion) return;
      // Keep the signature from before the snapshot. Concurrent commits must trigger the next tick.
      if (this.backups.updateSelected() !== null) {
        this.signature = next;
        this.retryNeeded = false;
      }
    } catch (error) {
      // Retain the last successful signature so that a failed snapshot is retried next time.
      this.retryNeeded = true;
      this.onError?.(error);
    } finally { this.updating = false; }
  }
}
