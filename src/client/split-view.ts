/**
 * @file 拖拽拆分布局管理器
 * @description 复刻 VSCode 的 SplitView（src/vs/base/browser/ui/splitview/splitview.ts）
 *              核心算法——管理一组水平并排的 pane，用 Sash 分隔，拖拽 Sash 时按
 *              min/max 约束分配 delta 给相邻 pane。
 *
 *              与 VSCode 原版的差异：
 *              - 只支持 HORIZONTAL 方向（终端拆分只有水平并排）
 *              - 不支持滚动（pane 总尺寸 ≤ 容器尺寸，不溢出）
 *              - 不支持 snap / 隐藏 pane（终端 pane 总是可见）
 *              - 不支持优先级（所有 pane 平等分配）
 *              - 不支持正交 sash
 *              - 保留：resize() delta 分配算法、proportions 比例保存、
 *                distributeViewSizes() 等分、layout() 按比例分配、
 *                onSashStart/Change/End 事件处理、sash 启用状态计算
 */

import { Disposable, type IDisposable, Sash, SashState, Orientation, type IVerticalSashLayoutProvider } from './sash.js';
import { createLogger } from '../logger.js';

const log = createLogger('split-view');

/** clamp 工具：将值夹取到 [min, max] */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** range 工具：生成 [start, start+step, ..., end) 的整数序列 */
function range(from: number, to: number): number[] {
  const result: number[] = [];
  if (from <= to) {
    for (let i = from; i < to; i++) result.push(i);
  } else {
    for (let i = from; i > to; i--) result.push(i);
  }
  return result;
}

/** 拆分视图中的视图接口（复刻 VSCode IView 的最小子集） */
export interface IView {
  /** 视图 DOM 元素 */
  readonly element: HTMLElement;
  /** 最小尺寸（像素） */
  readonly minimumSize: number;
  /** 最大尺寸（像素） */
  readonly maximumSize: number;
  /** 尺寸变化事件（视图内部约束变化时发出） */
  readonly onDidChange: (listener: (size: number | undefined) => void) => IDisposable;
  /** 布局回调——SplitView 分配尺寸后调用，视图应据此调整自身渲染 */
  layout(size: number, offset: number): void;
}

/** sash 拖拽状态（复刻 VSCode ISashDragState） */
interface ISashDragState {
  /** sash 索引 */
  readonly index: number;
  /** 拖拽起始位置（pageX） */
  readonly start: number;
  /** 当前位置（pageX） */
  current: number;
  /** 拖拽开始时各 pane 尺寸快照 */
  readonly sizes: number[];
  /** delta 最小值（受 min 约束） */
  readonly minDelta: number;
  /** delta 最大值（受 max 约束） */
  readonly maxDelta: number;
  /** alt 键状态 */
  readonly alt: boolean;
}

/** sash + 其事件订阅 */
interface ISashItem {
  readonly sash: Sash;
  readonly disposable: IDisposable;
}

/** 单个 pane 的包装项（复刻 VSCode ViewItem） */
class ViewItem {
  private _size: number;

  /** 当前尺寸（像素） */
  get size(): number { return this._size; }
  set size(size: number) { this._size = size; }

  /** 最小尺寸 */
  get minimumSize(): number { return this.view.minimumSize; }
  /** 最大尺寸 */
  get maximumSize(): number { return this.view.maximumSize; }

  constructor(
    readonly container: HTMLElement,
    readonly view: IView,
    size: number,
  ) {
    this._size = size;
    container.classList.add('visible');
  }

  /** 布局：设置容器 left/width 并调用 view.layout */
  layout(offset: number): void {
    this.container.style.left = `${offset}px`;
    this.container.style.width = `${this.size}px`;
    try {
      this.view.layout(this.size, offset);
    } catch (e) {
      log.error('pane layout 抛错', e);
    }
  }

  dispose(): void {
    this.container.remove();
  }
}

/**
 * 拆分布局管理器：管理一组水平并排的 pane，用 Sash 分隔。
 *
 * 核心算法（复刻 VSCode SplitView）：
 * - **resize(index, delta)**：将 delta 分配给 sash 左侧和右侧的 pane，
 *   按 min/max 约束夹取，多余/不足的 delta 在同侧 pane 间传递
 * - **layout(size)**：容器尺寸变化时，按 proportions（比例快照）分配新尺寸
 * - **onSashStart**：记录起始尺寸快照和 min/max delta 约束
 * - **onSashChange**：计算 delta，调用 resize，重新布局所有 pane
 * - **onSashEnd**：保存 proportions
 * - **distributeViewSizes**：等分所有 pane 尺寸
 */
export class SplitView extends Disposable implements IVerticalSashLayoutProvider {
  /** 容器元素 */
  readonly el: HTMLElement;
  /** pane 容器（绝对定位的 pane 挂在这里） */
  private readonly viewContainer: HTMLElement;
  /** sash 容器（sash 挂在这里，在 pane 之上） */
  private readonly sashContainer: HTMLElement;

  /** 容器总尺寸（像素） */
  private size = 0;
  /** 所有 pane 尺寸之和 */
  private _contentSize = 0;
  /** 比例快照（容器 resize 时按比例分配新尺寸） */
  private proportions: (number | undefined)[] | undefined = undefined;
  /** pane 包装项列表 */
  private viewItems: ViewItem[] = [];
  /** sash 项列表 */
  private sashItems: ISashItem[] = [];
  /** 当前 sash 拖拽状态 */
  private sashDragState: ISashDragState | undefined;

  /** sash 位置变化事件（拖拽结束后发出） */
  private readonly _onDidSashChange = this._register(new Emitter<number>());
  /** sash 位置变化事件 */
  readonly onDidSashChange = this._onDidSashChange.event;
  /** sash 双击重置事件 */
  private readonly _onDidSashReset = this._register(new Emitter<number>());
  /** sash 双击重置事件 */
  readonly onDidSashReset = this._onDidSashReset.event;

  /** pane 数量 */
  get length(): number { return this.viewItems.length; }
  /** 所有 pane 尺寸之和 */
  get contentSize(): number { return this._contentSize; }

  /** 所有 sash */
  get sashes(): readonly Sash[] { return this.sashItems.map((s) => s.sash); }

  /**
   * @param container - 父容器（SplitView 创建自己的 DOM 结构挂入其中）
   */
  constructor(container: HTMLElement) {
    super();

    this.el = document.createElement('div');
    this.el.classList.add('dshTermSplitView', 'horizontal');
    container.appendChild(this.el);

    this.sashContainer = document.createElement('div');
    this.sashContainer.classList.add('dshTermSashContainer');
    this.el.appendChild(this.sashContainer);

    this.viewContainer = document.createElement('div');
    this.viewContainer.classList.add('dshTermSplitViewContainer');
    this.el.appendChild(this.viewContainer);
  }

  /**
   * 添加一个 pane。
   *
   * @param view - 视图接口
   * @param size - 初始尺寸（像素），缺省等分
   * @param index - 插入位置，缺省末尾
   */
  addView(view: IView, size?: number, index: number = this.viewItems.length): void {
    const container = document.createElement('div');
    container.classList.add('dshTermSplitViewView');

    if (index === this.viewItems.length) {
      this.viewContainer.appendChild(container);
    } else {
      this.viewContainer.insertBefore(container, this.viewContainer.children.item(index));
    }
    container.appendChild(view.element);

    const item = new ViewItem(container, view, size ?? view.minimumSize);
    this.viewItems.splice(index, 0, item);

    /* 有 2+ pane 时插入 sash */
    if (this.viewItems.length > 1) {
      const sashIndex = Math.max(index - 1, 0);
      const sash = new Sash(this.sashContainer, this, { orientation: Orientation.VERTICAL });

      const onStart = sash.onDidStart((e) => this.onSashStart(sash, e.startX, e.altKey));
      const onChange = sash.onDidChange((e) => this.onSashChange(sash, e.currentX));
      const onEnd = sash.onDidEnd(() => {
        const idx = this.sashItems.findIndex((s) => s.sash === sash);
        this.onSashEnd(idx);
      });
      const onReset = sash.onDidReset(() => {
        const idx = this.sashItems.findIndex((s) => s.sash === sash);
        this.distributeViewSizes();
        this._onDidSashReset.fire(idx);
      });

      const disposable = { dispose: () => { onStart.dispose(); onChange.dispose(); onEnd.dispose(); onReset.dispose(); sash.dispose(); } };
      this.sashItems.splice(sashIndex, 0, { sash, disposable });
    }

    /* 初次添加时等分 */
    if (size === undefined && this.size > 0) {
      this.distributeViewSizes();
    }

    this.relayout();
  }

  /**
   * 移除一个 pane。
   *
   * @param index - pane 索引
   */
  removeView(index: number): IView {
    if (index < 0 || index >= this.viewItems.length) {
      throw new Error('Index out of bounds');
    }

    const item = this.viewItems.splice(index, 1)[0];

    /* 移除相邻 sash */
    if (this.viewItems.length >= 1) {
      const sashIndex = Math.max(index - 1, 0);
      const sashItem = this.sashItems.splice(sashIndex, 1)[0];
      sashItem.disposable.dispose();
    }

    item.dispose();
    this.relayout();
    return item.view;
  }

  /** 获取 pane 尺寸 */
  getViewSize(index: number): number {
    if (index < 0 || index >= this.viewItems.length) return -1;
    return this.viewItems[index].size;
  }

  /** 等分所有 pane 尺寸（复刻 VSCode distributeViewSizes） */
  distributeViewSizes(): void {
    const flexibleSize = this.viewItems.reduce((r, i) => r + i.size, 0);
    const size = Math.floor(flexibleSize / this.viewItems.length);
    for (const item of this.viewItems) {
      item.size = clamp(size, item.minimumSize, item.maximumSize);
    }
    this.relayout();
  }

  /**
   * 布局：设置容器总尺寸，按比例分配（复刻 VSCode SplitView.layout）。
   *
   * @param size - 容器总尺寸（像素）
   */
  layout(size: number): void {
    const previousSize = Math.max(this.size, this._contentSize);
    this.size = size;

    if (this.proportions === undefined) {
      /* 首次 layout：等分 */
      this.resize(this.viewItems.length - 1, size - previousSize);
    } else {
      /* 按比例分配 */
      let total = 0;
      for (let i = 0; i < this.viewItems.length; i++) {
        const proportion = this.proportions[i];
        if (typeof proportion === 'number') {
          total += proportion;
        } else {
          size -= this.viewItems[i].size;
        }
      }
      for (let i = 0; i < this.viewItems.length; i++) {
        const proportion = this.proportions[i];
        if (typeof proportion === 'number' && total > 0) {
          const item = this.viewItems[i];
          item.size = clamp(Math.round((proportion * size) / total), item.minimumSize, item.maximumSize);
        }
      }
    }

    this.distributeEmptySpace();
    this.layoutViews();
  }

  /** sash 位置（复刻 VSCode getSashPosition）——供 Sash.layout 调用 */
  getVerticalSashLeft(sash: Sash): number {
    let position = 0;
    for (let i = 0; i < this.sashItems.length; i++) {
      position += this.viewItems[i].size;
      if (this.sashItems[i].sash === sash) return position;
    }
    return 0;
  }

  /** sash 高度——填满容器 */
  getVerticalSashHeight(_sash: Sash): number {
    return this.el.offsetHeight;
  }

  /** 保存比例快照（复刻 VSCode saveProportions） */
  private saveProportions(): void {
    if (this._contentSize > 0) {
      this.proportions = this.viewItems.map((v) => v.size / this._contentSize);
    }
  }

  /** sash 拖拽开始（复刻 VSCode onSashStart） */
  private onSashStart(sash: Sash, start: number, alt: boolean): void {
    const index = this.sashItems.findIndex((item) => item.sash === sash);
    const sizes = this.viewItems.map((i) => i.size);

    /* 计算 min/max delta——sash 左侧 pane 不能小于各自 min，右侧 pane 不能小于各自 min */
    const upIndexes = range(index, -1);
    const downIndexes = range(index + 1, this.viewItems.length);
    const minDeltaUp = upIndexes.reduce((r, i) => r + (this.viewItems[i].minimumSize - sizes[i]), 0);
    const maxDeltaUp = upIndexes.reduce((r, i) => r + (this.viewItems[i].maximumSize - sizes[i]), 0);
    const maxDeltaDown = downIndexes.length === 0 ? Number.POSITIVE_INFINITY : downIndexes.reduce((r, i) => r + (sizes[i] - this.viewItems[i].minimumSize), 0);
    const minDeltaDown = downIndexes.length === 0 ? Number.NEGATIVE_INFINITY : downIndexes.reduce((r, i) => r + (sizes[i] - this.viewItems[i].maximumSize), 0);
    const minDelta = Math.max(minDeltaUp, minDeltaDown);
    const maxDelta = Math.min(maxDeltaDown, maxDeltaUp);

    this.sashDragState = { index, start, current: start, sizes, minDelta, maxDelta, alt };
  }

  /** sash 拖拽移动（复刻 VSCode onSashChange） */
  private onSashChange(sash: Sash, current: number): void {
    if (this.sashDragState === undefined) return;
    const { index, start, sizes, minDelta, maxDelta } = this.sashDragState;
    this.sashDragState.current = current;

    const delta = current - start;
    this.resize(index, delta, sizes, minDelta, maxDelta);

    this.distributeEmptySpace();
    this.layoutViews();
  }

  /** sash 拖拽结束（复刻 VSCode onSashEnd） */
  private onSashEnd(index: number): void {
    this._onDidSashChange.fire(index);
    this.sashDragState = undefined;
    this.saveProportions();
  }

  /**
   * 核心算法：将 delta 分配给 sash 左右两侧的 pane（复刻 VSCode SplitView.resize）。
   *
   * 左侧 pane 分配 deltaUp（尺寸增大），右侧 pane 分配 deltaDown（尺寸减小）。
   * 每个 pane 的最终尺寸被 clamp 到 [min, max]，多余的 delta 传递给同侧下一个 pane。
   *
   * @param index - sash 索引（左侧最后一个 pane 的索引）
   * @param delta - 位移量（正=右移，左侧 pane 增大）
   * @param sizes - 拖拽开始时的尺寸快照（缺省当前尺寸）
   * @param overloadMinDelta - 外部约束的 delta 下限
   * @param overloadMaxDelta - 外部约束的 delta 上限
   * @returns 实际分配的 delta
   */
  private resize(
    index: number,
    delta: number,
    sizes: number[] = this.viewItems.map((i) => i.size),
    overloadMinDelta: number = Number.NEGATIVE_INFINITY,
    overloadMaxDelta: number = Number.POSITIVE_INFINITY,
  ): number {
    if (index < 0 || index >= this.viewItems.length) return 0;

    const upIndexes = range(index, -1);
    const downIndexes = range(index + 1, this.viewItems.length);

    const upItems = upIndexes.map((i) => this.viewItems[i]);
    const upSizes = upIndexes.map((i) => sizes[i]);
    const downItems = downIndexes.map((i) => this.viewItems[i]);
    const downSizes = downIndexes.map((i) => sizes[i]);

    const minDeltaUp = upIndexes.reduce((r, i) => r + (this.viewItems[i].minimumSize - sizes[i]), 0);
    const maxDeltaUp = upIndexes.reduce((r, i) => r + (this.viewItems[i].maximumSize - sizes[i]), 0);
    const maxDeltaDown = downIndexes.length === 0 ? Number.POSITIVE_INFINITY : downIndexes.reduce((r, i) => r + (sizes[i] - this.viewItems[i].minimumSize), 0);
    const minDeltaDown = downIndexes.length === 0 ? Number.NEGATIVE_INFINITY : downIndexes.reduce((r, i) => r + (sizes[i] - this.viewItems[i].maximumSize), 0);
    const minDelta = Math.max(minDeltaUp, minDeltaDown, overloadMinDelta);
    const maxDelta = Math.min(maxDeltaDown, maxDeltaUp, overloadMaxDelta);

    delta = clamp(delta, minDelta, maxDelta);

    /* 左侧 pane 分配 deltaUp（增大） */
    for (let i = 0, deltaUp = delta; i < upItems.length; i++) {
      const item = upItems[i];
      const size = clamp(upSizes[i] + deltaUp, item.minimumSize, item.maximumSize);
      const viewDelta = size - upSizes[i];
      deltaUp -= viewDelta;
      item.size = size;
    }

    /* 右侧 pane 分配 deltaDown（减小） */
    for (let i = 0, deltaDown = delta; i < downItems.length; i++) {
      const item = downItems[i];
      const size = clamp(downSizes[i] - deltaDown, item.minimumSize, item.maximumSize);
      const viewDelta = size - downSizes[i];
      deltaDown += viewDelta;
      item.size = size;
    }

    return delta;
  }

  /** 分配剩余空间（复刻 VSCode distributeEmptySpace） */
  private distributeEmptySpace(): void {
    const contentSize = this.viewItems.reduce((r, i) => r + i.size, 0);
    let emptyDelta = this.size - contentSize;

    const indexes = range(this.viewItems.length - 1, -1);
    for (let i = 0; emptyDelta !== 0 && i < indexes.length; i++) {
      const item = this.viewItems[indexes[i]];
      const size = clamp(item.size + emptyDelta, item.minimumSize, item.maximumSize);
      const viewDelta = size - item.size;
      emptyDelta -= viewDelta;
      item.size = size;
    }
  }

  /** 布局所有 pane 和 sash（复刻 VSCode layoutViews） */
  private layoutViews(): void {
    this._contentSize = this.viewItems.reduce((r, i) => r + i.size, 0);

    let offset = 0;
    for (const viewItem of this.viewItems) {
      viewItem.layout(offset);
      offset += viewItem.size;
    }

    this.sashItems.forEach((item) => item.sash.layout());
    this.updateSashEnablement();
  }

  /** 重新布局（复刻 VSCode relayout） */
  private relayout(): void {
    const contentSize = this.viewItems.reduce((r, i) => r + i.size, 0);
    this.resize(this.viewItems.length - 1, this.size - contentSize);
    this.distributeEmptySpace();
    this.layoutViews();
    this.saveProportions();
  }

  /** 更新 sash 启用状态（复刻 VSCode updateSashEnablement） */
  private updateSashEnablement(): void {
    let previous = false;
    const collapsesDown = this.viewItems.map((i) => {
      previous = i.size - i.minimumSize > 0 || previous;
      return previous;
    });

    previous = false;
    const expandsDown = this.viewItems.map((i) => {
      previous = i.maximumSize - i.size > 0 || previous;
      return previous;
    });

    const reverseViews = [...this.viewItems].reverse();
    previous = false;
    const collapsesUp = reverseViews.map((i) => {
      previous = i.size - i.minimumSize > 0 || previous;
      return previous;
    }).reverse();

    previous = false;
    const expandsUp = reverseViews.map((i) => {
      previous = i.maximumSize - i.size > 0 || previous;
      return previous;
    }).reverse();

    let position = 0;
    for (let index = 0; index < this.sashItems.length; index++) {
      const { sash } = this.sashItems[index];
      position += this.viewItems[index].size;

      const min = !(collapsesDown[index] && expandsUp[index + 1]);
      const max = !(expandsDown[index] && collapsesUp[index + 1]);

      if (min && max) {
        sash.state = SashState.Disabled;
      } else if (min && !max) {
        sash.state = SashState.AtMinimum;
      } else if (!min && max) {
        sash.state = SashState.AtMaximum;
      } else {
        sash.state = SashState.Enabled;
      }
    }
  }

  override dispose(): void {
    for (const item of this.viewItems) item.dispose();
    this.viewItems = [];
    for (const item of this.sashItems) item.disposable.dispose();
    this.sashItems = [];
    super.dispose();
  }
}

// —— Emitter 适配（sash.ts 已有 Emitter，但 split-view.ts 独立使用） ——
class Emitter<T> {
  private listeners: ((e: T) => void)[] = [];
  readonly event = (listener: (e: T) => void): IDisposable => {
    this.listeners.push(listener);
    return { dispose: () => { this.listeners = this.listeners.filter((l) => l !== listener); } };
  };
  fire(e: T): void {
    for (const listener of this.listeners) {
      try { listener(e); } catch (err) { log.error('split-view 事件监听器抛错', err); }
    }
  }
  dispose(): void { this.listeners = []; }
}
