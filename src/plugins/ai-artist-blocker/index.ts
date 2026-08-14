// src/plugins/ai-artist-blocker/index.ts
//
// Pear Desktop plugin: blocks/skips tracks by artist, song, or title keyword

import style from './style.css?inline';
import { createPlugin } from '@/utils';

type ElectronMain = typeof import('electron');
let _electronMain: ElectronMain | null = null;
async function getElectronMain(): Promise<ElectronMain> {
  if (!_electronMain) {
    _electronMain = await import('electron');
  }
  return _electronMain;
}

interface BlockedSong {
  title: string;
  artist: string;
}

interface PluginConfig {
  enabled: boolean;
  blockedArtists: string[];
  blockedSongs: BlockedSong[];
  blockedKeywords: string[];
  syncZoundhub: boolean;
  zoundhubApiUrl: string;
  syncIntervalHours: number;
  zoundhubMinScore: number;
  hasPopulatedDefaults?: boolean;
  _keywordsJSON?: string;
  _artistsJSON?: string;
  _songsJSON?: string;
}

const DEFAULT_KEYWORDS = ['sped up', 'nightcore', 'commentary', 'live at', 'slowed down'];

const DEFAULT_CONFIG: PluginConfig = {
  enabled: true,
  blockedArtists: [],
  blockedSongs: [],
  blockedKeywords: [],
  syncZoundhub: true,
  zoundhubApiUrl: 'https://zoundhub.com/api/artists/all',
  syncIntervalHours: 24,
  zoundhubMinScore: 70,
  hasPopulatedDefaults: false,
};

const normalize = (s: string): string => s.trim().toLowerCase();

let backendConfigCache: PluginConfig = { ...DEFAULT_CONFIG };
let globalGetConfig: any = null;
let globalSetConfig: any = null;
let mainWindow: any = null;

function sanitizeArrays(cfg: Partial<PluginConfig>): PluginConfig {
  const base = { ...DEFAULT_CONFIG, ...cfg };

  const rawKeywords = Array.isArray(base.blockedKeywords) ? base.blockedKeywords : [];
  const uniqueKwMap = new Map<string, string>();
  for (const kw of rawKeywords) {
    if (typeof kw === 'string' && kw.trim()) {
      const norm = normalize(kw);
      if (!uniqueKwMap.has(norm)) {
        uniqueKwMap.set(norm, kw.trim());
      }
    }
  }

  const rawArtists = Array.isArray(base.blockedArtists) ? base.blockedArtists : [];
  const uniqueArtistMap = new Map<string, string>();
  for (const a of rawArtists) {
    if (typeof a === 'string' && a.trim()) {
      const norm = normalize(a);
      if (!uniqueArtistMap.has(norm)) {
        uniqueArtistMap.set(norm, a.trim());
      }
    }
  }

  const rawSongs = Array.isArray(base.blockedSongs) ? base.blockedSongs : [];
  const songMap = new Map<string, BlockedSong>();
  for (const s of rawSongs) {
    if (s && typeof s.title === 'string' && typeof s.artist === 'string') {
      const key = `${normalize(s.title)}|||${normalize(s.artist)}`;
      if (!songMap.has(key)) {
        songMap.set(key, { title: s.title.trim(), artist: s.artist.trim() });
      }
    }
  }

  return {
    ...base,
    blockedKeywords: Array.from(uniqueKwMap.values()),
    blockedArtists: Array.from(uniqueArtistMap.values()),
    blockedSongs: Array.from(songMap.values()),
  };
}

function parseDiskConfig(raw: any): PluginConfig {
  const mem = { ...DEFAULT_CONFIG, ...raw };
  if (typeof raw._keywordsJSON === 'string') {
    try { mem.blockedKeywords = JSON.parse(raw._keywordsJSON); } catch {}
  }
  if (typeof raw._artistsJSON === 'string') {
    try { mem.blockedArtists = JSON.parse(raw._artistsJSON); } catch {}
  }
  if (typeof raw._songsJSON === 'string') {
    try { mem.blockedSongs = JSON.parse(raw._songsJSON); } catch {}
  }
  return sanitizeArrays(mem);
}

async function updateAndSaveConfig(updates: Partial<PluginConfig>) {
  if (!globalGetConfig || !globalSetConfig) return backendConfigCache;

  const clean = sanitizeArrays({ ...backendConfigCache, ...updates });
  
  const payload: any = { 
    ...clean,
    blockedKeywords: [],
    blockedArtists: [],
    blockedSongs: [],
    _keywordsJSON: JSON.stringify(clean.blockedKeywords),
    _artistsJSON: JSON.stringify(clean.blockedArtists),
    _songsJSON: JSON.stringify(clean.blockedSongs),
  };

  await globalSetConfig(payload);
  backendConfigCache = clean;
  
  // Force an immediate layout tick before refreshing the menu structure
  await new Promise(resolve => setTimeout(resolve, 50));
  await forceMenuRefresh();

  if (mainWindow && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('ai-blocker:config-updated', clean);
  }
  return clean;
}

async function forceMenuRefresh() {
  try {
    const { Menu } = await getElectronMain();
    const appMenu = Menu.getApplicationMenu();
    if (!appMenu) return;

    const currentPluginMenu = await buildPluginMenu();

    const cloneMenuItem = (item: any): Electron.MenuItemConstructorOptions => {
      const clone: any = {};
      const keys = ['id', 'label', 'sublabel', 'toolTip', 'icon', 'role', 'type', 'enabled', 'checked', 'visible', 'accelerator', 'click'];
      for (const k of keys) {
        if (item[k] !== undefined) clone[k] = item[k];
      }

      if (item.submenu && item.submenu.items) {
        if (item.label === 'Plugins' || item.role === 'plugins') {
          clone.submenu = item.submenu.items.map((pluginItem: any) => {
            const isOurs = pluginItem.label === 'AI Artist Blocker' || pluginItem.label === 'AI Artist & Song Blocker';
            if (isOurs) {
              const newSubmenu = [...currentPluginMenu];
              const pearEnabled = pluginItem.submenu?.items?.find((i: any) => i.label === 'Enabled' && (i.type === 'checkbox' || i.type === 'normal'));
              if (pearEnabled) {
                newSubmenu.unshift({ type: 'separator' });
                newSubmenu.unshift({
                  label: 'Enabled',
                  type: pearEnabled.type as any,
                  checked: pearEnabled.checked,
                  click: pearEnabled.click
                });
              }

              return {
                label: pluginItem.label,
                submenu: newSubmenu
              };
            }
            return cloneMenuItem(pluginItem);
          });
        } else {
          clone.submenu = item.submenu.items.map(cloneMenuItem);
        }
      }
      return clone;
    };

    const newTemplate = appMenu.items.map(cloneMenuItem);
    Menu.setApplicationMenu(Menu.buildFromTemplate(newTemplate));

    if (mainWindow && !mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('refresh-in-app-menu');
    }
  } catch (err) {
    console.error('[ai-blocker] Menu rebuild error:', err);
  }
}

async function promptKeywordFromRenderer(window: any): Promise<string | null> {
  try {
    if (!window || !window.webContents) return null;
    
    // Defer execution out of the native menu click stack to prevent context lockup
    await new Promise(resolve => setTimeout(resolve, 100));

    const result = await window.webContents.executeJavaScript(`
      new Promise((resolve) => {
        const existing = document.getElementById('ai-blocker-prompt-overlay');
        if (existing) existing.remove();

        const overlay = document.createElement('div');
        overlay.id = 'ai-blocker-prompt-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;font-family:sans-serif;';
        const box = document.createElement('div');
        box.style.cssText = 'background:#222;color:#fff;padding:20px;border-radius:8px;min-width:320px;box-shadow:0 4px 24px rgba(0,0,0,0.5);';
        const label = document.createElement('div');
        label.textContent = 'Enter a keyword to block (e.g., "nightcore", "remix"):';
        label.style.cssText = 'margin-bottom:10px;font-size:14px;';
        const input = document.createElement('input');
        input.type = 'text';
        input.style.cssText = 'width:100%;box-sizing:border-box;padding:8px;border-radius:4px;border:1px solid #555;background:#111;color:#fff;font-size:14px;margin-bottom:12px;';
        const btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;gap:8px;';
        const cancelBtn = document.createElement('button');
        cancelBtn.textContent = 'Cancel';
        cancelBtn.style.cssText = 'padding:6px 14px;border-radius:4px;border:none;background:#444;color:#fff;cursor:pointer;';
        const okBtn = document.createElement('button');
        okBtn.textContent = 'OK';
        okBtn.style.cssText = 'padding:6px 14px;border-radius:4px;border:none;background:#3b82f6;color:#fff;cursor:pointer;';

        function cleanup(value) {
          overlay.remove();
          resolve(value);
        }

        cancelBtn.onclick = () => cleanup(null);
        okBtn.onclick = () => cleanup(input.value);
        input.addEventListener('keydown', (e) => {
          if (e.key === 'Enter') cleanup(input.value);
          if (e.key === 'Escape') cleanup(null);
        });

        btnRow.appendChild(cancelBtn);
        btnRow.appendChild(okBtn);
        box.appendChild(label);
        box.appendChild(input);
        box.appendChild(btnRow);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        input.focus();
      })
    `);
    return (result as string)?.trim() || null;
  } catch (err) {
    return null;
  }
}

async function buildPluginMenu(): Promise<Electron.MenuItemConstructorOptions[]> {
  const config = backendConfigCache;

  const keywordSubmenu: Electron.MenuItemConstructorOptions[] = [
    {
      label: '➕ Add keyword',
      click: () => {
        setImmediate(async () => {
          const newKeyword = await promptKeywordFromRenderer(mainWindow);
          if (newKeyword) {
            await updateAndSaveConfig({
              blockedKeywords: [...backendConfigCache.blockedKeywords, newKeyword],
            });
          }
        });
      },
    },
    { type: 'separator' },
  ];

  if (config.blockedKeywords.length === 0) {
    keywordSubmenu.push({ label: '(none yet)', enabled: false });
  } else {
    config.blockedKeywords.forEach((kw, index) => {
      keywordSubmenu.push({
        label: `✕ ${kw}`,
        click: () => {
          setImmediate(async () => {
            const next = backendConfigCache.blockedKeywords.filter((_, i) => i !== index);
            await updateAndSaveConfig({ blockedKeywords: next });
          });
        },
      });
    });
  }

  return [
    {
      label: 'Auto-block Zoundhub-flagged artists',
      type: 'checkbox',
      checked: config.syncZoundhub,
      click: () => {
        setImmediate(async () => {
          await updateAndSaveConfig({ syncZoundhub: !config.syncZoundhub });
        });
      },
    },
    {
      label: `Zoundhub min. AI score: ${config.zoundhubMinScore}`,
      submenu: [50, 60, 70, 80, 90].map((score) => ({
        label: `${score}+`,
        type: 'radio' as const,
        checked: config.zoundhubMinScore === score,
        click: () => {
          setImmediate(async () => {
            await updateAndSaveConfig({ zoundhubMinScore: score });
          });
        },
      })),
    },
    {
      label: 'Zoundhub cache size: ' + zoundhubCache.size,
      enabled: false,
    },
    { type: 'separator' },
    {
      label: `Blocked artists (${config.blockedArtists.length})`,
      submenu:
        config.blockedArtists.length === 0
          ? [{ label: '(none yet)', enabled: false }]
          : config.blockedArtists.map((artist, index) => ({
              label: `✕ ${artist}`,
              click: () => {
                setImmediate(async () => {
                  const next = backendConfigCache.blockedArtists.filter((_, i) => i !== index);
                  await updateAndSaveConfig({ blockedArtists: next });
                });
              },
            })),
    },
    {
      label: `Blocked songs (${config.blockedSongs.length})`,
      submenu:
        config.blockedSongs.length === 0
          ? [{ label: '(none yet)', enabled: false }]
          : config.blockedSongs.map((song, index) => ({
              label: `✕ ${song.title} — ${song.artist}`,
              click: () => {
                setImmediate(async () => {
                  const next = backendConfigCache.blockedSongs.filter((_, i) => i !== index);
                  await updateAndSaveConfig({ blockedSongs: next });
                });
              },
            })),
    },
    {
      label: `Keyword filters (${config.blockedKeywords.length})`,
      submenu: keywordSubmenu,
    },
    { type: 'separator' },
    {
      label: 'Reset keyword filters to defaults',
      click: () => {
        setImmediate(async () => {
          await updateAndSaveConfig({ blockedKeywords: [...DEFAULT_KEYWORDS] });
        });
      },
    },
    {
      label: 'Clear all blocklists',
      click: () => {
        setImmediate(async () => {
          await updateAndSaveConfig({
            blockedArtists: [],
            blockedSongs: [],
            blockedKeywords: [],
          });
        });
      },
    },
  ];
}

interface ZoundhubArtist {
  submithub_score?: number;
  name?: string;
  [key: string]: unknown;
}

function safeHandle(
  ipc: { handle: (channel: string, listener: (...args: any[]) => any) => void; removeHandler?: (channel: string) => void },
  channel: string,
  listener: (...args: any[]) => any,
) {
  try {
    ipc.removeHandler?.(channel);
  } catch {}
  ipc.handle(channel, listener);
}

let zoundhubCache = new Set<string>();

async function fetchZoundhubList(url: string, minScore: number): Promise<string[]> {
  const res = await fetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Zoundhub request failed: ${res.status}`);
  const data = await res.json();
  const list: ZoundhubArtist[] = Array.isArray(data) ? data : [];
  return list
    .filter((entry) => typeof entry.submithub_score === 'number' && entry.submithub_score >= minScore)
    .map((entry) => entry.name)
    .filter((name): name is string => Boolean(name))
    .map(normalize);
}

// ---------------------------------------------------------------------
// Renderer-process state
// ---------------------------------------------------------------------

let rendererConfig: PluginConfig = { ...DEFAULT_CONFIG };
let rendererZoundhubSet = new Set<string>();
let playerApi: any = null;

function extractArtistCandidates(rawArtist: string): string[] {
  if (!rawArtist) return [];

  const firstSegment = rawArtist.split('•')[0];
  const stripped = firstSegment.replace(/-\s*topic\s*$/i, '');

  const parts = stripped
    .split(/,|&|\bfeat\.?\b|\bfeaturing\b|\bwith\b|\bx\b/gi)
    .map((p) => p.trim())
    .filter(Boolean);

  const candidates = new Set<string>([stripped.trim(), ...parts]);
  return Array.from(candidates).filter(Boolean).map(normalize);
}

type BlockReason = 'artist' | 'song' | 'keyword' | 'zoundhub';

function getBlockReason(title: string, artist: string): BlockReason | null {
  if (!rendererConfig || rendererConfig.enabled === false) return null;

  const nTitle = normalize(title || '');
  const nArtist = normalize(artist || '');
  const artistCandidates = extractArtistCandidates(artist || '');

  const artists = Array.isArray(rendererConfig.blockedArtists) ? rendererConfig.blockedArtists : [];
  if (artists.some((a) => normalize(a) === nArtist)) return 'artist';

  const songs = Array.isArray(rendererConfig.blockedSongs) ? rendererConfig.blockedSongs : [];
  if (songs.some((s) => normalize(s.title) === nTitle && normalize(s.artist) === nArtist)) return 'song';

  const keywords = Array.isArray(rendererConfig.blockedKeywords) ? rendererConfig.blockedKeywords : [];
  if (keywords.some((k) => k && nTitle.includes(normalize(k)))) return 'keyword';

  if (
    rendererConfig.syncZoundhub &&
    artistCandidates.some((candidate) => rendererZoundhubSet.has(candidate))
  ) {
    return 'zoundhub';
  }

  return null;
}

function isBlocked(title: string, artist: string): boolean {
  return getBlockReason(title, artist) !== null;
}

export default createPlugin({
  name: () => 'AI Artist & Song Blocker (Zoundhub)',
  restartNeeded: false,
  config: DEFAULT_CONFIG,
  stylesheets: [style],

  menu: async ({ getConfig, setConfig, window }) => {
    globalGetConfig = getConfig;
    globalSetConfig = setConfig;
    mainWindow = window;

    const raw = await getConfig();
    backendConfigCache = parseDiskConfig(raw);
    
    if (!raw.hasPopulatedDefaults) {
      await updateAndSaveConfig({
        blockedKeywords: [...DEFAULT_KEYWORDS],
        hasPopulatedDefaults: true,
      });
    }

    return await buildPluginMenu();
  },

  backend: {
    async start({ window, ipc, getConfig, setConfig }) {
      globalGetConfig = getConfig;
      globalSetConfig = setConfig;
      mainWindow = window;
      
      const raw = await getConfig();
      backendConfigCache = parseDiskConfig(raw);

      const sync = async () => {
        if (!backendConfigCache.syncZoundhub) return;
        try {
          const names = await fetchZoundhubList(
            backendConfigCache.zoundhubApiUrl,
            backendConfigCache.zoundhubMinScore,
          );
          zoundhubCache = new Set(names);
          await forceMenuRefresh();
          if (window && !window.webContents.isDestroyed()) {
            window.webContents.send('ai-blocker:zoundhub-updated', [...zoundhubCache]);
          }
        } catch (err) {
          console.error('[ai-blocker] Zoundhub sync failed:', err);
        }
      };

      if (backendConfigCache.syncZoundhub) await sync();

      const intervalMs = Math.max(1, backendConfigCache.syncIntervalHours) * 60 * 60 * 1000;
      const timer = setInterval(sync, intervalMs);

      safeHandle(ipc, 'ai-blocker:get-zoundhub-list', () => [...zoundhubCache]);
      safeHandle(ipc, 'ai-blocker:force-sync', () => sync());

      safeHandle(ipc, 'ai-blocker:mutate-config', async (updates) => {
        return await updateAndSaveConfig(updates);
      });

      safeHandle(
        ipc,
        'ai-blocker:confirm-block',
        async (payload: { kind: 'artist' | 'song'; label: string }) => {
          const message =
            payload.kind === 'artist'
              ? `Block all tracks by "${payload.label}"?`
              : `Block "${payload.label}"?`;

          const { dialog } = await getElectronMain();
          const result = await dialog.showMessageBox(window, {
            type: 'question',
            title: payload.kind === 'artist' ? 'Block artist' : 'Block song',
            message,
            buttons: ['Cancel', 'Block'],
            defaultId: 1,
            cancelId: 0,
            noLink: true,
          });

          return result.response === 1;
        },
      );

      (this as any)._timer = timer;
    },
    stop() {
      if ((this as any)._timer) clearInterval((this as any)._timer);
    },
    onConfigChange(newCfg) {
      backendConfigCache = parseDiskConfig(newCfg);
      forceMenuRefresh();
    },
  },

  renderer: {
    async start(context) {
      const rawCfg = await context.getConfig();
      rendererConfig = parseDiskConfig(rawCfg);

      rendererZoundhubSet = new Set(
        ((await context.ipc.invoke('ai-blocker:get-zoundhub-list')) as string[]) ?? [],
      );

      context.ipc.on('ai-blocker:zoundhub-updated', (_e: unknown, list: string[]) => {
        rendererZoundhubSet = new Set(list);
      });

      context.ipc.on('ai-blocker:config-updated', (_e: unknown, newCfg: PluginConfig) => {
        rendererConfig = sanitizeArrays(newCfg);
      });

      const getCurrentTrackInfo = (): { title: string; artist: string } | null => {
        const titleEl = document.querySelector('.title.ytmusic-player-bar');
        const artistEl = document.querySelector(
          '.byline.ytmusic-player-bar a, .byline.ytmusic-player-bar',
        );
        const title = titleEl?.textContent?.trim();
        const artist = artistEl?.textContent?.trim();
        if (!title || !artist) return null;
        return { title, artist };
      };

      let lastSkipKey = '';
      let lastSkipAttemptAt = 0;
      let skipAttemptCount = 0;
      const SKIP_RETRY_MS = 1500;
      const MAX_SKIP_ATTEMPTS = 8;

      const attemptSkip = (info: { title: string; artist: string }, reason: string | null) => {
        const nextBtn = document.querySelector<HTMLElement>(
          '#next-button, .next-button.ytmusic-player-bar, tp-yt-paper-icon-button.next-button',
        );
        if (nextBtn) {
          nextBtn.click();
        } else {
          playerApi?.nextVideo?.();
        }
        console.log(
          `[ai-blocker] skip attempt #${skipAttemptCount} for blocked track (reason: ${reason}): ${info.artist} — ${info.title}`,
        );
      };

      const GIVE_UP_COOLDOWN_MS = 15000;

      const trySkipIfBlocked = () => {
        const info = getCurrentTrackInfo();
        if (!info) return;

        const key = `${info.title}|||${info.artist}`;
        const reason = getBlockReason(info.title, info.artist);

        if (reason !== null) {
          const now = Date.now();

          if (key !== lastSkipKey) {
            lastSkipKey = key;
            skipAttemptCount = 1;
            lastSkipAttemptAt = now;
            attemptSkip(info, reason);
          } else if (skipAttemptCount < MAX_SKIP_ATTEMPTS && now - lastSkipAttemptAt >= SKIP_RETRY_MS) {
            skipAttemptCount++;
            lastSkipAttemptAt = now;
            attemptSkip(info, reason);
          } else if (
            skipAttemptCount >= MAX_SKIP_ATTEMPTS &&
            now - lastSkipAttemptAt >= GIVE_UP_COOLDOWN_MS
          ) {
            skipAttemptCount = 1;
            lastSkipAttemptAt = now;
            attemptSkip(info, reason);
          } else if (skipAttemptCount === MAX_SKIP_ATTEMPTS) {
            skipAttemptCount++;
            console.warn(
              `[ai-blocker] gave up trying to skip "${info.title}" — ${info.artist} after ${MAX_SKIP_ATTEMPTS} attempts. Will try again in ${GIVE_UP_COOLDOWN_MS / 1000}s if it's still playing. The next/nextVideo controls may not be working — check selectors.`,
            );
          }
        } else {
          lastSkipKey = '';
          skipAttemptCount = 0;
        }
      };

      setInterval(trySkipIfBlocked, 1000);
      trySkipIfBlocked();

      const injectButtons = () => {
        const bar =
          document.querySelector('ytmusic-player-bar .middle-controls-buttons') ??
          document.querySelector('ytmusic-player-bar');
        if (!bar || document.getElementById('ai-blocker-artist-btn')) return;

        const makeBtn = (id: string, label: string, title: string, onClick: () => void | Promise<void>) => {
          const btn = document.createElement('button');
          btn.id = id;
          btn.textContent = label;
          btn.title = title;
          btn.className = 'ai-blocker-btn';
          btn.addEventListener('click', onClick);
          return btn;
        };

        const artistBtn = makeBtn('ai-blocker-artist-btn', '🚫 Artist', 'Block this artist', async () => {
          const info = getCurrentTrackInfo();
          if (!info) return;

          const confirmed = await context.ipc.invoke('ai-blocker:confirm-block', {
            kind: 'artist',
            label: info.artist,
          });
          if (!confirmed) return;

          const updatedArtists = [...(rendererConfig.blockedArtists || []), info.artist];
          rendererConfig = await context.ipc.invoke('ai-blocker:mutate-config', { blockedArtists: updatedArtists });
          trySkipIfBlocked(); 
        });

        const songBtn = makeBtn('ai-blocker-song-btn', '🚫 Song', 'Block this song', async () => {
          const info = getCurrentTrackInfo();
          if (!info) return;

          const confirmed = await context.ipc.invoke('ai-blocker:confirm-block', {
            kind: 'song',
            label: `${info.title} — ${info.artist}`,
          });
          if (!confirmed) return;

          const updatedSongs = [...(rendererConfig.blockedSongs || []), info];
          rendererConfig = await context.ipc.invoke('ai-blocker:mutate-config', { blockedSongs: updatedSongs });
          trySkipIfBlocked(); 
        });

        bar.appendChild(artistBtn);
        bar.appendChild(songBtn);
      };

      const observer = new MutationObserver(injectButtons);
      observer.observe(document.body, { childList: true, subtree: true });
      injectButtons();
    },

    onPlayerApiReady(api) {
      playerApi = api;
    },

    onConfigChange(newConfig: PluginConfig) {
      rendererConfig = parseDiskConfig(newConfig);
    },

    stop() {
      document.getElementById('ai-blocker-artist-btn')?.remove();
      document.getElementById('ai-blocker-song-btn')?.remove();
    },
  },
});
