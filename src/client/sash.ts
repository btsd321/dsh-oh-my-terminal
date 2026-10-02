/**
 * @file 拖拽分隔条（Sash）组件
 * @description 复刻 VSCode 的 Sash 类（src/vs/base/browser/ui/sash/sash.ts），
 *              提供可拖拽的分隔条——用户拖拽时发出 onDidStart/onDidChange/onDidEnd
 *              事件，由 SplitView 消费并分配 delta 给相邻 pane。
 *
 *              与 VSCode 原版的差异：
 *              - 不支持触摸 Gesture（DSH 桌面端不需要）
 *              - 不支持正交 sash / corner sash（终端拆分只有单向）
 *              - 不支持 linkedSash（终端拆分不需要联动）
 *              - 不支持 snap 状态（终端 pane 不隐藏）
 *              - 保留：mousedown 启动 → 全局 mousemove/mouseup → cursor 样式 →
 *                hover 延迟 → iframe 指针禁用（防拖拽期间 iframe 吃事件）
 */

import { createLogger } from '../logger.js';

const log = createLogger('sash');

/** 可释放资源接口（复刻 VSCode IDisposable 的最小子集） */
export interface IDisposable {
  /** 释放资源 */
  dispose(): void;
}

/** 可释放基类：管理子资源，dispose 时自动释放（复刻 VSCode Disposable 的最小子集） */
export class Disposable implements IDisposable {
  private readonly disposables: IDisposable[] = [];
  private _disposed = false;

  /** 注册子资源，dispose 时自动释放 */
  protected _register<T extends IDisposable>(d: T): T {
    if (this._disposed) {
      d.dispose();
    } else {
      this.disposables.push(d);
    }
    return d;
  }

  dispose(): void {
    if (this._disposed) return;
    this._disposed = true;
    for (const d of this.disposables) {
      try { d.dispose(); } catch (err) { log.error('dispose 子资源抛错', err); }
    }
  }
}

/** sash 方向（终端拆分只用 VERTICAL——垂直线左右拖拽） */
export const enum Orientation {
  VERTICAL,
  HORIZONTAL,
}

/** sash 可交互状态（决定 cursor 与是否响应拖拽） */
export const enum SashState {
  /** 禁用——不响应拖拽 */
  Disabled,
  /** 已到最小值——只能放大不能缩小 */
  AtMinimum,
  /** 已到最大值——只能缩小不能放大 */
  AtMaximum,
  /** 正常——可自由拖拽 */
  Enabled,
}

/** sash 拖拽事件载荷 */
export interface ISashEvent {
  /** 拖拽起始 x 坐标（pageX） */
  readonly startX: number;
  /** 当前 x 坐标（pageX） */
  readonly currentX: number;
  /** 拖拽起始 y 坐标（pageY） */
  readonly startY: number;
  /** 当前 y 坐标（pageY） */
  readonly currentY: number;
  /** 是否按住 alt 键（macOS 风格反向调整） */
  readonly altKey: boolean;
}

/** 垂直 sash 布局提供者——提供 sash 的 left 位置和高度 */
export interface IVerticalSashLayoutProvider {
  /** sash 左边距（像素） */
  getVerticalSashLeft(sash: Sash): number;
  /** sash 顶部边距（像素） */
  getVerticalSashTop?(sash: Sash): number;
  /** sash 高度（像素） */
  getVerticalSashHeight?(sash: Sash): number;
}

/** sash 构造选项 */
export interface ISashOptions {
  /** 方向 */
  readonly orientation: Orientation;
  /** sash 宽度（像素），缺省用全局默认值 */
  readonly size?: number;
}

/**
 * 拖拽分隔条：一条不可见的线，hover 时高亮，拖拽时发出位移事件。
 *
 * 核心流程（复刻 VSCode Sash.onPointerStart）：
 * 1. mousedown 启动：记录起始坐标，禁用 iframe 指针事件（防拖拽期间 iframe 吃事件）
 * 2. 注入全局 cursor <style>（拖拽期间强制 col-resize/ew-resize cursor）
 * 3. 全局 mousemove → 发出 onDidChange（携带 currentX/Y）
 * 4. 全局 mouseup → 发出 onDidEnd，清理 <style> 和 iframe 禁用
 *
 * @remarks 不使用 PointerEvent：DSH 桌面端只需鼠标，PointerEvent 在某些 Electron
 *          版本与 iframe 交互有兼容性问题。VSCode 原版也支持 mouse + gesture 两条路，
 *          这里只保留 mouse。
 */
export class Sash extends Disposable {
  /** sash 的 DOM 元素 */
  readonly el: HTMLElement;
  /** 方向 */
  readonly orientation: Orientation;
  /** sash 宽度（像素） */
  readonly size: number;

  private _state: SashState = SashState.Enabled;

  /** sash 状态变更事件 */
  private readonly onDidEnablementChange = this._register(new Emitter<SashState>());
  /** 拖拽开始事件 */
  private readonly _onDidStart = this._register(new Emitter<ISashEvent>());
  /** 拖拽移动事件 */
  private readonly _onDidChange = this._register(new Emitter<ISashEvent>());
  /** 拖拽结束事件 */
  private readonly _onDidEnd = this._register(new Emitter<void>());
  /** 双击重置事件 */
  private readonly _onDidReset = this._register(new Emitter<void>());

  /** 拖拽开始事件（SplitView 订阅，记录起始尺寸并禁用 pane 交互） */
  readonly onDidStart = this._onDidStart.event;
  /** 拖拽移动事件（SplitView 订阅，计算 delta 并分配给相邻 pane） */
  readonly onDidChange = this._onDidChange.event;
  /** 拖拽结束事件（SplitView 订阅，保存 proportions 并恢复 pane 交互） */
  readonly onDidEnd = this._onDidEnd.event;
  /** 双击重置事件（SplitView 订阅，等分 pane 尺寸） */
  readonly onDidReset = this._onDidReset.event;

  /** 当前状态 */
  get state(): SashState { return this._state; }
  /** 设置状态（决定 cursor 与拖拽可用性） */
  set state(state: SashState) {
    if (this._state === state) return;
    this.el.classList.toggle('disabled', state === SashState.Disabled);
    this.el.classList.toggle('minimum', state === SashState.AtMinimum);
    this.el.classList.toggle('maximum', state === SashState.AtMaximum);
    this._state = state;
    this.onDidEnablementChange.fire(state);
  }

  /**
   * @param container - sash 挂载的父元素
   * @param layoutProvider - 布局提供者（提供 sash 位置和尺寸）
   * @param options - 选项（方向 + 宽度）
   */
  constructor(
    container: HTMLElement,
    private readonly layoutProvider: IVerticalSashLayoutProvider,
    options: ISashOptions,
  ) {
    super();
    this.orientation = options.orientation;
    this.size = options.size ?? SASH_GLOBAL_SIZE;

    this.el = document.createElement('div');
    this.el.classList.add('dshTermSash');
    if (this.orientation === Orientation.HORIZONTAL) {
      this.el.classList.add('horizontal');
    } else {
      this.el.classList.add('vertical');
    }
    container.appendChild(this.el);

    this._register(addDisposableListener(this.el, 'mousedown', (e) => this.onPointerStart(e)));
    /* 双击重置——等分相邻 pane（复刻 VSCode Sash onDidReset） */
    this._register(addDisposableListener(this.el, 'dblclick', () => {
      this._onDidReset.fire();
    }));
    this._register(addDisposableListener(this.el, 'mouseenter', () => {
      this.el.classList.add('hover');
    }));
    this._register(addDisposableListener(this.el, 'mouseleave', () => {
      this.el.classList.remove('hover');
    }));

    this.layout();
  }

  /** 启动拖拽（复刻 VSCode Sash.onPointerStart） */
  private onPointerStart(event: MouseEvent): void {
    event.preventDefault();
    event.stopPropagation();

    if (this._state === SashState.Disabled) return;

    /* 禁用 iframe 指针事件——拖拽期间 iframe 会吃掉 mousemove 事件（VSCode #21675） */
    const iframes = this.el.ownerDocument.getElementsByTagName('iframe');
    for (const iframe of iframes) {
      iframe.classList.add('dshTermSashIframeDisabled');
    }

    const startX = event.pageX;
    const startY = event.pageY;
    const altKey = event.altKey;

    this.el.classList.add('active');
    this._onDidStart.fire({ startX, currentX: startX, startY, currentY: startY, altKey });

    /* 注入全局 cursor <style>——拖拽期间强制 cursor 不随元素变化（VSCode #21675） */
    const style = document.createElement('style');
    document.head.appendChild(style);
    const updateStyle = (): void => {
      let cursor: string;
      if (this.orientation === Orientation.HORIZONTAL) {
        cursor = this._state === SashState.AtMinimum ? 's-resize'
          : this._state === SashState.AtMaximum ? 'n-resize'
            : 'ns-resize';
      } else {
        cursor = this._state === SashState.AtMinimum ? 'e-resize'
          : this._state === SashState.AtMaximum ? 'w-resize'
            : 'ew-resize';
      }
      style.textContent = `* { cursor: ${cursor} !important; }`;
    };
    updateStyle();
    const enablementSub = this.onDidEnablementChange.event(updateStyle);

    const onPointerMove = (e: MouseEvent): void => {
      e.preventDefault();
      this._onDidChange.fire({ startX, currentX: e.pageX, startY, currentY: e.pageY, altKey });
    };

    const onPointerUp = (e: MouseEvent): void => {
      e.preventDefault();
      style.remove();
      enablementSub.dispose();
      this.el.classList.remove('active');
      this._onDidEnd.fire();
      document.removeEventListener('mousemove', onPointerMove);
      document.removeEventListener('mouseup', onPointerUp);
      for (const iframe of iframes) {
        iframe.classList.remove('dshTermSashIframeDisabled');
      }
    };

    document.addEventListener('mousemove', onPointerMove);
    document.addEventListener('mouseup', onPointerUp);
  }

  /** 重新布局 sash 位置（由 SplitView.layout 调用） */
  layout(): void {
    if (this.orientation === Orientation.VERTICAL) {
      const provider = this.layoutProvider;
      this.el.style.left = `${provider.getVerticalSashLeft(this) - (this.size / 2)}px`;
      if (provider.getVerticalSashTop !== undefined) {
        this.el.style.top = `${provider.getVerticalSashTop(this)}px`;
      }
      if (provider.getVerticalSashHeight !== undefined) {
        this.el.style.height = `${provider.getVerticalSashHeight(this)}px`;
      }
    }
  }

  override dispose(): void {
    super.dispose();
    this.el.remove();
  }
}

/** sash 默认宽度（像素）——1px 可见分隔线，hover 时用 CSS 伪元素扩展命中区域（参考 VSCode 默认 4px） */
const SASH_GLOBAL_SIZE = 1;

// —— 最小化的 Emitter / addDisposableListener 适配层 ——
// （避免引入 VSCode 的完整 lifecycle/event 模块；这里只复刻 Sash 需要的最小接口）

/** 事件发射器（复刻 VSCode Emitter 的最小子集） */
export class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  /** 订阅事件 */
  readonly event = (listener: (e: T) => void): IDisposable => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  /** 触发事件 */
  fire(e: T): void {
    for (const listener of this.listeners) {
      try { listener(e); } catch (err) { log.error('sash 事件监听器抛错', err); }
    }
  }
  dispose(): void {
    this.listeners = [];
  }
}

/** 添加 DOM 事件监听器，返回 IDisposable（复刻 VSCode addDisposableListener） */
function addDisposableListener(
  el: HTMLElement,
  type: string,
  handler: (e: MouseEvent) => void,
): IDisposable {
  el.addEventListener(type, handler as EventListener);
  return { dispose: () => { el.removeEventListener(type, handler as EventListener); } };
}
