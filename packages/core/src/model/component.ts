import { Draft, produce, Patch, enablePatches } from 'immer'
import { map, Observable, Subject, Subscription } from '@tanbo/stream'
import { AbstractType, Type, InjectionToken, InjectFlags, Injector } from '@viewfly/core'

import { makeError } from '../_utils/make-error'
import { ContentType, Slot, SlotLiteral } from './slot'
import { Formats } from './format'
import { ChangeMarker } from './change-marker'
import { Slots } from './slots'
import { StateChange } from './types'

enablePatches()

const componentErrorFn = makeError('DefineComponent')

export interface SlotsComponentInitData<State, SlotState> {
  slots: Slot<SlotState>[]
  state?: State
}

export interface StateComponentInitData<State, SlotState> {
  slots?: Slot<SlotState>[]
  state: State
}

/**
 * 组件初始化数据
 */
export type ComponentInitData<State = unknown, SlotState = unknown> =
  SlotsComponentInitData<State, SlotState>
  | StateComponentInitData<State, SlotState>

/**
 * 组件 JSON 字面量接口
 */
export interface ComponentLiteral<State = any> {
  name: string
  slots: SlotLiteral<any, any>[]
  state: State
}


export interface Key {
  match: RegExp | ((key: string) => boolean)
  name: string | string[]
}

export interface Keymap {
  ctrlKey?: boolean;
  shiftKey?: boolean;
  altKey?: boolean;
  key: string | string[] | Key;
}

export interface Shortcut {
  keymap: Keymap

  action(key: string): boolean | void
}

export interface ZenCodingGrammarInterceptor<Data = any> {
  /** 匹配字符 */
  match: RegExp | ((content: string) => boolean)
  /** 触发键 */
  key: string | string[] | RegExp | ((content: string) => boolean)

  /** 触发执行的方法 */
  generateInitData(content: string, injector: Injector): Data
}

/**
 * 组件实例对象
 */
export class ComponentInstance<State = unknown, SlotState = unknown, Extends = unknown> {
  id = Math.random()
  /**
   * 组件所在的插槽
   * @readonly
   * @internal
   */
  parent: Slot | null = null
  /**
   * 父组件
   * @readonly
   * @internal
   */
  parentComponent: ComponentInstance | null = null
  /** 组件变化标识器 */
  changeMarker = new ChangeMarker()
  /** 组件长度，固定为 1 */
  length = 1
  /** 组件的子插槽集合 */
  slots: Slots<SlotState>
  /** 组件动态上下文菜单注册表 */
  shortcutList: Shortcut[] = []
  /** 当状态变更时触发 */
  onStateChange: Observable<StateChange<State>>
  /** 组件内部实现的方法 */
  extends!: Extends
  /** 组件名 */
  name: string
  /** 组件类型 */
  type: ContentType
  /** 组件是否可拆分 */
  separable: boolean
  /** 组件状态 */
  state: State

  protected stateChangeEvent = new Subject<StateChange<State>>()

  /**
   * @param injector 当前容器上下文
   * @param options 组件配置项
   * @param initData 初始数据
   */
  constructor(injector: Injector,
              options: ComponentOptions<State, SlotState, Extends>,
              initData?: ComponentInitData<State, SlotState>) {
    this.onStateChange = this.stateChangeEvent.asObservable()
    this.name = options.name
    this.type = options.type
    this.separable = !!options.separable

    if (typeof options.validate === 'function') {
      initData = options.validate(initData)
    }

    this.state = initData?.state as any || null
    this.slots = new Slots<SlotState>(this, initData?.slots || [])

    const changeController: ChangeController<State> = {
      update: (fn, record = true) => {
        return this.updateState(fn, record)
      },
      onChange: this.onStateChange.pipe(map(i => i.newState))
    }
    const context: ComponentContext<State> = {
      contextInjector: injector,
      changeController,
      componentInstance: this,
      eventCache: new EventCache<EventTypes>(),
    }
    contextStack.push(context)
    if (typeof options.setup === 'function') {
      this.extends = options.setup()
    }
    onDestroy(() => {
      eventCacheMap.delete(this)
      subscriptions.forEach(i => i.unsubscribe())
    })
    eventCacheMap.set(this, context.eventCache)
    contextStack.pop()

    const subscriptions: Subscription[] = [
      this.slots.onChange.subscribe(ops => {
        this.changeMarker.markAsDirtied(ops)
      })
    ]
  }

  /**
   * 更新组件状态的方法
   * @param fn
   * @param record
   */
  updateState(fn: (draft: Draft<State>) => void, record?: boolean): State {
    let changes!: Patch[]
    let inverseChanges!: Patch[]
    const oldState = this.state
    const newState = produce(oldState, fn, (p, ip) => {
      changes = p
      inverseChanges = ip
    }) as State
    if (changes.length === 0 && inverseChanges.length === 0) {
      return oldState!
    }
    this.state = newState
    this.changeMarker.markAsDirtied({
      path: [],
      apply: [{
        type: 'apply',
        patches: changes!,
        value: newState,
        record: !!record
      }],
      unApply: [{
        type: 'apply',
        patches: inverseChanges!,
        value: oldState,
        record: !!record
      }]
    })
    this.stateChangeEvent.next({
      oldState: oldState!,
      newState,
      record: !!record
    })
    return newState
  }

  /**
   * 组件转为 JSON 数据的方法
   */
  toJSON(): ComponentLiteral<State> {
    return {
      name: this.name,
      state: this.state ?? null as unknown as State,
      slots: this.slots.toJSON()
    }
  }

  /**
   * 将组件转换为 string
   */
  toString(): string {
    return this.slots.toString()
  }
}

/**
 * Textbus 扩展组件接口
 */
export interface ComponentOptions<State, SlotState, Extends> {
  /** 组件名 */
  name: string
  /** 组件类型 */
  type: ContentType
  /** 组件是否可拆分 */
  separable?: boolean

  /** 输入语法糖支持 */
  zenCoding?: ZenCodingGrammarInterceptor<ComponentInitData<State, SlotState>> |
    ZenCodingGrammarInterceptor<ComponentInitData<State, SlotState>>[]

  /**
   * 组件初始数据校验
   * @param initData
   */
  validate?(initData?: ComponentInitData<State, SlotState>): ComponentInitData<State, SlotState>

  /**
   * 组件初始化实现
   */
  setup?(): Extends
}

/**
 * Textbus 组件
 */
export class Component<
  State = unknown,
  SlotState = unknown,
  Extends = unknown> {

  /** 组件名 */
  name: string
  /** 实例数据类型 */
  instanceType: ContentType
  /** 组件是否可拆分 */
  separable: boolean
  /** 快捷语法拦截器 */
  zenCoding: ZenCodingGrammarInterceptor<ComponentInitData<State, SlotState>> |
    ZenCodingGrammarInterceptor<ComponentInitData<State, SlotState>>[]

  constructor(private options: ComponentOptions<State, SlotState, Extends>) {
    this.name = options.name
    this.instanceType = options.type
    this.separable = !!options.separable
    this.zenCoding = options.zenCoding || []
  }

  /**
   * 组件创建实例的方法
   * @param injector
   * @param data
   */
  createInstance(injector: Injector, data?: ComponentInitData<State, SlotState>): ComponentInstance<State, SlotState, Extends> {
    return new ComponentInstance<State, SlotState, Extends>(injector, this.options, data)
  }
}

/**
 * 组件内状态管理器
 */
export interface ChangeController<T> {
  /** 组件状态变化时触发 */
  onChange: Observable<T>

  /**
   * 组件状态更新函数
   * @param fn
   * @param record 是否记录此次状态变更
   */
  update(fn: (draft: Draft<T>) => void, record?: boolean): T
}

/**
 * 插入内容事件对象
 */
export interface InsertEventData {
  /** 插槽插入的位置 */
  index: number
  /** 当前插入的内容 */
  content: string | ComponentInstance,
  /** 当前插入的附加的格式 */
  formats: Formats
}

/**
 * 换行事件对象
 */
export interface BreakEventData {
  /** 换行事件插槽的第几位触发的换行操作 */
  index: number
}

/**
 * 删除数据事件对象
 */
export interface DeleteEventData {
  /** 删除数据的位置 */
  index: number
  /** 删除数据的长度 */
  count: number
  /** 是否是向结束位置删除 */
  toEnd: boolean
}

/**
 * 粘贴事件对象
 */
export interface PasteEventData {
  /** 标识粘贴发生在插槽的第几位 */
  index: number
  /** 粘贴的内容 */
  data: Slot
  /** 粘贴内容的纯文本 */
  text: string
}

/**
 * 组合输入开始事件对象
 */
export interface CompositionStartEventData {
  /** 标识在插槽的第几位触发 */
  index: number
}

/**
 * 组合输入更新事件对象
 */
export interface CompositionUpdateEventData {
  /** 标识在插槽的第几位触发 */
  index: number
  /** 组件数据输入的数据 */
  data: string
}

/**
 * 上下文本菜单配置项
 */
export interface ContextMenuItem {
  iconClasses?: string[]
  label: string
  disabled?: boolean

  onClick(): void
}

/**
 * 自定义上下文本菜单配置项
 */
export interface ContextMenuCustomItem<T = unknown> {
  type: string
  value?: T
  disabled?: boolean

  validate?(value: T): true | string

  onComplete(value: T): void
}

/**
 * 上下文多级菜单配置项
 */
export interface ContextMenuGroup {
  iconClasses?: string[]
  label: string
  disabled?: boolean
  submenu: Array<ContextMenuItem | ContextMenuCustomItem>
}

export type ContextMenuConfig = ContextMenuGroup | ContextMenuItem

export interface SlotRange {
  slot: Slot
  startIndex: number
  endIndex: number
}

export interface EventTypes {
  onUnselect: () => void
  onSelected: () => void
  onFocus: () => void
  onBlur: () => void
  onFocusIn: () => void
  onFocusOut: () => void
  onDestroy: () => void
  onParentSlotUpdated: () => void
  onSelectionFromFront: (event: Event<ComponentInstance>) => void
  onSelectionFromEnd: (event: Event<ComponentInstance>) => void
  onBreak: (event: Event<Slot, BreakEventData>) => void
  onPaste: (event: Event<Slot, PasteEventData>) => void
  onContextMenu: (event: ContextMenuEvent<ComponentInstance>) => void

  onContentInserted: (event: Event<Slot, InsertEventData>) => void
  onContentInsert: (event: Event<Slot, InsertEventData>) => void
  onContentDelete: (event: Event<Slot, DeleteEventData>) => void
  onContentDeleted: (event: Event<Slot>) => void

  // onSlotInserted: (event: Event<Slot, InsertEventData>) => void
  // onSlotInsert: (event: Event<Slot, InsertEventData>) => void
  onSlotRemove: (event: Event<ComponentInstance, DeleteEventData>) => void
  onSlotRemoved: (event: Event<ComponentInstance>) => void

  onGetRanges: (event: GetRangesEvent<ComponentInstance>) => void
  onCompositionStart: (event: Event<Slot, CompositionStartEventData>) => void
  onCompositionUpdate: (event: Event<Slot, CompositionUpdateEventData>) => void
  onCompositionEnd: (event: Event<Slot>) => void
}

class EventCache<T, K extends keyof T = keyof T> {
  private listeners = new Map<K, Array<T[K]>>()

  add(eventType: K, callback: T[K]) {
    let callbacks = this.listeners.get(eventType)
    if (!callbacks) {
      callbacks = []
      this.listeners.set(eventType, callbacks)
    }
    callbacks.push(callback)
  }

  get(eventType: K): Array<T[K]> {
    return this.listeners.get(eventType) || []
  }

  clean(eventType: K) {
    this.listeners.delete(eventType)
  }
}

interface ComponentContext<T> {
  changeController: ChangeController<T>
  contextInjector: Injector
  componentInstance: ComponentInstance
  // dynamicShortcut: Shortcut[]
  eventCache: EventCache<EventTypes>
}

const eventCacheMap = new WeakMap<ComponentInstance, EventCache<EventTypes>>()
const contextStack: ComponentContext<any>[] = []

function getCurrentContext() {
  const current = contextStack[contextStack.length - 1]
  if (!current) {
    throw componentErrorFn('cannot be called outside the component!')
  }
  return current
}

/**
 * 提取组件的实例类型
 */
export type ExtractComponentInstanceType<T> = T extends Component<infer S, infer U, infer K> ? ComponentInstance<S, U, K> : never
/**
 * 提取组件扩展类型
 */
export type ExtractComponentInstanceExtendsType<T> = T extends Component<infer S> ? S : never
/**
 * 提取组件状态类型
 */
export type ExtractComponentStateType<T> = T extends Component<any, infer S> ? S : never

/**
 * Textbus 扩展组件方法
 * @param options
 */
export function defineComponent<State = unknown, SlotState = unknown, Extends = void>(
  options: ComponentOptions<State, SlotState, Extends>
) {
  return new Component<State, SlotState, Extends>(options)
}

/**
 * 组件 setup 方法内获取编辑器 IoC 容器的勾子
 */
export function useContext(): Injector
export function useContext<T>(token: Type<T> | AbstractType<T> | InjectionToken<T>, notFoundValue?: T, flags?: InjectFlags): T
export function useContext(token: any = Injector, noFoundValue?: any, flags?: any): Injector {
  const context = getCurrentContext()
  return context.contextInjector.get(token, noFoundValue, flags)
}

/**
 * 组件 setup 方法内获取组件实例的勾子
 */
export function useSelf<T extends ComponentInstance>(): T {
  const context = getCurrentContext()
  return context.componentInstance as T
}

/**
 * 组件注册动态快捷键的勾子
 * @param config
 */
export function useDynamicShortcut(config: Shortcut) {
  const context = getCurrentContext()
  context.componentInstance.shortcutList.push(config)
}

/**
 * Textbus 事件对象
 */
export class Event<S, T = null> {
  get isPrevented() {
    return this._isPrevented
  }

  private _isPrevented = false

  constructor(public target: S,
              public data: T,
  ) {
  }

  preventDefault() {
    this._isPrevented = true
  }
}

export class ContextMenuEvent<T> extends Event<T> {
  constructor(target: T,
              private getMenus: (menus: ContextMenuConfig[]) => void) {
    super(target, null)
  }

  get stopped() {
    return this.isStopped
  }

  private isStopped = false

  stopPropagation() {
    this.isStopped = true
  }

  useMenus(menus: ContextMenuConfig[]) {
    this.getMenus(menus)
  }
}

export class GetRangesEvent<T> extends Event<T> {
  constructor(target: T,
              private getRanges: (ranges: SlotRange[]) => void) {
    super(target, null)
  }

  useRanges(ranges: SlotRange[]) {
    this.getRanges(ranges)
  }
}

/**
 * 触发组件事件的方法
 * @param target 目标组件
 * @param eventType 事件名
 * @param event 事件对象
 */
export function invokeListener(target: ComponentInstance, eventType: 'onSelectionFromFront', event: Event<ComponentInstance>): void
export function invokeListener(target: ComponentInstance, eventType: 'onSelectionFromEnd', event: Event<ComponentInstance>): void
export function invokeListener(target: ComponentInstance, eventType: 'onContentInsert', event: Event<Slot, InsertEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onContentInserted', event: Event<Slot, InsertEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onContentDelete', event: Event<Slot, DeleteEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onContentDeleted', event: Event<Slot>): void
export function invokeListener(target: ComponentInstance, eventType: 'onSlotRemove', event: Event<ComponentInstance, DeleteEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onSlotRemoved', event: Event<ComponentInstance>): void
export function invokeListener(target: ComponentInstance, eventType: 'onBreak', event: Event<Slot, BreakEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onContextMenu', event: ContextMenuEvent<ComponentInstance>): void
export function invokeListener(target: ComponentInstance, eventType: 'onPaste', event: Event<Slot, PasteEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onGetRanges', event: GetRangesEvent<ComponentInstance>): void
// eslint-disable-next-line max-len
export function invokeListener(target: ComponentInstance, eventType: 'onCompositionStart', event: Event<Slot, CompositionStartEventData>): void
// eslint-disable-next-line max-len
export function invokeListener(target: ComponentInstance, eventType: 'onCompositionUpdate', event: Event<Slot, CompositionUpdateEventData>): void
export function invokeListener(target: ComponentInstance, eventType: 'onCompositionEnd', event: Event<Slot>): void
export function invokeListener(target: ComponentInstance, eventType: 'onSelected'): void
export function invokeListener(target: ComponentInstance, eventType: 'onUnselect'): void
export function invokeListener(target: ComponentInstance, eventType: 'onFocus'): void
export function invokeListener(target: ComponentInstance, eventType: 'onBlur'): void
export function invokeListener(target: ComponentInstance, eventType: 'onFocusIn'): void
export function invokeListener(target: ComponentInstance, eventType: 'onFocusOut'): void
export function invokeListener(target: ComponentInstance, eventType: 'onDestroy'): void
export function invokeListener(target: ComponentInstance, eventType: 'onParentSlotUpdated'): void
export function invokeListener<K extends keyof EventTypes,
  D = EventTypes[K] extends (args: infer U) => any ?
    U extends Event<any> ? U : never
    : never>(target: ComponentInstance, eventType: K, event?: D) {
  if (typeof target !== 'object' || target === null) {
    return
  }
  const cache = eventCacheMap.get(target)
  if (cache) {
    const callbacks = cache.get(eventType)
    callbacks.forEach(fn => {
      return (fn as any)(event)
    })
    if (eventType === 'onDestroy') {
      eventCacheMap.delete(target)
    }
  }
}

function makeEventHook<T extends keyof EventTypes>(type: T) {
  return function (listener: EventTypes[T]) {
    const context = getCurrentContext()
    if (context) {
      context.eventCache.add(type, listener)
    }
  }
}

/**
 * 根据组件触发上下文菜单
 * @param component
 */
export function triggerContextMenu(component: ComponentInstance) {
  let comp: ComponentInstance | null = component
  const menuItems: ContextMenuConfig[][] = []
  while (comp) {
    const event = new ContextMenuEvent<ComponentInstance>(comp, (menus: ContextMenuConfig[]) => {
      menuItems.push(menus)
    })
    invokeListener(
      comp as ComponentInstance,
      'onContextMenu',
      event
    )
    if (event.stopped) {
      break
    }
    comp = comp.parent?.parent || null
  }
  return menuItems
}

/**
 * 当已选中组件未选中或选区不只选中已选中组件时触发
 */
export const onUnselect = makeEventHook('onUnselect')

/**
 * 当选区刚好选中一个组件
 */
export const onSelected = makeEventHook('onSelected')

/**
 * 当光标从前面进入组件
 */
export const onSelectionFromFront = makeEventHook('onSelectionFromFront')

/**
 * 当光标从后面进入组件
 */
export const onSelectionFromEnd = makeEventHook('onSelectionFromEnd')

/**
 * 组件获取焦点事件的勾子
 */
export const onFocus = makeEventHook('onFocus')

/**
 * 组件失去焦点事件的勾子
 */
export const onBlur = makeEventHook('onBlur')

/**
 * 组件或子组件获取焦点事件的勾子
 */
export const onFocusIn = makeEventHook('onFocusIn')

/**
 * 组件或子组件失去焦点事件的勾子
 */
export const onFocusOut = makeEventHook('onFocusOut')

/**
 * 组件内粘贴事件勾子
 */
export const onPaste = makeEventHook('onPaste')

/**
 * 组件右键菜单事件勾子
 */
export const onContextMenu = makeEventHook('onContextMenu')

/**
 * 组件子插槽删除时的勾子
 */
export const onSlotRemove = makeEventHook('onSlotRemove')

/**
 * 组件子插槽删除完成时的勾子
 */
export const onSlotRemoved = makeEventHook('onSlotRemoved')

/**
 * 组件子插槽内容删除时的勾子
 */
export const onContentDelete = makeEventHook('onContentDelete')

/**
 * 组件子插槽内容删除完成时的勾子
 */
export const onContentDeleted = makeEventHook('onContentDeleted')

/**
 * 组件子插槽换行时的勾子
 */
export const onBreak = makeEventHook('onBreak')

/**
 * 组件子插槽插入内容时的勾子
 */
export const onContentInsert = makeEventHook('onContentInsert')

/**
 * 组件子插槽插入内容后时的勾子
 */
export const onContentInserted = makeEventHook('onContentInserted')

/**
 * 组件销毁时的勾子
 */
export const onDestroy = makeEventHook('onDestroy')
/**
 * 当组件为选区公共父组件时的勾子
 */
export const onGetRanges = makeEventHook('onGetRanges')
/**
 * 当插槽组合输入前触发
 */
export const onCompositionStart = makeEventHook('onCompositionStart')
/**
 * 当插槽组合输入时触发
 */
export const onCompositionUpdate = makeEventHook('onCompositionUpdate')
/**
 * 当插槽组合输入结束触发
 */
export const onCompositionEnd = makeEventHook('onCompositionEnd')
/**
 * 当组件的父插槽数据发生更新后触发
 */
export const onParentSlotUpdated = makeEventHook('onParentSlotUpdated')
