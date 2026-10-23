import type { Dictionary, Pattern } from './types';
import common from './common';
import app from './app';
import task from './task';
import workers from './workers';
import docs from './docs';
import settings from './settings';
import maintenance from './maintenance';
import * as server from './server';
import * as serverStore from './server-store';
import * as serverLogs from './server-logs';

/** Dictionaries by area; a text shared between areas must translate the same way. */
export const dictionaries: Record<string, Dictionary> = {
  common, app, task, workers, docs, settings, maintenance,
  server: server.messages, serverStore: serverStore.messages, serverLogs: serverLogs.messages,
};
export const en: Dictionary = Object.assign(Object.create(null) as Dictionary, ...Object.values(dictionaries));
export const enPatterns: readonly Pattern[] = [...server.patterns, ...serverStore.patterns, ...serverLogs.patterns];
