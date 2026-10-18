'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const on = (ch) => (fn) => {
  const listener = (_e, payload) => fn(payload);
  ipcRenderer.on(ch, listener);
  return () => ipcRenderer.removeListener(ch, listener);
};

contextBridge.exposeInMainWorld('hesta', {
  init: invoke('app:init'),
  parseLinks: invoke('links:parse'),
  probe: invoke('probe:start'),
  cancelProbe: invoke('probe:cancel'),

  addJobs: invoke('jobs:add'),
  pause: invoke('jobs:pause'),
  resume: invoke('jobs:resume'),
  retry: invoke('jobs:retry'),
  remove: invoke('jobs:remove'),
  pauseAll: invoke('jobs:pauseAll'),
  resumeAll: invoke('jobs:resumeAll'),
  clearFinished: invoke('jobs:clearFinished'),
  jobMenu: invoke('jobs:menu'),

  openFile: invoke('file:open'),
  revealFile: invoke('file:reveal'),
  openFolder: invoke('folder:open'),
  chooseFolder: invoke('dialog:chooseFolder'),
  openExternal: invoke('external:open'),

  getSettings: invoke('settings:get'),
  setSettings: invoke('settings:set'),
  openSettings: invoke('settings:open'),

  engineInfo: invoke('engine:info'),
  updateEngine: invoke('engine:update'),
  setupEngine: invoke('engine:setup'),

  pathForFile: (file) => (webUtils?.getPathForFile ? webUtils.getPathForFile(file) : ''),

  onJobsChanged: on('jobs:changed'),
  onSummary: on('jobs:summary'),
  onEngineStatus: on('engine:status'),
  onSettings: on('settings:changed'),
  onClipboardLinks: on('clipboard:links'),
  onMenu: on('menu'),
  onMenuPaste: on('menu:paste'),
});
