// preload.js


// window.addEventListener('DOMContentLoaded', () => {});


const { contextBridge } = require('electron');
contextBridge.exposeInMainWorld('agent', { version: '1.0' });
