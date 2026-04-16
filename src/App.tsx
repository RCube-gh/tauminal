import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { WebviewWindow } from '@tauri-apps/api/webviewWindow'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { useEffect, useRef, useState } from 'react'
import './App.css'

type TerminalCreated = {
  id: string
  shell: string
}

type TerminalOutputEvent = {
  id: string
  data: string
}

type TabModel = {
  id: string
  label: string
  shell: string
  cwd: string
}

type TabRuntime = {
  fitAddon: FitAddon
  sessionId: string | null
  shell: string
  terminal: Terminal
}

const appWindow = getCurrentWindow()
const resizeDirections = [
  'North',
  'East',
  'South',
  'West',
  'NorthEast',
  'SouthEast',
  'SouthWest',
  'NorthWest',
] as const

function useStickyState<T>(defaultValue: T, key: string): [T, React.Dispatch<React.SetStateAction<T>>] {
  const [value, setValue] = useState<T>(() => {
    const stickyValue = window.localStorage.getItem(key)
    return stickyValue !== null ? (JSON.parse(stickyValue) as T) : defaultValue
  })

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(value))
  }, [key, value])

  return [value, setValue]
}

function App() {
  const nextTabIdRef = useRef(1)
  const initializedRef = useRef(false)
  const listenersReadyRef = useRef(false)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const menuButtonRef = useRef<HTMLButtonElement | null>(null)
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const tabContainersRef = useRef(new Map<string, HTMLDivElement>())
  const runtimesRef = useRef(new Map<string, TabRuntime>())
  const [tabs, setTabs] = useState<TabModel[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const [isSearchOpen, setIsSearchOpen] = useState(false)
  const [isOverviewOpen, setIsOverviewOpen] = useState(false)
  const [isAboutOpen, setIsAboutOpen] = useState(false)
  const [isShortcutsOpen, setIsShortcutsOpen] = useState(false)
  const [isFullscreen, setIsFullscreen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [searchStatus, setSearchStatus] = useState('')
  const [isAdmin, setIsAdmin] = useState(false) // Ready for rust hook!
  const [zoomLevel, setZoomLevel] = useStickyState(14.5, 'prefs:zoomLevel')
  const [themeName, setThemeName] = useStickyState<'dark' | 'light'>('dark', 'prefs:themeName')
  const [closedSessionId, setClosedSessionId] = useState<string | null>(null)

  const [isPreferencesOpen, setIsPreferencesOpen] = useState(false)
  const [useSystemFont, setUseSystemFont] = useStickyState(true, 'prefs:useSystemFont')
  const [customFont, setCustomFont] = useStickyState('Consolas', 'prefs:customFont')
  const [unlimitedScrollback, setUnlimitedScrollback] = useStickyState(false, 'prefs:unlimitedScrollback')
  const [scrollbackLines, setScrollbackLines] = useStickyState(10000, 'prefs:scrollbackLines')
  const [bellSound, setBellSound] = useStickyState(false, 'prefs:bellSound')
  const [bellVisual, setBellVisual] = useStickyState(true, 'prefs:bellVisual')

  const activeTabIdRef = useRef(activeTabId)
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? null
  const titleText = activeTab?.cwd ?? '~'

  useEffect(() => {
    if (initializedRef.current) {
      return
    }

    initializedRef.current = true
    const firstTabId = `tab-${nextTabIdRef.current++}`
    setTabs([{ id: firstTabId, label: 'Tab 1', shell: 'starting...', cwd: '~' }])
    setActiveTabId(firstTabId)
  }, [])

  useEffect(() => {
    if (listenersReadyRef.current) {
      return
    }

    listenersReadyRef.current = true

    let disposed = false
    const unlistenPromise = listen<TerminalOutputEvent>(
      'terminal-output',
      (event) => {
        if (disposed) {
          return
        }

        for (const runtime of runtimesRef.current.values()) {
          if (runtime.sessionId === event.payload.id) {
            runtime.terminal.write(event.payload.data)
            break
          }
        }
      },
    )

    const unlistenExitedPromise = listen<{ id: string }>(
      'terminal-exited',
      (event) => {
        if (disposed) return
        setClosedSessionId(event.payload.id)
      }
    )

    return () => {
      disposed = true
      void unlistenPromise.then((unlisten) => unlisten())
      void unlistenExitedPromise.then((unlisten) => unlisten())
    }
  }, [])

  useEffect(() => {
    void appWindow.isFullscreen().then(setIsFullscreen)
  }, [])

  useEffect(() => {
    if (closedSessionId) {
      const tab = tabs.find((t) => runtimesRef.current.get(t.id)?.sessionId === closedSessionId)
      if (tab) {
        void closeTab(tab.id)
      }
      setClosedSessionId(null)
    }
  }, [closedSessionId, tabs])

  useEffect(() => {
    const isDark = themeName === 'dark'
    const newTheme = {
       background: isDark ? '#1e1e1e' : '#ffffff',
       foreground: isDark ? '#deddda' : '#171421',
       black: isDark ? '#3d3846' : '#ffffff',
       red: '#ed333b',
       green: '#57e389',
       yellow: isDark ? '#f6d32d' : '#e9ad0c',
       blue: '#3584e4',
       magenta: '#9141ac',
       cyan: '#33c7de',
       white: isDark ? '#c0bfbc' : '#241f31',
       brightBlack: '#77767b',
       brightRed: '#f66151',
       brightGreen: '#8ff0a4',
       brightYellow: '#f9f06b',
       brightBlue: '#78aeed',
       brightMagenta: '#c061cb',
       brightCyan: '#63d5fd',
       brightWhite: isDark ? '#ffffff' : '#000000',
       selectionBackground: isDark ? '#ffffff20' : '#00000020',
    }

    document.body.className = isDark ? '' : 'theme-light'

    for (const runtime of runtimesRef.current.values()) {
      runtime.terminal.options.fontSize = zoomLevel
      runtime.terminal.options.theme = newTheme
      runtime.terminal.options.fontFamily = useSystemFont ? 'inherit' : customFont
      runtime.terminal.options.scrollback = unlimitedScrollback ? 9999999 : scrollbackLines
      runtime.terminal.options.bellStyle = (bellSound && bellVisual) ? 'both' : (bellSound ? 'sound' : (bellVisual ? 'visual' : 'none'))
      runtime.fitAddon.fit()
    }
  }, [
    zoomLevel, themeName, useSystemFont, customFont, 
    unlimitedScrollback, scrollbackLines, bellSound, bellVisual
  ])

  useEffect(() => {
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node

      if (
        isMenuOpen &&
        menuRef.current &&
        !menuRef.current.contains(target) &&
        menuButtonRef.current &&
        !menuButtonRef.current.contains(target)
      ) {
        setIsMenuOpen(false)
      }
    }

    document.addEventListener('mousedown', handlePointerDown)
    return () => {
      document.removeEventListener('mousedown', handlePointerDown)
    }
  }, [isMenuOpen])

  useEffect(() => {
    if (!isSearchOpen) {
      return
    }

    const timer = window.setTimeout(() => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [isSearchOpen])

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!(event.ctrlKey || event.metaKey)) {
        return
      }

      const key = event.key.toLowerCase()
      if (event.ctrlKey || event.metaKey) {
        if (key === '=' || key === '+') {
          event.preventDefault()
          setZoomLevel((z) => Math.min(z + 1, 30))
          return
        }
        if (key === '-') {
          event.preventDefault()
          setZoomLevel((z) => Math.max(z - 1, 8))
          return
        }
        if (key === '0') {
          event.preventDefault()
          setZoomLevel(14.5)
          return
        }
      }

      if (event.shiftKey && key === 'f') {
        event.preventDefault()
        setIsSearchOpen(true)
        setIsMenuOpen(false)
        return
      }

      if (event.shiftKey && key === 't') {
        event.preventDefault()
        void createTab()
        return
      }

      if (event.shiftKey && key === 'o') {
        event.preventDefault()
        setIsOverviewOpen(true)
        setIsMenuOpen(false)
        return
      }

      if (key === 'tab') {
        event.preventDefault()
        setTabs((currentTabs) => {
          if (currentTabs.length < 2 || !activeTabId) {
            return currentTabs
          }

          const currentIndex = currentTabs.findIndex((tab) => tab.id === activeTabId)
          if (currentIndex < 0) {
            return currentTabs
          }

          const delta = event.shiftKey ? -1 : 1
          const nextIndex =
            (currentIndex + delta + currentTabs.length) % currentTabs.length
          setActiveTabId(currentTabs[nextIndex]?.id ?? activeTabId)
          return currentTabs
        })
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [activeTabId, tabs.length])

  useEffect(() => {
    for (const tab of tabs) {
      if (runtimesRef.current.has(tab.id)) {
        continue
      }

      const container = tabContainersRef.current.get(tab.id)
      if (!container) {
        continue
      }

      const terminal = new Terminal({
        allowTransparency: true,
        cursorBlink: true,
        cursorStyle: 'block',
        fontFamily: useSystemFont ? 'inherit' : customFont,
        fontSize: zoomLevel,
        lineHeight: 1.24,
        letterSpacing: 0,
        scrollback: unlimitedScrollback ? 9999999 : scrollbackLines,
        bellStyle: (bellSound && bellVisual) ? 'both' : (bellSound ? 'sound' : (bellVisual ? 'visual' : 'none')),
        theme: {
          background: themeName === 'light' ? '#ffffff' : '#1e1e1e',
          foreground: themeName === 'light' ? '#171421' : '#deddda',
          black: '#3d3846',
          red: '#ed333b',
          green: '#57e389',
          yellow: '#f6d32d',
          blue: '#3584e4',
          magenta: '#9141ac',
          cyan: '#33c7de',
          white: themeName === 'light' ? '#241f31' : '#c0bfbc',
          brightBlack: '#77767b',
          brightRed: '#f66151',
          brightGreen: '#8ff0a4',
          brightYellow: '#f9f06b',
          brightBlue: '#78aeed',
          brightMagenta: '#c061cb',
          brightCyan: '#63d5fd',
          brightWhite: themeName === 'light' ? '#000000' : '#ffffff',
          selectionBackground: themeName === 'light' ? '#00000020' : '#ffffff20',
        },
      })
      const fitAddon = new FitAddon()

      terminal.parser.registerOscHandler(7, (data) => {
        try {
          const uri = new URL(data)
          let path = decodeURI(uri.pathname)
          if (path.match(/^\/[a-zA-Z]:/)) {
            path = path.slice(1) // Remove leading slash on Windows drives
          }
          setTabs((currentTabs) =>
            currentTabs.map((t) => (t.id === tab.id ? { ...t, cwd: path } : t))
          )
        } catch {
          // ignore bad uri
          setTabs((currentTabs) =>
            currentTabs.map((t) => (t.id === tab.id ? { ...t, cwd: data } : t))
          )
        }
        return true
      })

      terminal.loadAddon(fitAddon)
      terminal.open(container)

      const runtime: TabRuntime = {
        fitAddon,
        sessionId: null,
        shell: 'starting...',
        terminal,
      }

      runtimesRef.current.set(tab.id, runtime)

      terminal.onData((data) => {
        if (!runtime.sessionId) {
          return
        }

        void invoke('terminal_write', {
          id: runtime.sessionId,
          data,
        }).catch((error) => {
          runtime.terminal.writeln(
            `\r\n\x1b[31mWrite error:\x1b[0m ${String(error)}`,
          )
        })
      })

      requestAnimationFrame(() => {
        fitAddon.fit()
        void invoke<TerminalCreated>('create_terminal', {
          cols: terminal.cols,
          rows: terminal.rows,
        })
          .then((created) => {
            runtime.sessionId = created.id
            runtime.shell = created.shell
            setTabs((currentTabs) =>
              currentTabs.map((currentTab) =>
                currentTab.id === tab.id
                  ? {
                      ...currentTab,
                      label:
                        created.shell.split(/[/\\]/).filter(Boolean).pop() ??
                        currentTab.label,
                      shell: created.shell,
                    }
                  : currentTab,
              ),
            )
            terminal.clear()
            terminal.focus()
          })
          .catch((error) => {
            terminal.writeln(
              `\r\n\x1b[31mFailed to create terminal session:\x1b[0m ${String(error)}`,
            )
          })
      })
    }
  }, [
    tabs, zoomLevel, themeName, useSystemFont, customFont, 
    unlimitedScrollback, scrollbackLines, bellSound, bellVisual
  ])

  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface) {
      return
    }

    const fitAll = () => {
      for (const runtime of runtimesRef.current.values()) {
        runtime.fitAddon.fit()

        if (!runtime.sessionId) {
          continue
        }

        void invoke('terminal_resize', {
          id: runtime.sessionId,
          cols: runtime.terminal.cols,
          rows: runtime.terminal.rows,
        }).catch(() => {})
      }
    }

    const resizeObserver = new ResizeObserver(() => {
      fitAll()
    })

    resizeObserver.observe(surface)
    window.addEventListener('resize', fitAll)
    const timer = window.setTimeout(() => {
      fitAll()
    }, 0)

    return () => {
      resizeObserver.disconnect()
      window.removeEventListener('resize', fitAll)
      window.clearTimeout(timer)
    }
  }, [])

  useEffect(() => {
    if (!activeTabId) {
      return
    }

    const runtime = runtimesRef.current.get(activeTabId)
    if (!runtime) {
      return
    }

    const timer = window.setTimeout(() => {
      runtime.fitAddon.fit()
      runtime.terminal.focus()
    }, 0)

    return () => {
      window.clearTimeout(timer)
    }
  }, [activeTabId, tabs.length])

  useEffect(() => {
    return () => {
      for (const runtime of runtimesRef.current.values()) {
        if (runtime.sessionId) {
          void invoke('terminal_kill', { id: runtime.sessionId }).catch(() => {})
        }
        runtime.terminal.dispose()
      }

      runtimesRef.current.clear()
    }
  }, [])

  async function createTab() {
    const tabIndex = nextTabIdRef.current
    const id = `tab-${tabIndex}`
    nextTabIdRef.current += 1

    setTabs((currentTabs) => [
      ...currentTabs,
      {
        id,
        label: `Tab ${tabIndex}`,
        shell: 'starting...',
        cwd: '~',
      },
    ])
    setActiveTabId(id)
    setIsOverviewOpen(false)
    setIsMenuOpen(false)
  }

  async function closeTab(tabId: string) {
    const runtime = runtimesRef.current.get(tabId)
    if (runtime?.sessionId) {
      await invoke('terminal_kill', { id: runtime.sessionId }).catch(() => {})
    }

    runtime?.terminal.dispose()
    runtimesRef.current.delete(tabId)
    tabContainersRef.current.delete(tabId)

    setTabs((currentTabs) => {
      const closingIndex = currentTabs.findIndex((tab) => tab.id === tabId)
      const nextTabs = currentTabs.filter((tab) => tab.id !== tabId)

      if (nextTabs.length === 0) {
        void appWindow.close()
        return nextTabs
      }

      if (activeTabId === tabId) {
        const nextActive =
          nextTabs[Math.max(0, closingIndex - 1)] ?? nextTabs[0] ?? null
        setActiveTabId(nextActive?.id ?? null)
      }

      return nextTabs
    })

    setIsOverviewOpen(false)
    setIsMenuOpen(false)
  }

  async function toggleFullscreen() {
    const nextFullscreen = !(await appWindow.isFullscreen())
    await appWindow.setFullscreen(nextFullscreen)
    setIsFullscreen(nextFullscreen)
    setIsMenuOpen(false)
  }

  async function copySelection() {
    const runtime = activeTabId ? runtimesRef.current.get(activeTabId) : null
    const selection = runtime?.terminal.getSelection() ?? ''

    if (!selection) {
      setSearchStatus('Nothing selected.')
      setIsMenuOpen(false)
      return
    }

    await navigator.clipboard.writeText(selection)
    setSearchStatus('Selection copied.')
    setIsMenuOpen(false)
  }

  async function pasteClipboard() {
    const runtime = activeTabId ? runtimesRef.current.get(activeTabId) : null
    if (!runtime?.sessionId) {
      return
    }

    const text = await navigator.clipboard.readText()
    if (!text) {
      return
    }

    await invoke('terminal_write', {
      id: runtime.sessionId,
      data: text,
    })
    runtime.terminal.focus()
    setIsMenuOpen(false)
  }

  function getActiveRuntime() {
    if (!activeTabId) {
      return null
    }

    return runtimesRef.current.get(activeTabId) ?? null
  }

  function searchTerminal(direction: 1 | -1) {
    const query = searchQuery.trim()
    const runtime = getActiveRuntime()

    if (!runtime || !query) {
      setSearchStatus('Enter text to search.')
      return
    }

    const terminal = runtime.terminal
    const buffer = terminal.buffer.active
    const normalizedQuery = query.toLocaleLowerCase()
    const lineCount = buffer.length
    let startRow = terminal.buffer.active.viewportY

    if (terminal.hasSelection()) {
      const selectionPosition = terminal.getSelectionPosition()
      if (selectionPosition) {
        startRow = selectionPosition.start.y
      }
    }

    for (let offset = 0; offset < lineCount; offset++) {
      const step = direction === 1 ? offset + 1 : -(offset + 1)
      const row =
        (startRow + step + lineCount * 4) %
        Math.max(1, lineCount)
      const line = buffer.getLine(row)?.translateToString(true) ?? ''
      const column = line.toLocaleLowerCase().indexOf(normalizedQuery)

      if (column < 0) {
        continue
      }

      terminal.clearSelection()
      terminal.select(column, row, query.length)
      terminal.scrollToLine(Math.max(0, row - 3))
      terminal.focus()
      setSearchStatus(`Match at line ${row + 1}.`)
      return
    }

    terminal.clearSelection()
    setSearchStatus(`No match for "${query}".`)
  }

  function registerTabContainer(tabId: string, element: HTMLDivElement | null) {
    if (element) {
      tabContainersRef.current.set(tabId, element)
      return
    }

    tabContainersRef.current.delete(tabId)
  }

  async function showNewWindow() {
    const label = `window-${Date.now()}`
    new WebviewWindow(label, {
      title: 'my-terminal',
      width: 700,
      height: 460,
      minWidth: 410,
      minHeight: 280,
      decorations: false,
      transparent: true,
      shadow: false,
    })
    setIsMenuOpen(false)
  }

  const handleTitlebarDoubleClick = async () => {
    await appWindow.toggleMaximize()
  }

  return (
    <main className="app-shell">
      <section className="window-frame">
        {resizeDirections.map((direction) => (
          <button
            key={direction}
            aria-hidden="true"
            className={`resize-handle resize-${direction.toLowerCase()}`}
            onMouseDown={() => {
              void appWindow.startResizeDragging(direction)
            }}
            tabIndex={-1}
            type="button"
          />
        ))}

        <header
          className={`titlebar${isAdmin ? ' is-admin' : ''}`}
          data-tauri-drag-region
          onDoubleClick={() => {
            void handleTitlebarDoubleClick()
          }}
        >
          <button
            aria-label="Find in terminal"
            className={`header-icon search-button${isSearchOpen ? ' is-active' : ''}`}
            data-window-control="true"
            onClick={() => {
              setIsSearchOpen((current) => !current)
              setIsMenuOpen(false)
            }}
            type="button"
          >
            <svg
              aria-hidden="true"
              className="search-icon"
              viewBox="0 0 18 18"
            >
              <circle cx="7.5" cy="7.5" r="5" />
              <path d="M11.2 11.2 L15.4 15.4" />
            </svg>
          </button>

          <div className="title-copy" data-tauri-drag-region>
            <span className="title-main">{titleText}</span>
          </div>

          <div className="header-actions">
            <button
              aria-label="New tab"
              className="header-icon"
              data-window-control="true"
              onClick={() => {
                void createTab()
              }}
              type="button"
            >
              <span className="plus-icon" />
            </button>
            <button
              aria-label="Main menu"
              className={`header-icon${isMenuOpen ? ' is-active' : ''}`}
              data-window-control="true"
              onClick={() => {
                setIsMenuOpen((current) => !current)
                setIsOverviewOpen(false)
              }}
              ref={menuButtonRef}
              type="button"
            >
              <span className="menu-icon" />
            </button>
            <button
              aria-label="Close window"
              className="close-button"
              data-window-control="true"
              onClick={() => {
                void appWindow.close()
              }}
              type="button"
            >
              <span className="close-icon" />
            </button>
          </div>
        </header>

        {isSearchOpen ? (
          <section className="search-strip">
            <input
              className="search-input"
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setSearchStatus('')
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  searchTerminal(event.shiftKey ? -1 : 1)
                }

                if (event.key === 'Escape') {
                  setIsSearchOpen(false)
                }
              }}
              placeholder="Find in terminal"
              ref={searchInputRef}
              type="text"
              value={searchQuery}
            />
            <button
              className="search-action"
              onClick={() => {
                searchTerminal(-1)
              }}
              type="button"
            >
              Prev
            </button>
            <button
              className="search-action"
              onClick={() => {
                searchTerminal(1)
              }}
              type="button"
            >
              Next
            </button>
            <button
              aria-label="Close search"
              className="search-close"
              onClick={() => {
                setIsSearchOpen(false)
              }}
              type="button"
            >
              ×
            </button>
          </section>
        ) : null}

        {tabs.length > 1 ? (
          <section className="tab-bar" aria-label="Tabs">
            {tabs.map((tab) => (
              <div
                className={`tab-chip${tab.id === activeTabId ? ' is-active' : ''}`}
                key={tab.id}
              >
                <button
                  className="tab-chip-main"
                  onClick={() => {
                    setActiveTabId(tab.id)
                  }}
                  type="button"
                >
                  <span className="tab-chip-title">{tab.label}</span>
                </button>
                <button
                  aria-label={`Close ${tab.label}`}
                  className="tab-chip-close"
                  onClick={() => {
                    void closeTab(tab.id)
                  }}
                  type="button"
                >
                  ×
                </button>
              </div>
            ))}
          </section>
        ) : null}

        {isMenuOpen ? (
          <div className="menu-popover" ref={menuRef}>
            <div className="menu-section">
              <div
                className="menu-item row-layout toggle-row"
                onClick={() => setThemeName((t) => (t === 'dark' ? 'light' : 'dark'))}
              >
                <span>Theme</span>
                <span className="toggle-indicator">{themeName === 'dark' ? '🌗' : '☀️'}</span>
              </div>
            </div>
            <div className="menu-section">
              <div className="menu-item row-layout zoom-controls">
                <button
                  className="icon-btn"
                  onClick={() => setZoomLevel((z) => Math.max(z - 1, 8))}
                  type="button"
                >
                  -
                </button>
                <span>{Math.round((zoomLevel / 14.5) * 100)}%</span>
                <button
                  className="icon-btn"
                  onClick={() => setZoomLevel((z) => Math.min(z + 1, 30))}
                  type="button"
                >
                  +
                </button>
              </div>
            </div>
            <hr className="menu-divider" />
            <button
              className="menu-item"
              onClick={() => {
                void showNewWindow()
              }}
              type="button"
            >
              New Window
            </button>
            <hr className="menu-divider" />
            <button
              className="menu-item"
              onClick={() => {
                setIsOverviewOpen(true)
                setIsMenuOpen(false)
              }}
              type="button"
            >
              Show All Tabs
            </button>
            <button
              className="menu-item"
              onClick={() => {
                void toggleFullscreen()
              }}
              type="button"
            >
              {isFullscreen ? 'Leave Fullscreen' : 'Fullscreen'}
            </button>
            <hr className="menu-divider" />
            <button
              className="menu-item"
              onClick={() => {
                setIsPreferencesOpen(true)
                setIsMenuOpen(false)
              }}
              type="button"
            >
              Preferences
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setIsShortcutsOpen(true)
                setIsMenuOpen(false)
              }}
              type="button"
            >
              Keyboard Shortcuts
            </button>
            <button
              className="menu-item"
              onClick={() => {
                setIsAboutOpen(true)
                setIsMenuOpen(false)
              }}
              type="button"
            >
              About Console
            </button>
            <button
              className="menu-item is-danger"
              onClick={() => {
                if (activeTabId) {
                  void closeTab(activeTabId)
                }
              }}
              type="button"
            >
              Close Tab
            </button>
          </div>
        ) : null}

        <section className="terminal-surface" ref={surfaceRef}>
          <div className="terminal-host">
            {tabs.map((tab) => (
              <div
                aria-hidden={tab.id !== activeTabId}
                className={`terminal-panel${tab.id === activeTabId ? ' is-active' : ''}`}
                key={tab.id}
                ref={(element) => {
                  registerTabContainer(tab.id, element)
                }}
              />
            ))}
          </div>
        </section>

        {searchStatus ? (
          <div className="status-toast" role="status">
            {searchStatus}
          </div>
        ) : null}

        {isOverviewOpen ? (
          <div
            className="overlay-backdrop"
            onClick={() => {
              setIsOverviewOpen(false)
            }}
          >
            <section
              className="overlay-card tabs-card"
              onClick={(event) => {
                event.stopPropagation()
              }}
            >
              <h2>All Tabs</h2>
              <div className="tabs-list">
                {tabs.map((tab) => (
                  <div
                    className={`tabs-list-item${tab.id === activeTabId ? ' is-active' : ''}`}
                    key={tab.id}
                  >
                    <button
                      className="tabs-list-main"
                      onClick={() => {
                        setActiveTabId(tab.id)
                        setIsOverviewOpen(false)
                      }}
                      type="button"
                    >
                      <span>{tab.label}</span>
                      <span className="tabs-list-shell">{tab.shell}</span>
                    </button>
                    <button
                      aria-label={`Close ${tab.label}`}
                      className="tabs-list-close"
                      onClick={() => {
                        void closeTab(tab.id)
                      }}
                      type="button"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </section>
          </div>
        ) : null}

        {isPreferencesOpen && (
          <div
            className="overlay-backdrop"
            onPointerDown={() => setIsPreferencesOpen(false)}
          >
            <div
              className="overlay-card preferences-card"
              onPointerDown={(e) => e.stopPropagation()}
            >
              <div style={{ marginBottom: '16px' }}>
                <h2 style={{ fontSize: '1.2rem', fontWeight: 600, margin: 0 }}>Preferences</h2>
              </div>

              <div className="preferences-body">
                <div className="preferences-group">
                  <h3>Font</h3>
                  <label className="preferences-row">
                    <div className="row-info">
                      <span>Use System Default</span>
                    </div>
                    <input
                      type="checkbox"
                      className="toggle-switch"
                      checked={useSystemFont}
                      onChange={(e) => setUseSystemFont(e.target.checked)}
                    />
                  </label>
                  {!useSystemFont && (
                    <label className="preferences-row">
                      <div className="row-info">
                        <span>Custom Font</span>
                      </div>
                      <input
                        type="text"
                        className="text-input"
                        value={customFont}
                        onChange={(e) => setCustomFont(e.target.value)}
                      />
                    </label>
                  )}
                </div>

                <div className="preferences-group">
                  <h3>Behavior</h3>
                  <label className="preferences-row">
                    <div className="row-info">
                      <span>Unlimited Scrollback</span>
                    </div>
                    <input
                      type="checkbox"
                      className="toggle-switch"
                      checked={unlimitedScrollback}
                      onChange={(e) => setUnlimitedScrollback(e.target.checked)}
                    />
                  </label>
                  {!unlimitedScrollback && (
                    <label className="preferences-row">
                      <div className="row-info">
                        <span>Scrollback Lines</span>
                      </div>
                      <input
                        type="number"
                        min="0"
                        max="800000"
                        step="1000"
                        className="text-input"
                        value={scrollbackLines}
                        onChange={(e) => setScrollbackLines(Number(e.target.value))}
                      />
                    </label>
                  )}
                </div>

                <div className="preferences-group">
                  <h3>Terminal Bell</h3>
                  <label className="preferences-row">
                    <div className="row-info">
                      <span>Play Sound</span>
                    </div>
                    <input
                      type="checkbox"
                      className="toggle-switch"
                      checked={bellSound}
                      onChange={(e) => setBellSound(e.target.checked)}
                    />
                  </label>
                  <label className="preferences-row">
                    <div className="row-info">
                      <span>Visual Effects</span>
                    </div>
                    <input
                      type="checkbox"
                      className="toggle-switch"
                      checked={bellVisual}
                      onChange={(e) => setBellVisual(e.target.checked)}
                    />
                  </label>
                </div>
              </div>
              
              <div style={{ textAlign: 'right', marginTop: '16px' }}>
                <button
                  className="dialog-action"
                  onClick={() => setIsPreferencesOpen(false)}
                  type="button"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {isAboutOpen ? (
          <div
            className="overlay-backdrop"
            onClick={() => {
              setIsAboutOpen(false)
            }}
          >
            <section
              className="overlay-card"
              onClick={(event) => {
                event.stopPropagation()
              }}
            >
              <h2>About</h2>
              <p>
                This build borrows its header layout and interaction model from
                GNOME Console / KGX while keeping a Tauri + xterm.js terminal
                core.
              </p>
              <button
                className="dialog-action"
                onClick={() => {
                  setIsAboutOpen(false)
                }}
                type="button"
              >
                Close
              </button>
            </section>
          </div>
        ) : null}

        {isShortcutsOpen ? (
          <div
            className="overlay-backdrop"
            onClick={() => {
              setIsShortcutsOpen(false)
            }}
          >
            <section
              className="overlay-card shortcuts-card"
              onClick={(event) => {
                event.stopPropagation()
              }}
            >
              <h2>Keyboard Shortcuts</h2>
              <div className="shortcut-row">
                <span>Find</span>
                <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>F</kbd>
              </div>
              <div className="shortcut-row">
                <span>New Tab</span>
                <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>T</kbd>
              </div>
              <div className="shortcut-row">
                <span>Show All Tabs</span>
                <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>O</kbd>
              </div>
              <div className="shortcut-row">
                <span>Next Tab</span>
                <kbd>Ctrl</kbd>
                <kbd>Tab</kbd>
              </div>
              <div className="shortcut-row">
                <span>Previous Tab</span>
                <kbd>Ctrl</kbd>
                <kbd>Shift</kbd>
                <kbd>Tab</kbd>
              </div>
              <button
                className="dialog-action"
                onClick={() => {
                  setIsShortcutsOpen(false)
                }}
                type="button"
              >
                Close
              </button>
            </section>
          </div>
        ) : null}
      </section>
    </main>
  )
}

export default App
