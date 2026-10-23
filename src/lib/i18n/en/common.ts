import type { Dictionary } from './types';

const dictionary: Dictionary = {
  // Settings sections and the language switch.
  'Общие': 'General',
  'Язык': 'Language',
  'Внешний вид': 'Appearance',
  'Модели': 'Models',
  'Разрешения': 'Permissions',
  'Автопилот': 'Autopilot',
  'Параллельность': 'Concurrency',
  'Хранилище': 'Storage',
  'Бэкапы': 'Backups',
  'Язык интерфейса': 'Interface language',
  'Выбор сохраняется в этом браузере. Задачи, комментарии и ответы агентов остаются на языке, на котором написаны.':
    'Saved in this browser. Tasks, comments and agent answers stay in the language they were written in.',
  'Язык изменён, но браузер не разрешил сохранить выбор. После перезагрузки выберите язык снова.':
    'The language changed, but the browser did not allow saving the choice. Choose the language again after reloading.',
  // File size units.
  'Б': 'B',
  'КБ': 'KB',
  'МБ': 'MB',
  'ГБ': 'GB',
  'ТБ': 'TB',
};

export default dictionary;
