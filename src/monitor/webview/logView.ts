/**
 * The log viewer component: toolbar, query bar, virtualised grid, folding, source links, pause,
 * clear and save. It talks to the host only through the message protocol. Log text is untrusted:
 * it is only ever put into the DOM with `textContent`.
 */

import {
  formatTime,
  levelLetter,
  levelOf,
  parseQuery,
  MIN_LEVELS,
  type AppIdentity,
  type LogFilters,
  type LogLevel,
  type MinLevel,
  type Query,
  type SourceRef,
} from '../logModel';
import { controlGlyphs } from '../displayText';
import type { AppIdentityWire, HostMessage, LogStatus, PageMessage, SaveFormat } from '../protocol';
import { describeLogStatus, describeRow, firstRef, groupLines, LogRows, rowRefs, splitLine, type LogGroup } from './logViewModel';
import { VirtualList } from './virtualList';
import { lineHeightFor } from './virtualWindow';

export interface LogViewHost {
  post(message: PageMessage): void;
  /** Called when something worth persisting changed (filters, widths, scroll). */
  persist(): void;
}

export interface LogViewState {
  minLevel: MinLevel;
  tags: string[];
  mine: boolean;
  query: string;
  derive: boolean;
  group: boolean;
  colWidths: Record<string, number>;
  scrollTop: number;
  autoScroll: boolean;
}

export const DEFAULT_LOG_STATE: LogViewState = {
  minLevel: 'verbose',
  tags: [],
  mine: false,
  query: '',
  derive: false,
  group: true,
  colWidths: {},
  scrollTop: 0,
  autoScroll: true,
};

const LEVEL_NAME: Record<LogLevel, string> = {
  error: 'error',
  warning: 'warning',
  info: 'info',
  debug: 'debug',
  unknown: 'unknown level',
  agent: 'agent message',
  marker: 'marker',
};
const LEVEL_ICON: Record<LogLevel, string> = { error: '✖', warning: '⚠', info: 'ℹ', debug: '·', unknown: '·', agent: '◆', marker: '' };
const COLUMNS = ['time', 'pid', 'tag'] as const;
const QUERY_DEBOUNCE_MS = 150;
const REBUILD_SLICE_MS = 16;
const NOTICE_MS = 5000;
const MENU_TAG_LIMIT = 60;

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`monitor page: missing #${id}`);
  return el as T;
}

function make(tag: string, className: string, text?: string): HTMLElement {
  const el = document.createElement(tag);
  el.className = className;
  if (text !== undefined) el.textContent = text;
  return el;
}

function cell(className: string, text?: string): HTMLElement {
  const c = make('div', `cell ${className}`, text);
  c.setAttribute('role', 'gridcell');
  return c;
}

function baseName(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i >= 0 ? path.slice(i + 1) : path;
}

export class LogView {
  private rows: LogRows;
  private readonly list: VirtualList;
  private readonly grid = byId<HTMLElement>('log-grid');
  private readonly body = byId<HTMLElement>('log-body');
  private readonly statusEl = byId<HTMLElement>('log-status');
  private readonly queryEl = byId<HTMLInputElement>('log-query');
  private readonly levelEl = byId<HTMLSelectElement>('log-level');
  private readonly mineEl = byId<HTMLButtonElement>('log-mine');
  private readonly groupEl = byId<HTMLInputElement>('log-group');
  private readonly deriveEl = byId<HTMLInputElement>('log-derive');
  private readonly pauseEl = byId<HTMLButtonElement>('log-pause');
  private readonly jumpEl = byId<HTMLButtonElement>('log-jump');
  private readonly resumeEl = byId<HTMLButtonElement>('log-resume');
  private readonly installEl = byId<HTMLButtonElement>('log-install');
  private readonly tagsBtn = byId<HTMLButtonElement>('log-tags-btn');
  private readonly tagsMenu = byId<HTMLElement>('log-tags-menu');
  private readonly helpBtn = byId<HTMLButtonElement>('log-help');
  private readonly helpPop = byId<HTMLElement>('log-help-pop');

  private state: LogViewState;
  private query: Query = { terms: [], tags: [], pids: [] };
  private identity: { name?: string; binary?: string; pids: Set<number> } | undefined;
  private readonly expanded = new Set<number>();
  private readonly links = new WeakMap<HTMLElement, SourceRef>();
  private activeSeq: number | undefined;
  private paused = false;
  private held: Extract<HostMessage, { type: 'log.append' }>[] = [];
  private status: { status: LogStatus; reason?: string; format?: 'json' | 'text'; rate?: number; pending?: number } = { status: 'starting' };
  private noticeTimer: ReturnType<typeof setTimeout> | undefined;
  private queryTimer: ReturnType<typeof setTimeout> | undefined;
  private frame = 0;
  private fullDirty = true;
  private dirtyFrom = 0;
  private visible = true;
  private restoredScroll = false;
  private lastEvicted = 0;

  constructor(
    private readonly host: LogViewHost,
    saved: Partial<LogViewState> | undefined,
    maxEntries: number,
  ) {
    this.state = { ...DEFAULT_LOG_STATE, ...saved, tags: [...(saved?.tags ?? [])], colWidths: { ...(saved?.colWidths ?? {}) } };
    this.rows = new LogRows(maxEntries);
    this.list = new VirtualList({
      viewport: this.body,
      spacer: byId('log-spacer'),
      count: () => this.rows.length,
      lines: (i) => this.linesOf(i),
      renderRow: (i, el) => this.renderRow(i, el),
    });
    this.measure();
    this.applyStateToControls();
    this.wire();
    this.applyFilters();
  }

  // --- configuration from the host ---

  /** `init` settings: the buffer size and the defaults the user has no saved choice for. */
  configure(maxEntries: number, deriveLevels: boolean, groupFrames: boolean, hadSaved: boolean): void {
    if (maxEntries !== this.rows.maxEntries) this.rows = new LogRows(maxEntries);
    if (!hadSaved) {
      this.state.derive = deriveLevels;
      this.state.group = groupFrames;
      this.applyStateToControls();
    }
    this.applyFilters();
  }

  setIdentity(id: AppIdentityWire | undefined): void {
    const next = id ? { name: id.name, binary: id.binary, pids: new Set(id.pids) } : undefined;
    const same =
      (this.identity === undefined && next === undefined) ||
      (this.identity !== undefined &&
        next !== undefined &&
        this.identity.name === next.name &&
        this.identity.binary === next.binary &&
        this.identity.pids.size === next.pids.size &&
        [...next.pids].every((p) => this.identity?.pids.has(p)));
    this.identity = next;
    if (!same && this.state.mine) this.applyFilters();
  }

  getState(): LogViewState {
    return { ...this.state, tags: [...this.state.tags], colWidths: { ...this.state.colWidths }, scrollTop: this.body.scrollTop };
  }

  setVisible(on: boolean): void {
    this.visible = on;
    if (on) this.scheduleTick(true);
  }

  focusQuery(): void {
    this.queryEl.focus();
    this.queryEl.select();
  }

  focusGrid(): void {
    this.grid.focus();
  }

  // --- messages from the host ---

  append(msg: Extract<HostMessage, { type: 'log.append' }>): void {
    if (this.paused) {
      this.held.push(msg);
      this.updateStatus();
      return;
    }
    this.applyAppend(msg);
  }

  private applyAppend(msg: Extract<HostMessage, { type: 'log.append' }>): void {
    const before = this.rows.length;
    if (msg.dropped > 0) this.rows.appendMarker(`${msg.dropped} lines skipped by the viewer`, Date.now());
    this.rows.append(msg.entries);
    if (this.rows.evicted !== this.lastEvicted || this.rows.rebuilding) {
      this.lastEvicted = this.rows.evicted;
      this.fullDirty = true;
    } else {
      this.dirtyFrom = Math.min(this.dirtyFrom, Math.max(0, before - 1));
    }
    this.scheduleTick();
    this.host.post({ type: 'log.ack', upTo: msg.upTo });
  }

  clear(): void {
    this.rows.clear();
    this.held = [];
    this.expanded.clear();
    this.activeSeq = undefined;
    this.rows.appendMarker('── log cleared ──', Date.now());
    this.fullDirty = true;
    this.scheduleTick();
  }

  setStatus(s: { status: LogStatus; reason?: string; format?: 'json' | 'text'; rate?: number; pending?: number }): void {
    this.status = s;
    this.updateStatus();
  }

  /** A transient message in the status line (announced by the live region). */
  notice(text: string): void {
    this.statusEl.textContent = text;
    if (this.noticeTimer) clearTimeout(this.noticeTimer);
    this.noticeTimer = setTimeout(() => this.updateStatus(), NOTICE_MS);
  }

  private updateStatus(): void {
    if (this.noticeTimer) {
      clearTimeout(this.noticeTimer);
      this.noticeTimer = undefined;
    }
    const pending = (this.status.pending ?? 0) + this.held.reduce((n, m) => n + m.entries.length, 0);
    const effective: LogStatus = this.paused ? 'paused' : this.status.status;
    let text = describeLogStatus({ ...this.status, status: effective, pending });
    if (this.query.regexNote) text += ` · ${this.query.regexNote}`;
    if (this.statusEl.textContent !== text) this.statusEl.textContent = text;
    this.resumeEl.hidden = effective !== 'stopped';
    this.installEl.hidden = effective !== 'needsAgent';
  }

  // --- filters ---

  private filters(): LogFilters {
    const id = this.identity;
    let mine: AppIdentity | undefined;
    // "mine" with no known app shows nothing rather than everything
    if (this.state.mine) mine = id ? { name: id.name, binary: id.binary, pids: id.pids } : { pids: new Set<number>() };
    return { minLevel: this.state.minLevel, tags: this.state.tags, mine, query: this.query, deriveLevels: this.state.derive };
  }

  private applyFilters(): void {
    this.query = parseQuery(this.state.query);
    this.rows.setFilters({ filters: this.filters(), groupFrames: this.state.group });
    this.fullDirty = true;
    this.scheduleTick();
    this.updateStatus();
    this.host.persist();
  }

  private applyStateToControls(): void {
    this.levelEl.value = this.state.minLevel;
    this.queryEl.value = this.state.query;
    this.groupEl.checked = this.state.group;
    this.deriveEl.checked = this.state.derive;
    this.mineEl.setAttribute('aria-pressed', String(this.state.mine));
    for (const col of COLUMNS) {
      const w = this.state.colWidths[col];
      if (w) this.grid.style.setProperty(`--w-${col}`, `${w}px`);
    }
  }

  // --- rendering ---

  private measure(): void {
    const size = parseFloat(getComputedStyle(document.body).getPropertyValue('--vscode-editor-font-size'));
    const px = lineHeightFor(size);
    this.grid.style.setProperty('--row-line', `${px}px`);
    this.list.setLinePx(px);
  }

  private linesOf(i: number): number {
    const g = this.rows.rowAt(i);
    return g && g.extra > 0 && this.expanded.has(g.entry.id) ? 1 + g.extra : 1;
  }

  private scheduleTick(force = false): void {
    if (force) this.fullDirty = true;
    if (this.frame || !this.visible) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.tick();
    });
  }

  private tick(): void {
    if (this.rows.rebuilding) this.rows.rebuildStep(REBUILD_SLICE_MS, () => performance.now());
    const follow = this.state.autoScroll;
    this.list.relayout(this.fullDirty ? 0 : this.dirtyFrom);
    this.fullDirty = false;
    this.dirtyFrom = Number.MAX_SAFE_INTEGER;
    this.grid.setAttribute('aria-rowcount', String(this.rows.length + 1));
    if (!this.restoredScroll && this.rows.length > 0 && !follow) {
      this.restoredScroll = true;
      this.body.scrollTop = this.state.scrollTop;
      this.list.render();
    } else if (follow) {
      this.list.scrollToEnd();
    }
    this.syncActive();
    this.updateJump();
    if (this.rows.rebuilding) this.scheduleTick();
  }

  private updateJump(): void {
    this.jumpEl.hidden = this.state.autoScroll || this.rows.length === 0;
  }

  private renderRow(i: number, el: HTMLElement): void {
    const g = this.rows.rowAt(i);
    if (!g) return;
    const e = g.entry;
    el.id = `lr-${e.id}`;
    el.dataset.index = String(i);
    el.setAttribute('role', 'row');
    el.setAttribute('aria-rowindex', String(i + 2));
    if (g.seq === this.activeSeq) el.classList.add('active');
    if (e.source === 'marker') {
      el.classList.add('marker');
      el.setAttribute('aria-label', e.message);
      el.appendChild(cell('wide', controlGlyphs(e.message)));
      return;
    }
    const level = levelOf(e, this.state.derive);
    el.classList.add(`lvl-${level}`);
    const lines = groupLines(g);
    const refs = rowRefs(g, lines);
    const open = g.extra > 0 && this.expanded.has(e.id);
    if (g.extra > 0) el.setAttribute('aria-expanded', String(open));
    el.title = describeRow(g, LEVEL_NAME[level], formatTime(e.ts));

    el.appendChild(cell('time', formatTime(e.ts)));
    const lvl = cell('lvl');
    lvl.setAttribute('aria-label', LEVEL_NAME[level]);
    const icon = make('span', 'icon', LEVEL_ICON[level]);
    icon.setAttribute('aria-hidden', 'true');
    lvl.append(icon, make('span', 'letter', levelLetter(level)));
    el.appendChild(lvl);
    el.appendChild(cell('pid', e.pid !== undefined ? String(e.pid) : ''));
    el.appendChild(cell('tag', controlGlyphs(e.tag)));

    const msg = cell('msg');
    const shown = open ? lines : lines.slice(0, 1);
    shown.forEach((line, k) => {
      const div = make('div', 'line');
      for (const seg of splitLine(line, refs.perLine[k] ?? [])) {
        if (seg.ref) {
          const a = make('a', 'src-link', controlGlyphs(seg.text));
          a.setAttribute('role', 'link');
          a.tabIndex = -1;
          this.links.set(a, seg.ref);
          div.appendChild(a);
        } else {
          div.appendChild(document.createTextNode(controlGlyphs(seg.text)));
        }
      }
      if (k === 0 && g.extra > 0 && !open) div.appendChild(make('span', 'fold', `  ▸ ${g.extra} more line${g.extra === 1 ? '' : 's'}`));
      if (k === 0 && g.extra > 0 && open) div.appendChild(make('span', 'fold', '  ▾'));
      if (k === 0 && refs.code) {
        const a = make('a', 'src-link code', ` ${baseName(refs.code.file)}:${refs.code.line}`);
        a.setAttribute('role', 'link');
        a.tabIndex = -1;
        this.links.set(a, refs.code);
        div.appendChild(a);
      }
      msg.appendChild(div);
    });
    el.appendChild(msg);
  }

  // --- active row and folding ---

  private activeIndex(): number {
    return this.activeSeq === undefined ? -1 : this.rows.indexOfSeq(this.activeSeq);
  }

  private syncActive(): void {
    const idx = this.activeIndex();
    const el = idx >= 0 ? this.list.rowElement(idx) : undefined;
    if (el) this.grid.setAttribute('aria-activedescendant', el.id);
    else this.grid.removeAttribute('aria-activedescendant');
  }

  private setActive(idx: number, reveal = true): void {
    const g = this.rows.rowAt(Math.max(0, Math.min(idx, this.rows.length - 1)));
    if (!g) return;
    const old = this.activeIndex();
    this.activeSeq = g.seq;
    if (old >= 0) this.list.rowElement(old)?.classList.remove('active');
    const now = this.rows.indexOfSeq(g.seq);
    if (reveal) this.list.reveal(now);
    this.list.rowElement(now)?.classList.add('active');
    this.syncActive();
  }

  private toggleFold(g: LogGroup, open?: boolean): void {
    if (g.extra === 0) return;
    const want = open ?? !this.expanded.has(g.entry.id);
    if (want) this.expanded.add(g.entry.id);
    else this.expanded.delete(g.entry.id);
    this.fullDirty = true;
    this.scheduleTick();
  }

  private setAllFolds(open: boolean): void {
    this.expanded.clear();
    if (open) for (let i = 0; i < this.rows.length; i++) {
      const g = this.rows.rowAt(i);
      if (g && g.extra > 0) this.expanded.add(g.entry.id);
    }
    this.fullDirty = true;
    this.scheduleTick();
  }

  private openRef(ref: SourceRef): void {
    this.host.post(ref.col !== undefined ? { type: 'openSource', file: ref.file, line: ref.line, col: ref.col } : { type: 'openSource', file: ref.file, line: ref.line });
  }

  // --- wiring ---

  private setPaused(on: boolean): void {
    if (this.paused === on) return;
    this.paused = on;
    this.pauseEl.setAttribute('aria-pressed', String(on));
    this.pauseEl.textContent = on ? 'Resume' : 'Pause';
    this.host.post({ type: 'log.pause', on });
    if (!on) {
      const queued = this.held;
      this.held = [];
      for (const m of queued) this.applyAppend(m);
      this.state.autoScroll = true;
    }
    this.updateStatus();
  }

  togglePause(): void {
    this.setPaused(!this.paused);
  }

  private closePopovers(except?: HTMLElement): void {
    for (const [btn, pop] of [
      [this.tagsBtn, this.tagsMenu],
      [this.helpBtn, this.helpPop],
    ] as const) {
      if (pop === except) continue;
      pop.hidden = true;
      btn.setAttribute('aria-expanded', 'false');
    }
  }

  private togglePopover(btn: HTMLElement, pop: HTMLElement): void {
    const open = pop.hidden;
    this.closePopovers(open ? pop : undefined);
    pop.hidden = !open;
    btn.setAttribute('aria-expanded', String(open));
    if (open && pop === this.tagsMenu) this.fillTagsMenu();
  }

  private fillTagsMenu(): void {
    const tags = this.rows.tags().slice(0, MENU_TAG_LIMIT);
    for (const t of this.state.tags) if (!tags.includes(t)) tags.push(t);
    this.tagsMenu.replaceChildren();
    if (tags.length === 0) {
      this.tagsMenu.appendChild(make('p', 'muted', 'No tags seen yet.'));
      return;
    }
    for (const t of tags) {
      const label = make('label', 'check');
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = this.state.tags.includes(t);
      box.addEventListener('change', () => {
        const set = new Set(this.state.tags);
        if (box.checked) set.add(t);
        else set.delete(t);
        this.state.tags = [...set];
        this.tagsBtn.textContent = set.size > 0 ? `Tags (${set.size})` : 'Tags';
        this.applyFilters();
      });
      label.append(box, document.createTextNode(` ${controlGlyphs(t)}`));
      this.tagsMenu.appendChild(label);
    }
  }

  private wire(): void {
    this.levelEl.addEventListener('change', () => {
      const v = this.levelEl.value as MinLevel;
      if ((MIN_LEVELS as readonly string[]).includes(v)) {
        this.state.minLevel = v;
        this.applyFilters();
      }
    });
    this.mineEl.addEventListener('click', () => {
      this.state.mine = !this.state.mine;
      this.mineEl.setAttribute('aria-pressed', String(this.state.mine));
      this.applyFilters();
    });
    this.groupEl.addEventListener('change', () => {
      this.state.group = this.groupEl.checked;
      this.applyFilters();
    });
    this.deriveEl.addEventListener('change', () => {
      this.state.derive = this.deriveEl.checked;
      this.applyFilters();
    });
    this.queryEl.addEventListener('input', () => {
      if (this.queryTimer) clearTimeout(this.queryTimer);
      this.queryTimer = setTimeout(() => {
        this.state.query = this.queryEl.value;
        this.applyFilters();
      }, QUERY_DEBOUNCE_MS);
    });
    this.queryEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        this.queryEl.value = '';
        this.state.query = '';
        this.applyFilters();
        ev.preventDefault();
      } else if (ev.key === 'Enter' || ev.key === 'ArrowDown') {
        this.focusGrid();
        ev.preventDefault();
      }
    });
    byId('log-expand').addEventListener('click', () => this.setAllFolds(true));
    byId('log-collapse').addEventListener('click', () => this.setAllFolds(false));
    this.pauseEl.addEventListener('click', () => this.togglePause());
    byId('log-clear').addEventListener('click', () => this.host.post({ type: 'log.clear' }));
    byId('log-save').addEventListener('click', () => {
      const format = byId<HTMLSelectElement>('log-save-format').value === 'jsonl' ? 'jsonl' : 'log';
      this.save(format satisfies SaveFormat, byId<HTMLInputElement>('log-save-filtered').checked);
    });
    this.jumpEl.addEventListener('click', () => this.jumpToEnd());
    this.resumeEl.addEventListener('click', () => this.host.post({ type: 'resume', what: 'logs' }));
    this.installEl.addEventListener('click', () => this.host.post({ type: 'action', name: 'installAgent' }));
    this.tagsBtn.addEventListener('click', () => this.togglePopover(this.tagsBtn, this.tagsMenu));
    this.helpBtn.addEventListener('click', () => this.togglePopover(this.helpBtn, this.helpPop));
    document.addEventListener('click', (ev) => {
      const t = ev.target as Node;
      if (!this.tagsBtn.parentElement?.contains(t) && !this.helpBtn.parentElement?.contains(t)) this.closePopovers();
    });

    this.body.addEventListener('scroll', () => {
      const atEnd = this.list.atEnd();
      if (this.state.autoScroll !== atEnd && this.rows.length > 0) {
        this.state.autoScroll = atEnd;
        this.updateJump();
      }
      this.host.persist();
    }, { passive: true });

    this.body.addEventListener('click', (ev) => {
      const target = ev.target as HTMLElement;
      const rowEl = target.closest<HTMLElement>('.row');
      const idx = rowEl ? this.indexOfRowEl(rowEl) : -1;
      const link = target.closest<HTMLElement>('.src-link');
      if (idx >= 0) this.setActive(idx, false);
      const ref = link ? this.links.get(link) : undefined;
      if (ref) {
        this.openRef(ref);
        ev.preventDefault();
      } else if (idx >= 0 && target.closest('.fold')) {
        const g = this.rows.rowAt(idx);
        if (g) this.toggleFold(g);
      }
    });
    this.grid.addEventListener('focus', () => {
      if (this.activeIndex() < 0 && this.rows.length > 0) this.setActive(this.rows.length - 1);
    });
    this.grid.addEventListener('keydown', (ev) => this.onGridKey(ev));
    document.addEventListener('keydown', (ev) => this.onGlobalKey(ev));
    this.wireResizers();
  }

  private indexOfRowEl(el: HTMLElement): number {
    const i = Number(el.dataset.index);
    return Number.isInteger(i) && this.list.rowElement(i) === el ? i : -1;
  }

  jumpToEnd(): void {
    this.state.autoScroll = true;
    this.list.scrollToEnd();
    if (this.rows.length > 0) this.setActive(this.rows.length - 1);
    this.updateJump();
  }

  save(format: SaveFormat, filteredOnly: boolean): void {
    if (!filteredOnly) {
      this.host.post({ type: 'log.save', filteredOnly: false, format });
      return;
    }
    this.host.post({
      type: 'log.save',
      filteredOnly: true,
      format,
      filter: { minLevel: this.state.minLevel, tags: this.state.tags.slice(0, 64), mine: this.state.mine, query: this.state.query, deriveLevels: this.state.derive },
    });
  }

  private onGridKey(ev: KeyboardEvent): void {
    const target = ev.target as HTMLElement;
    if (target.classList.contains('sep')) return;
    const idx = this.activeIndex();
    const last = this.rows.length - 1;
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown':
        this.setActive(idx < 0 ? last : idx + 1);
        break;
      case 'ArrowUp':
        this.setActive(idx < 0 ? last : idx - 1);
        break;
      case 'PageDown':
        this.setActive(idx + this.list.pageRows());
        break;
      case 'PageUp':
        this.setActive(idx - this.list.pageRows());
        break;
      case 'Home':
        this.setActive(0);
        break;
      case 'End':
        this.jumpToEnd();
        break;
      case 'ArrowRight':
      case 'ArrowLeft': {
        const g = this.rows.rowAt(idx);
        if (g) this.toggleFold(g, ev.key === 'ArrowRight');
        break;
      }
      case 'Enter': {
        const g = this.rows.rowAt(idx);
        if (!g) break;
        const ref = firstRef(rowRefs(g, groupLines(g)));
        if (ref) this.openRef(ref);
        else this.toggleFold(g);
        break;
      }
      default:
        handled = false;
    }
    if (handled) ev.preventDefault();
  }

  private onGlobalKey(ev: KeyboardEvent): void {
    if (ev.ctrlKey || ev.altKey || ev.metaKey) return;
    const t = ev.target as HTMLElement | null;
    const tag = t?.tagName;
    if (ev.key === 'Escape') {
      if (!this.helpPop.hidden || !this.tagsMenu.hidden) {
        this.closePopovers();
        ev.preventDefault();
      }
      return;
    }
    if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || t?.isContentEditable) return;
    if (ev.key === '/') {
      this.focusQuery();
      ev.preventDefault();
    } else if (ev.key === 'p') {
      this.togglePause();
      ev.preventDefault();
    } else if (ev.key === '?') {
      this.togglePopover(this.helpBtn, this.helpPop);
      ev.preventDefault();
    }
  }

  private wireResizers(): void {
    for (const sep of Array.from(this.grid.querySelectorAll<HTMLElement>('.sep'))) {
      const col = sep.dataset.col;
      if (!col) continue;
      const current = (): number => sep.parentElement?.getBoundingClientRect().width ?? 80;
      const set = (w: number): void => {
        const px = Math.max(32, Math.min(600, Math.round(w)));
        this.grid.style.setProperty(`--w-${col}`, `${px}px`);
        this.state.colWidths[col] = px;
        sep.setAttribute('aria-valuenow', String(px));
        this.host.persist();
      };
      sep.addEventListener('pointerdown', (ev) => {
        const startX = ev.clientX;
        const startW = current();
        sep.setPointerCapture(ev.pointerId);
        const move = (m: PointerEvent): void => set(startW + m.clientX - startX);
        const up = (): void => {
          sep.removeEventListener('pointermove', move);
          sep.removeEventListener('pointerup', up);
        };
        sep.addEventListener('pointermove', move);
        sep.addEventListener('pointerup', up);
        ev.preventDefault();
      });
      sep.addEventListener('keydown', (ev) => {
        if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
          set(current() + (ev.key === 'ArrowRight' ? 8 : -8));
          ev.preventDefault();
          ev.stopPropagation();
        }
      });
    }
  }
}
